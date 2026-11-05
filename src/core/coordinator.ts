import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import hashObject from "hash-object";
import { Attempt, Work, type Slot, type Pool } from "./allocation.js";
import { Demand } from "./demand.js";
import type { AnyResourceProvider } from "./provider.js";
import type { ProviderContext, ProvisionOptions, Requirements, Json } from "./types.js";

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
type Waiter = (outcome: Outcome) => void;
// Cancelled waits must not accumulate reactions on runner-lived service promises.
const pendingWaiters = new WeakMap<Promise<unknown>, Set<Waiter>>();

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let waiters = pendingWaiters.get(operation);
  if (!waiters) {
    const observers = new Set<Waiter>();
    waiters = observers;
    pendingWaiters.set(operation, observers);
    const notify = (outcome: Outcome) => {
      pendingWaiters.delete(operation);
      for (const waiter of observers) waiter(outcome);
      observers.clear();
    };
    void operation.then(
      (value) => notify({ ok: true, value }),
      (error: unknown) => notify({ ok: false, error }),
    );
  }
  const subscribers = waiters;
  return new Promise<T>((resolve, reject) => {
    const onResult: Waiter = (outcome) => {
      listener[Symbol.dispose]();
      if (outcome.ok) resolve(outcome.value as T);
      else reject(outcome.error);
    };
    subscribers.add(onResult);
    const listener = addAbortListener(signal, () => {
      subscribers.delete(onResult);
      reject(signal.reason);
    });
  });
}

export type TestForecast = { testId: string; requirements: Requirements };
function cleanupMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  return cause === undefined
    ? error.message
    : `${error.message}: ${cause instanceof Error ? cause.message : String(cause)}`;
}

type ProviderState = {
  provider: AnyResourceProvider;
  max: number;
  running: number;
  rate?: { limit: number; interval: number; starts: number[] } | undefined;
  pending: Set<Pool>;
};

/** Schedule preparation while fixtures alone own actual attempts. */
export class Coordinator {
  readonly #providers = new Map<string, ProviderState>();
  readonly #pendingProviders = new Set<ProviderState>();
  readonly #pools = new Map<string, Pool>();
  readonly #demand = new Demand();
  readonly #inventoryChanged = new Set<Pool>();
  readonly #waiting = new Map<Attempt, Map<string, Set<Slot>>>();
  readonly #attempts = new Set<Attempt>();
  readonly #running = new Set<Promise<void>>();
  readonly #cleanupTasks = new Set<Promise<void>>();
  readonly #runId = randomUUID();
  readonly #totalLimit: number;
  readonly #prefetchLimit: number;
  readonly #shutdownTimeout: number;
  readonly #prefetching = new Set<Work>();
  #pumping = false;
  #closed = false;
  #closing?: Promise<void>;
  #serial = 0;
  #admissions = 0;
  #rateTimer: ReturnType<typeof setTimeout> | undefined;
  #rateWakeAt = Infinity;

