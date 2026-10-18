// Request budgets running out, and requests whose client went away.
//
// A check between results only stops work that is still producing results:
// an IMAP command the server has stopped answering (a stalled FETCH, a long
// SEARCH) never yields the next result to check at. `abortable` closes the
// connection when the request is abandoned while such a command is on it,
// which rejects the command and unwinds whatever awaits it; the closed
// connection then leaves the pool when its lease is released.
import type { ImapFlow } from "imapflow";

/** A RequestBudgets allowance ran out (or the request was abandoned). */
export class BudgetExceededError extends Error {}

/** The request's client went away; its remaining work stops. */
export class RequestAbortedError extends BudgetExceededError {
  constructor() {
    super("request aborted by the client");
  }
}

export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RequestAbortedError();
}

/**
 * Run `op`, IMAP commands on `client`. If `signal` fires before `op` settles,
 * the connection is closed so a command the server is not answering unwinds,
 * and `op` is awaited (not raced) before the cancellation is thrown: when
 * this returns, nothing of `op` still runs on the connection. A result `op`
 * returns after that is dropped too: imapflow answers some commands cut off
 * by the close with an empty value rather than an error.
 */
export async function abortable<T>(client: ImapFlow, signal: AbortSignal | undefined, op: () => Promise<T>): Promise<T> {
  if (!signal) return op();
  checkAborted(signal);
  const onAbort = () => client.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await op();
    checkAborted(signal);
    return result;
  } catch (e) {
    // The close (or the cancellation itself) is what ended `op`.
    if (signal.aborted) throw e instanceof RequestAbortedError ? e : new RequestAbortedError();
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
