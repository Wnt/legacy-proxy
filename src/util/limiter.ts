// Per-key concurrency limit with a bounded wait queue. Callers over the limit
// wait their turn; once the queue is full too, run() refuses with LimitError
// instead of letting work (and the memory it holds) pile up.

export class LimitError extends Error {
  constructor() {
    super("too many concurrent requests");
  }
}

export class KeyedLimiter {
  private running = new Map<string, number>();
  private queues = new Map<string, Array<() => void>>();

  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
  ) {}

  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new LimitError();
    if ((this.running.get(key) ?? 0) >= this.limit) {
      const queue = this.queues.get(key) ?? [];
      if (queue.length >= this.maxQueued) throw new LimitError();
      // The slot is handed over by release(), so the count is not bumped here.
      // An aborted caller leaves the queue without taking one.
      await new Promise<void>((resolve, reject) => {
        const entry = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const q = this.queues.get(key);
          const i = q?.indexOf(entry) ?? -1;
          if (q && i >= 0) {
            q.splice(i, 1);
            if (q.length === 0) this.queues.delete(key);
          }
          reject(new LimitError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(entry);
        this.queues.set(key, queue);
      });
    } else {
      this.running.set(key, (this.running.get(key) ?? 0) + 1);
    }
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  private release(key: string): void {
    const queue = this.queues.get(key);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.queues.delete(key);
    if (next) {
      next(); // the slot passes straight to the next caller
      return;
    }
    const n = (this.running.get(key) ?? 1) - 1;
    if (n > 0) this.running.set(key, n);
    else this.running.delete(key);
  }
}
