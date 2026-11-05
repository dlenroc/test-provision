import type { RpcCompatible } from "capnweb";
import type {
  DeepReadonly,
  ProviderContext,
  ProviderOptions,
  ResourceContract,
  ServiceContract,
} from "./types.js";

type CreateResource<Input, Result> = (
  input: DeepReadonly<Input>,
  context: ProviderContext,
) => Result | Promise<Result>;

type CreateService<Result extends RpcCompatible<Result>> = (
  context: ProviderContext,
) => Result | Promise<Result>;

export type ResourceProvider<Input, Result> = {
  readonly kind: "resource";
  readonly key: string;
  readonly options: ProviderOptions;
  readonly create: CreateResource<Input, Result>;
};

export type ServiceProvider<Result extends RpcCompatible<Result>> = {
  readonly kind: "service";
  readonly key: string;
  readonly create: CreateService<Result>;
};

// Erase callback types after provider() checks them; ESM and CJS contracts have distinct brands.
export type AnyResourceProvider = Omit<ResourceProvider<never, unknown>, "create"> & {
  readonly create: (...args: never[]) => unknown;
};
export type AnyServiceProvider = Omit<ServiceProvider<unknown>, "create"> & {
  readonly create: (...args: never[]) => unknown;
};
export type AnyProvider = AnyResourceProvider | AnyServiceProvider;

/**
 * Implement a resource with a creation callback and optional limits.
 *
 * @remarks
 * The callback receives readonly input and a {@link ProviderContext}.
 * Register cleanup with `onCleanup()` as resources are acquired, so cleanup
 * still runs if a later step fails. Creation failures are cached for matching
 * inputs within a run; retry inside the callback if needed. Cleanup failures
 * are reported as warnings.
 *
 * @example
 * ```ts
 * const userProvider = provider(user, async ({ name }, { onCleanup }) => {
 *   const account = await createUser(name)
 *   onCleanup(() => deleteUser(account.id))
 *   return account
 * })
 * ```
 */
export function provider<Input, Result>(
  contract: ResourceContract<Input, Result>,
  ...args:
    | [create: CreateResource<Input, Result>]
    | [options: ProviderOptions, create: CreateResource<Input, Result>]
): ResourceProvider<Input, Result>;
/**
 * Implement a shared service declaration with a creation callback.
 *
 * @remarks
 * Initialization runs once on first use; failures are cached without retries.
 * Register cleanup with `onCleanup()` for failures or runner shutdown.
 * Service providers can use `getService()` during initialization.
 *
 * @example
 * ```ts
 * const accountsProvider = provider(accounts, async ({ onCleanup }) => {
 *   const client = await createAccountClient()
 *   onCleanup(() => client.close())
 *   return client
 * })
 * ```
 */
export function provider<Result extends RpcCompatible<Result>>(
  contract: ServiceContract<Result>,
  create: CreateService<Result>,
): ServiceProvider<Result>;
export function provider(
  contract: ResourceContract<unknown, unknown> | ServiceContract<unknown>,
  ...args:
    | [CreateService<unknown>]
    | [CreateResource<unknown, unknown>]
    | [ProviderOptions, CreateResource<unknown, unknown>]
): AnyProvider {
  if (contract.kind === "service") {
    if (args.length !== 1 || typeof args[0] !== "function") {
      throw new TypeError(`Service provider '${contract.key}' requires a creation callback`);
    }
    return { kind: "service", key: contract.key, create: args[0] as CreateService<unknown> };
  }
  const options: ProviderOptions = typeof args[0] === "function" ? {} : args[0];
  const create = typeof args[0] === "function" ? args[0] : args[1]!;
  return { kind: "resource", key: contract.key, options, create } as const;
}

export function splitProviders(providers: readonly AnyProvider[]) {
  const resources: AnyResourceProvider[] = [];
  const services: AnyServiceProvider[] = [];
  const resourceKeys = new Set<string>();
  const serviceKeys = new Set<string>();
  for (const provider of providers) {
    const keys = provider.kind === "service" ? serviceKeys : resourceKeys;
    if (keys.has(provider.key)) throw new Error(`Duplicate provider '${provider.key}'`);
    keys.add(provider.key);
    if (provider.kind === "service") services.push(provider);
    else resources.push(provider);
  }
  return { resources, services };
}

