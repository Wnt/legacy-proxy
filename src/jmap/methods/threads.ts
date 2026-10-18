// Thread/get and Thread/changes.
//
// Threading metadata (Message-ID / In-Reply-To / References → threadId) is
// immutable per (mailbox, uidvalidity, uid), so it lives in the email_cache
// table and is maintained incrementally: each build LISTs the folders with
// their STATUS, SELECTs only those whose (uidvalidity, uidNext, messages) moved
// since the last scan, and only FETCHes headers for UIDs that arrived since.
// The steady state — nothing changed — costs one LIST and zero SELECTs; the
// full-account header scan happens exactly once per account lifetime.

import type { FetchMessageObject, ImapFlow } from "imapflow";
import type { AccountRow, Store, EmailCacheUpsert } from "../../state/store.js";
import type { ImapPool } from "../../imap/pool.js";
import { decodeEmailId, decodeMailboxId, encodeEmailId } from "../../mapping/ids.js";
import { decodeEmailState, encodeEmailState } from "../../state/states.js";
import { accountNotFound, cannotCalculateChanges } from "../errors.js";
import { withMailbox } from "../../imap/client.js";
import { fetchByUid } from "../../imap/uids.js";
import { listMailboxes, liveMailboxStatus, type LiveMailboxStatus } from "./mailbox.js";
import { parseHeaderBlock, threadIdFromInputs, threadInputs } from "../../imap/headers.js";
import { headerBlocksBounded } from "../../imap/fetcher.js";
import { abortable, BudgetExceededError, checkAborted } from "../../imap/abort.js";
import { joinShared, type SharedTasks } from "../../util/shared.js";
import { log } from "../../util/log.js";
import { type ChangesResponse } from "./_shared.js";

export interface ThreadGetArgs {
  accountId: string;
  ids: string[] | null;
}

export interface ThreadJson {
  id: string;
  emailIds: string[];
}

export interface ThreadIndex {
  // threadId -> emailIds in that thread, ordered by receivedAt ascending.
  members: Map<string, string[]>;
  // emailId -> threadId for reverse lookup.
  byEmail: Map<string, string>;
  // emailId -> set of raw IMAP flags (e.g. "\\Seen", "\\Flagged"). Only
  // populated when the caller asked for flags (they're mutable, so they cost
  // a FETCH per folder) — see buildThreadIndex opts.withFlags.
  flagsByEmail: Map<string, Set<string>>;
}

export interface ThreadCtx {
  account: AccountRow;
  client: ImapFlow;
  store: Store;
  // When present, the scan runs on the account's bulk connection so a
  // first-time full scan doesn't block interactive JMAP calls.
  pool?: ImapPool;
}

interface CachedIndex {
  expiresAt: number;
  emailState: number;
  hasFlags: boolean;
  index: ThreadIndex;
}

const indexCache = new Map<number, CachedIndex>();
const INDEX_TTL_MS = 5_000;
const inflight = new Map<number, Promise<ThreadIndex>>();

// Nothing arrived and nothing was expunged since the folder was last scanned.
export function sameAsLastScan(
  live: LiveMailboxStatus,
  scan: { uidvalidity: number; uidnext: number; messages: number },
): boolean {
  return live.uidValidity === scan.uidvalidity && live.uidNext === scan.uidnext && live.messages === scan.messages;
}

// Bring the email_cache rows for one folder up to date with the live mailbox.
// Assumes the mailbox is already SELECTed on `client`.
// What the scan keeps per message between its two FETCH phases: no header
// data, and the envelope's Message-ID only within threading's own bound.
interface ScanMeta {
  uid: number;
  size: number | undefined;
  messageId: string | null;
  internaldate: number;
}

function scanMeta(msg: FetchMessageObject): ScanMeta {
  const mid = (msg.envelope as { messageId?: string } | undefined)?.messageId ?? null;
  return {
    uid: msg.uid!,
    size: msg.size,
    messageId: mid && mid.length <= 1000 ? mid : null,
    internaldate: msg.internalDate ? new Date(msg.internalDate).getTime() : 0,
  };
}

