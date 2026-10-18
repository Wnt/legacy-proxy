import { createHash } from "node:crypto";
import type { ImapFlow } from "imapflow";
import type { AccountRow, Store, EmailCacheUpsert } from "../../state/store.js";
import { viewEmailState, type ImapPool } from "../../imap/pool.js";
import { decodeEmailId, decodeMailboxId, encodeBlobId, encodeEmailId, encodeMailboxId } from "../../mapping/ids.js";
import { encodeEmailState } from "../../state/states.js";
import type { ParsedHeader } from "../../imap/headers.js";
import {
  fetchEmailsBatch,
  MAX_FULL_HEADER_BYTES_PER_CALL,
  MAX_RESPONSE_CHARS,
  MAX_BODYSTRUCTURE_JSON_CHARS,
  boundBodyStructure,
  BudgetExceededError,
  checkAborted,
  newRequestBudgets,
  type JmapEmail,
  type RequestBudgets,
} from "../../imap/fetcher.js";
import { selectedUidValidity, withMailbox } from "../../imap/client.js";
import { fetchByUid } from "../../imap/uids.js";
import { JmapError, accountNotFound, invalidArguments, notFound, unsupportedFilter, unsupportedSort } from "../errors.js";
import { compileFilter, UnsupportedFilter, type Filter, type ImapSearch } from "../../imap/search.js";
import { listMailboxes, refreshMailboxCounts } from "./mailbox.js";
import { log } from "../../util/log.js";
import { mapWithConcurrency } from "../../util/concurrency.js";
import { headersToEmailHeaders, projectHeaderProp } from "../../imap/headers.js";
import { buildThreadIndex, syncThreadRows, threadIdsOf } from "./threads.js";
import { keywordToFlag } from "../../mapping/flags.js";
import {
  buildRfc822,
  MAX_MIME_BYTES,
  MessageTooLargeError,
  mimeContentPlan,
  MissingBlobError,
  type BodyStructurePart,
  type JmapEmailCreate,
} from "../../mapping/buildMime.js";
import { InvalidEmailCreateError, validateEmailCreate } from "../../mapping/emailCreate.js";
import { BlobTooLargeError, readBlob } from "../blobs.js";
import {
  changesFromLog,
  changesOrCannotCalculate,
  queryChangesOrCannotCalculate,
  type ChangesResponse,
  type QueryChangesResponse,
} from "./_shared.js";
import { decodeCounterState, decodeEmailState } from "../../state/states.js";

// Shared handler context. `pool` is optional (unit tests construct contexts
// without one); when present, long-running scans ride the bulk connection.
interface MailCtx {
  account: AccountRow;
  client: ImapFlow;
  store: Store;
  pool?: ImapPool;
  /** The session's advertised maxObjectsInGet (config limits). */
  maxObjectsInGet?: number;
  /** Shared by every Email/get of one HTTP request; fresh per call if absent. */
  budgets?: RequestBudgets;
}

// header:* properties one Email/get may ask for; clients use a handful.
const MAX_HEADER_PROPERTIES = 128;

// Same default as the config's MAX_OBJECTS_IN_GET.
const DEFAULT_MAX_OBJECTS_IN_GET = 500;

export interface EmailQueryArgs {
  accountId: string;
  filter?: Filter;
  sort?: { property: string; isAscending?: boolean }[];
  position?: number;
  limit?: number;
  collapseThreads?: boolean;
  // Anchor-based paging (RFC 8620 §5.5). When `anchor` is set, `position` is
  // ignored — paging starts at the anchor's offset (plus anchorOffset).
  anchor?: string;
  anchorOffset?: number;
  calculateTotal?: boolean;
}

// Resolve `position`/`anchor`/`anchorOffset` to a concrete start offset
// against an ordered id list. Throws `anchorNotFound` per RFC 8620 §5.5
// when an anchor is provided but doesn't appear in the result list.
function resolveQueryStart(
  orderedIds: string[],
  args: { position?: number; anchor?: string; anchorOffset?: number },
): number {
  if (args.anchor !== undefined) {
    const idx = orderedIds.indexOf(args.anchor);
    if (idx < 0) throw new JmapError("anchorNotFound", `anchor ${args.anchor} not in result list`);
    const off = typeof args.anchorOffset === "number" ? args.anchorOffset : 0;
    return Math.max(0, idx + off);
  }
  const pos = args.position ?? 0;
  if (pos < 0) return Math.max(0, orderedIds.length + pos);
  return pos;
}

// We honor any of the JMAP-defined sort properties: receivedAt (the fast
// path; equivalent to UID order in single-mailbox queries) plus size, from,
// to, subject, sentAt, hasKeyword. Anything else falls through to
// unsupportedSort. Non-receivedAt sorts trigger a per-match FETCH; that's
// fine for the v0.1 scale but a server-side SORT extension would be the
// long-term win on huge mailboxes.
const SUPPORTED_SORT_PROPS = new Set([
  "receivedAt",
  "size",
  "from",
  "to",
  "subject",
  "sentAt",
  "hasKeyword",
]);

const FETCH_SORT_PROPS = new Set(["size", "from", "to", "subject", "sentAt", "hasKeyword"]);

// Per-mailbox SEARCH-result cache. The same client typically issues
// `Email/query { position: 0, limit: 50 }`, then `position: 50`, then
// `position: 100`, etc., scrolling through a folder. Each one used to
// re-issue an IMAP SEARCH; with this cache they reuse one round trip until
// either the mailbox state moves or the TTL expires.
//
// Cache key includes a stable filter hash + uidvalidity so a new mailbox
// (UIDVALIDITY rolled, e.g. recreate) automatically invalidates entries.
//
// The connection's HIGHESTMODSEQ alone is not a safe key: a pooled connection
// whose view is behind the server reports the old modseq too, and the entry
// would outlive the IDLE worker's "new mail" StateChange by up to the TTL.
// So an entry is also stamped with the email state its SEARCH ran at, and
// only reused while that is still the state the reading connection is at.
interface SearchCacheEntry {
  uids: number[];
  modseq: number;
  emailState: number;
  expiresAt: number;
}
const searchCache = new Map<string, SearchCacheEntry>();
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX = 256;

function searchCacheKey(
  accountId: number,
  mailboxIdx: number,
  uidvalidity: number,
  filter: unknown,
): string {
  return `${accountId}|${mailboxIdx}|${uidvalidity}|${stableHash(filter)}`;
}

// Deterministic JSON: keys sorted at every level so logically-equal filters
// hash identically regardless of the property order the client used.
function stableHash(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}

function pruneSearchCache(): void {
  if (searchCache.size <= SEARCH_CACHE_MAX) return;
  // Map preserves insertion order; drop the oldest entries first.
  const drop = searchCache.size - SEARCH_CACHE_MAX;
  let i = 0;
  for (const k of searchCache.keys()) {
    if (i++ >= drop) break;
    searchCache.delete(k);
  }
}

// Drop the account's cached search results. Called after we mutate emails
// (Email/set, Email/import, Email/copy) — the next Email/query needs to see
// the new state, and imapflow's cached mailbox.highestModseq isn't always
// advanced on the same connection that did the APPEND, so the modseq guard
// alone can serve a stale answer.
// With `mailboxes` (the folders the write touched), the per-folder results of
// account-wide queries are dropped for those folders only: the others did not
// change, and their results are still checked against a fresh LIST-STATUS
// (the snapshot is dropped too). Dropping every folder made each message open
// ($seen) cost a full re-search of every folder on the next tag count.
function invalidateSearchCacheForAccount(accountId: number, store?: Store, mailboxes?: Iterable<number>): void {
  const prefix = `${accountId}|`;
  for (const k of [...searchCache.keys()]) {
    if (k.startsWith(prefix)) searchCache.delete(k);
  }
  const only = mailboxes ? [...mailboxes] : null;
  const folderPrefixes = only && only.length > 0 ? only.map((idx) => `${accountId}|${idx}|`) : [prefix];
  for (const k of [...folderSearchCache.keys()]) {
    if (folderPrefixes.some((p) => k.startsWith(p))) folderSearchCache.delete(k);
  }
  folderSnapshots.delete(accountId);
  try {
    store?.deleteFolderSearches(accountId, only && only.length > 0 ? only : undefined);
  } catch (e) {
    log.warn({ err: (e as Error).message }, "folder search cache purge failed");
  }
}

// The account email state that results read on `client` include: the state
// the pool last synced the connection to (ImapPool refreshes a connection
// whenever the state moved), or the current state for a connection from
// outside the pool. Results stamped with it never claim a newer state than
// the connection has seen, so a client is never told "you are up to date"
// with data that misses an advertised change.
function viewState(ctx: { account: AccountRow; store: Store }, client: ImapFlow): number {
  return viewEmailState(client) ?? ctx.store.getState(ctx.account.id, "email");
}

function findInMailbox(filter: Filter): string | null {
  if ("operator" in filter) {
    if (filter.operator !== "AND") return null;
    for (const c of filter.conditions) {
      const m = findInMailbox(c);
      if (m) return m;
    }
    return null;
  }
  return filter.inMailbox ?? null;
}

// Top-level hasAttachment (RFC 8621 §4.4.4). On non-gmail backends IMAP can't
// answer this directly, so we extract it here and apply it as a post-filter
// against per-message BODYSTRUCTURE.
function findHasAttachment(filter: Filter): boolean | null {
  if ("operator" in filter) {
    if (filter.operator !== "AND") return null;
    for (const c of filter.conditions) {
      const m = findHasAttachment(c);
      if (m !== null) return m;
    }
    return null;
  }
  return (filter as { hasAttachment?: boolean }).hasAttachment ?? null;
}

// Top-level noneInThreadHaveKeyword (RFC 8621 §4.4.4): "include emails whose
// thread contains no message bearing this keyword". We honor it as a post-
// filter against the thread index, so the IMAP search side can ignore it.
function findNoneInThreadHaveKeyword(filter: Filter): string | null {
  if ("operator" in filter) {
    if (filter.operator !== "AND") return null;
    for (const c of filter.conditions) {
      const m = findNoneInThreadHaveKeyword(c);
      if (m) return m;
    }
    return null;
  }
  return (filter as { noneInThreadHaveKeyword?: string }).noneInThreadHaveKeyword ?? null;
}

// Top-level inMailboxOtherThan; only AND trees recurse. RFC 8621 §4.4.4 lets a
// client say "anywhere except in these folders" — which only makes sense in the
// account-wide path, since the single-mailbox path already pins one folder.
function findInMailboxOtherThan(filter: Filter): string[] | null {
  if ("operator" in filter) {
    if (filter.operator !== "AND") return null;
    for (const c of filter.conditions) {
      const m = findInMailboxOtherThan(c);
      if (m) return m;
    }
    return null;
  }
  return filter.inMailboxOtherThan ?? null;
}

export async function emailQuery(
  args: EmailQueryArgs,
  ctx: MailCtx,
): Promise<{
  accountId: string;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  total?: number;
  ids: string[];
}> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const filter = args.filter ?? ({} as Filter);

  let imapFilter;
  try {
    imapFilter = compileFilter(filter, {
      dialect: ctx.account.kind === "gmail" ? "gmail" : "generic",
    });
  } catch (e) {
    if (e instanceof UnsupportedFilter) throw unsupportedFilter(e.message);
    throw e;
  }

  for (const s of args.sort ?? []) {
    if (!SUPPORTED_SORT_PROPS.has(s.property)) throw unsupportedSort();
  }
  // Default JMAP order is unspecified; clients usually want newest-first.
  const sort = (args.sort ?? []) as SortSpec[];
  const needsFetch = sort.some((s) => FETCH_SORT_PROPS.has(s.property));
  const ascending = sort[0]?.isAscending === true;
  const lim = Math.min(args.limit ?? 50, 500);

  const inMailbox = findInMailbox(filter);
  const run = (window?: DateWindow) =>
    inMailbox
      ? emailQuerySingleMailboxFull(ctx, filter, imapFilter, inMailbox, sort, ascending, needsFetch, window)
      : emailQueryAccountWideFull(ctx, filter, imapFilter, sort, ascending, needsFetch, window);

  let full: { ids: string[]; queryState: string };
  // False only when a windowed search stopped before its oldest window: the
  // ids are then an exact prefix of the result, and its length is unknown.
  let complete = true;
  if (canSearchInWindows(args, filter, imapFilter, sort, ctx)) {
    const needed = Math.max(0, args.position ?? 0) + lim;
    const windows = textSearchWindows(new Date());
    const ids: string[] = [];
    let queryState: string | null = null;
    complete = false;
    for (let i = 0; i < windows.length; i++) {
      const part = await run(windows[i]);
      // The first window's state: no later window's view is older.
      queryState ??= part.queryState;
      for (const id of part.ids) ids.push(id);
      if (i === windows.length - 1) {
        complete = true;
        break;
      }
      const have = args.collapseThreads === true ? (await collapseByThread(ctx, ids)).length : ids.length;
      if (have >= needed) break;
    }
    full = { ids, queryState: queryState! };
  } else {
    full = await run();
  }

  let orderedIds = full.ids;

  const wantsHasAttachment = findHasAttachment(filter);
  if (wantsHasAttachment !== null) {
    orderedIds = await postFilterByHasAttachment(ctx, orderedIds, wantsHasAttachment);
  }

  const noneKw = findNoneInThreadHaveKeyword(filter);
  if (noneKw) {
    // Flags are mutable, so the index only carries them on request — this
    // filter is the one consumer that needs them.
    const indexed = await buildThreadIndex(ctx, { withFlags: true });
    let imapFlag: string;
    try {
      imapFlag = keywordToFlag(noneKw);
    } catch {
      imapFlag = noneKw;
    }
    const threadHasKeyword = new Map<string, boolean>();
    for (const [tid, members] of indexed.members) {
      let any = false;
      for (const eid of members) {
        const flags = indexed.flagsByEmail.get(eid);
        if (flags && flags.has(imapFlag)) { any = true; break; }
      }
      threadHasKeyword.set(tid, any);
    }
    orderedIds = orderedIds.filter((id) => {
      const tid = indexed.byEmail.get(id);
      if (!tid) return true; // unknown thread → don't drop
      return !threadHasKeyword.get(tid);
    });
  }

  if (args.collapseThreads === true) {
    orderedIds = await collapseByThread(ctx, orderedIds);
  }

  const start = resolveQueryStart(orderedIds, args);
  return {
    accountId: args.accountId,
    queryState: full.queryState,
    canCalculateChanges: false,
    position: start,
    // RFC 8620 §5.5: `total` is only owed when calculateTotal was asked for;
    // a windowed search that stopped early does not know it.
    ...(complete ? { total: orderedIds.length } : {}),
    ids: orderedIds.slice(start, start + lim),
  };
}

