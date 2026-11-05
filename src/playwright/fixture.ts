import type { TestType } from "@playwright/test";
import { PreparedScope } from "../core/prepared.js";
import { getSession } from "../core/session.js";
import type { FixtureOptions, PreparedFixture } from "../core/types.js";
import { ENDPOINT_ENV } from "./endpoint.js";
import { readRequirements } from "./needs.js";

function endpointFromEnvironment(): string {
  const endpoint = process.env[ENDPOINT_ENV];
  if (!endpoint) {
    throw new Error(
      `Missing ${ENDPOINT_ENV}; register the test-provision Playwright ` +
        "reporter before using withResources()",
    );
  }
  return endpoint;
}

/**
 * Add the automatic `prepared` fixture to a Playwright test API.
 *
 * @remarks
 * Register `provision()` in the Playwright reporter config and use `needs()`
 * annotations for resources. Each attempt releases its resources on teardown.
 * Services are available without `needs()` and live until runner shutdown.
 *
 * @example
 * ```ts
 * import { test as base, expect } from '@playwright/test'
 * import { withResources, needs } from '@dlenroc/test-provision/playwright'
 *
 * export const test = withResources(base)
 * export { expect, needs }
 * ```
 */
export function withResources<TestArgs extends object, WorkerArgs extends object>(
  base: TestType<TestArgs, WorkerArgs>,
  options: FixtureOptions = {},
) {
  const extended = (base as TestType<object, object>).extend<PreparedFixture>({
    prepared: [
      async ({}, use, testInfo) => {
        const requirements = readRequirements(testInfo.annotations);
        const connect = () => getSession(endpointFromEnvironment());
        if (!Object.keys(requirements).length) {
          using scope = new PreparedScope({}, requirements, connect);
          await use(scope.prepared);
          return;
        }
        const remote = connect();
        await using allocation = remote.open(testInfo.testId, requirements, testInfo.retry);
        let response: Awaited<ReturnType<typeof allocation.ready>>;
        try {
          response = await allocation.ready();
        } catch (error) {
          await allocation.release().catch(() => {});
          throw error;
        }
        using scope = new PreparedScope(response.values, requirements, connect);
        try {
          await use(scope.prepared);
        } finally {
          try {
            response[Symbol.dispose]();
          } finally {
            await allocation.release();
          }
        }
      },
      { auto: true, timeout: options.timeout ?? 0, box: true },
    ],
  });
  return extended as unknown as TestType<TestArgs & PreparedFixture, WorkerArgs>;
}