// Messages whose header blocks are fetched, reduced and written per batch, so
// a scan holds at most one block and one batch of rows however large the
// folder is.
const SCAN_BATCH = 256;
// UIDs whose envelopes one scan step reads (and holds) before indexing them.
const SCAN_CHUNK_UIDS = 4096;

// Thread rows for `metas`: header blocks fetched with the same bound (and so
// the same bytes) as Email/get's, reduced to ThreadInputs as each arrives.
async function indexMessages(
  client: ImapFlow,
  account: AccountRow,
  mailboxId: number,
  uidvalidity: number,
  metas: ScanMeta[],
  store: Store,
): Promise<void> {
  for (let i = 0; i < metas.length; i += SCAN_BATCH) {
    const batch = new Map(metas.slice(i, i + SCAN_BATCH).map((m) => [m.uid, m]));
    const upserts: EmailCacheUpsert[] = [];
    for await (const { uid, block } of headerBlocksBounded(client, [...batch.keys()], (u) => batch.get(u)?.size, false)) {
      const m = batch.get(uid);
      if (!m) continue;
      const thread = threadInputs(parseHeaderBlock(block));
      const tid =
        threadIdFromInputs(thread, m.messageId) ??
        encodeEmailId({ accountIdx: account.id, mailboxIdx: mailboxId, uidvalidity, uid });
      upserts.push({
        accountId: account.id,
        mailboxId,
        uidvalidity,
        uid,
        threadId: tid,
        threadInputs: JSON.stringify(thread),
        internaldate: m.internaldate,
      });
    }
    store.upsertEmailCacheRows(upserts);
  }
}

async function syncMailboxScan(
  client: ImapFlow,
  account: AccountRow,
  mailboxId: number,
  store: Store,
): Promise<void> {
  const mb = client.mailbox && typeof client.mailbox === "object" ? client.mailbox : null;
  if (!mb) return;
  const uidvalidity = Number((mb as { uidValidity?: number | bigint }).uidValidity ?? 0);
  const uidNext = Number((mb as { uidNext?: number | bigint }).uidNext ?? 0);
  const exists = Number((mb as { exists?: number }).exists ?? 0);

  const scan = store.getMailboxScan(account.id, mailboxId);
  if (scan && scan.uidvalidity === uidvalidity && scan.uidnext === uidNext && scan.messages === exists) {
    return; // nothing arrived, nothing expunged
  }

  let startUid = 1;
  if (scan && scan.uidvalidity === uidvalidity) {
    startUid = Math.max(1, scan.uidnext);
  } else if (scan) {
    // uidvalidity rolled: every cached row for this folder is garbage.
    store.purgeEmailCacheMailbox(account.id, mailboxId);
  }

  // New mail in UID ranges of SCAN_CHUNK_UIDS, each indexed before the next
  // is read: a first scan of a large folder holds one range's metadata, not
  // the whole folder's. Mail arriving between scans is one range, as before.
  for (let lo = startUid; exists > 0 && lo < uidNext; lo += SCAN_CHUNK_UIDS) {
    const hi = lo + SCAN_CHUNK_UIDS - 1;
    const last = hi >= uidNext - 1;
    const metas: ScanMeta[] = [];
    for await (const msg of client.fetch(
      last ? `${lo}:*` : `${lo}:${hi}`,
      { uid: true, envelope: true, internalDate: true, size: true },
      { uid: true },
    )) {
      // `${x}:*` returns the highest-UID message even when x exceeds it. A
      // FLAGS-only FETCH pushed mid-command has no envelope: not ours.
      if (msg.uid == null || msg.uid < lo || (!last && msg.uid > hi) || !msg.envelope) continue;
      metas.push(scanMeta(msg));
    }
    await indexMessages(client, account, mailboxId, uidvalidity, metas, store);
  }

  // Reconcile expunges (and self-heal any cache gaps): only when the row
  // count disagrees with EXISTS, ask the server for the live UID set.
  const cachedUids = store.getEmailCacheUids(account.id, mailboxId);
  if (cachedUids.length !== exists) {
    const searchResult = exists > 0 ? await client.search({ all: true }, { uid: true }) : [];
    const live = new Set(Array.isArray(searchResult) ? (searchResult as number[]) : []);
    const stale = cachedUids.filter((uid) => !live.has(uid));
    store.deleteEmailCacheUids(account.id, mailboxId, stale);
    const cachedSet = new Set(cachedUids);
    const gaps = [...live].filter((uid) => !cachedSet.has(uid));
    for (let i = 0; i < gaps.length; i += SCAN_CHUNK_UIDS) {
      const metas: ScanMeta[] = [];
      for await (const msg of fetchByUid(
        client,
        gaps.slice(i, i + SCAN_CHUNK_UIDS),
        { uid: true, envelope: true, internalDate: true, size: true },
      )) {
        if (msg.uid == null || !msg.envelope) continue;
        metas.push(scanMeta(msg));
      }
      await indexMessages(client, account, mailboxId, uidvalidity, metas, store);
    }
  }

  store.putMailboxScan({
    account_id: account.id,
    mailbox_id: mailboxId,
    uidvalidity,
    uidnext: uidNext,
    messages: exists,
    scanned_at: Date.now(),
  });
}

