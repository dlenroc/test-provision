import { LifecycleScope } from "./scope.js";
import type { Json } from "./types.js";

function deferred<T>() {
  const result = Promise.withResolvers<T>();
  void result.promise.catch(() => {});
  return result;
}

export type Pool = {
  key: string;
  input: Json;
  failure?: { error: unknown };
  creating: Set<Work>;
  ready: Set<Work>;
  readonly available: number;
};

type Slot = {
  readonly pool: Pool;
  readonly owner: Attempt;
  readonly alias: string;
  work?: Work;
};

/** One authoritative fixture execution. Forecasts never create attempts. */
export class Attempt {
  readonly #slots = new Map<string, Slot>();
  readonly #pending = new Set<Slot>();
  readonly #completion = deferred<void>();
  #failure: { slot: Slot; error: unknown } | undefined;
  #state: "preparing" | "delivered" | "released-unused" | "released-delivered" = "preparing";
  #releasing: Promise<void> | undefined;

  constructor(
    readonly testId: string,
    requirements: ReadonlyMap<string, Pool>,
    readonly admissionIndex: number,
  ) {
    for (const [alias, pool] of requirements) {
      const slot = { pool, owner: this, alias };
      this.#slots.set(alias, slot);
      this.#pending.add(slot);
    }
    if (!this.#pending.size) this.#completion.resolve();
  }

  get slots(): ReadonlyMap<string, Slot> {
    return this.#slots;
  }
  get failure() {
    return this.#failure;
  }
  get delivered() {
    return this.#state === "delivered" || this.#state === "released-delivered";
  }
  get closed() {
    return this.#state === "released-unused" || this.#state === "released-delivered";
  }
  get readyCount() {
    return this.#slots.size - this.#pending.size;
  }

  resolve(slot: Slot): void {
    if (this.closed || !this.#pending.delete(slot)) return;
    if (!this.#pending.size) this.#completion.resolve();
  }

  fail(slot: Slot, error: unknown): void {
    if (this.closed || this.#failure || !this.#pending.has(slot)) return;
    this.#failure = { slot, error };
    this.#completion.reject(error);
  }

  async ready() {
    if (this.closed && !this.#failure) throw new Error("Resource preparation cancelled");
    try {
      if (this.#failure) throw this.#failure.error;
      await this.#completion.promise;
      if (this.closed) throw new Error("Resource preparation cancelled");
      this.#state = "delivered";
      return {
        values: Object.fromEntries(
          [...this.#slots].map(([alias, slot]) => [alias, slot.work!.value]),
        ),
      };
    } catch (error) {
      const failed = this.#failure;
      throw failed
        ? new Error(
            `Failed to prepare resource '${failed.slot.alias}' (provider '${failed.slot.pool.key}')`,
            { cause: failed.error },
          )
        : error;
    }
  }

  finish(release: (delivered: boolean) => Promise<void>): Promise<void> {
    if (this.#releasing) return this.#releasing;
    const completion = deferred<void>();
    this.#releasing = completion.promise;
    const delivered = this.delivered;
    this.#state = delivered ? "released-delivered" : "released-unused";
    this.#completion.reject(new Error("Resource preparation cancelled"));
    try {
      release(delivered).then(completion.resolve, completion.reject);
    } catch (error) {
      completion.reject(error);
    }
    return this.#releasing;
  }
}

/** One provider creation, independent of the test currently requesting its result. */
export class Work {
  readonly #scope: LifecycleScope;
  #slot: Slot | undefined;
  #state: "running" | "ready" | "failed" | "abandoned" = "running";
  #value: unknown;
  #error: unknown;
  #creation: Promise<void> | undefined;
  #releasing: Promise<void> | undefined;

  constructor(
    readonly pool: Pool,
    cleanup: (callback: () => unknown) => Promise<void>,
  ) {
    this.#scope = new LifecycleScope(cleanup);
  }

  get slot() {
    return this.#slot;
  }
  get state() {
    return this.#state;
  }
  get value() {
    return this.#value;
  }
  get error() {
    return this.#error;
  }
  get signal() {
    return this.#scope.signal;
  }
  get onCleanup() {
    return this.#scope.onCleanup;
  }

  assign(slot: Slot | undefined): void {
    const previous = this.#slot;
    if (previous === slot) return;
    if (
      this.#state === "abandoned" ||
      previous?.owner.delivered ||
      (previous && this.#state === "failed" && previous.owner !== slot?.owner) ||
      (slot && (slot.owner.closed || slot.work || slot.pool !== this.pool))
    )
      throw new Error("Resource work cannot change ownership");
    if (previous) delete previous.work;
    this.#slot = slot;
    if (slot) {
      slot.work = this;
      if (this.#state === "ready") slot.owner.resolve(slot);
      else if (this.#state === "failed") slot.owner.fail(slot, this.#error);
    }
  }

  start(create: () => unknown, settled: () => void): Promise<void> {
    if (this.#creation) throw new Error("Resource creation has already started");
    this.#creation = Promise.resolve()
      .then(create)
      .then(
        (value) => {
          if (this.#state === "abandoned") return;
          this.#state = "ready";
          this.#value = value;
          if (this.#slot) this.#slot.owner.resolve(this.#slot);
          settled();
        },
        (error) => {
          if (this.#state === "abandoned") return;
          this.#state = "failed";
          this.#error = error;
          if (this.#slot) this.#slot.owner.fail(this.#slot, error);
          settled();
        },
      );
    return this.#creation;
  }

  cleanup(reason?: unknown): Promise<void> {
    return this.#scope.release(reason);
  }

  release(): Promise<void> {
    if (this.#releasing) return this.#releasing;
    const reason = new Error(
      this.#state === "ready" ? "Resource allocation released" : "Resource preparation cancelled",
    );
    this.#state = "abandoned";
    const cleanup = this.#scope.release(reason);
    this.#releasing = (async () => {
      // Creation may ignore cancellation and register cleanup before it settles.
      await Promise.allSettled([this.#creation, cleanup]);
      await this.#scope.release(reason);
    })();
    return this.#releasing;
  }
}

export type { Slot };