// The newest id of each thread, in the given order. Only the matched ids'
// threads matter: look those up, rather than load the whole account's thread
// index (seconds on a 100k-message account).
async function collapseByThread(ctx: MailCtx, ids: string[]): Promise<string[]> {
  await syncThreadRows(ctx);
  const threadOf = threadIdsOf(ctx.store, ctx.account.id, ids);
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const id of ids) {
    const tid = threadOf.get(id) ?? id;
    if (seen.has(tid)) continue;
    seen.add(tid);
    dedup.push(id);
  }
  return dedup;
}

// Full-text search, newest first, in date windows.
//
// A `text` or `body` criterion makes the IMAP server read every message it
// considers. A server without a full-text index (Dovecot without FTS) scans
// on the order of a thousand messages a second per connection, so a search of
// a mailbox with tens of thousands of messages takes tens of seconds: longer
// than clients wait, and a client that gives up may show an empty result.
// The server does filter on the internal date first, from its index, so a
// search bounded with SINCE/BEFORE costs only the messages inside the bounds.
//
// When the client asks for no total, newest first, the page it wants is
// decided by the newest matches only. The query then runs over consecutive
// date windows, newest window first, and stops as soon as the windows read so
// far hold `position + limit` matches. The windows partition time (SINCE d
// and BEFORE d split at the same day boundary on the server), so every match
// in a window is newer than every match in the windows after it: the windows
// read hold exactly the newest matches. (Within one folder the unwindowed
// search orders by UID; a message filed late with an old date is placed by
// its date here, which is what receivedAt order asks for.) A search that
// reaches the oldest window has read everything and also reports its total.
export interface DateWindow {
  since?: Date;
  before?: Date;
}

// Window bounds, in months before the start of the current month (UTC).
// Fixed calendar bounds keep each window's per-folder SEARCH results reusable
// all month; widening steps keep a rare term to a handful of extra round trips.
const TEXT_SEARCH_WINDOW_MONTHS = [1, 4, 13, 37];

export function textSearchWindows(now: Date): DateWindow[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const bounds = TEXT_SEARCH_WINDOW_MONTHS.map((k) => new Date(Date.UTC(y, m - k, 1)));
  const out: DateWindow[] = [{ since: bounds[0] }];
  for (let i = 1; i < bounds.length; i++) out.push({ since: bounds[i], before: bounds[i - 1] });
  out.push({ before: bounds[bounds.length - 1] });
  return out;
}

function hasFullTextTerm(f: Filter): boolean {
  if ("operator" in f) return f.conditions.some(hasFullTextTerm);
  return !!(f.text?.trim() || f.body?.trim());
}

function canSearchInWindows(
  args: EmailQueryArgs,
  filter: Filter,
  imapFilter: ImapSearch,
  sort: SortSpec[],
  ctx: MailCtx,
): boolean {
  if (args.calculateTotal === true || args.anchor !== undefined) return false;
  if ((args.position ?? 0) < 0) return false;
  // Gmail answers X-GM-RAW from its own index.
  if (ctx.account.kind === "gmail") return false;
  const newestFirst =
    sort.length === 0 || (sort.length === 1 && sort[0]!.property === "receivedAt" && sort[0]!.isAscending === false);
  if (!newestFirst) return false;
  // The window's SINCE/BEFORE would replace the filter's own.
  if (imapFilter.since !== undefined || imapFilter.before !== undefined) return false;
  // Post-filters that drop ids after the search; kept on the plain path.
  if (findHasAttachment(filter) !== null || findNoneInThreadHaveKeyword(filter)) return false;
  return hasFullTextTerm(filter);
}

function windowedSearch(imapFilter: ImapSearch, window: DateWindow | undefined): ImapSearch {
  if (!window) return imapFilter;
  return {
    ...imapFilter,
    ...(window.since ? { since: window.since } : {}),
    ...(window.before ? { before: window.before } : {}),
  };
}

// What a window's SEARCH result is cached under. Without a window it is the
// filter itself, as before, so existing cache entries stay valid.
function windowedCacheKey(filter: Filter, window: DateWindow | undefined): unknown {
  if (!window) return filter;
  return { filter, window: [window.since?.toISOString() ?? null, window.before?.toISOString() ?? null] };
}

interface SortSpec { property: string; isAscending?: boolean; keyword?: string }
interface SortableHit {
  mailboxIdx: number;
  uidvalidity: number;
  uid: number;
  receivedAt?: number;
  size?: number;
  from?: string;
  to?: string;
  subject?: string;
  sentAt?: number;
  flags?: Set<string>;
}

function sortValue(h: SortableHit, prop: string, kw: string | undefined): number | string | boolean {
  switch (prop) {
    case "receivedAt": return h.receivedAt ?? 0;
    case "size": return h.size ?? 0;
    // Already lower-cased and bounded (sortKey).
    case "from": return h.from ?? "";
    case "to": return h.to ?? "";
    case "subject": return h.subject ?? "";
    case "sentAt": return h.sentAt ?? 0;
    case "hasKeyword":
      // The hit holds raw IMAP flags. Map the JMAP keyword the client picked
      // through keywordToFlag so $flagged/$seen/etc. compare against \\Flagged
      // / \\Seen rather than missing every time.
      if (!kw || !h.flags) return false;
      try {
        return h.flags.has(keywordToFlag(kw));
      } catch {
        return false;
      }
    default: return 0;
  }
}

function compareHits(a: SortableHit, b: SortableHit, sort: SortSpec[]): number {
  for (const s of sort) {
    const asc = s.isAscending !== false;
    const av = sortValue(a, s.property, s.keyword);
    const bv = sortValue(b, s.property, s.keyword);
    if (av === bv) continue;
    const cmp = av < bv ? -1 : 1;
    return asc ? cmp : -cmp;
  }
  return 0;
}

// Enrich UIDs with whatever metadata the requested sort needs. Non-receivedAt
// sorts FETCH envelope/size/flags from IMAP — batched per mailbox, split into
// bounded UID sets so huge folders don't overflow the server's line limit.
async function fetchSortMetadata(
  client: ImapFlow,
  uids: number[],
  needsFetch: boolean,
): Promise<Map<number, { size?: number; from?: string; to?: string; subject?: string; sentAt?: number; receivedAt?: number; flags?: Set<string> }>> {
  const out = new Map<number, { size?: number; from?: string; to?: string; subject?: string; sentAt?: number; receivedAt?: number; flags?: Set<string> }>();
  if (uids.length === 0) return out;
  const query = needsFetch
    ? { uid: true, internalDate: true, size: true, envelope: true, flags: true }
    : { uid: true, internalDate: true };
  for await (const msg of fetchByUid(client, uids, query)) {
    const uid = Number(msg.uid);
    // Only sort keys are kept, as each message arrives: lower-cased once and
    // cut to SORT_KEY_CHARS, so a sender's huge Subject or address costs
    // neither memory per hit nor work per comparison.
    out.set(uid, {
      receivedAt: msg.internalDate ? new Date(msg.internalDate).getTime() : 0,
      size: typeof msg.size === "number" ? msg.size : undefined,
      from: sortKey(pickFirstAddr((msg.envelope as { from?: { address?: string }[] } | undefined)?.from)),
      to: sortKey(pickFirstAddr((msg.envelope as { to?: { address?: string }[] } | undefined)?.to)),
      subject: sortKey((msg.envelope as { subject?: string } | undefined)?.subject),
      sentAt: (msg.envelope as { date?: Date | string } | undefined)?.date
        ? new Date((msg.envelope as { date: Date | string }).date).getTime()
        : 0,
      flags: msg.flags ? new Set(msg.flags) : undefined,
    });
  }
  return out;
}

const SORT_KEY_CHARS = 256;

function sortKey(v: unknown): string | undefined {
  return typeof v === "string" ? v.slice(0, SORT_KEY_CHARS).toLowerCase() : undefined;
}

function pickFirstAddr(addrs: { address?: string }[] | undefined): string | undefined {
  return addrs?.[0]?.address ?? undefined;
}

// Post-filter emailIds by their bodyStructure-derived hasAttachment flag.
// IMAP doesn't expose attachment presence as a SEARCH criterion (without an
// extension), so this runs an extra FETCH per mailbox group. Performance is
// fine for v1 — clients that page narrowly stay snappy; the slow path is
// only triggered when the filter explicitly asks for hasAttachment.
async function postFilterByHasAttachment(
  ctx: MailCtx,
  ids: string[],
  want: boolean,
): Promise<string[]> {
  if (ids.length === 0) return ids;
  // One group per mailbox and UIDVALIDITY epoch, so cache rows are read and
  // written under the epoch the ids name.
  const groups = new Map<string, { mailboxIdx: number; gids: string[] }>();
  for (const id of ids) {
    let parts;
    try { parts = decodeEmailId(id); } catch { continue; }
    if (parts.accountIdx !== ctx.account.id) continue;
    const key = `${parts.mailboxIdx}:${parts.uidvalidity}`;
    const g = groups.get(key) ?? { mailboxIdx: parts.mailboxIdx, gids: [] };
    g.gids.push(id);
    groups.set(key, g);
  }
  const keep = new Set<string>();
  for (const { mailboxIdx, gids } of groups.values()) {
    const row = ctx.store
      .prep(`SELECT id, name FROM mailbox WHERE id = ? AND account_id = ?`)
      .get(mailboxIdx, ctx.account.id) as { id: number; name: string } | undefined;
    if (!row) continue;
    const uidByEid = new Map<number, string>();
    let uidvalidity = 0;
    for (const id of gids) {
      try {
        const parts = decodeEmailId(id);
        uidByEid.set(parts.uid, id);
        uidvalidity = parts.uidvalidity;
      } catch { /* skip */ }
    }
    if (uidByEid.size === 0) continue;

    // BODYSTRUCTURE is immutable — serve from the cache and only FETCH the
    // gaps (persisting them, so repeat hasAttachment filters are IMAP-free).
    const cachedRows = ctx.store.getEmailCacheRows(
      ctx.account.id, mailboxIdx, uidvalidity, [...uidByEid.keys()],
    );
    const missingUids: number[] = [];
    for (const [uid, eid] of uidByEid) {
      const cached = cachedRows.get(uid);
      const len = cached?.bodystructure_len ?? 0;
      if (len > 0 && len <= MAX_BODYSTRUCTURE_JSON_CHARS) {
        // One row at a time, keeping only the predicate.
        try {
          const bs = ctx.store.getEmailCacheMeta(ctx.account.id, mailboxIdx, uidvalidity, uid)?.bodystructure;
          if (bs && bs !== "null") {
            if (bodyStructureHasAttachment(boundBodyStructure(JSON.parse(bs))) === want) keep.add(eid);
            continue;
          }
        } catch { /* corrupt row: refetch */ }
      }
      missingUids.push(uid);
    }
    if (missingUids.length === 0) continue;
    try {
      await withMailbox(ctx.client, row.name, async () => {
        if (!isCurrentEpoch(ctx.client, uidvalidity)) return; // stale ids: filtered out
        // Bounded like Email/get's, judged as each arrives, and written in
        // batches: the filter keeps only the predicate per message.
        let upserts: EmailCacheUpsert[] = [];
        for await (const msg of fetchByUid(ctx.client, missingUids, { uid: true, bodyStructure: true })) {
          const uid = Number(msg.uid);
          const eid = uidByEid.get(uid);
          // A FLAGS-only FETCH pushed mid-command has no structure to judge by.
          if (!eid || !msg.bodyStructure) continue;
          const bs = boundBodyStructure(msg.bodyStructure);
          if (bodyStructureHasAttachment(bs) === want) keep.add(eid);
          upserts.push({
            accountId: ctx.account.id,
            mailboxId: mailboxIdx,
            uidvalidity,
            uid,
            bodystructure: JSON.stringify(bs),
          });
          if (upserts.length >= 256) {
            ctx.store.upsertEmailCacheRows(upserts);
            upserts = [];
          }
        }
        ctx.store.upsertEmailCacheRows(upserts);
      });
    } catch {
      // Skip folders we can't open; their candidates fall out of the filter.
    }
  }
  return ids.filter((id) => keep.has(id));
}