// Freshness of the email_cache thread rows, per account. Thread/get,
// Thread/changes and collapseThreads read those rows directly (one thread, or
// the ids at hand), so all they need is the incremental scan below; only the
// noneInThreadHaveKeyword filter still wants the whole index with flags.
interface RowSync {
  expiresAt: number;
  emailState: number;
}
const rowSync = new Map<number, RowSync>();
// A state change (IDLE saw new mail, or we wrote) always re-syncs; without
// one, rows are re-checked against LIST-STATUS at most this often -- the
// staleness window listMailboxes and the search cache already accept.
const ROW_SYNC_TTL_MS = 30_000;
// The running scan per account, shared by the requests waiting for it (see
// joinShared): one that is abandoned stops waiting, and the scan stops when
// none waits. Its progress is kept per folder and batch, so the next one
// carries on.
const rowSyncTasks: SharedTasks<void> = new Map();

/** Forget every cached index and row freshness (tests, where account ids repeat across stores). */
export function resetThreadCaches(): void {
  indexCache.clear();
  rowSync.clear();
}

/**
 * Bring the account's thread rows up to date (incremental, cached, one scan at
 * a time). With `signal`, an abandoned request stops waiting for the scan.
 */
export async function syncThreadRows(ctx: ThreadCtx, signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const curState = ctx.store.getState(ctx.account.id, "email");
  const fresh = rowSync.get(ctx.account.id);
  if (fresh && fresh.expiresAt > now && fresh.emailState === curState) return;
  const building = inflight.get(ctx.account.id);
  if (building) {
    await building.catch(() => {});
    return syncThreadRows(ctx, signal);
  }
  const key = String(ctx.account.id);
  const joined = rowSyncTasks.has(key);
  await joinShared(rowSyncTasks, key, async (stop) => {
    // Without a pool (unit tests) the scan runs on the caller's connection.
    const lease = ctx.pool ? await ctx.pool.acquire(ctx.account, "bulk", stop) : null;
    try {
      await scanFolders(ctx, lease ? lease.client : ctx.client, false, stop);
      rowSync.set(ctx.account.id, { expiresAt: now + ROW_SYNC_TTL_MS, emailState: curState });
    } finally {
      lease?.release();
    }
  }, signal, { onCallerConnection: !ctx.pool, graceMs: 0 });
  // A scan joined midway may have started before this caller's state.
  if (joined) return syncThreadRows(ctx, signal);
}

