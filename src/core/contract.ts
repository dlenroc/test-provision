import type { RpcCompatible } from "capnweb";
import type {
  Requirements,
  ResourceRequest,
  Json,
  JsonSafe,
  ResourceContract,
  ServiceContract,
} from "./types.js";

/**
 * Declare a test resource and identify its provider.
 *
 * @remarks
 * Each alias gets a separate allocation. Keys identify resource providers
 * and must be unique among them.
 * Inputs must be JSON-serializable and may appear in test metadata.
 * Do not include secrets.
 *
 * @example
 * ```ts
 * import { resource } from '@dlenroc/test-provision'
 *
 * const user = resource<{ name: string }, { name: string }>('user')
 * const alice = user('alice', { name: 'Alice' })
 * const requests = [alice, user('bob', { name: 'Bob' })]
 * ```
 */
export function resource<Input, Result extends RpcCompatible<Result> = unknown>(
  key: [Input] extends [JsonSafe<Input>] ? string : never,
): ResourceContract<Input, Result> {
  const declaration = (alias: string, input: Input) => {
    if (!alias) throw new TypeError("Resource requests require a nonempty alias");
    return { key, alias, input: JSON.parse(JSON.stringify(input)) as Input };
  };
  return Object.assign(declaration, { kind: "resource" as const, key }) as unknown as ResourceContract<Input, Result>;
}

/**
 * Declare a runner-owned service shared across tests.
 *
 * @remarks
 * The provider initializes the service on first `prepared()` or `getService()`
 * access. No `needs()` is required. Successful services survive Vitest reruns
 * until runner shutdown. Initialization failures are cached without retries.
 * Service and resource keys are independent.
 *
 * @example
 * ```ts
 * // src/provision/services/accounts.ts
 * import { service } from '@dlenroc/test-provision'
 * import type { AccountClient } from '../../app/accounts.js'
 *
 * export const accounts = service<AccountClient>('accounts')
 * ```
 */
export function service<Result extends RpcCompatible<Result>>(key: string): ServiceContract<Result> {
  return { kind: "service", key } as ServiceContract<Result>;
}

/** Convert typed declarations to the runner's serialized requirements. */
export function collectRequirements(requests: readonly ResourceRequest[]): Requirements {
  const entries = new Map<string, Requirements[string]>();
  for (const { key, alias, input } of requests) {
    if (!alias) throw new TypeError("Resource requests require a nonempty alias");
    if (entries.has(alias)) {
      throw new Error(`Duplicate resource alias '${alias}'`);
    }
    entries.set(alias, { key, input: input as Json });
  }
  return Object.fromEntries(entries);
}

