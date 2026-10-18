/**
 * Run `fn` over `items` with a bounded worker pool, preserving input order in
 * the returned array regardless of which items finish first.
 *
 * Used where a proxy request fans out into many independent backend round
 * trips — CardDAV multiget chunks, per-folder IMAP scans — and the serial
 * version would cost the sum of their latencies instead of the maximum. The
 * bound matters: it keeps one user's request from opening an unbounded burst
 * of work against a shared server.
 *
 * Once an item fails, no further item starts, and the call rejects with that
 * first error only after the items already running have settled: the caller
 * hears of the failure when none of the work runs any more.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (!failure) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]!);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return out;
}