// Walk a BODYSTRUCTURE tree and decide whether the message has attachments.
// Definition matches the JMAP convention: a part is an attachment if it has
// a Content-Disposition: attachment, or it isn't a top-level text/* / multipart.
function bodyStructureHasAttachment(bs: unknown): boolean {
  if (!bs || typeof bs !== "object") return false;
  const node = bs as { type?: string; disposition?: string; childNodes?: unknown[]; description?: unknown };
  const type = (node.type ?? "").toLowerCase();
  if (Array.isArray(node.childNodes)) {
    for (const c of node.childNodes) if (bodyStructureHasAttachment(c)) return true;
  }
  if (typeof node.disposition === "string" && node.disposition.toLowerCase() === "attachment") {
    return true;
  }
  // Inline image attachments / unknown leaf parts that aren't text or
  // multipart count as attachments per JMAP convention.
  if (
    !type.startsWith("multipart/") &&
    !type.startsWith("text/") &&
    !Array.isArray(node.childNodes)
  ) {
    return true;
  }
  return false;
}

async function emailQuerySingleMailboxFull(
  ctx: MailCtx,
  filter: Filter,
  imapFilter: ReturnType<typeof compileFilter>,
  inMailbox: string,
  sort: SortSpec[],
  ascending: boolean,
  needsFetch: boolean,
  window?: DateWindow,
): Promise<{ ids: string[]; queryState: string }> {
  const m = decodeMailboxId(inMailbox);
  const mboxRow = ctx.store
    .prep(`SELECT * FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(m.mailboxIdx, ctx.account.id) as { name: string; uidvalidity: number } | undefined;
  if (!mboxRow) throw invalidArguments("unknown mailbox");

  return await withMailbox(ctx.client, mboxRow.name, async () => {
    const status = ctx.client.mailbox && typeof ctx.client.mailbox === "object" ? ctx.client.mailbox : null;
    const uidvalidity = Number(
      (status as { uidValidity?: number | bigint } | null)?.uidValidity ?? mboxRow.uidvalidity,
    );
    const modseq = Number((status as { highestModseq?: bigint } | null)?.highestModseq ?? 0n);
    const emailState = viewState(ctx, ctx.client);

    const cacheKey = searchCacheKey(ctx.account.id, m.mailboxIdx, uidvalidity, windowedCacheKey(filter, window));
    let uids: number[] | null = null;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.modseq === modseq && cached.emailState === emailState && cached.expiresAt > Date.now()) {
      uids = cached.uids;
    }
    if (!uids) {
      const searchResult = await ctx.client.search(windowedSearch(imapFilter, window), { uid: true });
      uids = Array.isArray(searchResult) ? (searchResult as number[]) : [];
      searchCache.set(cacheKey, {
        uids,
        modseq,
        emailState,
        expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
      });
      pruneSearchCache();
    }
    let orderedUids: number[];
    // Fast path: a pure receivedAt sort (or no sort) is UID order in a single
    // mailbox — SEARCH already returned UIDs ascending, so no FETCH at all.
    // Virtually every client sends `[{property:"receivedAt",isAscending:false}]`,
    // so this is the path folder listing takes.
    const pureReceivedAt =
      sort.length === 0 || (sort.length === 1 && sort[0]!.property === "receivedAt");
    if (pureReceivedAt) {
      // Explicit comparator: RFC 8620 defaults isAscending to true. No
      // comparator at all: keep the legacy newest-first default.
      const uidAscending = sort.length > 0 ? sort[0]!.isAscending !== false : ascending;
      orderedUids = uidAscending ? uids : uids.slice().reverse();
    } else {
      const meta = await fetchSortMetadata(ctx.client, uids, needsFetch);
      const hits: SortableHit[] = uids.map((uid) => ({
        mailboxIdx: m.mailboxIdx,
        uidvalidity,
        uid,
        ...meta.get(uid),
      }));
      hits.sort((a, b) => compareHits(a, b, sort));
      orderedUids = hits.map((h) => h.uid);
    }
    const orderedIds = orderedUids.map((uid) =>
      encodeEmailId({ accountIdx: ctx.account.id, mailboxIdx: m.mailboxIdx, uidvalidity, uid }),
    );
    return {
      ids: orderedIds,
      // queryState is intentionally the account-wide counter rather than the
      // per-mailbox (uidvalidity, modseq) tuple. Email/queryChanges has only
      // the account state to compare against — tying them together lets the
      // "no-change" fast path return an empty diff without recomputing the
      // search server-side. Mailbox-specific staleness still surfaces via
      // the search cache. It is the state this connection's view includes
      // (see viewState), not whatever the counter reads by now.
      queryState: encodeEmailState({ uidvalidity: 0, modseq: emailState }),
    };
  });
}

// Account-wide Email/query. Spec-compliant fallback for clients that don't pin
// a mailbox; the IMAP SEARCH happens once per folder. Slow on large accounts,
// but the fast path remains pinned-mailbox queries that share the cache.
//
// Sort is by INTERNALDATE across folders. We FETCH internaldate for every
// matching UID (one batched FETCH per folder), then merge; this is the only
// way to honor `receivedAt` ordering without a server-side index. For unfiltered
// scans on huge accounts a future optimisation would be to do a coarse sort by
// per-folder UID descending and only fetch the slice.
// How many folders an account-wide query scans at once. The bulk pool is the
// real ceiling; going one above it keeps a worker queued so a freed
// connection is picked up immediately rather than sitting idle.
const ACCOUNT_SCAN_CONCURRENCY = 3;

// Account-wide queries (tag counts, "all folders" searches) used to SELECT and
// SEARCH every folder whenever the account's email state had moved, and any
// write -- opening a message sets $seen -- moves it. A client that refreshes a
// handful of tag counts after each open then kept every connection busy for
// tens of seconds. Each folder's SEARCH result is now kept with the folder's
// HIGHESTMODSEQ, UIDNEXT and message count from LIST-STATUS (RFC 7162: any
// flag change, arrival or expunge in the folder raises HIGHESTMODSEQ), and
// reused for as long as those are unchanged, so only folders that changed are
// searched again. One LIST-STATUS serves a burst of queries.
interface FolderStatus {
  uidValidity: number;
  uidNext: number;
  messages: number;
  modseq: string;
}
interface FolderSnapshot {
  emailState: number;
  at: number;
  byPath: Map<string, FolderStatus>;
}
const folderSnapshots = new Map<number, FolderSnapshot>();
const folderSnapshotInflight = new Map<number, Promise<FolderSnapshot>>();
// How long one LIST-STATUS answers for, while the account's state stays put.
const FOLDER_SNAPSHOT_TTL_MS = 5_000;

interface FolderSearchEntry extends FolderStatus {
  uids: number[];
}
const folderSearchCache = new Map<string, FolderSearchEntry>();
const FOLDER_SEARCH_CACHE_MAX = 4096;

async function folderSnapshot(ctx: MailCtx, emailState: number): Promise<FolderSnapshot | null> {
  const id = ctx.account.id;
  const cur = folderSnapshots.get(id);
  if (cur && cur.emailState === emailState && Date.now() - cur.at < FOLDER_SNAPSHOT_TTL_MS) return cur;
  let running = folderSnapshotInflight.get(id);
  if (!running) {
    running = (async () => {
      const at = Date.now();
      const list = await ctx.client.list({
        statusQuery: { messages: true, uidNext: true, uidValidity: true, highestModseq: true },
      });
      const byPath = new Map<string, FolderStatus>();
      for (const it of list) {
        const st = it.status as
          | { messages?: number; uidNext?: number; uidValidity?: number | bigint; highestModseq?: number | bigint }
          | undefined;
        if (st?.uidNext == null || st.uidValidity == null || st.messages == null || st.highestModseq == null) continue;
        byPath.set(it.path, {
          uidValidity: Number(st.uidValidity),
          uidNext: Number(st.uidNext),
          messages: st.messages,
          modseq: String(st.highestModseq),
        });
      }
      const snap = { emailState, at, byPath };
      folderSnapshots.set(id, snap);
      return snap;
    })();
    folderSnapshotInflight.set(id, running);
    running.finally(() => folderSnapshotInflight.delete(id)).catch(() => {});
  }
  try {
    const snap = await running;
    // A snapshot read for an older state is no good to a newer caller.
    return snap.emailState === emailState ? snap : null;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "account-wide Email/query: LIST-STATUS failed; searching every folder");
    return null;
  }
}

/** Forget the in-memory search caches, as a restart does (tests). */
export function resetSearchCachesInMemory(): void {
  searchCache.clear();
  folderSearchCache.clear();
  folderSnapshots.clear();
}

function sameFolderStatus(a: FolderStatus, b: FolderStatus): boolean {
  return a.uidValidity === b.uidValidity && a.uidNext === b.uidNext && a.messages === b.messages && a.modseq === b.modseq;
}

// The results also live in SQLite (folder_search_cache), so a restart does
// not cost one full re-search of every folder: a row is only ever used while
// the folder's live STATUS matches the one it was filed under, and rows of an
// older UIDVALIDITY are dropped when a newer one is filed.
function getFolderSearch(store: Store, accountId: number, idx: number, uidvalidity: number, filterHash: string): FolderSearchEntry | null {
  const key = `${accountId}|${idx}|${uidvalidity}|${filterHash}`;
  const mem = folderSearchCache.get(key);
  if (mem) return mem;
  try {
    const row = store.getFolderSearch(accountId, idx, uidvalidity, filterHash);
    if (!row) return null;
    const uids = JSON.parse(row.uids) as unknown;
    if (!Array.isArray(uids) || !uids.every((u) => Number.isInteger(u) && u > 0)) return null;
    const entry: FolderSearchEntry = { uidValidity: uidvalidity, uidNext: row.uid_next, messages: row.messages, modseq: row.modseq, uids: uids as number[] };
    rememberFolderSearch(key, entry);
    return entry;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "folder search cache read failed");
    return null;
  }
}

// Above this many hits a result is kept in memory only.
const FOLDER_SEARCH_PERSIST_MAX_UIDS = 50_000;

function putFolderSearch(store: Store, accountId: number, idx: number, filterHash: string, entry: FolderSearchEntry): void {
  rememberFolderSearch(`${accountId}|${idx}|${entry.uidValidity}|${filterHash}`, entry);
  if (entry.uids.length > FOLDER_SEARCH_PERSIST_MAX_UIDS) return;
  try {
    store.putFolderSearch({
      accountId, mailboxId: idx, uidvalidity: entry.uidValidity, filterHash,
      uidNext: entry.uidNext, messages: entry.messages, modseq: entry.modseq, uids: JSON.stringify(entry.uids),
    }, FOLDER_SEARCH_CACHE_MAX);
  } catch (e) {
    log.warn({ err: (e as Error).message }, "folder search cache write failed");
  }
}

function rememberFolderSearch(key: string, entry: FolderSearchEntry): void {
  folderSearchCache.delete(key);
  folderSearchCache.set(key, entry);
  if (folderSearchCache.size <= FOLDER_SEARCH_CACHE_MAX) return;
  const drop = folderSearchCache.size - FOLDER_SEARCH_CACHE_MAX;
  let i = 0;
  for (const k of folderSearchCache.keys()) {
    if (i++ >= drop) break;
    folderSearchCache.delete(k);
  }
}

async function emailQueryAccountWideFull(
  ctx: MailCtx,
  filter: Filter,
  imapFilter: ReturnType<typeof compileFilter>,
  sort: SortSpec[],
  ascending: boolean,
  needsFetch: boolean,
  window?: DateWindow,
): Promise<{ ids: string[]; queryState: string }> {
  const otherThan = findInMailboxOtherThan(filter);
  const excludedIdxs = new Set<number>();
  if (otherThan) {
    for (const enc of otherThan) {
      try {
        excludedIdxs.add(decodeMailboxId(enc).mailboxIdx);
      } catch {
        throw invalidArguments(`invalid inMailboxOtherThan id: ${enc}`);
      }
    }
  }

  // Folders are scanned on bulk connections leased after this one, so their
  // views include at least the state this connection is at.
  const emailState = viewState(ctx, ctx.client);
  const all = await listMailboxes(ctx.client, ctx.account, ctx.store);
  type MboxRow = { id: number; name: string; uidvalidity: number };
  const rows = ctx.store
    .prep(`SELECT id, name, uidvalidity FROM mailbox WHERE account_id = ?`)
    .all(ctx.account.id) as MboxRow[];
  const rowById = new Map(rows.map((r) => [r.id, r] as const));

  // Each folder is an independent SELECT + SEARCH (+ maybe FETCH). Walking
  // them one at a time made an account-wide query cost the sum of every
  // folder's round trips; imapflow serialises commands per socket, so the
  // only way to overlap them is to give each folder its own connection.
  // They ride the bulk role -- this is the long scan that role exists for --
  // and the pool bounds how many actually go out at once.
  //
  // Each folder's hits are collected separately and concatenated in
  // listMailboxes order, so the merge below sees exactly the input it saw
  // when this ran serially. The result is identical, only sooner.
  //
  // Per-folder STATUS, for reusing SEARCH results of folders that did not
  // change. Without it (LIST failed, or a server without CONDSTORE) every
  // folder is searched, as before.
  const snapshot = await folderSnapshot(ctx, emailState);
  const filterHash = createHash("sha256").update(stableHash(windowedCacheKey(filter, window))).digest("hex");

  const targets: Array<{ idx: number; row: MboxRow }> = [];
  for (const m of all) {
    const idx = decodeMailboxId(m.id).mailboxIdx;
    if (excludedIdxs.has(idx)) continue;
    // An empty folder can't contribute matches; skip the SELECT + SEARCH
    // round trips. The count comes from the cached LIST STATUS (<=30s stale,
    // the same window the search cache already tolerates).
    const row = rowById.get(idx);
    if (!row) continue;
    // The fresh STATUS when there is one, else the cached LIST's count.
    if ((snapshot?.byPath.get(row.name)?.messages ?? m.totalEmails) === 0) continue;
    targets.push({ idx, row });
  }

  // A folder whose STATUS still matches its cached SEARCH needs no
  // connection: the hits come from that result and the cached dates. Null
  // when it has to be searched (or a date has to be fetched).
  const cachedFolderHits = (idx: number, row: MboxRow): SortableHit[] | null => {
    if (needsFetch || !snapshot) return null;
    const live = snapshot.byPath.get(row.name);
    if (!live) return null;
    const hit = getFolderSearch(ctx.store, ctx.account.id, idx, live.uidValidity, filterHash);
    if (!hit || !sameFolderStatus(hit, live)) return null;
    if (hit.uids.length === 0) return [];
    const rows = ctx.store.getEmailCacheRows(ctx.account.id, idx, live.uidValidity, hit.uids);
    const found: SortableHit[] = [];
    for (const uid of hit.uids) {
      const r = rows.get(uid);
      if (!r || !(r.internaldate > 0)) return null;
      found.push({ mailboxIdx: idx, uidvalidity: live.uidValidity, uid, receivedAt: r.internaldate });
    }
    return found;
  };

  const scanFolder = async (idx: number, row: MboxRow, client: ImapFlow): Promise<SortableHit[]> => {
    const found: SortableHit[] = [];
    await withMailbox(client, row.name, async () => {
      const status =
        client.mailbox && typeof client.mailbox === "object" ? client.mailbox : null;
      const uidvalidity = Number(
        (status as { uidValidity?: number | bigint } | null)?.uidValidity ?? row.uidvalidity,
      );
      const modseq = Number((status as { highestModseq?: bigint } | null)?.highestModseq ?? 0n);
      const emailState = viewState(ctx, client);

      const cacheKey = searchCacheKey(ctx.account.id, idx, uidvalidity, windowedCacheKey(filter, window));
      let uids: number[] | null = null;
      const cached = searchCache.get(cacheKey);
      if (cached && cached.modseq === modseq && cached.emailState === emailState && cached.expiresAt > Date.now()) {
        uids = cached.uids;
      }
      // The folder STATUS read before this SEARCH; the result is filed under
      // it, so a change made in between only causes a needless re-search.
      const live = snapshot?.byPath.get(row.name);
      if (!uids && live && live.uidValidity === uidvalidity) {
        const prev = getFolderSearch(ctx.store, ctx.account.id, idx, uidvalidity, filterHash);
        if (prev && sameFolderStatus(prev, live)) uids = prev.uids;
      }
      if (!uids) {
        const searchResult = await client.search(windowedSearch(imapFilter, window), { uid: true });
        uids = Array.isArray(searchResult) ? (searchResult as number[]) : [];
        searchCache.set(cacheKey, {
          uids,
          modseq,
          emailState,
          expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
        });
        pruneSearchCache();
        if (live && live.uidValidity === uidvalidity) putFolderSearch(ctx.store, ctx.account.id, idx, filterHash, { ...live, uids });
      }
      if (uids.length === 0) return;

      // Cross-folder merge needs receivedAt for every hit. Prefer the
      // cached internaldate (populated by the thread scan and Email/get) —
      // for warm accounts this drops the FETCH entirely. Sorts on other
      // properties still need the live envelope/size/flags FETCH.
      const meta = new Map<
        number,
        { size?: number; from?: string; to?: string; subject?: string; sentAt?: number; receivedAt?: number; flags?: Set<string> }
      >();
      let toFetch = uids;
      if (!needsFetch) {
        const cachedRows = ctx.store.getEmailCacheRows(ctx.account.id, idx, uidvalidity, uids);
        toFetch = [];
        for (const uid of uids) {
          const row = cachedRows.get(uid);
          if (row && row.internaldate > 0) meta.set(uid, { receivedAt: row.internaldate });
          else toFetch.push(uid);
        }
      }
      if (toFetch.length > 0) {
        const fetched = await fetchSortMetadata(client, toFetch, needsFetch);
        for (const [uid, m2] of fetched) meta.set(uid, m2);
        if (!needsFetch) {
          // Remember the dates so the next account-wide query is FETCH-free.
          const upserts: EmailCacheUpsert[] = [];
          for (const [uid, m2] of fetched) {
            if (m2.receivedAt) {
              upserts.push({
                accountId: ctx.account.id,
                mailboxId: idx,
                uidvalidity,
                uid,
                internaldate: m2.receivedAt,
              });
            }
          }
          ctx.store.upsertEmailCacheRows(upserts);
        }
      }
      for (const uid of uids) {
        const m2 = meta.get(uid);
        found.push({ mailboxIdx: idx, uidvalidity, uid, ...m2 });
      }
    });
    return found;
  };

  const perFolder = await mapWithConcurrency(targets, ACCOUNT_SCAN_CONCURRENCY, async (t) => {
    const cachedHits = cachedFolderHits(t.idx, t.row);
    if (cachedHits) return cachedHits;
    try {
      // Unit-test contexts are built without a pool; fall back to the
      // request's own connection, which reproduces the old serial walk.
      if (!ctx.pool) return await scanFolder(t.idx, t.row, ctx.client);
      return await ctx.pool.withConnection(ctx.account, "bulk", (client) =>
        scanFolder(t.idx, t.row, client),
      );
    } catch (e) {
      // A folder can disappear between LIST and SELECT (concurrent mutation),
      // and the DB may carry rows for folders the server no longer reports.
      // Skip rather than fail the whole query - pinned-mailbox queries still
      // surface mailbox errors loudly.
      log.warn(
        { mailbox: t.row.name, err: (e as Error).message },
        "account-wide Email/query: skipping mailbox",
      );
      return [] as SortableHit[];
    }
  });
  const hits: SortableHit[] = perFolder.flat();

  const effectiveSort: SortSpec[] = sort.length
    ? sort
    : [{ property: "receivedAt", isAscending: ascending }];
  hits.sort((a, b) => compareHits(a, b, effectiveSort));
  const orderedIds = hits.map((h) =>
    encodeEmailId({
      accountIdx: ctx.account.id,
      mailboxIdx: h.mailboxIdx,
      uidvalidity: h.uidvalidity,
      uid: h.uid,
    }),
  );
  return {
    ids: orderedIds,
    queryState: encodeEmailState({ uidvalidity: 0, modseq: emailState }),
  };
}

export async function emailGet(
  args: {
    accountId: string;
    ids: string[];
    properties?: string[];
    fetchTextBodyValues?: boolean;
    fetchHTMLBodyValues?: boolean;
    fetchAllBodyValues?: boolean;
    maxBodyValueBytes?: number;
  },
  ctx: MailCtx,
): Promise<{ accountId: string; state: string; list: Record<string, unknown>[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  // RFC 8620 §5.1: more ids than the advertised maxObjectsInGet is an error,
  // not a request to buffer however many messages a client names.
  if (Array.isArray(args.ids) && args.ids.length > (ctx.maxObjectsInGet ?? DEFAULT_MAX_OBJECTS_IN_GET)) {
    throw new JmapError("requestTooLarge", `at most ${ctx.maxObjectsInGet ?? DEFAULT_MAX_OBJECTS_IN_GET} ids per Email/get`);
  }
  const budgets = ctx.budgets ?? newRequestBudgets();
  // The state these messages are read at; see viewState.
  const state = encodeEmailState({ uidvalidity: 0, modseq: viewState(ctx, ctx.client) });
  const projected: Record<string, unknown>[] = [];
  // Every emitted header projection draws on budgets.projection, and every
  // emitted property on budgets.response (see projectEmailForGet).
  const properties = args.properties ? [...new Set(args.properties)] : undefined;
  // RFC 8621 §4.1.3 header property grammar: a field name of printable ASCII
  // without colon, an optional form, an optional :all. Anything else is not a
  // property we can answer, and must not be echoed back as a key.
  for (const p of properties ?? []) {
    if (typeof p !== "string" || (p.startsWith("header:") && !/^header:[!-9;-~]{1,256}(?::as[A-Za-z]+)?(?::all)?$/.test(p))) {
      throw invalidArguments(`invalid property: ${JSON.stringify(String(p)).slice(0, 80)}`);
    }
  }
  if ((properties ?? []).filter((p) => p.startsWith("header:")).length > MAX_HEADER_PROPERTIES) {
    throw new JmapError("requestTooLarge", `at most ${MAX_HEADER_PROPERTIES} header:* properties per Email/get`);
  }
  const notFound: string[] = [];
  // If the client picked an explicit property set, skip the preview FETCH
  // unless `preview` was requested. This is the common path for header-only
  // list views and saves one IMAP round trip per Email/get page.
  const wantsPreview =
    args.properties === undefined || args.properties.includes("preview");
  // Only `headers` and `header:*` projections need the complete header block;
  // everything else (references, threading) is covered by the threading-field
  // subset, which is a fraction of the bytes on modern messages.
  const needsFullHeaders =
    args.properties?.some((p) => p === "headers" || p.startsWith("header:")) ?? false;
  const bodyOpts = {
    fetchTextBodyValues: args.fetchTextBodyValues,
    fetchHTMLBodyValues: args.fetchHTMLBodyValues,
    fetchAllBodyValues: args.fetchAllBodyValues,
    maxBodyValueBytes: args.maxBodyValueBytes,
    wantsPreview,
    needsFullHeaders,
    // One set of budgets for the whole request, across its mailbox groups.
    headerBudget: budgets.header,
    bodyBudget: budgets.body,
    metadataBudget: budgets.metadata,
    signal: budgets.signal,
  };

  // Group ids by mailbox so we can do one SELECT + one batched FETCH per
  // mailbox, instead of one per id. UI flows (open thread, open folder)
  // typically request many ids in the same mailbox.
  type Group = { mailboxIdx: number; entries: { id: string; uid: number; uidvalidity: number }[] };
  const groups = new Map<number, Group>();
  // RFC 8620 §5.1: an id given more than once is answered once. Ids are
  // canonical (decodeEmailId), so one message is fetched and projected once.
  for (const id of new Set(args.ids)) {
    let parts;
    try {
      parts = decodeEmailId(id);
    } catch {
      notFound.push(id);
      continue;
    }
    if (parts.accountIdx !== ctx.account.id) {
      notFound.push(id);
      continue;
    }
    let g = groups.get(parts.mailboxIdx);
    if (!g) {
      g = { mailboxIdx: parts.mailboxIdx, entries: [] };
      groups.set(parts.mailboxIdx, g);
    }
    g.entries.push({ id, uid: parts.uid, uidvalidity: parts.uidvalidity });
  }

  for (const group of groups.values()) {
    const mboxRow = ctx.store
      .prep(`SELECT * FROM mailbox WHERE id = ? AND account_id = ?`)
      .get(group.mailboxIdx, ctx.account.id) as
      | { id: number; name: string; uidvalidity: number; highest_modseq: number }
      | undefined;
    if (!mboxRow) {
      for (const e of group.entries) notFound.push(e.id);
      continue;
    }
    let current = group.entries;
    const fetched = await withMailbox(ctx.client, mboxRow.name, async () => {
      // Use the live uidvalidity from the SELECTed mailbox so the response
      // ids round-trip with what Email/query returned. The cached value in
      // the mailbox row starts at 0 and is never refreshed by listMailboxes.
      // Ids from another UIDVALIDITY epoch are stale: notFound, not fetched.
      const liveUv = selectedUidValidity(ctx.client);
      current = group.entries.filter((e) => e.uidvalidity === liveUv);
      const uids = current.map((e) => e.uid);
      if (liveUv === null || uids.length === 0) return new Map<number, JmapEmail>();
      const mailboxArg = {
        ...mboxRow,
        uidvalidity: liveUv,
        account_id: ctx.account.id,
        parent_id: null,
        delim: "/",
        role: null,
        special_use: null,
        total: 0,
        unread: 0,
        subscribed: 0,
        last_seen: 0,
      } as never;
      checkAborted(budgets.signal);
      return fetchEmailsBatch(ctx.client, ctx.account, mailboxArg, uids, bodyOpts, ctx.store);
    }).catch((e) => {
      if (e instanceof BudgetExceededError) throw new JmapError("requestTooLarge", e.message);
      throw e;
    });
    for (const e of group.entries) {
      const meta = current.includes(e) ? fetched.get(e.uid) : undefined;
      // The message found must be the one the id names: its id is built from
      // the live UIDVALIDITY, so an id with another epoch (or any other
      // spelling of the same UID) is notFound, and each message is listed once.
      // Projected (and charged) as each group arrives, so a request over its
      // budgets stops before holding every group's results.
      if (meta && meta.id === e.id) projected.push(projectEmailForGet(meta, properties, budgets));
      else notFound.push(e.id);
    }
  }
  return {
    accountId: args.accountId,
    state,
    list: projected,
    notFound,
  };
}

// Build the response object for one Email/get hit. Honors the `properties`
// filter (RFC 8620 §5.1) and resolves `header:Foo[:asForm]` projections from
// the parsed header block we attached during fetch. Strips the internal
// `_headers` field unconditionally.
function projectEmailForGet(
  email: JmapEmail,
  properties: string[] | undefined,
  budgets: Pick<RequestBudgets, "projection" | "response">,
): Record<string, unknown> {
  const tooLarge = (what: string, limit: number) =>
    new JmapError("requestTooLarge", `${what} exceed ${limit} characters; request fewer ids or properties`);
  const emit = <T>(value: T, header: boolean): T => {
    const n = projectedChars(value);
    if (header) {
      budgets.projection.remaining -= n;
      if (budgets.projection.remaining < 0) throw tooLarge("header projections", MAX_FULL_HEADER_BYTES_PER_CALL);
    }
    budgets.response.remaining -= n;
    if (budgets.response.remaining < 0) throw tooLarge("Email/get responses", MAX_RESPONSE_CHARS);
    return value;
  };
  const headers = email._headers;
  // One pass over the header list, then a lookup per projection: requesting
  // many (absent) header names must not rescan a large header block each time.
  let byName: Map<string, ParsedHeader[]> | null = null;
  const headersNamed = (prop: string): ParsedHeader[] => {
    if (!byName) {
      byName = new Map();
      for (const h of headers) {
        const k = h.name.toLowerCase();
        const l = byName.get(k);
        if (l) l.push(h);
        else byName.set(k, [h]);
      }
    }
    const name = /^header:([^:]+)/.exec(prop)?.[1]?.toLowerCase() ?? "";
    return byName.get(name) ?? [];
  };
  // Equivalent spellings (case of the name and form, a default :asRaw) are
  // computed once per message and reused under each requested key.
  const projections = new Map<string, unknown>();
  const project = (prop: string): unknown => {
    const m = /^header:([^:]+)((?::[A-Za-z]+)*)$/.exec(prop);
    const mods = (m?.[2] ?? "").toLowerCase().split(":").filter(Boolean);
    const key = `${(m?.[1] ?? prop).toLowerCase()}:${mods[0] && mods[0] !== "all" ? mods[0] : "asraw"}${mods.includes("all") ? ":all" : ""}`;
    if (!projections.has(key)) projections.set(key, projectHeaderProp(headersNamed(prop), prop));
    return projections.get(key);
  };
  // Default property set per RFC 8621 §4.2 Email/get if the client doesn't
  // pick one. We mirror the upstream test suite's expectations here — id is
  // always present; everything else is included by default.
  const defaultProps = [
    "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt",
    "messageId", "inReplyTo", "references", "sender", "from", "to", "cc",
    "bcc", "replyTo", "subject", "sentAt", "hasAttachment", "preview",
    "bodyStructure", "textBody", "htmlBody", "attachments", "bodyValues",
  ];
  const props = properties ?? defaultProps;
  const out: Record<string, unknown> = { id: emit(email.id, false) };
  for (const p of props) {
    if (p === "id") continue;
    // The key goes out too, escaped.
    budgets.response.remaining -= Buffer.byteLength(JSON.stringify(p));
    if (p.startsWith("header:")) {
      out[p] = emit(project(p), true);
      continue;
    }
    if (p === "headers") {
      out.headers = emit(headersToEmailHeaders(headers), true);
      continue;
    }
    // Plain top-level property; copy through if we have it.
    if (Object.prototype.hasOwnProperty.call(email, p)) {
      out[p] = emit((email as unknown as Record<string, unknown>)[p], false);
    }
  }
  return out;
}

// Bytes a projected value adds to the serialized response: its JSON, escapes
// and UTF-8 included, plus room for the property name around it.
function projectedChars(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? "null") + 64;
}

// Account-wide email state used by Email/get and Email/set. Bumped by Email/set
// (and by submission). Email/query's `queryState` is intentionally a different
// shape: it encodes (uidvalidity, modseq) of the queried mailbox so refresh
// can be cheaper than a full counter compare.
function accountEmailState(store: Store, accountId: number): string {
  return encodeEmailState({ uidvalidity: 0, modseq: store.getState(accountId, "email") });
}

// --- Email/set ------------------------------------------------------------

interface MailboxLookup {
  id: number;
  name: string;
  uidvalidity: number;
}

export interface EmailSetArgs {
  accountId: string;
  ifInState?: string | null;
  create?: Record<string, Record<string, unknown>> | null;
  update?: Record<string, Record<string, unknown>> | null;
  destroy?: string[] | null;
}

interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export interface EmailSetResponse {
  accountId: string;
  oldState: string;
  newState: string;
  created: Record<string, unknown> | null;
  notCreated: Record<string, SetError> | null;
  updated: Record<string, unknown | null> | null;
  notUpdated: Record<string, SetError> | null;
  destroyed: string[] | null;
  notDestroyed: Record<string, SetError> | null;
}

export async function emailSet(
  args: EmailSetArgs,
  ctx: MailCtx,
): Promise<EmailSetResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();

  const oldState = accountEmailState(ctx.store, ctx.account.id);
  if (args.ifInState != null && args.ifInState !== oldState) {
    throw new JmapError("stateMismatch", "ifInState does not match current Email state");
  }

  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, unknown | null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};

  const touchedMailboxes = new Set<number>();

  for (const [cid, payload] of Object.entries(args.create ?? {})) {
    try {
      const res = await applyEmailCreate(payload as Record<string, unknown>, ctx);
      created[cid] = res;
      try { touchedMailboxes.add(decodeEmailId(res.id).mailboxIdx); } catch { /* opaque id */ }
    } catch (e) {
      notCreated[cid] = toSetError(e);
    }
  }

  // A client that went away gets no further mutations done in its name.
  const stopIfAborted = () => {
    if (ctx.budgets?.signal?.aborted) throw new JmapError("serverFail", "request aborted by the client");
  };
  stopIfAborted();
  await applyEmailUpdatesBatched(args.update ?? {}, ctx, { updated, notUpdated, touchedMailboxes });
  stopIfAborted();
  await applyEmailDestroysBatched(args.destroy ?? [], ctx, { destroyed, notDestroyed, touchedMailboxes });

  const mutated =
    Object.keys(created).length > 0 ||
    Object.keys(updated).length > 0 ||
    destroyed.length > 0;
  if (mutated) {
    invalidateSearchCacheForAccount(ctx.account.id, ctx.store, touchedMailboxes);
    ctx.store.recordChanges(ctx.account.id, "email", {
      created: Object.entries(created).map(([, r]) => (r as { id: string }).id),
      updated: Object.keys(updated),
      destroyed: [...destroyed],
    });
    // Folder counts (totalEmails / unreadEmails) move whenever we add, move,
    // delete, or change Seen — so any successful Email/set mutation also
    // invalidates the Mailbox state. Without this, clients keyed on
    // Mailbox.state never refresh the inbox unread counter after a flag flip.
    // We don't record per-mailbox-id changes here (they aren't meaningful
    // without knowing which folders the affected emails actually live in),
    // so any subsequent Mailbox/changes will see a state move with no log
    // entries → cannotCalculateChanges. That's the same answer it gave
    // before, just more explicit.
    ctx.store.bumpState(ctx.account.id, "mailbox");
    // Refresh counts for just the folders this mutation touched (one STATUS
    // each) so the next Mailbox/get doesn't pay a full LIST+STATUS sweep.
    await refreshMailboxCounts(ctx.client, ctx.account, ctx.store, [...touchedMailboxes]).catch(() => {});
  }

  return {
    accountId: args.accountId,
    oldState,
    newState: accountEmailState(ctx.store, ctx.account.id),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    updated: Object.keys(updated).length ? updated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    destroyed: destroyed.length ? destroyed : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}

function toSetError(e: unknown): SetError {
  if (e instanceof JmapError) return e.toMethodError() as SetError;
  return { type: "serverFail", description: (e as Error).message };
}

function lookupMailboxByIdx(
  store: Store,
  accountId: number,
  mailboxIdx: number,
): MailboxLookup | null {
  const row = store
    .prep(`SELECT id, name, uidvalidity FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(mailboxIdx, accountId) as MailboxLookup | undefined;
  return row ?? null;
}

function lookupMailboxByEncodedId(
  store: Store,
  accountId: number,
  encodedId: string,
): MailboxLookup {
  let parts;
  try {
    parts = decodeMailboxId(encodedId);
  } catch {
    throw new JmapError("invalidProperties", `unknown mailboxId: ${encodedId}`, {
      properties: ["mailboxIds"],
    });
  }
  if (parts.accountIdx !== accountId) {
    throw new JmapError("invalidProperties", "mailboxId belongs to a different account", {
      properties: ["mailboxIds"],
    });
  }
  const row = lookupMailboxByIdx(store, accountId, parts.mailboxIdx);
  if (!row) {
    throw new JmapError("invalidProperties", `unknown mailboxId: ${encodedId}`, {
      properties: ["mailboxIds"],
    });
  }
  return row;
}

interface ResolvedPatch {
  // Full replacement for mailboxIds (the `mailboxIds: {...}` form). null = no change.
  mailboxFull: string[] | null;
  // Partial patch entries (`mailboxIds/X = true | null | false`).
  mailboxAdd: Set<string>;
  mailboxRemove: Set<string>;
  keywordSet: Record<string, true> | null; // full replacement; null = no change
  keywordAdd: Set<string>;
  keywordRemove: Set<string>;
  // Properties the client tried to write that the IMAP backend can't change
  // in place. We return these in the SetError if they were the *only* fields
  // in the patch — otherwise we ignore them silently and let the writable
  // parts succeed (clients often resubmit the whole Email object).
  rejectedProperties: string[];
}

// IMAP-mutable JMAP Email properties (RFC 8621 §4.1). Anything else in a
// patch is server-derived (id, blobId, size, …) or part of the RFC822
// envelope, which we can't rewrite without re-APPENDing.
const WRITABLE_KEYS = new Set(["mailboxIds", "keywords"]);

function resolvePatch(patch: Record<string, unknown>): ResolvedPatch {
  const out: ResolvedPatch = {
    mailboxFull: null,
    mailboxAdd: new Set(),
    mailboxRemove: new Set(),
    keywordSet: null,
    keywordAdd: new Set(),
    keywordRemove: new Set(),
    rejectedProperties: [],
  };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "mailboxIds") {
      if (v === null || typeof v !== "object") {
        throw invalidArguments("mailboxIds must be an object");
      }
      out.mailboxFull = Object.keys(v as Record<string, unknown>).filter(
        (id) => (v as Record<string, unknown>)[id] === true,
      );
    } else if (k.startsWith("mailboxIds/")) {
      const id = k.slice("mailboxIds/".length);
      if (v === true) out.mailboxAdd.add(id);
      else if (v === null || v === false) out.mailboxRemove.add(id);
    } else if (k === "keywords") {
      if (v === null || typeof v !== "object") {
        throw invalidArguments("keywords must be an object");
      }
      const set: Record<string, true> = {};
      for (const [kw, val] of Object.entries(v as Record<string, unknown>)) {
        if (val === true) set[kw] = true;
      }
      out.keywordSet = set;
    } else if (k.startsWith("keywords/")) {
      const kw = k.slice("keywords/".length);
      if (v === true) out.keywordAdd.add(kw);
      else if (v === null || v === false) out.keywordRemove.add(kw);
    } else {
      const root = k.split("/")[0]!;
      if (!WRITABLE_KEYS.has(root)) out.rejectedProperties.push(k);
    }
  }
  return out;
}

