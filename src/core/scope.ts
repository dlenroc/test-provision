/** Own cancellation and registered cleanup independently of RPC references. */
export class LifecycleScope {
  readonly #controller = new AbortController();
  readonly #callbacks: (() => unknown)[] = [];
  #released = false;
  #draining: Promise<void> | undefined;

  constructor(private readonly run: (cleanup: () => unknown) => Promise<void>) {}

  get signal() {
    return this.#controller.signal;
  }

  readonly onCleanup = (cleanup: () => unknown): void => {
    this.#callbacks.push(cleanup);
    if (this.#released) this.#drain();
  };

  abort(reason: unknown): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
  }

  async release(reason: unknown = new Error("Resource allocation released")) {
    this.#released = true;
    this.abort(reason);
    this.#drain();
    while (this.#draining) await this.#draining;
  }

  #drain(): void {
    if (this.#draining || !this.#callbacks.length) return;
    const work = (async () => {
      while (this.#callbacks.length) await this.run(this.#callbacks.pop()!);
    })();
    this.#draining = work;
    void work.then(() => {
      this.#draining = undefined;
      // A registration may arrive after the loop completed but before this continuation.
      this.#drain();
    });
  }
}
