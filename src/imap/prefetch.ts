// Warm the caches for messages a user is about to open: new INBOX mail (the
// IDLE worker) and the top of the INBOX list (Email/query). Fills what an
// open's Email/get needs -- envelope, structure, the full header block,
// preview (email_cache) and the text body parts (body_cache) -- so opening
// one costs a flags FETCH instead of four round trips to the server.
// Runs in the background on a bulk connection, one batch per account at a
// time, and only reads (BODY.PEEK): nothing is marked seen.
//
// A conversation open (Thread/get + Email/get of every member) also reads the
// thread's other copies -- the Sent copy of a message sent to oneself, our own
// reply filed in Sent, a copy in another folder -- so those are warmed after
// the messages themselves (warmSiblings), within the bounds below.
import type { ImapFlow } from "imapflow";
import type { Store, AccountRow } from "../state/store.js";
import type { ImapPool } from "./pool.js";
import { decodeEmailId } from "../mapping/ids.js";
import { selectedUidValidity, withMailbox } from "./client.js";
import { fetchEmailsBatch } from "./fetcher.js";
import { syncThreadRows, threadIdsOf, threadMemberIds } from "../jmap/methods/threads.js";
import { log } from "../util/log.js";

// At most this many messages per prefetch call (the newest first, as given).
export const PREFETCH_MAX = 20;
// Thread siblings warmed per call, at most: newest first, from at most
// SIBLING_FOLDERS_MAX folders (each one a SELECT on the bulk connection), and
// only from threads of at most SIBLING_THREAD_MAX messages (a long mailing-list
// thread is not followed).
export const SIBLINGS_MAX = 10;
export const SIBLING_FOLDERS_MAX = 3;
export const SIBLING_THREAD_MAX = 25;
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

type Groups = Map<number, { uidvalidity: number; uids: number[] }[]>;

function addToGroups(groups: Groups, p: { mailboxIdx: number; uidvalidity: number; uid: number }): void {
  const list = groups.get(p.mailboxIdx) ?? [];
  let g = list.find((x) => x.uidvalidity === p.uidvalidity);
  if (!g) list.push((g = { uidvalidity: p.uidvalidity, uids: [] }));
  g.uids.push(p.uid);
  groups.set(p.mailboxIdx, list);
}

/** Queue a background warm-up of `emailIds` (the first PREFETCH_MAX not done recently) and their thread siblings. */
export function prefetchEmails(pool: ImapPool, store: Store, account: AccountRow, emailIds: string[]): void {
  const groups: Groups = new Map();
  const ids: string[] = [];
  for (const id of emailIds) {
    if (ids.length >= PREFETCH_MAX) break;
    if (recent.has(id)) continue;
    let p;
    try {
      p = decodeEmailId(id);
    } catch {
      continue;
    }
    if (p.accountIdx !== account.id) continue;
    remember(id);
    ids.push(id);
    addToGroups(groups, p);
  }
  if (ids.length === 0) return;
  const prev = queues.get(account.id) ?? Promise.resolve();
  const next = prev.then(() => run(pool, store, account, groups, ids)).catch(() => {});
  queues.set(account.id, next);
  void next.finally(() => {
    if (queues.get(account.id) === next) queues.delete(account.id);
  });
}

async function run(
  pool: ImapPool,
  store: Store,
  account: AccountRow,
  groups: Groups,
  ids: string[],
): Promise<void> {
  const t0 = Date.now();
  try {
    await warm(pool, store, account, groups);
    const siblings = await warmSiblings(pool, store, account, groups, ids);
    log.info({ accountId: account.id, messages: ids.length, siblings, ms: Date.now() - t0 }, "prefetch done");
  } catch (e) {
    log.warn({ accountId: account.id, err: (e as Error).message }, "prefetch failed");
  }
}

/**
 * Warm the other messages of the threads `ids` belong to, newest first and
 * within SIBLINGS_MAX / SIBLING_FOLDERS_MAX / SIBLING_THREAD_MAX. Only for an
 * account whose thread rows exist already (a Thread/get or collapseThreads
 * query scanned it once): bringing them up to date is then the incremental
 * row sync a Thread/get would run anyway -- one LIST-STATUS, and a header
 * FETCH in the folders that moved -- on the bulk connection. A prefetch never
 * starts an account's first full scan. Returns how many were warmed.
 */
async function warmSiblings(
  pool: ImapPool,
  store: Store,
  account: AccountRow,
  groups: Groups,
  ids: string[],
): Promise<number> {
  if (![...groups.keys()].some((mailboxIdx) => store.getMailboxScan(account.id, mailboxIdx))) return 0;
  // With the pool, the sync leases its own bulk connection; `client` is not used.
  await syncThreadRows({ account, client: null as unknown as ImapFlow, store, pool });
  const own = new Set(ids);
  const siblings: Groups = new Map();
  let n = 0;
  outer: for (const threadId of new Set(threadIdsOf(store, account.id, ids).values())) {
    const members = threadMemberIds(store, account.id, threadId);
    if (members.length < 2 || members.length > SIBLING_THREAD_MAX) continue;
    for (const id of members.slice().reverse()) {
      if (own.has(id) || recent.has(id)) continue;
      const p = decodeEmailId(id);
      if (!siblings.has(p.mailboxIdx) && siblings.size >= SIBLING_FOLDERS_MAX) continue;
      remember(id);
      addToGroups(siblings, p);
      if (++n >= SIBLINGS_MAX) break outer;
    }
  }
  if (n > 0) await warm(pool, store, account, siblings);
  return n;
}

async function warm(pool: ImapPool, store: Store, account: AccountRow, groups: Groups): Promise<void> {
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
}
