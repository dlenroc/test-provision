import type { AnyProvider } from "./provider.js";
import type { RpcCompatible, RpcPromise } from "capnweb";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonSafe<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends Date | RegExp | Promise<unknown> | Map<unknown, unknown> | Set<unknown>
    ? never
    : T extends string | boolean | number | null
      ? T
      : T extends readonly unknown[]
        ? { [K in keyof T]: JsonSafe<T[K]> }
        : T extends object
          ? { [K in keyof T]: JsonSafe<T[K]> }
          : never;

type Received<T> = T extends RpcCompatible<T> ? Awaited<RpcPromise<{ value: T }>>["value"] : never;

declare const brand: unique symbol;

/** A resource request with an alias and input for `needs()`. */
type ResourceRequest<Input = unknown, Result = unknown> = {
  readonly key: string;
  readonly alias: string;
  readonly input: DeepReadonly<Input>;
  readonly [brand]: Result;
};

type Declaration<Kind extends "resource" | "service", Result> = {
  readonly kind: Kind;
  readonly key: string;
  readonly [brand]: Result;
};

/** A callable declaration that creates requests for `needs()`. */
export type ResourceContract<Input, Result> = Declaration<"resource", Result> & {
  /**
   * Request a resource under an alias. Input is serialized into test metadata.
   *
   * @throws
   * A {@link TypeError} if the alias is empty.
   */
  (alias: string, input: Input): ResourceRequest<Input, Result>;
};

/** A declaration for one lazily initialized service per runner. */
export type ServiceContract<Result extends RpcCompatible<Result>> = Declaration<"service", Result>;

/**
 * The result type of `prepared()` for resources and services.
 *
 * @example
 * ```ts
 * type PreparedUser = Prepared<typeof user>
 * ```
 */
export type Prepared<C extends { readonly [brand]: unknown }> = C extends ServiceContract<infer Result>
  ? RpcPromise<Result>
  : Received<C[typeof brand]>;

/**
 * Access resources declared through `needs()` or runner-owned services.
 * Resources return prepared values synchronously. Services need no `needs()`;
 * their promises support method calls before initialization finishes.
 *
 * @example
 * ```ts
 * const account = prepared(alice)
 * const sameAccount = prepared(user, 'alice')
 * const stored = await prepared(accounts).getUser(account.id)
 * ```
 *
 * @throws
 * A {@link TypeError} for a missing or mismatched resource alias.
 *
 * @throws
 * An {@link Error} if a resource was not declared or prepared.
 */
export type Accessor = {
  <Result extends RpcCompatible<Result>>(service: ServiceContract<Result>): RpcPromise<Result>;
  <Result>(request: ResourceRequest<unknown, Result>): Received<Result>;
  <Input, Result>(resource: ResourceContract<Input, Result>, alias: string): Received<Result>;
};

type Requirements = Record<string, { key: string; input: Json }>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type PreparedFixture = {
  /** Access prepared resources or shared services. */
  prepared: Accessor;
};

export type FixtureOptions = {
  /**
   * Resource preparation and fixture teardown timeout in milliseconds, separate
   * from the test-body timeout.
   * Defaults to `0`, which disables the deadline.
   */
  timeout?: number | undefined;
};

/** Creation context for a resource allocation or runner-owned service. */
export type ProviderContext = {
  /** Aborted when creation fails or the allocation or service is released. */
  signal: AbortSignal;

  /** Unique per provider invocation. */
  id: string;

  /**
   * Register cleanup for acquired resources or services. Callbacks registered
   * before cleanup starts run once in reverse order; async callbacks are
   * awaited without delaying the next test. Cleanup can start while creation
   * is still in progress. Late registrations also run, but cannot be ordered
   * before callbacks that have already finished. Return values are ignored.
   */
  onCleanup(cleanup: () => unknown): void;

  /**
   * Resolve a runner-owned service to its initialized value.
   * Resource providers can call this during creation; service providers only
   * during initialization. Circular service dependencies reject.
   */
  getService<Result extends RpcCompatible<Result>>(declaration: ServiceContract<Result>): Promise<Result>;
};

export type ProviderOptions = {
  /**
   * Maximum simultaneous creations for this provider. Cleanup does not count.
   * Must be a positive integer or `Infinity`. Defaults to `Infinity`.
   */
  concurrency?: number | undefined;

  /**
   * Limit creation starts within a rolling window. Cleanup is not rate-limited.
   * Waiting for a window uses no creation slot. Omit for no rate limit.
   */
  rateLimit?:
    | {
        /** Maximum creation starts per interval. Must be a positive integer. */
        limit: number;
        /** Rolling interval in milliseconds. Must be a positive integer. */
        interval: number;
      }
    | undefined;
};

export type ProvisionOptions = {
  /** Shared resource creation limits; cleanup does not count. */
  concurrency?:
    | {
        /**
         * Maximum simultaneous creations, including prefetching.
         * Must be a positive integer or `Infinity`. Defaults to `Infinity`.
         */
        total?: number | undefined;

        /**
         * Maximum simultaneous creations for upcoming attempts.
         * `0` disables prefetch.
         * Defaults to 2, reduced to `total - 1` when smaller.
         *
         * Must be a nonnegative integer no greater than `total`, or `Infinity`
         * if `total` is unlimited.
         * Running tests take priority; active creations are not interrupted.
         */
        prefetch?: number | undefined;
      }
    | undefined;

  /**
   * Shutdown wait for unfinished creation and cleanup, in milliseconds.
   * Defaults to 15000. Must be an integer from 1 to 2147483647.
   * Expiry reports a cleanup warning; unfinished operations may continue.
   */
  shutdownTimeout?: number | undefined;

  /** Resource and service providers. Keys must be unique within each kind. */
  providers: readonly AnyProvider[];

  /**
   * Prepare resources ahead of retries after a failure. Defaults to `false`.
   * With `concurrency.prefetch: 0`, retries create resources on demand.
   */
  prefetchRetries?: boolean | undefined;

  /** Server bind address. Defaults to `"127.0.0.1"` (loopback). */
  listenHost?: string | undefined;

  /** Host sent to test workers and browsers. Defaults to `listenHost`. */
  advertiseHost?: string | undefined;
};

export type { ResourceRequest, Requirements, DeepReadonly };