// Compute the final set of mailbox ids the client wants the message to live in,
// given the patch and the current single-mailbox membership. Returns null if
// the patch did not touch mailboxIds.
function computeNewMailboxIds(
  resolved: ResolvedPatch,
  currentEncodedId: string,
): string[] | null {
  if (resolved.mailboxFull !== null) return resolved.mailboxFull;
  if (resolved.mailboxAdd.size === 0 && resolved.mailboxRemove.size === 0) return null;
  const next = new Set<string>([currentEncodedId]);
  for (const id of resolved.mailboxAdd) next.add(id);
  for (const id of resolved.mailboxRemove) next.delete(id);
  return [...next];
}

interface UpdateOp {
  id: string;
  patch: Record<string, unknown>;
  uid: number;
  uidvalidity: number;
  srcMbox: MailboxLookup;
  resolved: ResolvedPatch;
  destMbox: MailboxLookup | null;
}

// Identical flag/move operations against the same source mailbox share one
// IMAP command: "mark 200 as read" is a single UID STORE instead of 200.
function updateOpSignature(op: UpdateOp): string {
  return JSON.stringify({
    set: op.resolved.keywordSet ? Object.keys(op.resolved.keywordSet).sort() : null,
    add: [...op.resolved.keywordAdd].sort(),
    rem: [...op.resolved.keywordRemove].sort(),
    dest: op.destMbox?.id ?? null,
  });
}