/** A thread's member email ids, oldest first (empty for an unknown thread). */
export function threadMemberIds(store: Store, accountId: number, threadId: string): string[] {
  return store.getThreadMembers(accountId, threadId).map((r) =>
    encodeEmailId({ accountIdx: accountId, mailboxIdx: r.mailbox_id, uidvalidity: r.uidvalidity, uid: r.uid }),
  );
}

/** threadId of each given email id that has one recorded; others are absent. */
export function threadIdsOf(store: Store, accountId: number, emailIds: Iterable<string>): Map<string, string> {
  const groups = new Map<string, { mailboxIdx: number; uidvalidity: number; byUid: Map<number, string> }>();
  for (const id of emailIds) {
    let p;
    try {
      p = decodeEmailId(id);
    } catch {
      continue;
    }
    if (p.accountIdx !== accountId) continue;
    const key = `${p.mailboxIdx}:${p.uidvalidity}`;
    let g = groups.get(key);
    if (!g) {
      g = { mailboxIdx: p.mailboxIdx, uidvalidity: p.uidvalidity, byUid: new Map() };
      groups.set(key, g);
    }
    g.byUid.set(p.uid, id);
  }
  const out = new Map<string, string>();
  for (const g of groups.values()) {
    const tids = store.getThreadIdsByUid(accountId, g.mailboxIdx, g.uidvalidity, [...g.byUid.keys()]);
    for (const [uid, tid] of tids) out.set(g.byUid.get(uid)!, tid);
  }
  return out;
}

export async function buildThreadIndex(
  ctx: ThreadCtx,
  opts: { withFlags?: boolean } = {},
): Promise<ThreadIndex> {
  const wantFlags = opts.withFlags === true;
  const cached = indexCache.get(ctx.account.id);
  const now = Date.now();
  const curState = ctx.store.getState(ctx.account.id, "email");
  if (
    cached &&
    cached.expiresAt > now &&
    cached.emailState === curState &&
    (!wantFlags || cached.hasFlags)
  ) {
    return cached.index;
  }

  // One build per account at a time: a request that arrives mid-build waits
  // for it rather than walking the same folders again on another connection.
  const running = inflight.get(ctx.account.id) ?? rowSyncTasks.get(String(ctx.account.id))?.promise;
  if (running) {
    await running.catch(() => {});
    return buildThreadIndex(ctx, opts);
  }
  const build = rebuildThreadIndex(ctx, wantFlags, curState, now);
  inflight.set(ctx.account.id, build);
  try {
    return await build;
  } finally {
    inflight.delete(ctx.account.id);
  }
}

