// Work several requests wait for at once (a full-text SEARCH, the account's
// LIST-STATUS, the thread rows' scan), with a lifetime of its own.
//
// Each waiting request is counted. One that is abandoned stops waiting at
// once; the work runs on for the others. When nobody waits any more it may
// run on for a grace (`graceMs`, for a client that asks again at once), and
// is then stopped through its own signal. Results the work produces should be
// filed by the work itself, not by its waiters, so a result that arrives with
// nobody waiting still counts.
import { checkAborted, RequestAbortedError } from "../imap/abort.js";

export interface SharedTask<T> {
  promise: Promise<T>;
  stop: AbortController;
  waiters: number;
  settled: boolean;
  idle?: ReturnType<typeof setTimeout>;
}

export type SharedTasks<T> = Map<string, SharedTask<T>>;

/**
 * Wait for the task `key` in `tasks`, starting it with `run` if none runs.
 *
 * `onCallerConnection`: `run` uses the caller's own connection, which is busy
 * with it until it settles. A caller that started such a task waits for it to
 * settle even when its own request is abandoned, then throws: it never hands
 * back a connection with the work still on it.
 */
export function joinShared<T>(
  tasks: SharedTasks<T>,
  key: string,
  run: (stop: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  opts: { onCallerConnection?: boolean; graceMs: number },
): Promise<T> {
  checkAborted(signal);
  let task = tasks.get(key);
  const started = !task;
  if (!task) {
    const t: SharedTask<T> = { promise: null as never, stop: new AbortController(), waiters: 0, settled: false };
    t.promise = run(t.stop.signal).finally(() => {
      t.settled = true;
      clearTimeout(t.idle);
      if (tasks.get(key) === t) tasks.delete(key);
    });
    // Every waiter handles the outcome; with none left it must not go unhandled.
    t.promise.catch(() => {});
    tasks.set(key, t);
    task = t;
  }
  const t = task;
  t.waiters++;
  clearTimeout(t.idle);
  t.idle = undefined;
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    if (--t.waiters > 0 || t.settled) return;
    const stop = () => {
      if (t.waiters > 0 || t.settled) return;
      // A later caller starts afresh rather than joining work being stopped.
      if (tasks.get(key) === t) tasks.delete(key);
      t.stop.abort();
    };
    if (opts.graceMs <= 0) return stop();
    t.idle = setTimeout(stop, opts.graceMs);
    t.idle.unref?.();
  };
  if (!signal) return t.promise.finally(leave);
  if (started && opts.onCallerConnection) {
    signal.addEventListener("abort", leave, { once: true });
    return t.promise
      .finally(() => {
        signal.removeEventListener("abort", leave);
        leave();
      })
      .then((v) => {
        checkAborted(signal);
        return v;
      });
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      leave();
      reject(new RequestAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    t.promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        leave();
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        leave();
        reject(e);
      },
    );
  });
}

/** Requests waiting, over all tasks of `tasks` (tests). */
export function sharedWaiters(tasks: SharedTasks<unknown>): number {
  let n = 0;
  for (const t of tasks.values()) n += t.waiters;
  return n;
}