async function applyEmailUpdatesBatched(
  updates: Record<string, Record<string, unknown>>,
  ctx: MailCtx,
  out: {
    updated: Record<string, unknown | null>;
    notUpdated: Record<string, SetError>;
    touchedMailboxes: Set<number>;
  },
): Promise<void> {
  const groups = new Map<string, UpdateOp[]>();
  for (const [id, patch] of Object.entries(updates)) {
    // Per-id validation mirrors applyEmailUpdate; anything invalid fails just
    // that id, exactly as the sequential path did.
    try {
      const parts = decodeEmailIdSafe(id);
      if (parts.accountIdx !== ctx.account.id) throw notFound();
      const srcMbox = lookupMailboxByIdx(ctx.store, ctx.account.id, parts.mailboxIdx);
      if (!srcMbox) throw notFound();
      const resolved = resolvePatch(patch as Record<string, unknown>);
      const writableTouched =
        resolved.mailboxFull !== null ||
        resolved.mailboxAdd.size > 0 ||
        resolved.mailboxRemove.size > 0 ||
        resolved.keywordSet !== null ||
        resolved.keywordAdd.size > 0 ||
        resolved.keywordRemove.size > 0;
      if (!writableTouched && resolved.rejectedProperties.length > 0) {
        throw new JmapError(
          "invalidProperties",
          "the IMAP backend cannot edit these fields in place; only mailboxIds and keywords are mutable",
          { properties: resolved.rejectedProperties },
        );
      }
      const currentEncodedId = encodeMailboxId({
        accountIdx: ctx.account.id,
        mailboxIdx: srcMbox.id,
      });
      const newMailboxIds = computeNewMailboxIds(resolved, currentEncodedId);
      let destMbox: MailboxLookup | null = null;
      if (newMailboxIds !== null) {
        if (newMailboxIds.length === 0) {
          // Empty mailboxIds = removed from all mailboxes ⇒ destroy. Rare;
          // apply individually.
          await applyEmailDestroy(id, ctx);
          out.updated[id] = null;
          out.touchedMailboxes.add(srcMbox.id);
          continue;
        }
        if (newMailboxIds.length > 1) {
          throw new JmapError(
            "invalidProperties",
            "multi-mailbox membership is not supported by the IMAP backend",
            { properties: ["mailboxIds"] },
          );
        }
        const [first] = newMailboxIds;
        if (!first) throw invalidArguments("mailboxIds entry missing");
        const target = lookupMailboxByEncodedId(ctx.store, ctx.account.id, first);
        if (target.id !== srcMbox.id) destMbox = target;
      }
      const op: UpdateOp = {
        id,
        patch: patch as Record<string, unknown>,
        uid: parts.uid,
        uidvalidity: parts.uidvalidity,
        srcMbox,
        resolved,
        destMbox,
      };
      const key = `${srcMbox.id}|${updateOpSignature(op)}`;
      const arr = groups.get(key) ?? [];
      arr.push(op);
      groups.set(key, arr);
    } catch (e) {
      out.notUpdated[id] = toSetError(e);
    }
  }

  for (const allOps of groups.values()) {
    const { srcMbox, resolved, destMbox } = allOps[0]!;
    let ops = allOps;
    let uids = ops.map((o) => o.uid);
    try {
      await withMailbox(ctx.client, srcMbox.name, async () => {
        ops = allOps.filter((o) => isCurrentEpoch(ctx.client, o.uidvalidity));
        uids = ops.map((o) => o.uid);
        if (ops.length === 0) return;
        // Flag changes precede the move: after MOVE the source UIDs are gone.
        if (resolved.keywordSet !== null) {
          const flags = Object.keys(resolved.keywordSet).map(keywordToFlag);
          await ctx.client.messageFlagsSet(uids, flags, { uid: true });
        } else {
          if (resolved.keywordAdd.size > 0) {
            const flags = [...resolved.keywordAdd].map(keywordToFlag);
            await ctx.client.messageFlagsAdd(uids, flags, { uid: true });
          }
          if (resolved.keywordRemove.size > 0) {
            const flags = [...resolved.keywordRemove].map(keywordToFlag);
            await ctx.client.messageFlagsRemove(uids, flags, { uid: true });
          }
        }
        if (destMbox) {
          const moved = await ctx.client.messageMove(uids, destMbox.name, { uid: true });
          if (!moved) {
            throw new JmapError("serverFail", `MOVE to "${destMbox.name}" failed`);
          }
        }
      });
      for (const op of allOps) if (!ops.includes(op)) out.notUpdated[op.id] = toSetError(notFound());
      if (ops.length === 0) continue;
      if (destMbox) {
        // Source rows are gone; the copies in destMbox have new UIDs that the
        // next scan / Email/get will cache under their own ids.
        ctx.store.deleteEmailCacheUids(ctx.account.id, srcMbox.id, uids);
      }
      for (const op of ops) out.updated[op.id] = null;
      out.touchedMailboxes.add(srcMbox.id);
      if (destMbox) out.touchedMailboxes.add(destMbox.id);
    } catch {
      // The batched command failed as a unit — retry each id individually so
      // per-id success/error reporting stays exact.
      for (const op of ops) {
        try {
          await applyEmailUpdate(op.id, op.patch, ctx);
          out.updated[op.id] = null;
          out.touchedMailboxes.add(op.srcMbox.id);
          if (op.destMbox) out.touchedMailboxes.add(op.destMbox.id);
        } catch (e) {
          out.notUpdated[op.id] = toSetError(e);
        }
      }
    }
  }
}