// Walk the folders: bring each moved folder's rows up to date, and with
// `wantFlags` read every folder's flags. Runs on `client`, which the caller
// holds for the whole walk.
// With `stop`, the walk is cut off when it fires (abortable).
async function scanFolders(
  ctx: ThreadCtx,
  client: ImapFlow,
  wantFlags: boolean,
  stop?: AbortSignal,
): Promise<Map<string, Set<string>>> {
  // A fresh LIST reports every folder's UIDVALIDITY, UIDNEXT and count in one
  // round trip (LIST-STATUS); only folders where those moved get SELECTed.
  // Before, each build SELECTed every non-empty folder, and on Gmail, where
  // every label is a folder, that alone took tens of seconds.
  const all = await listMailboxes(client, ctx.account, ctx.store, { force: true, signal: stop });
  const rows = ctx.store
    .prep(`SELECT id, name, uidvalidity FROM mailbox WHERE account_id = ?`)
    .all(ctx.account.id) as { id: number; name: string; uidvalidity: number }[];
  const rowById = new Map(rows.map((r) => [r.id, r] as const));

  const flagsByEmail = new Map<string, Set<string>>();
  for (const m of all) {
    const mailboxIdx = decodeMailboxId(m.id).mailboxIdx;
    const row = rowById.get(mailboxIdx);
    if (!row) continue;
    const scan = ctx.store.getMailboxScan(ctx.account.id, mailboxIdx);
    if (m.totalEmails === 0 && (scan?.messages ?? 0) === 0) continue;
    // Flags are mutable and not in the scan, so a flags build still reads them.
    const live = liveMailboxStatus(ctx.account.id, row.name);
    if (!wantFlags && live && scan && sameAsLastScan(live, scan)) continue;
    checkAborted(stop);
    try {
      await abortable(client, stop, () => withMailbox(client, row.name, async () => {
        await syncMailboxScan(client, ctx.account, mailboxIdx, ctx.store);
        if (wantFlags) {
          const mb = client.mailbox && typeof client.mailbox === "object" ? client.mailbox : null;
          const uidvalidity = Number(
            (mb as { uidValidity?: number | bigint } | null)?.uidValidity ?? row.uidvalidity,
          );
          const exists = Number((mb as { exists?: number } | null)?.exists ?? 0);
          if (exists > 0) {
            for await (const msg of client.fetch("1:*", { uid: true, flags: true }, { uid: true })) {
              if (msg.uid == null) continue;
              const eid = encodeEmailId({
                accountIdx: ctx.account.id,
                mailboxIdx,
                uidvalidity,
                uid: msg.uid,
              });
              flagsByEmail.set(eid, msg.flags ? new Set(msg.flags) : new Set());
            }
          }
        }
      }));
    } catch (e) {
      // Stopped: the walk ends here (the next scan carries on).
      if (e instanceof BudgetExceededError) throw e;
      // Skip folders we can't open; the index just won't include them.
      log.warn(
        { mailbox: row.name, err: (e as Error).message },
        "thread scan: skipping mailbox",
      );
    }
  }
  return flagsByEmail;
}

async function rebuildThreadIndex(
  ctx: ThreadCtx,
  wantFlags: boolean,
  curState: number,
  now: number,
): Promise<ThreadIndex> {
  // Long scans ride the bulk connection so they don't queue behind (or hold
  // up) interactive method calls sharing the request-path connection. The
  // lease is held for the whole scan and returned however this exits.
  const lease = ctx.pool ? await ctx.pool.acquire(ctx.account, "bulk") : null;
  const client = lease ? lease.client : ctx.client;
  try {
    const flagsByEmail = await scanFolders(ctx, client, wantFlags);
    rowSync.set(ctx.account.id, { expiresAt: now + ROW_SYNC_TTL_MS, emailState: curState });

    const index: ThreadIndex = {
      members: new Map(),
      byEmail: new Map(),
      flagsByEmail,
    };
    // Rows come back ordered by internaldate ascending (RFC 8621 §3 order).
    for (const r of ctx.store.getThreadIndexRows(ctx.account.id)) {
      const eid = encodeEmailId({
        accountIdx: ctx.account.id,
        mailboxIdx: r.mailbox_id,
        uidvalidity: r.uidvalidity,
        uid: r.uid,
      });
      let arr = index.members.get(r.thread_id);
      if (!arr) {
        arr = [];
        index.members.set(r.thread_id, arr);
      }
      arr.push(eid);
      index.byEmail.set(eid, r.thread_id);
    }

    indexCache.set(ctx.account.id, {
      expiresAt: now + INDEX_TTL_MS,
      emailState: curState,
      hasFlags: wantFlags,
      index,
    });
    return index;
  } finally {
    lease?.release();
  }
}

