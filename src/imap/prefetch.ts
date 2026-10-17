// Warm the caches for messages a user is about to open: new INBOX mail (the
// IDLE worker) and the top of the INBOX list (Email/query). Fills what an
// open's Email/get needs -- envelope, structure, the full header block,
// preview (email_cache) and the text body parts (body_cache) -- so opening
// one costs a flags FETCH instead of four round trips to the server.
// Runs in the background on a bulk connection, one batch per account at a
// time, and only reads (BODY.PEEK): nothing is marked seen.
import type { Store, AccountRow } from "../state/store.js";
import type { ImapPool } from "./pool.js";
import { decodeEmailId } from "../mapping/ids.js";
import { selectedUidValidity, withMailbox } from "./client.js";
import { fetchEmailsBatch } from "./fetcher.js";
import { log } from "../util/log.js";

// At most this many messages per prefetch call (the newest first, as given).
export const PREFETCH_MAX = 20;
// Ids recently warmed (or being warmed), so repeated list loads cost nothing.
const RECENT_MAX = 5000;
const recent = new Set<string>();
const queues = new Map<number, Promise<void>>();

function remember(id: string): void {
  recent.delete(id);
  recent.add(id);
  if (recent.size <= RECENT_MAX) return;
  for (const k of recent) {
    recent.delete(k);
    if (recent.size <= RECENT_MAX) break;
  }
}

/** Queue a background warm-up of `emailIds` (the first PREFETCH_MAX not done recently). */
export function prefetchEmails(pool: ImapPool, store: Store, account: AccountRow, emailIds: string[]): void {
  const groups = new Map<number, { uidvalidity: number; uids: number[] }[]>();
  let n = 0;
  for (const id of emailIds) {
    if (n >= PREFETCH_MAX) break;
    if (recent.has(id)) continue;
    let p;
    try {
      p = decodeEmailId(id);
    } catch {
      continue;
    }
    if (p.accountIdx !== account.id) continue;
    remember(id);
    n++;
    const list = groups.get(p.mailboxIdx) ?? [];
    let g = list.find((x) => x.uidvalidity === p.uidvalidity);
    if (!g) list.push((g = { uidvalidity: p.uidvalidity, uids: [] }));
    g.uids.push(p.uid);
    groups.set(p.mailboxIdx, list);
  }
  if (n === 0) return;
  const prev = queues.get(account.id) ?? Promise.resolve();
  const next = prev.then(() => run(pool, store, account, groups, n)).catch(() => {});
  queues.set(account.id, next);
  void next.finally(() => {
    if (queues.get(account.id) === next) queues.delete(account.id);
  });
}

async function run(
  pool: ImapPool,
  store: Store,
  account: AccountRow,
  groups: Map<number, { uidvalidity: number; uids: number[] }[]>,
  n: number,
): Promise<void> {
  const t0 = Date.now();
  try {
    for (const [mailboxIdx, epochs] of groups) {
      const row = store.prep(`SELECT * FROM mailbox WHERE id = ? AND account_id = ?`).get(mailboxIdx, account.id) as
        | { id: number; name: string; uidvalidity: number; highest_modseq: number }
        | undefined;
      if (!row) continue;
      await pool.withConnection(account, "bulk", (client) =>
        withMailbox(client, row.name, async () => {
          const liveUv = selectedUidValidity(client);
          const uids = epochs.filter((e) => e.uidvalidity === liveUv).flatMap((e) => e.uids);
          if (liveUv === null || uids.length === 0) return;
          const mailboxArg = {
            ...row, uidvalidity: liveUv, account_id: account.id, parent_id: null, delim: "/", role: null,
            special_use: null, total: 0, unread: 0, subscribed: 0, last_seen: 0,
          } as never;
          // What an open asks for: every text part (at the default value cap),
          // the full header block, the preview.
          await fetchEmailsBatch(client, account, mailboxArg, uids,
            { fetchAllBodyValues: true, needsFullHeaders: true, wantsPreview: true }, store);
        }),
      );
    }
    log.info({ accountId: account.id, messages: n, ms: Date.now() - t0 }, "prefetch done");
  } catch (e) {
    log.warn({ accountId: account.id, err: (e as Error).message }, "prefetch failed");
  }
}