async function applyEmailDestroysBatched(
  ids: string[],
  ctx: MailCtx,
  out: {
    destroyed: string[];
    notDestroyed: Record<string, SetError>;
    touchedMailboxes: Set<number>;
  },
): Promise<void> {
  const groups = new Map<number, { mbox: MailboxLookup; entries: { id: string; uid: number; uidvalidity: number }[] }>();
  for (const id of ids) {
    try {
      const parts = decodeEmailIdSafe(id);
      if (parts.accountIdx !== ctx.account.id) throw notFound();
      const mbox = lookupMailboxByIdx(ctx.store, ctx.account.id, parts.mailboxIdx);
      if (!mbox) throw notFound();
      let g = groups.get(mbox.id);
      if (!g) {
        g = { mbox, entries: [] };
        groups.set(mbox.id, g);
      }
      g.entries.push({ id, uid: parts.uid, uidvalidity: parts.uidvalidity });
    } catch (e) {
      out.notDestroyed[id] = toSetError(e);
    }
  }
  for (const g of groups.values()) {
    try {
      const fresh = await withMailbox(ctx.client, g.mbox.name, async () => {
        const current = g.entries.filter((e) => isCurrentEpoch(ctx.client, e.uidvalidity));
        if (current.length > 0) {
          await ctx.client.messageDelete(current.map((e) => e.uid), { uid: true });
        }
        return current;
      });
      const freshIds = new Set(fresh.map((e) => e.id));
      for (const e of g.entries) if (!freshIds.has(e.id)) out.notDestroyed[e.id] = toSetError(notFound());
      if (fresh.length === 0) continue;
      ctx.store.deleteEmailCacheUids(ctx.account.id, g.mbox.id, fresh.map((e) => e.uid));
      for (const e of fresh) out.destroyed.push(e.id);
      out.touchedMailboxes.add(g.mbox.id);
    } catch {
      for (const e of g.entries) {
        try {
          await applyEmailDestroy(e.id, ctx);
          out.destroyed.push(e.id);
          out.touchedMailboxes.add(g.mbox.id);
        } catch (err) {
          out.notDestroyed[e.id] = toSetError(err);
        }
      }
    }
  }
}

export async function applyEmailUpdate(
  id: string,
  patch: Record<string, unknown>,
  ctx: MailCtx,
): Promise<void> {
  const parts = decodeEmailIdSafe(id);
  if (parts.accountIdx !== ctx.account.id) throw notFound();

  const srcMbox = lookupMailboxByIdx(ctx.store, ctx.account.id, parts.mailboxIdx);
  if (!srcMbox) throw notFound();

  const resolved = resolvePatch(patch);
  // If every key in the patch was a non-writable JMAP Email property (subject,
  // from, headers/*, ...), there's nothing for us to do — but silently
  // succeeding would lie to the client. Surface invalidProperties.
  const writableTouched =
    resolved.mailboxFull !== null ||
    resolved.mailboxAdd.size > 0 ||
    resolved.mailboxRemove.size > 0 ||
    resolved.keywordSet !== null ||
    resolved.keywordAdd.size > 0 ||
    resolved.keywordRemove.size > 0;
  if (!writableTouched && resolved.rejectedProperties.length > 0) {
    throw new JmapError(
      "invalidProperties",
      "the IMAP backend cannot edit these fields in place; only mailboxIds and keywords are mutable",
      { properties: resolved.rejectedProperties },
    );
  }

  const currentEncodedId = encodeMailboxId({
    accountIdx: ctx.account.id,
    mailboxIdx: srcMbox.id,
  });
  const newMailboxIds = computeNewMailboxIds(resolved, currentEncodedId);

  // Resolve mailbox move target (we only support single-mailbox membership).
  let destMbox: MailboxLookup | null = null;
  if (newMailboxIds !== null) {
    if (newMailboxIds.length === 0) {
      // Empty mailboxIds = email removed from all mailboxes ⇒ destroy.
      await applyEmailDestroy(id, ctx);
      return;
    }
    if (newMailboxIds.length > 1) {
      throw new JmapError(
        "invalidProperties",
        "multi-mailbox membership is not supported by the IMAP backend",
        { properties: ["mailboxIds"] },
      );
    }
    const [first] = newMailboxIds;
    if (!first) throw invalidArguments("mailboxIds entry missing");
    const target = lookupMailboxByEncodedId(ctx.store, ctx.account.id, first);
    if (target.id !== srcMbox.id) destMbox = target;
  }

  // Apply flag changes in the source mailbox first, then move. After MOVE the
  // UID in the source is gone, so flag operations must precede the move.
  await withMailbox(ctx.client, srcMbox.name, async () => {
    assertCurrentEpoch(ctx.client, parts.uidvalidity);
    if (resolved.keywordSet !== null) {
      const flags = Object.keys(resolved.keywordSet).map(keywordToFlag);
      await ctx.client.messageFlagsSet(`${parts.uid}`, flags, { uid: true });
    } else {
      if (resolved.keywordAdd.size > 0) {
        const flags = [...resolved.keywordAdd].map(keywordToFlag);
        await ctx.client.messageFlagsAdd(`${parts.uid}`, flags, { uid: true });
      }
      if (resolved.keywordRemove.size > 0) {
        const flags = [...resolved.keywordRemove].map(keywordToFlag);
        await ctx.client.messageFlagsRemove(`${parts.uid}`, flags, { uid: true });
      }
    }
    if (destMbox) {
      const moved = await ctx.client.messageMove(`${parts.uid}`, destMbox.name, { uid: true });
      if (!moved) {
        if (ctx.account.kind !== "gmail") {
          throw new JmapError("serverFail", `MOVE to "${destMbox.name}" failed`);
        }
        await refileByAppend(ctx.client, parts.uid, destMbox.name);
      }
    }
  });
}

// Gmail can refuse UID MOVE out of [Gmail]/Drafts once the draft has gone out
// through its own SMTP server, which left sent mail stuck in Drafts. Append a
// copy to the destination and expunge the source instead. Gmail folders are
// labels, so if the append lands on the same message (Gmail dedupes by
// Message-ID) the expunge only takes the Drafts label off it. Must run with
// the source mailbox selected.
export async function refileByAppend(client: ImapFlow, uid: number, destName: string): Promise<void> {
  const msg = await client.fetchOne(
    `${uid}`,
    { uid: true, source: true, flags: true, internalDate: true },
    { uid: true },
  );
  if (!msg || !msg.source) throw notFound();
  // \Recent belongs to the server's session state; APPEND may not set it.
  const flags = [...(msg.flags ?? [])].filter((f) => f !== "\\Recent");
  const appended = await client.append(destName, msg.source, flags.length ? flags : undefined, msg.internalDate);
  if (!appended) throw new JmapError("serverFail", `MOVE to "${destName}" failed, and so did APPEND`);
  if (!(await client.messageDelete(`${uid}`, { uid: true }))) {
    throw new JmapError("serverFail", `copied to "${destName}" but could not remove the original`);
  }
}

// The advertised maxSizeAttachmentsPerEmail; here it bounds everything a
// draft's MIME is built from: every occurrence of every blob and body value.
export const MAX_COMPOSE_CONTENT_BYTES = 50_000_000;
// Worst-case transfer-encoding growth, line breaks included, and a generous
// allowance for headers and multipart boundaries.
const QP_WORST = (3 * 79) / 76;
const BASE64_WORST = (4 / 3) * (78 / 76);
const MIME_OVERHEAD_BYTES = 1024 * 1024;

