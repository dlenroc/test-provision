import { fileURLToPath } from "node:url";
import type { Reporter, TestModule, Vitest } from "vitest/node";
import type { Plugin } from "vitest/config";
import { Coordinator } from "../core/coordinator.js";
import { collectRequirements } from "../core/contract.js";
import { RpcServer } from "../core/server.js";
import { ServiceRegistry } from "../core/services.js";
import { splitProviders } from "../core/provider.js";
import type { ProvisionOptions as BaseProvisionOptions } from "../core/types.js";
import type { TestForecast } from "../core/coordinator.js";

type ProvisionOptions = BaseProvisionOptions & {
  /**
   * Collect selected modules before execution to prefetch across files.
   * Defaults to `false`. May execute module-level side effects twice;
   * skipped when `concurrency.prefetch` is `0`.
   */
  precollect?: boolean | undefined;
};

function* forecastsForModule(module: TestModule): IterableIterator<TestForecast> {
  if (module.errors().length) return;
  for (const test of module.children.allTests()) {
    if (test.options.mode !== "run" && test.options.mode !== "only") continue;
    const requirements = collectRequirements(test.meta().provision ?? []);
    if (Object.keys(requirements).length) yield { testId: test.id, requirements };
  }
}

const registered = new WeakMap<Vitest, Reporter>();

/**
 * Register resource and service providers in Vitest's `plugins` array.
 *
 * @remarks
 * Register once per Vitest instance. Services survive watch-mode reruns;
 * resources belong to individual attempts. `options` controls resource
 * creation, prefetching, and shutdown.
 *
 * @example
 * ```ts
 * import { defineConfig } from 'vitest/config'
 * import { provision } from '@dlenroc/test-provision/vitest/plugin'
 * import { userProvider } from './src/provision/resources/providers/user.js'
 * import {
 *   accountsProvider,
 * } from './src/provision/services/providers/accounts.js'
 *
 * export default defineConfig({
 *   plugins: [provision({ providers: [userProvider, accountsProvider] })],
 * })
 * ```
 */
export function provision(options: ProvisionOptions): Plugin {
  const entries = splitProviders(options.providers);
  const services = new ServiceRegistry(entries.services, options.shutdownTimeout);
  let coordinator: Coordinator | undefined;
  let running = false;
  let vitestContext: Vitest | undefined;
  let removeCancelListener: (() => void) | undefined;
  const preliminary = new Map<string, Set<string>>();
  const server = new RpcServer(() => {
    if (!coordinator) throw new Error("Resource coordinator not initialized");
    return coordinator;
  }, options, services);
  const reporter: Reporter = {
    async onInit(vitest) {
      vitestContext = vitest;
      await server.start();
      vitest.provide("__test_provision_rpc_url__", server.url!);
      vitest.provide("__test_provision_retry_preparation__", options.prefetchRetries === true);
      vitest.onClose(async () => {
        removeCancelListener?.();
        removeCancelListener = undefined;
        let cleanupError: unknown;
        try {
          await coordinator?.close();
        } catch (error) {
          cleanupError = error;
        }
        try {
          await services.close();
        } catch (error) {
          cleanupError ??= error;
        }
        try {
          await server.close();
        } catch (error) {
          if (cleanupError !== undefined) {
            throw new AggregateError([cleanupError, error], "Resource shutdown failed");
          }
          throw error;
        }
        if (cleanupError !== undefined) throw cleanupError;
      });
    },
    async onTestRunStart(specifications) {
      removeCancelListener?.();
      removeCancelListener = undefined;
      const previous = coordinator;
      coordinator = undefined;
      await previous?.close();
      preliminary.clear();
      running = !vitestContext?.config.mergeReports;
      if (!running) return;
      coordinator = new Coordinator(
        entries.resources,
        options,
        (declaration) => services.resolve(declaration),
      );
      if (options.precollect && options.concurrency?.prefetch !== 0 && specifications.length) {
        const result = await vitestContext!.collectTests([...specifications]);
        // collectTests also returns cached modules from earlier runs.
        const selected = new Set(specifications.map((specification) => specification.taskId));
        const forecasts: TestForecast[] = [];
        for (const module of result.testModules) {
          if (!selected.has(module.id)) continue;
          const plans = [...forecastsForModule(module)];
          preliminary.set(module.id, new Set(plans.map((plan) => plan.testId)));
          forecasts.push(...plans);
        }
        coordinator.scheduleForecasts(forecasts);
      }
    },
    onTestModuleQueued() {
      if (!running || removeCancelListener) return;
      // Vitest clears cancellation listeners after onTestRunStart, including
      // after precollection. Queueing occurs after that reset for the actual run.
      removeCancelListener = vitestContext!.onCancel(() => coordinator?.stopForecasts());
    },
    onTestModuleStart(module: TestModule) {
      if (!running) return;
      coordinator?.reconcileForecasts(preliminary.get(module.id) ?? [], forecastsForModule(module));
      preliminary.delete(module.id);
    },
    onTestCaseResult(testCase) {
      coordinator?.finish(testCase.id);
    },
    async onTestRunEnd() {
      removeCancelListener?.();
      removeCancelListener = undefined;
      running = false;
      const finished = coordinator;
      coordinator = undefined;
      await finished?.close();
    },
  };
  return {
    name: "test-provision:vitest",
    enforce: "pre",
    configureVitest({ vitest, project }) {
      const setup = fileURLToPath(new URL("./setup.mjs", import.meta.url));
      // Each resolved project needs its own setup entry, even when sharing this plugin.
      if (!project.config.setupFiles.includes(setup)) project.config.setupFiles.unshift(setup);
      // Browser Mode may load this file from outside the consumer's project root.
      const allow = project.vite.config.server.fs.allow;
      if (!allow.includes(setup)) allow.push(setup);
      const existing = registered.get(vitest);
      if (existing === reporter) return;
      if (existing) {
        throw new Error("provision() must be registered only once per Vitest instance");
      }
      registered.set(vitest, reporter);
      vitest.config.reporters.push(reporter);
    },
  };
}