  constructor(
    providers: readonly AnyResourceProvider[],
    options: Pick<ProvisionOptions, "concurrency" | "shutdownTimeout"> = {},
    private readonly resolveService?: ProviderContext["getService"],
  ) {
    const total = options.concurrency?.total ?? Infinity;
    const prefetch = options.concurrency?.prefetch ?? Math.min(2, Math.max(0, total - 1));
    if (!(total === Infinity || (Number.isInteger(total) && total >= 1))) {
      throw new RangeError("concurrency.total must be a positive integer or Infinity");
    }
    if (
      !(prefetch === Infinity || (Number.isInteger(prefetch) && prefetch >= 0)) ||
      prefetch > total
    ) {
      throw new RangeError(
        "concurrency.prefetch must be a nonnegative integer " + "no greater than concurrency.total",
      );
    }
    const shutdownTimeout = options.shutdownTimeout ?? 15_000;
    if (
      !Number.isSafeInteger(shutdownTimeout) ||
      shutdownTimeout <= 0 ||
      shutdownTimeout > 2_147_483_647
    ) {
      throw new RangeError("shutdownTimeout must be an integer from 1 to 2147483647 milliseconds");
    }
    this.#totalLimit = total;
    this.#prefetchLimit = prefetch;
    this.#shutdownTimeout = shutdownTimeout;
    for (const entry of providers) {
      if (this.#providers.has(entry.key)) {
        throw new Error(`Duplicate provider '${entry.key}'`);
      }
      const max = entry.options.concurrency ?? Infinity;
      if (!(max === Infinity || (Number.isInteger(max) && max >= 1))) {
        throw new RangeError(
          `Provider '${entry.key}' concurrency must be a positive integer ` + "or Infinity",
        );
      }
      const rate = entry.options.rateLimit;
      if (
        rate &&
        (!Number.isInteger(rate.limit) ||
          rate.limit < 1 ||
          !Number.isInteger(rate.interval) ||
          rate.interval < 1)
      ) {
        throw new RangeError(
          `Provider '${entry.key}' rateLimit.limit and ` +
            "rateLimit.interval must be positive integers",
        );
      }
      this.#providers.set(entry.key, {
        provider: entry,
        max,
        running: 0,
        rate: rate ? { limit: rate.limit, interval: rate.interval, starts: [] } : undefined,
        pending: new Set(),
      });
    }
  }

  #intern(key: string, input: Json): Pool {
    const hash = hashObject({ key, input }, { algorithm: "sha256" });
    let pool = this.#pools.get(hash);
    if (!pool) {
      pool = {
        key,
        input,
        creating: new Set(),
        ready: new Set(),
        get available() {
          return this.creating.size + this.ready.size;
        },
      };
      if (!this.#providers.has(key)) {
        pool.failure = { error: new Error(`No provider registered for resource '${key}'`) };
      }
      this.#pools.set(hash, pool);
    }
    return pool;
  }

  #resolveRequirements(requirements: Requirements): Map<string, Pool> {
    return new Map(
      Object.entries(requirements).map(([alias, { key, input }]) => [
        alias,
        this.#intern(key, input),
      ]),
    );
  }

  #touch(pool: Pool): void {
    this.#inventoryChanged.add(pool);
    this.#demand.inventoryChanged(pool);
  }

  registerForecasts(plans: Iterable<TestForecast>): void {
    if (this.#closed) return;
    for (const { testId, requirements } of plans) {
      this.#demand.register(testId, this.#resolveRequirements(requirements));
    }
  }

  scheduleForecasts(plans: Iterable<TestForecast>): void {
    this.registerForecasts(plans);
    this.#pump();
  }

  reconcileForecasts(previous: Iterable<string>, plans: Iterable<TestForecast>): void {
    if (this.#closed) return;
    this.#demand.reconcile(
      previous,
      new Map(
        [...plans].map(({ testId, requirements }) => [
          testId,
          this.#resolveRequirements(requirements),
        ]),
      ),
    );
    this.#pump();
  }

  /** Starting tests add urgency without reserving work or creating slots. */
  activate(testId: string, attempt = 0, requirements?: Requirements): void {
    if (this.#closed) return;
    if (requirements)
      this.#demand.reconcile([], new Map([[testId, this.#resolveRequirements(requirements)]]));
    this.#demand.activate(testId, attempt);
    this.#pump();
  }

  finish(testId: string, attempt?: number): void {
    this.#demand.finish(testId, attempt);
    this.#pump();
  }

  prefetchRetry(testId: string, attempt: number): void {
    if (this.#closed) return;
    this.#demand.retry(testId, attempt);
    this.#pump();
  }

  stopForecasts(): void {
    this.#demand.stop();
    this.#pump();
  }

  #queue(slot: Slot): void {
    let waiting = this.#waiting.get(slot.owner);
    if (!waiting) {
      waiting = new Map();
      this.#waiting.set(slot.owner, waiting);
    }
    let slots = waiting.get(slot.pool.key);
    if (!slots) {
      slots = new Set();
      waiting.set(slot.pool.key, slots);
    }
    slots.add(slot);
  }

  #dequeue(slot: Slot): void {
    const waiting = this.#waiting.get(slot.owner);
    const slots = waiting?.get(slot.pool.key);
    if (!slots) return;
    slots.delete(slot);
    if (!slots.size) waiting!.delete(slot.pool.key);
    if (!waiting!.size) this.#waiting.delete(slot.owner);
  }

  #claim(slot: Slot, work: Work): void {
    const pool = slot.pool;
    pool.ready.delete(work);
    pool.creating.delete(work);
    this.#prefetching.delete(work);
    this.#dequeue(slot);
    work.assign(slot);
    this.#touch(pool);
  }

  #take(slot: Slot): void {
    const pool = slot.pool;
    const work = pool.ready.values().next().value ?? pool.creating.values().next().value;
    if (work) this.#claim(slot, work);
    else if (pool.failure) slot.owner.fail(slot, pool.failure.error);
    else this.#queue(slot);
  }

  #priority(attempt: Attempt): number {
    const total = attempt.slots.size;
    const ready = attempt.readyCount;
    const remaining = total - ready;
    if (!remaining) return 0;
    return (
      Math.floor(100 / remaining) +
      Math.floor((30 * ready) / total) +
      (this.#admissions - attempt.admissionIndex - 1) * 8
    );
  }

  #matchWaiting(): void {
    while (true) {
      let selected: Slot | undefined;
      let best = -Infinity;
      for (const [attempt, waiting] of this.#waiting) {
        if (attempt.closed || attempt.failure) continue;
        const priority = this.#priority(attempt);
        if (priority <= best) continue;
        for (const slots of waiting.values())
          for (const slot of slots) {
            if (!slot.pool.available) continue;
            selected = slot;
            best = priority;
            break;
          }
      }
      if (!selected) return;
      this.#take(selected);
    }
  }

  #updatePending(pool: Pool): void {
    const state = this.#providers.get(pool.key);
    if (!state) return;
    if (!pool.failure && this.#demand.count(pool) > pool.available) {
      state.pending.add(pool);
      this.#pendingProviders.add(state);
    } else {
      state.pending.delete(pool);
      if (!state.pending.size) this.#pendingProviders.delete(state);
    }
  }

  #trim(pool: Pool): void {
    while (pool.available > this.#demand.count(pool)) {
      // Keep completed successes; cancel unfinished surplus first.
      const work = pool.creating.values().next().value ?? pool.ready.values().next().value!;
      pool.creating.delete(work);
      pool.ready.delete(work);
      this.#abandon(work);
    }
    this.#updatePending(pool);
  }

  #sync(): void {
    if (this.#inventoryChanged.size) this.#matchWaiting();
    for (const pool of this.#demand.changes()) this.#inventoryChanged.add(pool);
    for (const pool of this.#inventoryChanged) this.#trim(pool);
    this.#inventoryChanged.clear();
  }

  #speculativeCount(): number {
    let promoted = 0;
    for (const pool of this.#demand.urgent) {
      promoted += Math.min(
        pool.creating.size,
        Math.max(0, this.#demand.starting(pool) - pool.ready.size),
      );
    }
    return this.#prefetching.size - promoted;
  }

  open(testId: string, requirements: Requirements, attemptId: number) {
    if (this.#closed) throw new Error("Resource preparation has stopped");
    const resolved = this.#resolveRequirements(requirements);
    this.#demand.open(testId, attemptId, resolved);
    const attempt = new Attempt(testId, resolved, this.#admissions++);
    this.#attempts.add(attempt);
    // Claim the whole request before reconciling surplus inventory.
    for (const slot of attempt.slots.values()) this.#take(slot);
    if (attempt.failure) this.#finish(attempt);
    else this.#pump();
    return {
      ready: async () => {
        try {
          return await attempt.ready();
        } catch (error) {
          void this.#finish(attempt);
          throw error;
        }
      },
      release: () => this.#finish(attempt),
    };
  }

  #availableAt(key: string, now: number): number {
    const state = this.#providers.get(key)!;
    if (state.running >= state.max) return Infinity;
    if (state.rate) {
      const { starts, interval } = state.rate;
      while (starts.length && starts[0] + interval <= now) starts.shift();
      if (starts.length >= state.rate.limit) return starts[0] + interval;
    }
    return now;
  }

  #pump(): void {
    if (this.#closed || this.#pumping) return;
    this.#pumping = true;
    try {
      while (true) {
        this.#sync();
        if (this.#running.size >= this.#totalLimit) break;
        const now = Date.now();
        let selected: Slot | undefined;
        let best = -Infinity;
        let nextRateWake = Infinity;
        for (const [attempt, waiting] of this.#waiting) {
          if (attempt.failure || attempt.closed) continue;
          const priority = this.#priority(attempt);
          if (priority <= best) continue;
          for (const [key, slots] of waiting) {
            const availableAt = this.#availableAt(key, now);
            if (availableAt > now) {
              nextRateWake = Math.min(nextRateWake, availableAt);
              continue;
            }
            selected = slots.values().next().value;
            best = priority;
            break;
          }
        }
        if (selected) {
          this.#admit(selected.pool, selected, now);
          continue;
        }
        let urgent: Pool | undefined;
        for (const pool of this.#demand.urgent) {
          if (pool.failure || this.#demand.starting(pool) <= pool.available) continue;
          const availableAt = this.#availableAt(pool.key, now);
          if (availableAt > now) {
            nextRateWake = Math.min(nextRateWake, availableAt);
            continue;
          }
          urgent = pool;
          break;
        }
        if (urgent) {
          this.#admit(urgent, undefined, now);
          continue;
        }
        let prefetched = false;
        if (this.#speculativeCount() < this.#prefetchLimit) {
          for (const state of this.#pendingProviders) {
            const availableAt = this.#availableAt(state.provider.key, now);
            if (availableAt > now) {
              nextRateWake = Math.min(nextRateWake, availableAt);
              continue;
            }
            const pool = state.pending.values().next().value!;
            state.pending.delete(pool);
            this.#pendingProviders.delete(state);
            this.#admit(pool, undefined, now);
            if (state.pending.size) this.#pendingProviders.add(state);
            prefetched = true;
            break;
          }
        }
        if (!prefetched) {
          this.#scheduleRateWake(nextRateWake);
          break;
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  #scheduleRateWake(at: number): void {
    if (!Number.isFinite(at) || this.#closed) return;
    if (this.#rateTimer && this.#rateWakeAt <= at) return;
    if (this.#rateTimer) clearTimeout(this.#rateTimer);
    this.#rateWakeAt = at;
    this.#rateTimer = setTimeout(
      () => {
        this.#rateTimer = undefined;
        this.#rateWakeAt = Infinity;
        this.#pump();
      },
      Math.max(1, Math.min(at - Date.now(), 2_147_483_647)),
    );
  }

  #admit(pool: Pool, slot: Slot | undefined, now: number): void {
    const state = this.#providers.get(pool.key)!;
    let work: Work;
    work = new Work(pool, (cleanup) => this.#cleanup(work, cleanup));
    if (slot) {
      this.#dequeue(slot);
      work.assign(slot);
    } else {
      pool.creating.add(work);
      this.#prefetching.add(work);
      this.#touch(pool);
    }
    state.running++;
    if (state.rate) state.rate.starts.push(now);
    const id = `${this.#runId}:${this.#serial++}`;
    const creation = work
      .start(
        () => {
          // Registration erases input types; the key pairs each request with its provider.
          return (state.provider.create as (input: Json, context: ProviderContext) => unknown)(
            pool.input,
            {
              id,
              signal: work.signal,
              onCleanup: work.onCleanup,
              getService: (declaration) => {
                if (work.signal.aborted) return Promise.reject(work.signal.reason);
                if (!this.resolveService) {
                  return Promise.reject(new Error("Service provisioning is not configured"));
                }
                return waitForSignal(this.resolveService(declaration), work.signal);
              },
            },
          );
        },
        () => {
          if (work.state === "failed") {
            this.#trackCleanup(work.cleanup(work.error));
            pool.creating.delete(work);
            this.#failure(pool, work.error);
          } else if (!work.slot) {
            pool.creating.delete(work);
            pool.ready.add(work);
            this.#touch(pool);
          }
        },
      )
      .finally(() => {
        state.running--;
        this.#prefetching.delete(work);
        this.#running.delete(creation);
        this.#pump();
      });
    this.#running.add(creation);
  }

  #failure(pool: Pool, error: unknown): void {
    const first = !pool.failure;
    pool.failure ??= { error };
    this.#touch(pool);
    if (first)
      for (const waiting of this.#waiting.values()) {
        for (const slot of waiting.get(pool.key) ?? []) {
          if (slot.pool !== pool) continue;
          this.#dequeue(slot);
          slot.owner.fail(slot, pool.failure.error);
        }
      }
    this.#pump();
  }

  #finish(attempt: Attempt): Promise<void> {
    return attempt.finish(async (delivered) => {
      this.#attempts.delete(attempt);
      const returned: Work[] = [];
      for (const slot of attempt.slots.values()) {
        this.#dequeue(slot);
        const work = slot.work;
        if (!work) continue;
        if (!this.#closed && !delivered && (work.state === "running" || work.state === "ready")) {
          work.assign(undefined);
          if (work.state === "ready") work.pool.ready.add(work);
          else {
            work.pool.creating.add(work);
            this.#prefetching.add(work);
          }
          this.#touch(work.pool);
          returned.push(work);
        } else {
          this.#abandon(work);
        }
      }
      // Return the full batch before matching waiters or trimming unused work.
      this.#pump();
      for (const work of returned)
        if (work.state === "abandoned") this.#abandon(work);
    });
  }

  #abandon(work: Work): void {
    this.#trackCleanup(work.release());
  }

  #trackCleanup(work: Promise<void>): Promise<void> {
    this.#cleanupTasks.add(work);
    void work.then(
      () => this.#cleanupTasks.delete(work),
      () => this.#cleanupTasks.delete(work),
    );
    return work;
  }

  #cleanup(work: Work, cleanup: () => unknown): Promise<void> {
    return this.#trackCleanup(
      Promise.resolve()
        .then(cleanup)
        .then(
          () => {},
          (error) => {
            const slot = work.slot;
            const details = slot
              ? ` (test '${slot.owner.testId}', alias '${slot.alias}')`
              : " (unclaimed resource)";
            const failure = new Error(
              `Failed to clean up resource from provider '${work.pool.key}'${details}`,
              { cause: error },
            );
            console.warn(`[test-provision] resource cleanup warning: ${cleanupMessage(failure)}`);
          },
        ),
    );
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#shutdown(this.#shutdownTimeout));
  }

  async #shutdown(timeoutMs: number): Promise<void> {
    this.#closed = true;
    if (this.#rateTimer) clearTimeout(this.#rateTimer);
    this.#rateTimer = undefined;
    for (const attempt of this.#attempts.values()) this.#finish(attempt);
    for (const pool of this.#pools.values()) {
      for (const work of [...pool.creating, ...pool.ready]) this.#abandon(work);
      pool.creating.clear();
      pool.ready.clear();
    }
    this.#waiting.clear();
    for (const state of this.#pendingProviders) state.pending.clear();
    this.#pendingProviders.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    try {
      await Promise.race([
        (async () => {
          while (this.#running.size) await Promise.allSettled(this.#running);
          while (this.#cleanupTasks.size) await Promise.allSettled(this.#cleanupTasks);
          finished = true;
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!finished) {
      console.warn(
        `[test-provision] resource cleanup warning: Resource cleanup timed out after ${timeoutMs}ms`,
      );
    }
  }
}