interface CreatedEmailResult {
  id: string;
  blobId: string;
  threadId: string;
  size: number;
}

async function applyEmailCreate(
  payload: Record<string, unknown>,
  ctx: MailCtx,
): Promise<CreatedEmailResult> {
  // Types first: nothing below may see an object where JMAP has a string.
  try {
    validateEmailCreate(payload);
  } catch (e) {
    if (e instanceof InvalidEmailCreateError) {
      throw new JmapError("invalidProperties", e.message, { properties: e.properties });
    }
    throw e;
  }
  // Resolve target mailbox (single-membership only).
  const mailboxIds = payload.mailboxIds;
  if (!mailboxIds || typeof mailboxIds !== "object") {
    throw new JmapError("invalidProperties", "mailboxIds is required", {
      properties: ["mailboxIds"],
    });
  }
  const ids = Object.entries(mailboxIds as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (ids.length === 0) {
    throw new JmapError("invalidProperties", "mailboxIds must contain at least one entry", {
      properties: ["mailboxIds"],
    });
  }
  if (ids.length > 1) {
    throw new JmapError("invalidProperties", "multi-mailbox membership is not supported", {
      properties: ["mailboxIds"],
    });
  }
  const target = lookupMailboxByEncodedId(ctx.store, ctx.account.id, ids[0]!);

  const keywords = (payload.keywords ?? {}) as Record<string, unknown>;
  const flags: string[] = [];
  for (const [kw, v] of Object.entries(keywords)) {
    if (v === true) {
      try {
        flags.push(keywordToFlag(kw));
      } catch (e) {
        throw new JmapError("invalidProperties", (e as Error).message, {
          properties: ["keywords"],
        });
      }
    }
  }

  // buildRfc822 looks blobs up synchronously, so load them first. Besides
  // uploads these can be parts of existing mail: a re-opened draft or a
  // forward references its attachments by their part blobIds.
  // One budget for all of it, checked before each blob is loaded (from its
  // stored size, or while streaming it) rather than after.
  const tooLarge = () =>
    new JmapError("tooLarge", `attachments and body exceed ${MAX_COMPOSE_CONTENT_BYTES} bytes`);
  const uses = mimeContentPlan(payload as JmapEmailCreate);
  let remaining = MAX_COMPOSE_CONTENT_BYTES - uses.textBytes;
  // And what the encoding can make of it, before any encoder runs: at worst
  // quoted-printable (3 bytes per byte plus soft breaks) for text, base64 for
  // blobs, plus headers and structure. The MIME encoder takes each part whole,
  // so its output has to be bounded up front, not while it streams.
  let encodedRemaining = MAX_MIME_BYTES - MIME_OVERHEAD_BYTES - Math.ceil(uses.textBytes * QP_WORST);
  if (remaining < 0 || encodedRemaining < 0) throw tooLarge();
  const blobs = new Map<string, { body: Buffer; ctype: string }>();
  for (const [blobId, count] of uses.blobs) {
    checkAborted(ctx.budgets?.signal);
    let blob;
    try {
      const max = Math.min(Math.floor(remaining / count), Math.floor(encodedRemaining / (count * BASE64_WORST)));
      blob = await readBlob(blobId, ctx, max, ctx.budgets?.signal);
    } catch (e) {
      if (e instanceof BlobTooLargeError) throw tooLarge();
      throw e;
    }
    if (!blob) continue;
    checkAborted(ctx.budgets?.signal);
    remaining -= blob.body.length * count;
    encodedRemaining -= Math.ceil(blob.body.length * count * BASE64_WORST);
    if (remaining < 0 || encodedRemaining < 0) throw tooLarge();
    blobs.set(blobId, blob);
  }

  // A client that went away doesn't get a draft built (or stored) for it.
  checkAborted(ctx.budgets?.signal);
  let mime: Buffer;
  try {
    mime = await buildRfc822(
      payload as JmapEmailCreate,
      ctx.account.host || "localhost",
      (blobId) => blobs.get(blobId) ?? null,
    );
  } catch (e) {
    if (e instanceof MessageTooLargeError) throw new JmapError("tooLarge", e.message);
    // RFC 8621 §4.6: a part referencing an unknown blob fails the create.
    if (e instanceof MissingBlobError) {
      throw new JmapError("blobNotFound", e.message, { notFound: [e.blobId] });
    }
    throw e;
  }

  const idate = typeof payload.receivedAt === "string" ? new Date(payload.receivedAt) : undefined;
  checkAborted(ctx.budgets?.signal);
  const res = await ctx.client.append(target.name, mime, flags.length ? flags : undefined, idate);
  if (!res) {
    throw new JmapError("serverFail", `APPEND to "${target.name}" failed`);
  }

  // UIDPLUS gives us the new UID; without it we can't form a stable JMAP id.
  // Most modern servers (Stalwart, Dovecot, Cyrus) advertise it.
  if (res.uid == null) {
    throw new JmapError("serverFail", "server did not return UID for APPEND (no UIDPLUS)");
  }
  const uidvalidity = res.uidValidity != null ? Number(res.uidValidity) : target.uidvalidity;
  const emailId = encodeEmailId({
    accountIdx: ctx.account.id,
    mailboxIdx: target.id,
    uidvalidity,
    uid: res.uid,
  });
  return {
    id: emailId,
    blobId: encodeBlobId(emailId),
    threadId: emailId,
    size: mime.length,
  };
}

async function applyEmailDestroy(
  id: string,
  ctx: MailCtx,
): Promise<void> {
  const parts = decodeEmailIdSafe(id);
  if (parts.accountIdx !== ctx.account.id) throw notFound();
  const mbox = lookupMailboxByIdx(ctx.store, ctx.account.id, parts.mailboxIdx);
  if (!mbox) throw notFound();
  await withMailbox(ctx.client, mbox.name, async () => {
    assertCurrentEpoch(ctx.client, parts.uidvalidity);
    await ctx.client.messageDelete(`${parts.uid}`, { uid: true });
  });
}

// Every read or write addressed by an email id runs under the mailbox lock and
// first checks that the selected mailbox still has the id's UIDVALIDITY. A
// stale id (the mailbox was recreated or restored since) is notFound, never
// the message that now happens to carry the same UID.
function isCurrentEpoch(client: ImapFlow, uidvalidity: number): boolean {
  const live = selectedUidValidity(client);
  return live !== null && live === uidvalidity;
}

function assertCurrentEpoch(client: ImapFlow, uidvalidity: number): void {
  if (!isCurrentEpoch(client, uidvalidity)) throw notFound();
}

function decodeEmailIdSafe(id: string): ReturnType<typeof decodeEmailId> {
  try {
    return decodeEmailId(id);
  } catch {
    throw notFound();
  }
}

// Distinct mailbox indexes referenced by a set of email ids; undecodable ids
// are skipped (they can't correspond to a folder we track anyway).
function mailboxIdxsOf(emailIds: string[]): number[] {
  const out = new Set<number>();
  for (const id of emailIds) {
    try {
      out.add(decodeEmailId(id).mailboxIdx);
    } catch { /* opaque id */ }
  }
  return [...out];
}

// --- Email/parse, Email/import --------------------------------------------

interface ParsedEmail {
  // RFC 8621 §4.10 mandates these as null for not-stored emails.
  id: null;
  threadId: null;
  mailboxIds: null;
  keywords: null;
  blobId: string;
  size: number;
  receivedAt: string | null;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  from: { name: string | null; email: string }[] | null;
  to: { name: string | null; email: string }[] | null;
  cc: { name: string | null; email: string }[] | null;
  bcc: { name: string | null; email: string }[] | null;
  replyTo: { name: string | null; email: string }[] | null;
  subject: string | null;
  sentAt: string | null;
  textBody: { partId: string; type: string }[] | null;
  htmlBody: { partId: string; type: string }[] | null;
  bodyValues: Record<string, { value: string; isEncodingProblem: false; isTruncated: false }> | null;
}

// Email/parse: turn a previously-uploaded RFC822 blob into a JMAP Email
// projection. Useful for the "preview a forwarded message" flow before
// importing it into a mailbox. We use mailparser (already a dep), which also
// handles QP/base64 transfer encoding for body parts internally.
export async function emailParse(
  args: { accountId: string; blobIds: string[] },
  ctx: { account: AccountRow; store: Store },
): Promise<{ accountId: string; parsed: Record<string, ParsedEmail>; notParsable: string[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const { simpleParser } = await import("mailparser");
  const parsed: Record<string, ParsedEmail> = {};
  const notFound: string[] = [];
  const notParsable: string[] = [];
  for (const blobId of args.blobIds ?? []) {
    if (!blobId.startsWith("U")) {
      notFound.push(blobId);
      continue;
    }
    const upload = ctx.store.getUpload(blobId, ctx.account.id);
    if (!upload) {
      notFound.push(blobId);
      continue;
    }
    try {
      const m = await simpleParser(upload.body);
      const collect = (
        f: { value?: { name?: string; address?: string }[] }
          | { value?: { name?: string; address?: string }[] }[]
          | undefined,
      ) => {
        if (!f) return null;
        const arr = Array.isArray(f) ? f : [f];
        const out: { name: string | null; email: string }[] = [];
        for (const v of arr) for (const a of v.value ?? []) {
          if (a.address) out.push({ name: a.name?.trim() || null, email: a.address });
        }
        return out.length ? out : null;
      };
      // mailparser surfaces the decoded plain-text and HTML bodies as `text`
      // and `html`. We project these into JMAP's textBody/htmlBody/bodyValues
      // shape so the conformance suite can read them. Multi-part bodies in
      // RFC 8621 ride on partId — we synthesize a single root part per kind
      // (1, 2) which is what most clients expect for a parsed preview.
      const textBody: { partId: string; type: string }[] = [];
      const htmlBody: { partId: string; type: string }[] = [];
      const bodyValues: Record<string, { value: string; isEncodingProblem: false; isTruncated: false }> = {};
      if (typeof m.text === "string" && m.text.length > 0) {
        textBody.push({ partId: "1", type: "text/plain" });
        bodyValues["1"] = { value: m.text, isEncodingProblem: false, isTruncated: false };
      }
      if (typeof m.html === "string" && m.html.length > 0) {
        htmlBody.push({ partId: "2", type: "text/html" });
        bodyValues["2"] = { value: m.html, isEncodingProblem: false, isTruncated: false };
      }
      parsed[blobId] = {
        id: null,
        threadId: null,
        mailboxIds: null,
        keywords: null,
        blobId,
        size: upload.body.length,
        receivedAt: m.date ? new Date(m.date).toISOString() : null,
        messageId: m.messageId ? [m.messageId.replace(/^<|>$/g, "")] : null,
        inReplyTo: m.inReplyTo ? [m.inReplyTo.replace(/^<|>$/g, "")] : null,
        references: Array.isArray(m.references)
          ? m.references.map((r) => r.replace(/^<|>$/g, ""))
          : m.references
            ? [m.references.replace(/^<|>$/g, "")]
            : null,
        from: collect(m.from),
        to: collect(m.to),
        cc: collect(m.cc),
        bcc: collect(m.bcc),
        replyTo: collect(m.replyTo),
        subject: m.subject ?? null,
        sentAt: m.date ? new Date(m.date).toISOString() : null,
        textBody: textBody.length ? textBody : null,
        htmlBody: htmlBody.length ? htmlBody : null,
        bodyValues: Object.keys(bodyValues).length ? bodyValues : null,
      };
    } catch {
      notParsable.push(blobId);
    }
  }
  return { accountId: args.accountId, parsed, notParsable, notFound };
}

export interface EmailImportArgs {
  accountId: string;
  ifInState?: string | null;
  emails: Record<
    string,
    { blobId: string; mailboxIds: Record<string, boolean>; keywords?: Record<string, boolean>; receivedAt?: string }
  >;
}

// Email/import: APPEND an uploaded RFC822 blob into a mailbox.
export async function emailImport(
  args: EmailImportArgs,
  ctx: MailCtx,
): Promise<{
  accountId: string;
  oldState: string;
  newState: string;
  created: Record<string, { id: string; blobId: string; threadId: string; size: number }> | null;
  notCreated: Record<string, SetError> | null;
}> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const oldState = accountEmailState(ctx.store, ctx.account.id);
  if (args.ifInState != null && args.ifInState !== oldState) {
    throw new JmapError("stateMismatch", "ifInState does not match current Email state");
  }
  const created: Record<string, { id: string; blobId: string; threadId: string; size: number }> = {};
  const notCreated: Record<string, SetError> = {};
  for (const [cid, payload] of Object.entries(args.emails ?? {})) {
    try {
      created[cid] = await applyEmailImport(payload, ctx);
    } catch (e) {
      notCreated[cid] = toSetError(e);
    }
  }
  if (Object.keys(created).length > 0) {
    invalidateSearchCacheForAccount(ctx.account.id, ctx.store);
    ctx.store.recordChanges(ctx.account.id, "email", {
      created: Object.values(created).map((c) => c.id),
    });
    ctx.store.bumpState(ctx.account.id, "mailbox");
    await refreshMailboxCounts(ctx.client, ctx.account, ctx.store, mailboxIdxsOf(Object.values(created).map((c) => c.id))).catch(() => {});
  }
  return {
    accountId: args.accountId,
    oldState,
    newState: accountEmailState(ctx.store, ctx.account.id),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
  };
}

async function applyEmailImport(
  payload: {
    blobId: string;
    mailboxIds: Record<string, boolean>;
    keywords?: Record<string, boolean>;
    receivedAt?: string;
  },
  ctx: MailCtx,
): Promise<{ id: string; blobId: string; threadId: string; size: number }> {
  if (typeof payload.blobId !== "string" || !payload.blobId.startsWith("U")) {
    // RFC-wise this could be either invalidProperties (malformed reference) or
    // blobNotFound (the resource isn't there). The conformance suite expects
    // invalidProperties when the blobId can't possibly resolve in this
    // accountId — which matches our scheme: only "U…" ids exist. Reserve
    // blobNotFound for the structurally-valid-but-expired case below.
    throw new JmapError("invalidProperties", "blobId must reference a prior upload", {
      properties: ["blobId"],
    });
  }
  const upload = ctx.store.getUpload(payload.blobId, ctx.account.id);
  if (!upload) throw new JmapError("blobNotFound", "uploaded blob has expired or does not exist");

  const targetIds = Object.entries(payload.mailboxIds ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (targetIds.length === 0) {
    throw new JmapError("invalidProperties", "mailboxIds must contain at least one entry", {
      properties: ["mailboxIds"],
    });
  }
  if (targetIds.length > 1) {
    throw new JmapError("invalidProperties", "multi-mailbox membership is not supported", {
      properties: ["mailboxIds"],
    });
  }
  const target = lookupMailboxByEncodedId(ctx.store, ctx.account.id, targetIds[0]!);
  const flags: string[] = [];
  for (const [kw, v] of Object.entries(payload.keywords ?? {})) {
    if (v === true) {
      try {
        flags.push(keywordToFlag(kw));
      } catch (e) {
        throw new JmapError("invalidProperties", (e as Error).message, { properties: ["keywords"] });
      }
    }
  }
  const idate = payload.receivedAt ? new Date(payload.receivedAt) : undefined;
  const res = await ctx.client.append(target.name, upload.body, flags.length ? flags : undefined, idate);
  if (!res || res.uid == null) {
    throw new JmapError("serverFail", "APPEND did not return a UID (no UIDPLUS)");
  }
  const uidvalidity = res.uidValidity != null ? Number(res.uidValidity) : target.uidvalidity;
  const emailId = encodeEmailId({
    accountIdx: ctx.account.id,
    mailboxIdx: target.id,
    uidvalidity,
    uid: res.uid,
  });
  return {
    id: emailId,
    blobId: encodeBlobId(emailId),
    threadId: emailId,
    size: upload.body.length,
  };
}

// --- SearchSnippet/get ----------------------------------------------------

// SearchSnippet/get returns the matching text fragments for a Filter, used
// by webmail UIs to highlight hits in result rows. IMAP SEARCH does not give
// us back the matching offsets, so the only conforming response is `null`
// snippets per RFC 8621 §3.4 — clients fall back to their own highlighter.
//
// Note: RFC 8621 §5 makes notFound an Id[]|null (null when every id resolved),
// not the standard String[] used elsewhere. We don't actually look the email
// up in IMAP here — the client just passed us ids — so we use a structural
// check on the id format to decide "found vs notFound".
export async function searchSnippetGet(
  args: { accountId: string; filter?: unknown; emailIds: string[] },
  ctx: { account: AccountRow },
): Promise<{
  accountId: string;
  list: { emailId: string; subject: null; preview: null }[];
  notFound: string[] | null;
}> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const list: { emailId: string; subject: null; preview: null }[] = [];
  const notFound: string[] = [];
  for (const emailId of args.emailIds ?? []) {
    let valid = false;
    try {
      const parts = decodeEmailId(emailId);
      valid = parts.accountIdx === ctx.account.id;
    } catch {
      valid = false;
    }
    if (valid) list.push({ emailId, subject: null, preview: null });
    else notFound.push(emailId);
  }
  return {
    accountId: args.accountId,
    list,
    notFound: notFound.length ? notFound : null,
  };
}

// --- Email/changes, Email/queryChanges, Email/copy ------------------------

// Email/changes is answered from the in-memory change log when sinceState
// falls inside the retained window. Outside that window (or after a restart)
// we degrade to `cannotCalculateChanges` honestly — we never fabricate a diff.
export async function emailChanges(
  args: { accountId: string; sinceState: string },
  ctx: { account: AccountRow; store: Store },
): Promise<ChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const currentNumeric = ctx.store.getState(ctx.account.id, "email");
  const currentRaw = accountEmailState(ctx.store, ctx.account.id);
  let sinceNumeric: number;
  try {
    sinceNumeric = decodeEmailState(args.sinceState).modseq;
  } catch {
    return changesOrCannotCalculate(args.accountId, args.sinceState, currentRaw);
  }
  return changesFromLog({
    accountId: args.accountId,
    store: ctx.store,
    numericAccountId: ctx.account.id,
    kind: "email",
    sinceStateRaw: args.sinceState,
    sinceStateNumeric: sinceNumeric,
    currentStateRaw: currentRaw,
    currentStateNumeric: currentNumeric,
  });
}

