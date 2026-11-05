import { fileURLToPath } from "node:url";
import type {
  FullConfig,
  FullProject,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { Coordinator } from "../core/coordinator.js";
import { RpcServer } from "../core/server.js";
import { ServiceRegistry } from "../core/services.js";
import { splitProviders } from "../core/provider.js";
import type { ProvisionOptions } from "../core/types.js";
import { ENDPOINT_ENV } from "./endpoint.js";
import { readRequirements } from "./needs.js";
import type { TestForecast } from "../core/coordinator.js";

/** Only tests selected after filtering and sharding contribute forecast demand. */
function* forecastsForSuite(suite: Suite): IterableIterator<TestForecast> {
  for (const test of suite.allTests()) {
    if (test.expectedStatus === "skipped") continue;
    const requirements = readRequirements(test.annotations);
    if (Object.keys(requirements).length) {
      yield { testId: test.id, requirements };
    }
  }
}

/** Track reporter registration for each runner configuration. */
const provisionedRuns = new WeakSet<FullConfig>();

/**
 * Register resource and service providers in Playwright's `reporter` array.
 *
 * @remarks
 * Register once per Playwright run. Each attempt releases its resources
 * during fixture teardown; `onEnd()` closes remaining resource work.
 * Services remain available until `onExit()`.
 * Providers returning `RpcTarget` values must share the reporter's Cap'n Web
 * module format (ESM or CommonJS).
 *
 * @example
 * ```ts
 * import { defineConfig } from '@playwright/test'
 * import { provision } from '@dlenroc/test-provision/playwright/reporter'
 * import { userProvider } from './src/provision/resources/providers/user.js'
 * import {
 *   accountsProvider,
 * } from './src/provision/services/providers/accounts.js'
 *
 * export default defineConfig({
 *   reporter: [
 *     ['list'],
 *     provision({ providers: [userProvider, accountsProvider] }),
 *   ],
 * })
 * ```
 */
export function provision(options: ProvisionOptions): readonly [string, ProvisionOptions] {
  // Use this module's format so a CJS provider and reporter share Cap'n Web identity.
  return [fileURLToPath(import.meta.url), options] as const;
}

/** Playwright reporter configured through `provision()`. */
export default class ResourceReporter implements Reporter {
  constructor(private readonly options: ProvisionOptions) {}

  printsToStdio() {
    return false;
  }
  private coordinator: Coordinator | undefined;
  private server: RpcServer | undefined;
  private services: ServiceRegistry | undefined;
  private runConfig: FullConfig | undefined;
  private previousEndpoint: string | undefined;
  private publishedUrl: string | undefined;
  private readonly deferredProjects = new Map<FullProject, Suite>();

  // Playwright awaits preprocess() before workers start, but onBegin() is
  // synchronous. Open the endpoint here, then schedule forecasts in onBegin()
  // after test selection and sharding have finished.
  async preprocess({ config, suite }: { config: FullConfig; suite: Suite }) {
    // Playwright injects the command mode into reporter options, outside its public types.
    const mode = (this.options as ProvisionOptions & { _mode?: string })._mode;
    if (mode === "list" || mode === "merge") return;
    if (provisionedRuns.has(config)) {
      throw new Error("provision() must be registered only once per Playwright run");
    }
    if (!suite.allTests().length) return;
    provisionedRuns.add(config);
    this.runConfig = config;
    this.previousEndpoint = process.env[ENDPOINT_ENV];
    try {
      const entries = splitProviders(this.options.providers);
      const services = new ServiceRegistry(entries.services, this.options.shutdownTimeout);
      this.services = services;
      this.coordinator = new Coordinator(
        entries.resources,
        this.options,
        (declaration) => services.resolve(declaration),
      );
      this.server = new RpcServer(() => this.coordinator!, this.options, this.services);
      await this.server.start();
      this.publishedUrl = this.server.url!;
      process.env[ENDPOINT_ENV] = this.publishedUrl;
    } catch (error) {
      provisionedRuns.delete(config);
      this.runConfig = undefined;
      try {
        await this.services?.close();
        await this.server?.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Resource reporter initialization failed");
      }
      throw error;
    }
  }

  onBegin(config: FullConfig, suite: Suite) {
    if (!this.publishedUrl) return;
    const teardowns = new Set(config.projects.map((project) => project.teardown));
    for (const projectSuite of suite.suites) {
      const project = projectSuite.project()!;
      if (project.dependencies.length || teardowns.has(project.name)) {
        this.deferredProjects.set(project, projectSuite);
      } else {
        this.coordinator!.scheduleForecasts(forecastsForSuite(projectSuite));
      }
    }
  }

  onTestBegin(test: TestCase, result: TestResult) {
    if (!this.publishedUrl) return;
    const project = test.parent.project()!;
    const suite = this.deferredProjects.get(project);
    if (suite) {
      // A test starting confirms that Playwright has admitted this project's phase.
      this.deferredProjects.delete(project);
      this.coordinator!.registerForecasts(forecastsForSuite(suite));
    }
    this.coordinator!.activate(test.id, result.retry);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.publishedUrl) return;
    this.coordinator!.finish(test.id, result.status === "skipped" ? undefined : result.retry);
    if (
      this.options.prefetchRetries === true &&
      result.retry < test.retries &&
      result.status !== "skipped" &&
      result.status !== "interrupted" &&
      result.status !== test.expectedStatus
    ) {
      this.coordinator!.prefetchRetry(test.id, result.retry + 1);
    }
  }

  async onEnd() {
    if (!this.runConfig) return;
    let failure: unknown;
    try {
      await this.coordinator?.close();
    } catch (error) {
      failure = error;
    }
    this.coordinator = undefined;
    this.deferredProjects.clear();
    if (failure !== undefined) {
      console.error("[test-provision] resource shutdown failed:", failure);
      return { status: "failed" as const };
    }
  }

  async onExit() {
    if (!this.runConfig) return;
    try {
      await this.finish();
    } catch (error) {
      // Playwright does not propagate reporter onExit failures to the run status.
      console.error("[test-provision] service shutdown failed:", error);
    }
  }

  private async finish() {
    const errors: unknown[] = [];
    try {
      try {
        await this.coordinator?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.services?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.server?.close();
      } catch (error) {
        errors.push(error);
      }
    } finally {
      if (this.publishedUrl && process.env[ENDPOINT_ENV] === this.publishedUrl) {
        if (this.previousEndpoint === undefined) delete process.env[ENDPOINT_ENV];
        else process.env[ENDPOINT_ENV] = this.previousEndpoint;
      }
      if (this.runConfig) provisionedRuns.delete(this.runConfig);
      this.runConfig = undefined;
      this.publishedUrl = undefined;
      this.coordinator = undefined;
      this.server = undefined;
      this.services = undefined;
      this.deferredProjects.clear();
    }
    if (errors.length) {
      throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Shutdown failed");
    }
  }
}
