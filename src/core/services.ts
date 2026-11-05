import { randomUUID } from "node:crypto";
import { RpcStub, RpcTarget, type RpcCompatible } from "capnweb";
import { LifecycleScope } from "./scope.js";
import type { AnyServiceProvider } from "./provider.js";
import type { ProviderContext, ServiceContract } from "./types.js";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ServiceEntry {
  readonly dependencies = new Set<ServiceEntry>();
  readonly dependents = new Set<ServiceEntry>();
  readonly #scope: LifecycleScope;
  #initialization?: Promise<unknown>;
  #settled = false;
  #owner?: RpcStub<unknown>;
  #releasing?: Promise<void>;

  constructor(
    readonly provider: AnyServiceProvider,
    private readonly registry: ServiceRegistry,
  ) {
    this.#scope = new LifecycleScope(async (callback) => {
      try {
        await callback();
      } catch (error) {
        console.warn(
          `[test-provision] service cleanup warning: Failed to clean up service ` +
            `'${provider.key}': ${describe(error)}`,
        );
      }
    });
  }

  resolve(): Promise<unknown> {
    this.#initialization ??= Promise.resolve()
      .then(() => {
        let accepting = true;
        const context: ProviderContext = {
          id: `service:${this.provider.key}:${randomUUID()}`,
          signal: this.#scope.signal,
          onCleanup: this.#scope.onCleanup,
          getService: (declaration) => {
            if (!accepting) {
              return Promise.reject(
                new Error("Service dependencies are only available during initialization"),
              );
            }
            return this.registry.resolveFrom(this, declaration);
          },
        };
        context.signal.throwIfAborted();
        return Promise.resolve()
          .then(() => (this.provider.create as (context: ProviderContext) => unknown)(context))
          .finally(() => { accepting = false; });
      })
      .then((value) => {
        this.#scope.signal.throwIfAborted();
        return value;
      })
      .catch((error: unknown) => {
        // The initialization promise waits for this release, so do not await it here.
        void this.release(error);
        throw error;
      })
      .finally(() => { this.#settled = true; });
    return this.#initialization;
  }

  get(): Promise<unknown> {
    return this.resolve().then((value) => {
      this.#scope.signal.throwIfAborted();
      if (value instanceof RpcStub) {
        this.#owner ??= value.dup();
      } else if (value instanceof RpcTarget) {
        this.#owner ??= new RpcStub(value);
      } else if (typeof value === "function") {
        this.#owner ??= new RpcStub(value as (...args: never[]) => unknown);
      } else {
        return value;
      }
      // Retain one reference independently of client connections.
      return this.#owner.dup();
    });
  }

  abortPending(reason: unknown): void {
    if (this.#initialization && !this.#settled) this.#scope.abort(reason);
  }

  release(reason: unknown = new Error("Service runner shutting down")): Promise<void> {
    if (this.#releasing) return this.#releasing;
    const cleanup = this.#scope.release(reason);
    this.#releasing = (async () => {
      try {
        await Promise.allSettled([this.#initialization, cleanup]);
        await this.#scope.release(reason);
      } finally {
        this.#owner?.[Symbol.dispose]();
      }
    })();
    return this.#releasing;
  }
}

/** Own runner-scoped service instances and their dependency-ordered shutdown. */
export class ServiceRegistry {
  readonly #entries = new Map<string, ServiceEntry>();
  readonly #timeout: number;
  #closed = false;
  #closing?: Promise<void>;

  constructor(providers: readonly AnyServiceProvider[], shutdownTimeout = 15_000) {
    if (
      !Number.isSafeInteger(shutdownTimeout) ||
      shutdownTimeout < 1 ||
      shutdownTimeout > 2_147_483_647
    ) {
      throw new RangeError("shutdownTimeout must be an integer from 1 to 2147483647 milliseconds");
    }
    this.#timeout = shutdownTimeout;
    for (const provider of providers) {
      if (this.#entries.has(provider.key)) throw new Error(`Duplicate provider '${provider.key}'`);
      this.#entries.set(provider.key, new ServiceEntry(provider, this));
    }
  }

  #entry(key: string): ServiceEntry {
    if (this.#closed) throw new Error("Service provisioning has stopped");
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Service '${key}' is not registered`);
    return entry;
  }

  resolve<Result extends RpcCompatible<Result>>(declaration: ServiceContract<Result>): Promise<Result> {
    if (declaration?.kind !== "service") {
      return Promise.reject(new TypeError("getService() requires a service declaration"));
    }
    try {
      return this.#entry(declaration.key).resolve() as Promise<Result>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  resolveFrom<Result extends RpcCompatible<Result>>(
    source: ServiceEntry,
    declaration: ServiceContract<Result>,
  ): Promise<Result> {
    if (declaration?.kind !== "service") {
      return Promise.reject(new TypeError("getService() requires a service declaration"));
    }
    try {
      const target = this.#entry(declaration.key);
      if (!source.dependencies.has(target)) {
        const path = this.#path(target, source);
        if (path) {
          throw new Error(
            `Circular service dependency: ${[source, ...path].map((entry) => entry.provider.key).join(" -> ")}`,
          );
        }
        source.dependencies.add(target);
        target.dependents.add(source);
      }
      return target.resolve() as Promise<Result>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #path(
    from: ServiceEntry,
    to: ServiceEntry,
    seen = new Set<ServiceEntry>(),
  ): ServiceEntry[] | undefined {
    if (from === to) return [from];
    if (seen.has(from)) return undefined;
    seen.add(from);
    for (const next of from.dependencies) {
      const path = this.#path(next, to, seen);
      if (path) return [from, ...path];
    }
  }

  get(key: string): Promise<unknown> {
    return this.#entry(key).get();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const reason = new Error("Service runner shutting down");
    for (const entry of this.#entries.values()) entry.abortPending(reason);

    const scheduled = new Map<ServiceEntry, Promise<void>>();
    const release = (entry: ServiceEntry): Promise<void> => {
      const existing = scheduled.get(entry);
      if (existing) return existing;
      const work = Promise.all([...entry.dependents].map(release)).then(() => entry.release(reason));
      scheduled.set(entry, work);
      return work;
    };
    const releases = Promise.all([...this.#entries.values()].map(release));
    this.#closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const completed = await Promise.race([
          releases.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), this.#timeout);
          }),
        ]);
        if (!completed) {
          console.warn(
            `[test-provision] service cleanup warning: Service cleanup timed out after ${this.#timeout}ms`,
          );
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return this.#closing;
  }
}
