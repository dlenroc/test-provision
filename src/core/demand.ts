import type { Pool } from "./allocation.js";

type Requirements = ReadonlyMap<string, Pool>;
type Forecast = { requirements: Requirements; active: boolean; starting: boolean };
type Test = { known?: Requirements; forecasts: Map<number, Forecast>; opened: Set<number> };

/** Own predicted demand without assigning or releasing allocations. */
export class Demand {
  readonly #tests = new Map<string, Test>();
  readonly #counts = new Map<Pool, { total: number; starting: number }>();
  readonly #urgent = new Set<Pool>();
  #changed = new Set<Pool>();
  #dirty = false;
  #stopped = false;

  count(pool: Pool): number {
    return this.#counts.get(pool)?.total ?? 0;
  }
  starting(pool: Pool): number {
    return this.#counts.get(pool)?.starting ?? 0;
  }
  get urgent(): Iterable<Pool> {
    return this.#urgent;
  }

  #test(id: string): Test {
    let test = this.#tests.get(id);
    if (!test) {
      test = { forecasts: new Map(), opened: new Set() };
      this.#tests.set(id, test);
    }
    return test;
  }

  #change(forecast: Forecast, delta: 1 | -1): void {
    for (const pool of forecast.requirements.values()) {
      const count = this.#counts.get(pool) ?? { total: 0, starting: 0 };
      count.total += delta;
      if (forecast.starting) count.starting += delta;
      if (count.total) this.#counts.set(pool, count);
      else this.#counts.delete(pool);
      if (count.starting) this.#urgent.add(pool);
      else this.#urgent.delete(pool);
      this.#changed.add(pool);
      if (pool.failure) this.#dirty = true;
    }
  }

  register(testId: string, requirements: Requirements): void {
    if (this.#stopped) return;
    const test = this.#test(testId);
    if (test.known) return;
    test.known = requirements;
    const forecast = { requirements, active: true, starting: false };
    test.forecasts.set(0, forecast);
    this.#change(forecast, 1);
  }

  reconcile(previous: Iterable<string>, plans: ReadonlyMap<string, Requirements>): void {
    if (this.#stopped) return;
    for (const testId of previous) {
      if (!plans.has(testId)) this.#replace(testId);
    }
    for (const [testId, requirements] of plans) this.#replace(testId, requirements);
  }

  #replace(testId: string, requirements?: Requirements): void {
    const test = this.#test(testId);
    // Worker entry and allocations can arrive before collection telemetry.
    if (test.opened.size || test.forecasts.get(0)?.starting) return;
    if (
      test.known === requirements ||
      (test.known &&
        requirements &&
        test.known.size === requirements.size &&
        [...requirements].every(([alias, pool]) => test.known!.get(alias) === pool))
    )
      return;
    this.finish(testId);
    if (requirements) test.known = requirements;
    else delete test.known;
    if (requirements?.size) {
      const forecast = { requirements, active: true, starting: false };
      test.forecasts.set(0, forecast);
      this.#change(forecast, 1);
    }
  }

  activate(testId: string, attempt: number): void {
    if (this.#stopped) return;
    const test = this.#tests.get(testId);
    if (!test?.known?.size || test.opened.has(attempt)) return;
    let forecast = test.forecasts.get(attempt);
    if (!forecast) {
      forecast = { requirements: test.known, active: true, starting: true };
      test.forecasts.set(attempt, forecast);
      this.#change(forecast, 1);
    } else if (!forecast.starting) {
      if (forecast.active) this.#change(forecast, -1);
      forecast.starting = true;
      if (forecast.active) this.#change(forecast, 1);
      if ([...forecast.requirements.values()].some((pool) => pool.failure && pool.available))
        this.#dirty = true;
    }
  }

  open(testId: string, attempt: number, requirements: Requirements): void {
    const test = this.#test(testId);
    if (test.opened.has(attempt))
      throw new Error(`Duplicate resource allocation for '${testId}' attempt ${attempt}`);
    test.opened.add(attempt);
    test.known = requirements;
    this.finish(testId, attempt);
  }

  retry(testId: string, attempt: number): void {
    if (this.#stopped) return;
    const test = this.#tests.get(testId);
    if (
      !test?.known?.size ||
      attempt < 1 ||
      test.opened.has(attempt) ||
      test.forecasts.has(attempt)
    )
      return;
    const forecast = { requirements: test.known, active: true, starting: false };
    test.forecasts.set(attempt, forecast);
    this.#change(forecast, 1);
  }

  finish(testId: string, through = Infinity): void {
    const test = this.#tests.get(testId);
    if (!test) return;
    for (const [attempt, forecast] of test.forecasts) {
      if (attempt > through) continue;
      test.forecasts.delete(attempt);
      if (forecast.active) this.#change(forecast, -1);
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const testId of this.#tests.keys()) this.finish(testId);
  }

  inventoryChanged(pool: Pool): void {
    if (pool.failure) this.#dirty = true;
  }

  #forecasts(): Forecast[] {
    return [...this.#tests.values()].flatMap((test) => [...test.forecasts.values()]);
  }

  changes(): ReadonlySet<Pool> {
    if (this.#dirty) {
      // Failure permits only surviving work; each forecast must fit as a whole.
      const available = new Map<Pool, number>();
      const forecasts = this.#forecasts();
      for (const starting of [true, false])
        for (const forecast of forecasts) {
          if (forecast.starting !== starting) continue;
          const needed = new Map<Pool, number>();
          for (const pool of forecast.requirements.values()) {
            if (pool.failure) needed.set(pool, (needed.get(pool) ?? 0) + 1);
          }
          const active = [...needed].every(
            ([pool, count]) => count <= (available.get(pool) ?? pool.available),
          );
          if (active)
            for (const [pool, count] of needed) {
              available.set(pool, (available.get(pool) ?? pool.available) - count);
            }
          if (forecast.active === active) continue;
          forecast.active = active;
          this.#change(forecast, active ? 1 : -1);
        }
      this.#dirty = false;
    }
    const changed = this.#changed;
    this.#changed = new Set();
    return changed;
  }
}