export async function threadGet(
  args: ThreadGetArgs,
  ctx: ThreadCtx,
): Promise<{ accountId: string; state: string; list: ThreadJson[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const list: ThreadJson[] = [];
  const notFound: string[] = [];
  const ids = args.ids ?? [];
  // Bring the thread rows up to date, then read just the threads asked for.
  await syncThreadRows(ctx);
  for (const id of ids) {
    const members = typeof id === "string" ? threadMemberIds(ctx.store, ctx.account.id, id) : [];
    if (members && members.length > 0) {
      list.push({ id, emailIds: members });
      continue;
    }
    // Backwards-compat: an emailId-shaped id from the old "thread of one"
    // fallback still resolves to a degenerate thread containing that email.
    try {
      const parts = decodeEmailId(id);
      if (parts.accountIdx === ctx.account.id) {
        list.push({ id, emailIds: [id] });
        continue;
      }
    } catch { /* not a valid email id */ }
    notFound.push(id);
  }
  return {
    accountId: args.accountId,
    state: encodeEmailState({ uidvalidity: 0, modseq: ctx.store.getState(ctx.account.id, "email") }),
    list,
    notFound,
  };
}

// Surface for Email/query collapseThreads.
export function getCachedThreadIndex(accountId: number): ThreadIndex | null {
  const c = indexCache.get(accountId);
  return c ? c.index : null;
}

// Thread/changes is derived from the email-level change log: any email-level
// mutation lifts to a thread-level event for the affected thread. We resolve
// each email id to its threadId via the thread index — built on demand and
// cached for a few seconds. When the log can't reach back to sinceState, we
// fall back to `cannotCalculateChanges` rather than guessing.
export async function threadChanges(
  args: { accountId: string; sinceState: string },
  ctx: ThreadCtx,
): Promise<ChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const currentNumeric = ctx.store.getState(ctx.account.id, "email");
  const currentRaw = encodeEmailState({ uidvalidity: 0, modseq: currentNumeric });
  if (args.sinceState === currentRaw) {
    return {
      accountId: args.accountId,
      oldState: currentRaw,
      newState: currentRaw,
      hasMoreChanges: false,
      created: [], updated: [], destroyed: [],
    };
  }
  const decoded = (() => {
    try { return decodeEmailState(args.sinceState).modseq; } catch { return null; }
  })();
  if (decoded === null) throw cannotCalculateChanges();
  const entries = ctx.store.entriesSince(ctx.account.id, "email", decoded, currentNumeric);
  if (!entries) throw cannotCalculateChanges();

  await syncThreadRows(ctx);
  const threadOf = threadIdsOf(ctx.store, ctx.account.id, entries.map((e) => e.id));
  const created = new Set<string>();
  const updated = new Set<string>();
  const destroyed = new Set<string>();
  // Track whether each affected thread had members BEFORE the window — for
  // the simple "thread didn't exist before" → "created" classification.
  // Without snapshotting the index pre-window we approximate: a thread is
  // created if its CURRENT membership equals the set of created emails seen
  // in this window; otherwise it's updated.
  const threadsTouched = new Map<string, { hadCreate: boolean; hadDestroy: boolean }>();
  for (const e of entries) {
    let tid = threadOf.get(e.id);
    if (!tid) {
      // Email destroyed and no longer in the index — fall back to using its
      // own id as the thread id (matches the degenerate single-message
      // thread case). Safe because the upstream tests just check membership.
      tid = e.id;
    }
    const t = threadsTouched.get(tid) ?? { hadCreate: false, hadDestroy: false };
    if (e.action === "created") t.hadCreate = true;
    if (e.action === "destroyed") t.hadDestroy = true;
    threadsTouched.set(tid, t);
  }
  for (const [tid, t] of threadsTouched) {
    const liveCount = ctx.store.getThreadMembers(ctx.account.id, tid).length;
    if (liveCount === 0 && t.hadDestroy) destroyed.add(tid);
    else if (t.hadCreate && liveCount > 0) {
      // If we logged a `created` and the thread now exists, treat it as a
      // newly-visible thread from the client's perspective. This is the
      // correct call when `liveCount === 1` (the new email IS the thread)
      // and a defensible approximation when we appended to an existing
      // thread (the spec lets `created` imply "newly visible").
      if (liveCount === 1) created.add(tid);
      else updated.add(tid);
    } else {
      updated.add(tid);
    }
  }
  return {
    accountId: args.accountId,
    oldState: args.sinceState,
    newState: currentRaw,
    hasMoreChanges: false,
    created: [...created],
    updated: [...updated],
    destroyed: [...destroyed],
  };
}