export async function emailQueryChanges(
  args: EmailQueryArgs & { sinceQueryState: string; upToId?: string | null },
  ctx: MailCtx,
): Promise<QueryChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const currentNumeric = ctx.store.getState(ctx.account.id, "email");
  const currentRaw = accountEmailState(ctx.store, ctx.account.id);
  if (args.sinceQueryState === currentRaw) {
    return queryChangesOrCannotCalculate(args.accountId, args.sinceQueryState, currentRaw);
  }

  let sinceNumeric: number;
  try {
    sinceNumeric = decodeEmailState(args.sinceQueryState).modseq;
  } catch {
    throw new JmapError("cannotCalculateChanges", "unparseable sinceQueryState");
  }
  const entries = ctx.store.entriesSince(ctx.account.id, "email", sinceNumeric, currentNumeric);
  if (!entries) throw new JmapError("cannotCalculateChanges", "out-of-window");

  // Re-run the query to know which ids the client should currently see.
  // The diff is then: removed = (destroyed ∪ updated-and-no-longer-matches);
  // added = (created-now-matches ∪ updated-now-matches). For an MVP we only
  // surface destroyed and created against the live result set — that covers
  // the after-add and after-remove conformance cases without claiming more
  // accuracy than the log gives us.
  const fresh = await emailQuery(args, ctx);
  const liveSet = new Set(fresh.ids);
  const removed: string[] = [];
  const added: { id: string; index: number }[] = [];
  const seenRemoved = new Set<string>();
  const seenAdded = new Set<string>();
  for (const e of entries) {
    if (e.action === "destroyed" && !seenRemoved.has(e.id) && !liveSet.has(e.id)) {
      seenRemoved.add(e.id);
      removed.push(e.id);
    } else if (e.action === "created" && liveSet.has(e.id) && !seenAdded.has(e.id)) {
      seenAdded.add(e.id);
      const index = fresh.ids.indexOf(e.id);
      added.push({ id: e.id, index });
    }
  }
  return {
    accountId: args.accountId,
    oldQueryState: args.sinceQueryState,
    newQueryState: currentRaw,
    total: fresh.total,
    removed,
    added,
  };
}

export interface EmailCopyArgs {
  fromAccountId: string;
  accountId: string;
  ifFromInState?: string | null;
  ifInState?: string | null;
  create: Record<string, { id: string; mailboxIds: Record<string, boolean>; keywords?: Record<string, boolean> }>;
  onSuccessDestroyOriginal?: boolean;
  destroyFromIfInState?: string | null;
}

export interface EmailCopyResponse {
  fromAccountId: string;
  accountId: string;
  oldState: string;
  newState: string;
  created: Record<string, { id: string; blobId: string; threadId: string; size: number }> | null;
  notCreated: Record<string, SetError> | null;
}

// Cross-account copy is not supported: providers don't share IMAP namespaces.
// Within the same account we copy with IMAP COPY, which preserves UIDs only
// on UIDPLUS-aware servers (the same UIDPLUS dependency Email/set already
// has — see applyEmailCreate).
export async function emailCopy(
  args: EmailCopyArgs,
  ctx: MailCtx,
): Promise<EmailCopyResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  if (args.fromAccountId !== args.accountId) {
    throw new JmapError(
      "fromAccountNotFound",
      "cross-account Email/copy is not supported by the IMAP backend",
    );
  }
  const oldState = accountEmailState(ctx.store, ctx.account.id);
  if (args.ifInState != null && args.ifInState !== oldState) {
    throw new JmapError("stateMismatch", "ifInState does not match current Email state");
  }
  if (args.ifFromInState != null && args.ifFromInState !== oldState) {
    throw new JmapError("stateMismatch", "ifFromInState does not match current Email state");
  }

  const created: Record<string, { id: string; blobId: string; threadId: string; size: number }> = {};
  const notCreated: Record<string, SetError> = {};
  const successfulOriginals: string[] = [];

  for (const [cid, payload] of Object.entries(args.create ?? {})) {
    try {
      const result = await applyEmailCopy(payload, ctx);
      created[cid] = result;
      successfulOriginals.push(payload.id);
    } catch (e) {
      notCreated[cid] = toSetError(e);
    }
  }

  if (args.onSuccessDestroyOriginal === true) {
    for (const id of successfulOriginals) {
      try {
        await applyEmailDestroy(id, ctx);
      } catch {
        // best effort - the copy already succeeded
      }
    }
  }

  if (Object.keys(created).length > 0) {
    invalidateSearchCacheForAccount(ctx.account.id, ctx.store);
    ctx.store.recordChanges(ctx.account.id, "email", {
      created: Object.values(created).map((c) => c.id),
      destroyed: args.onSuccessDestroyOriginal ? successfulOriginals : [],
    });
    ctx.store.bumpState(ctx.account.id, "mailbox");
    const touched = mailboxIdxsOf([
      ...Object.values(created).map((c) => c.id),
      ...(args.onSuccessDestroyOriginal ? successfulOriginals : []),
    ]);
    await refreshMailboxCounts(ctx.client, ctx.account, ctx.store, touched).catch(() => {});
  }

  return {
    fromAccountId: args.fromAccountId,
    accountId: args.accountId,
    oldState,
    newState: accountEmailState(ctx.store, ctx.account.id),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
  };
}

async function applyEmailCopy(
  payload: { id: string; mailboxIds: Record<string, boolean>; keywords?: Record<string, boolean> },
  ctx: MailCtx,
): Promise<{ id: string; blobId: string; threadId: string; size: number }> {
  const srcParts = decodeEmailIdSafe(payload.id);
  if (srcParts.accountIdx !== ctx.account.id) throw notFound();
  const srcMbox = lookupMailboxByIdx(ctx.store, ctx.account.id, srcParts.mailboxIdx);
  if (!srcMbox) throw notFound();

  const targetIds = Object.entries(payload.mailboxIds ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (targetIds.length === 0) {
    throw new JmapError("invalidProperties", "mailboxIds must contain at least one entry", {
      properties: ["mailboxIds"],
    });
  }
  if (targetIds.length > 1) {
    throw new JmapError("invalidProperties", "multi-mailbox membership is not supported", {
      properties: ["mailboxIds"],
    });
  }
  const target = lookupMailboxByEncodedId(ctx.store, ctx.account.id, targetIds[0]!);

  const copyResult = await withMailbox(ctx.client, srcMbox.name, async () => {
    assertCurrentEpoch(ctx.client, srcParts.uidvalidity);
    return ctx.client.messageCopy(`${srcParts.uid}`, target.name, { uid: true });
  });
  if (!copyResult) {
    throw new JmapError("serverFail", `COPY to "${target.name}" failed`);
  }
  // imapflow returns `uidMap` (src UID → dst UID) when UIDPLUS is advertised.
  const newUid = copyResult.uidMap?.get(srcParts.uid) ?? null;
  if (newUid == null) {
    throw new JmapError("serverFail", "server did not return UID for COPY (no UIDPLUS)");
  }
  const uidvalidity =
    copyResult.uidValidity != null ? Number(copyResult.uidValidity) : target.uidvalidity;

  // Apply keyword changes on the new copy if requested.
  const keywords = payload.keywords ?? {};
  const flags: string[] = [];
  for (const [kw, v] of Object.entries(keywords)) {
    if (v === true) flags.push(keywordToFlag(kw));
  }
  if (flags.length > 0) {
    await withMailbox(ctx.client, target.name, async () => {
      await ctx.client.messageFlagsSet(`${newUid}`, flags, { uid: true });
    });
  }

  const newId = encodeEmailId({
    accountIdx: ctx.account.id,
    mailboxIdx: target.id,
    uidvalidity,
    uid: newUid,
  });
  // Without fetching the MIME we don't know the size; report 0 rather than
  // the source size (which may differ if server adds trailing markers).
  // Clients that need size will issue Email/get on the new id.
  return { id: newId, blobId: encodeBlobId(newId), threadId: newId, size: 0 };
}

// Test surface — kept private from production code paths but exposed under a
// reserved name so unit specs can exercise patch resolution without spinning
// up an IMAP connection.
export const __test = { resolvePatch, computeNewMailboxIds };
