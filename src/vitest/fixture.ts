import { inject, type TestAPI } from "vitest";
import type { RpcStub } from "capnweb";
import { collectRequirements } from "../core/contract.js";
import { PreparedScope } from "../core/prepared.js";
import { getSession } from "../core/session.js";
import type { ProvisionEndpoint } from "../core/server.js";
import type { Accessor, FixtureOptions, PreparedFixture } from "../core/types.js";

export { needs } from "./needs.js";

declare module "vitest" {
  interface ProvidedContext {
    __test_provision_rpc_url__: string;
    __test_provision_retry_preparation__: boolean;
  }
  interface TaskMeta {
    /** Resources declared for this test. */
    provision?: readonly import("../core/types.js").ResourceRequest[];
  }
}

async function deadline<T>(
  operation: PromiseLike<T>,
  timeout: number,
  phase: "preparation" | "teardown",
  onTimeout?: () => void,
): Promise<T> {
  if (!(timeout > 0) || timeout === Infinity) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`Resource ${phase} timed out after ${timeout}ms`));
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Add the automatic `prepared` fixture to a Vitest test API.
 *
 * @remarks
 * Register `provision()` in the Vitest config. Use `needs()` in test metadata
 * to declare resources. Each attempt releases its resources during teardown.
 * Services need no `needs()` and survive watch reruns until runner shutdown.
 *
 * @example
 * ```ts
 * import { test as base, expect } from 'vitest'
 * import { withResources, needs } from '@dlenroc/test-provision/vitest'
 *
 * export const test = withResources(base)
 * export { expect, needs }
 * ```
 */
export function withResources<Context extends object>(
  base: TestAPI<Context>,
  options: FixtureOptions = {},
) {
  const timeout = options.timeout ?? 0;
  const attempts = new WeakMap<
    object,
    {
      next: number;
      retryCount: number;
      retry: number;
      aborted?: AbortSignal;
    }
  >();
  const extended = (base as unknown as TestAPI<object>).extend(
    "prepared",
    { auto: true },
    async ({ task, signal }, { onCleanup }): Promise<Accessor> => {
      const requirements = collectRequirements(task.meta.provision ?? []);
      let scope: PreparedScope | undefined;
      let cleanupResource: () => Promise<void> = async () => {};
      onCleanup(async () => {
        try {
          await cleanupResource();
        } finally {
          scope?.[Symbol.dispose]();
        }
      });
      const connect = () => getSession(inject("__test_provision_rpc_url__"));
      if (!Object.keys(requirements).length) {
        scope = new PreparedScope({}, requirements, connect);
        return scope.prepared;
      }

      // Vitest updates repeat counters after aroundEach fixtures resolve. Count
      // fixture executions instead; a later run gets a new result object.
      const result = task.result!;
      let state = attempts.get(result);
      if (!state) {
        state = { next: 0, retryCount: result.retryCount ?? 0, retry: result.retryCount ?? 0 };
        attempts.set(result, state);
      } else {
        const count = result.retryCount ?? 0;
        // Retry count is cumulative across repeats; unchanged means a new repeat.
        state.retry = count === state.retryCount ? 0 : state.retry + count - state.retryCount;
        state.retryCount = count;
      }
      const retry = state.retry;
      const attempt = state.next++;
      const errorsStart = result.errors?.length ?? 0;
      type AllocationStub = ReturnType<RpcStub<ProvisionEndpoint>["open"]>;
      let allocation: AllocationStub | undefined;
      let response: Awaited<ReturnType<AllocationStub["ready"]>> | undefined;
      let closed = false;
      let releasing: Promise<void> | undefined;
      const release = () =>
        (releasing ??= (async () => {
          closed = true;
          try {
            response?.[Symbol.dispose]();
          } finally {
            if (allocation) {
              try {
                await allocation.release();
              } finally {
                allocation[Symbol.dispose]();
              }
            }
          }
        })());
      const onAbort = () => {
        state.aborted = signal;
        void release().catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      cleanupResource = async () => {
        signal.removeEventListener("abort", onAbort);
        await deadline(release(), timeout, "teardown");
        if (!response || !inject("__test_provision_retry_preparation__")) return;
        const maxRetries = typeof task.retry === "number" ? task.retry : (task.retry?.count ?? 0);
        if (retry >= maxRetries || result.state === "skip") return;
        // Cleanup runs after aroundEach and the current attempt's hooks. Vitest
        // applies expected-failure inversion and retry conditions immediately afterward.
        const errors = result.errors?.slice(errorsStart) ?? [];
        const failed = task.fails ? result.state === "pass" : result.state === "fail";
        if (!failed) return;
        const condition = typeof task.retry === "object" ? task.retry.condition : undefined;
        // Conditions can have side effects: never invoke a user's predicate twice.
        if (typeof condition === "function") return;
        if (condition) {
          const error = task.fails ? { message: "Expect test to fail" } : errors.at(-1);
          if (!error) return;
          const pattern = new RegExp(condition.source, condition.flags);
          pattern.lastIndex = condition.lastIndex;
          if (!pattern.test(error.message ?? "")) return;
        }
        await getSession(inject("__test_provision_rpc_url__"))
          .prefetchRetry(task.id, attempt + 1)
          .catch(() => {});
      };
      // Vitest retains the same signal after a timed-out attempt. Its stale abort
      // must not prevent the runner's next retry; normal teardown still owns release.
      if (signal.aborted && state.aborted !== signal) {
        onAbort();
        throw signal.reason;
      }
      const remote = getSession(inject("__test_provision_rpc_url__"));
      allocation = remote.open(task.id, requirements, attempt);
      const ready = Promise.resolve(allocation.ready()).then((value) => {
        if (closed) {
          value[Symbol.dispose]();
          throw new Error("Resource preparation cancelled");
        }
        response = value;
        return value;
      });
      try {
        await deadline(ready, timeout, "preparation", () => {
          void release().catch(() => {});
        });
      } catch (error) {
        await deadline(release(), timeout, "teardown").catch(() => {});
        throw error;
      }
      scope = new PreparedScope(response!.values, requirements, connect);
      return scope.prepared;
    },
  );
  return extended as unknown as TestAPI<Context & PreparedFixture>;
}
