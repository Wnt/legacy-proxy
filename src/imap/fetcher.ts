import type { FetchMessageObject, ImapFlow } from "imapflow";
// libqp ships no types; we only use `decode(string) => Buffer`.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no declaration file
import libqp from "libqp";
import { selectBodies, structureToBodyParts, type EmailBodyPart } from "../mapping/structure.js";
import { buildPreview } from "../mapping/preview.js";
import { flagsToKeywords } from "../mapping/flags.js";
import { encodeBlobId, encodeEmailId, encodeMailboxId } from "../mapping/ids.js";
import {
  parseHeaderBlock,
  parseThreadInputs,
  threadIdFromInputs,
  threadInputs,
  MAX_HEADER_BLOCK_BYTES,
  type ParsedHeader,
  type ThreadInputs,
} from "./headers.js";
import { imapErrorDetails } from "./client.js";
import { fetchByUid } from "./uids.js";
import type { AccountRow, MailboxRow, Store, EmailCacheUpsert } from "../state/store.js";
import { log } from "../util/log.js";
import { storeBodyCache, type BodyCache } from "./bodycache.js";

// The header fields threading and the default Email/get property set need:
// References for threadId + `references`, In-Reply-To / Message-ID as backup.
// Everything else in the header block (Received chains, ARC/DKIM signatures —
// often 5-20 KB per message) is dead weight unless the client asked for a
// `header:*` projection, so we only pull the full block on demand.
export const THREAD_HEADER_FIELDS = ["message-id", "in-reply-to", "references"];

// Everything but the header block, which fetchHeadersBounded() gets once the
// sizes are known.
const META_QUERY = {
  uid: true as const,
  flags: true as const,
  size: true as const,
  internalDate: true as const,
  envelope: true as const,
  bodyStructure: true as const,
};

/**
 * Header blocks for `uids`, one message at a time and never more than
 * MAX_HEADER_BLOCK_BYTES of each on the wire: the server, and so any sender,
 * decides how large a header block is, and imapflow buffers a whole literal
 * before we see it. Callers reduce each block (to ThreadInputs, or a kept
 * full block within their own budget) before taking the next, so nothing
 * here holds more than one block.
 *
 * imapflow can't send a partial HEADER.FIELDS fetch, but a message's header
 * can't be larger than the message. So a message whose RFC822.SIZE is within
 * the bound (nearly all mail without large attachments) keeps the cheap
 * fetch: HEADER.FIELDS for the threading fields, or HEADER. A larger one, or
 * one of unknown size, is fetched as the partial BODY.PEEK[HEADER]<0.N>.
 */
export async function* headerBlocksBounded(
  client: ImapFlow,
  uids: number[],
  sizeOf: (uid: number) => number | undefined,
  full: boolean,
): AsyncGenerator<{ uid: number; block: Buffer }> {
  const small: number[] = [];
  const large: number[] = [];
  for (const uid of uids) {
    const size = sizeOf(uid);
    (size != null && size <= MAX_HEADER_BLOCK_BYTES ? small : large).push(uid);
  }
  if (small.length > 0) {
    const query = { uid: true as const, headers: full ? (true as const) : THREAD_HEADER_FIELDS };
    for await (const m of fetchByUid(client, small, query)) {
      // A FLAGS-only FETCH pushed mid-command carries no header block.
      if (m.uid == null || m.headers == null) continue;
      yield { uid: m.uid, block: headersToBuffer(m.headers) };
    }
  }
  if (large.length > 0) {
    const query = { uid: true as const, bodyParts: [{ key: "HEADER", start: 0, maxLength: MAX_HEADER_BLOCK_BYTES }] };
    for await (const m of fetchByUid(client, large, query)) {
      if (m.uid == null || m.headers == null) continue;
      yield { uid: m.uid, block: headersToBuffer(m.headers) };
    }
  }
}

// Full header blocks kept for one Email/get (they go out in its response).
// Past this, further messages are answered without `headers` / `header:*`
// values; their threading is unaffected, it comes from ThreadInputs.
export const MAX_FULL_HEADER_BYTES_PER_CALL = 16 * 1024 * 1024;

/**
 * What one HTTP request's Email/get calls may fetch and emit, together: body
 * bytes fetched, full header blocks held, header characters projected, and
 * response characters overall.
 * Created per request (makeLegacyMethods), so neither several mailboxes in
 * one call nor several calls in one request multiply the limits.
 */
export interface RequestBudgets {
  body: { remaining: number };
  header: { remaining: number };
  projection: { remaining: number };
  response: { remaining: number };
  // ENVELOPE + BODYSTRUCTURE JSON characters held for this request's messages.
  metadata: { remaining: number };
  // Set when the client went away: work stops at the next check.
  signal?: AbortSignal;
}

/** A RequestBudgets allowance ran out (or the request was abandoned). */
export class BudgetExceededError extends Error {}

export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BudgetExceededError("request aborted by the client");
}

function chargeMetadata(budget: { remaining: number } | undefined, chars: number): void {
  if (!budget) return;
  budget.remaining -= chars;
  if (budget.remaining < 0) {
    throw new BudgetExceededError(`message metadata exceeds ${MAX_METADATA_CHARS} characters for one request`);
  }
}

// Message metadata (ENVELOPE, BODYSTRUCTURE) one request may hold. Each
// message's is at most ~192 KiB once bounded; typical mail is a few KB.
export const MAX_METADATA_CHARS = 64 * 1024 * 1024;

export function newRequestBudgets(): RequestBudgets {
  return {
    body: { remaining: MAX_BODY_FETCH_BYTES },
    header: { remaining: MAX_FULL_HEADER_BYTES_PER_CALL },
    projection: { remaining: MAX_FULL_HEADER_BYTES_PER_CALL },
    response: { remaining: MAX_RESPONSE_CHARS },
    metadata: { remaining: MAX_METADATA_CHARS },
  };
}

// Characters of Email objects all Email/get calls of one request may return,
// every property counted (body values and header projections included).
// Well above a large thread with full bodies; a request past it fails with
// requestTooLarge rather than piling up responses.
export const MAX_RESPONSE_CHARS = 64 * 1024 * 1024;

export interface JmapEmail {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, true>;
  keywords: Record<string, true>;
  size: number;
  receivedAt: string;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: { name: string | null; email: string }[] | null;
  from: { name: string | null; email: string }[] | null;
  to: { name: string | null; email: string }[] | null;
  cc: { name: string | null; email: string }[] | null;
  bcc: { name: string | null; email: string }[] | null;
  replyTo: { name: string | null; email: string }[] | null;
  subject: string | null;
  sentAt: string | null;
  hasAttachment: boolean;
  preview: string;
  bodyStructure: ReturnType<typeof structureToBodyParts>;
  textBody: ReturnType<typeof selectBodies>["textBody"];
  htmlBody: ReturnType<typeof selectBodies>["htmlBody"];
  attachments: ReturnType<typeof selectBodies>["attachments"];
  bodyValues: Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }>;
  // The parsed RFC 5322 header block. Internal-only; Email/get strips this
  // before serialising and the JMAP client never sees it.
  _headers: ParsedHeader[];
}

export interface BodyFetchOpts {
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
  maxBodyValueBytes?: number;
  // When false, skip the per-batch preview FETCH. Email/get callers that
  // don't request `preview` in `properties` set this to avoid an extra IMAP
  // round trip on every page of a folder list. Defaults to true (legacy
  // behaviour) for callers that don't pass `properties`.
  wantsPreview?: boolean;
  // True when the client requested a `header:*` projection, which needs the
  // complete header block rather than the threading subset.
  needsFullHeaders?: boolean;
  // Bytes of full header blocks this request may still hold, shared by every
  // fetchEmailsBatch of one Email/get (one per mailbox). Cached and freshly
  // fetched blocks both draw on it; a message past it is answered without
  // `headers`/`header:*` values. Defaults to a fresh MAX_FULL_HEADER_BYTES_PER_CALL.
  headerBudget?: { remaining: number };
  // Likewise for body values: bytes still fetchable in this request, shared
  // by every mailbox group (and every Email/get of one HTTP request).
  // Defaults to a fresh MAX_BODY_FETCH_BYTES.
  bodyBudget?: { remaining: number };
  metadataBudget?: { remaining: number };
  signal?: AbortSignal;
  // Raw text parts by blobId; fetchEmailsBatch sets it from its Store.
  bodyCache?: BodyCache;
}

function decodePartText(buf: Buffer, charset: string | null): string {
  return decodePartTextChecked(buf, charset, false).value;
}

/**
 * Decode a text part and say whether that went wrong (RFC 8621 bodyValue
 * `isEncodingProblem`): an unknown charset, or bytes that are not valid in it.
 * `partial` (a value cut at a byte limit) tolerates a cut final character.
 */
export function decodePartTextChecked(
  buf: Buffer,
  charset: string | null,
  partial: boolean,
): { value: string; problem: boolean } {
  const cs = (charset ?? "utf-8").toLowerCase();
  let strict: TextDecoder;
  try {
    strict = new TextDecoder(cs, { fatal: true });
  } catch {
    return { value: buf.toString("utf8"), problem: true };
  }
  try {
    return { value: strict.decode(buf, { stream: partial }), problem: false };
  } catch {
    return { value: new TextDecoder(cs, { fatal: false }).decode(buf, { stream: partial }), problem: true };
  }
}

// IMAP `BODY[partId]` returns the raw bytes - still in their Content-Transfer
// -Encoding (typically quoted-printable or base64 for text parts). imapflow's
// `download()` decodes that for us, but `fetch({bodyParts})` does not, so we
// must reverse the CTE ourselves before applying the charset.
function decodeTransferEncoding(buf: Buffer, encoding: string | null): Buffer {
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "quoted-printable") {
    try {
      return libqp.decode(buf.toString("binary"));
    } catch {
      return buf;
    }
  }
  if (enc === "base64") {
    try {
      // Strip CR/LF so partial-line base64 still decodes cleanly.
      return Buffer.from(buf.toString("binary").replace(/[\r\n]/g, ""), "base64");
    } catch {
      return buf;
    }
  }
  // 7bit, 8bit, binary, or unspecified: no transform.
  return buf;
}

function addr(list: { name?: string | null; address?: string | null }[] | null | undefined) {
  if (!list || list.length === 0) return null;
  return list
    .filter((a) => a.address)
    .map((a) => ({ name: a.name?.trim() || null, email: a.address! }));
}

// Bytes of a body part to fetch for the preview. JMAP previews cap at 256
// characters. A plain-text part reaches them within a few KB, whatever the
// charset or transfer encoding. An HTML part often does not: bulk mail puts
// tens of KB of <style> blocks and layout before its first visible word, so
// a short prefix would end inside a style sheet. Each Email/get spends at
// most PREVIEW_FETCH_BUDGET on preview fetches; messages past it get no
// preview in that response (and none is cached, so a later read computes it).
const PREVIEW_TEXT_FETCH_BYTES = 8 * 1024;
const PREVIEW_HTML_FETCH_BYTES = 128 * 1024;
const PREVIEW_FETCH_BUDGET = 16 * 1024 * 1024;

// The parts a preview is made from: the first text/plain part (or other
// non-HTML text part) of the text body, else the first HTML part. Chosen by
// type, not by list, since an HTML-only message may list its HTML part in
// textBody as well (RFC 8621 §4.1.4).
function previewParts(sel: ReturnType<typeof selectBodies>): { text: EmailBodyPart | null; html: EmailBodyPart | null } {
  const text = sel.textBody.find((b) => b.partId && b.type !== "text/html") ?? null;
  const html =
    sel.htmlBody.find((b) => b.partId && b.type === "text/html") ??
    sel.textBody.find((b) => b.partId && b.type === "text/html") ??
    null;
  return { text, html };
}

// Envelope as imapflow parses it. When rehydrated from the cache the Date
// fields come back as ISO strings — every consumer feeds them to `new Date()`,
// which accepts both.
// The server parses ENVELOPE and BODYSTRUCTURE from what the sender wrote, so
// their size is the sender's choice. Each is cut down as it arrives, before
// the next message is read, to what a client can use.
const MAX_ENVELOPE_SUBJECT_CHARS = 16 * 1024;
const MAX_META_STRING_CHARS = 998; // a header line
const MAX_META_ID_CHARS = 1000; // a msg-id with its brackets; longer is no id
export const MAX_ENVELOPE_JSON_CHARS = 64 * 1024;
export const MAX_BODYSTRUCTURE_JSON_CHARS = 128 * 1024;
const MAX_BODYSTRUCTURE_PARTS = 256;
const MAX_BODYSTRUCTURE_DEPTH = 16;

type Addr = { name?: string | null; address?: string | null };

export function boundEnvelope(env: EnvelopeLike | null | undefined): EnvelopeLike | null {
  if (!env || typeof env !== "object") return null;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  // An overlong Message-ID / In-Reply-To is not shortened into a new id (that
  // would invent a thread the scan doesn't see): it is dropped, as the
  // threading code drops it.
  const id = (v: unknown) => (typeof v === "string" && v.length <= MAX_META_ID_CHARS ? v : undefined);
  const list = (l: unknown, max: number): Addr[] | undefined =>
    Array.isArray(l)
      ? (l as Addr[]).slice(0, max).map((a) => ({
          name: typeof a?.name === "string" ? a.name.slice(0, MAX_META_STRING_CHARS) : null,
          address: typeof a?.address === "string" ? a.address.slice(0, MAX_META_STRING_CHARS) : null,
        }))
      : undefined;
  const build = (maxAddrs: number, subjectChars: number): EnvelopeLike => ({
    date: env.date instanceof Date ? env.date : str(env.date, MAX_META_STRING_CHARS),
    subject: str(env.subject, subjectChars),
    messageId: id(env.messageId),
    inReplyTo: id(env.inReplyTo),
    sender: list(env.sender, maxAddrs),
    from: list(env.from, maxAddrs),
    to: list(env.to, maxAddrs),
    cc: list(env.cc, maxAddrs),
    bcc: list(env.bcc, maxAddrs),
    replyTo: list(env.replyTo, maxAddrs),
  });
  // A hard bound on the serialized size (escapes included): fewer addresses
  // first, then a shorter subject; the last resort has neither.
  for (let maxAddrs = 1000, subject = MAX_ENVELOPE_SUBJECT_CHARS; ; ) {
    const out = build(maxAddrs, subject);
    if (jsonSize(out) <= MAX_ENVELOPE_JSON_CHARS) return out;
    if (maxAddrs > 0) maxAddrs = Math.floor(maxAddrs / 2);
    else if (subject > 0) subject = Math.floor(subject / 2);
    else return out; // ids, date and empty fields only: a few KB at most
  }
}

function jsonSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? "null");
}

const MAX_META_KEYS = 32; // parameters per map, keys per node
const MAX_META_KEY_CHARS = 64;

/**
 * BODYSTRUCTURE in one bounded traversal: depth, part count, keys per object
 * (and their length), and string length, then a hard bound on the serialized
 * size. If even a reduced tree doesn't fit, only the root's type, size and
 * encoding remain.
 */
export function boundBodyStructure(bs: unknown): unknown {
  const build = (maxParts: number) => {
    let parts = 0;
    const node = (n: unknown, depth: number): unknown => {
      if (typeof n === "string") return n.slice(0, MAX_META_STRING_CHARS);
      if (Array.isArray(n)) return n.slice(0, MAX_META_KEYS).map((x) => node(x, depth));
      if (!n || typeof n !== "object") return n;
      const out: Record<string, unknown> = {};
      let keys = 0;
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (k.length > MAX_META_KEY_CHARS || ++keys > MAX_META_KEYS) continue;
        if (k === "childNodes") {
          if (!Array.isArray(v) || depth >= MAX_BODYSTRUCTURE_DEPTH) continue;
          const kids: unknown[] = [];
          for (const c of v) {
            if (++parts > maxParts) break;
            kids.push(node(c, depth + 1));
          }
          out.childNodes = kids;
        } else if (k === "envelope") {
          out.envelope = boundEnvelope(v as EnvelopeLike);
        } else {
          out[k] = node(v, depth);
        }
      }
      return out;
    };
    return node(bs, 0);
  };
  for (let max = MAX_BODYSTRUCTURE_PARTS; max >= 0; max = max === 0 ? -1 : Math.floor(max / 2)) {
    const out = build(max);
    if (jsonSize(out) <= MAX_BODYSTRUCTURE_JSON_CHARS) return out;
  }
  const root = (bs && typeof bs === "object" ? bs : {}) as Record<string, unknown>;
  const scalar = (v: unknown) => (typeof v === "string" ? v.slice(0, MAX_META_STRING_CHARS) : typeof v === "number" ? v : undefined);
  return { part: scalar(root.part), type: scalar(root.type), encoding: scalar(root.encoding), size: scalar(root.size) };
}

interface EnvelopeLike {
  date?: Date | string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  sender?: { name?: string | null; address?: string | null }[];
  from?: { name?: string | null; address?: string | null }[];
  to?: { name?: string | null; address?: string | null }[];
  cc?: { name?: string | null; address?: string | null }[];
  bcc?: { name?: string | null; address?: string | null }[];
  replyTo?: { name?: string | null; address?: string | null }[];
}

// The immutable per-message facts, either fresh off a FETCH or rehydrated
// from the email_cache table. `flags` is null until fetched — it's the one
// mutable attribute and is never served from the cache.
interface RawMeta {
  uid: number;
  flags: Set<string> | null;
  size: number;
  internaldate: number;
  envelope: EnvelopeLike | null;
  bodystructure: unknown;
  // The header block as fetched, when the full block was asked for and kept;
  // otherwise null (headersFull false).
  headersRaw: Buffer | null;
  headersFull: boolean;
  // headersRaw is the bounded prefix of a larger header block.
  headersTruncated: boolean;
  // What threadId and `references` derive from, computed once per message.
  thread: ThreadInputs;
  // The threadId already recorded for this message (scan or earlier get), if
  // any: reused, so every path reports the decision made first.
  cachedThreadId?: string | null;
  preview: string | null;
  fromCache: boolean;
}

interface ProcessedMeta {
  raw: RawMeta;
  emailId: string;
  blobId: string;
  threadId: string;
  root: EmailBodyPart;
  sel: ReturnType<typeof selectBodies>;
  headers: ParsedHeader[];
}

const EMPTY_THREAD: ThreadInputs = { messageId: null, inReplyTo: null, references: null };

// Only the first MAX_HEADER_BLOCK_BYTES are ever parsed, so that is all we keep
// (and cache): a sender can't make every later read carry a huge header block.
function headersToBuffer(headers: FetchMessageObject["headers"]): Buffer {
  let buf: Buffer;
  if (Buffer.isBuffer(headers)) buf = headers;
  else if (typeof headers === "string") buf = Buffer.from(headers, "utf8");
  else return Buffer.alloc(0);
  return buf.length > MAX_HEADER_BLOCK_BYTES ? Buffer.from(buf.subarray(0, MAX_HEADER_BLOCK_BYTES)) : buf;
}

function rawFromFetch(
  msg: FetchMessageObject,
  thread: ThreadInputs,
  headersRaw: Buffer | null,
  headersTruncated: boolean,
): RawMeta {
  return {
    uid: msg.uid!,
    flags: new Set(msg.flags ?? []),
    size: msg.size ?? 0,
    internaldate: msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now(),
    envelope: msg.envelope as EnvelopeLike, // bounded when it was fetched
    bodystructure: msg.bodyStructure ?? null,
    headersRaw,
    headersFull: headersRaw !== null,
    headersTruncated,
    thread,
    preview: null,
    fromCache: false,
  };
}

function processMeta(account: AccountRow, mailbox: MailboxRow, raw: RawMeta): ProcessedMeta {
  const emailId = encodeEmailId({
    accountIdx: account.id,
    mailboxIdx: mailbox.id,
    uidvalidity: mailbox.uidvalidity,
    uid: raw.uid,
  });
  const blobId = encodeBlobId(emailId);
  const root = structureToBodyParts(raw.bodystructure as never, (partId) =>
    partId ? encodeBlobId(emailId, partId) : blobId,
  );
  const sel = selectBodies(root);
  const headers = raw.headersRaw ? parseHeaderBlock(raw.headersRaw) : [];
  const threadId =
    raw.cachedThreadId ?? threadIdFromInputs(raw.thread, raw.envelope?.messageId ?? null) ?? emailId;
  return { raw, emailId, blobId, threadId, root, sel, headers };
}

function assembleEmail(
  account: AccountRow,
  mailbox: MailboxRow,
  p: ProcessedMeta,
  preview: string,
  bodyValues: JmapEmail["bodyValues"],
): JmapEmail {
  const env = p.raw.envelope;
  const referencesIds = p.raw.thread.references;
  return {
    id: p.emailId,
    blobId: p.blobId,
    threadId: p.threadId,
    mailboxIds: {
      [encodeMailboxId({ accountIdx: account.id, mailboxIdx: mailbox.id })]: true,
    },
    keywords: flagsToKeywords(Array.from(p.raw.flags ?? [])),
    size: p.raw.size,
    receivedAt: new Date(p.raw.internaldate).toISOString(),
    messageId: env?.messageId ? [stripBrackets(env.messageId)] : null,
    inReplyTo: env?.inReplyTo ? [stripBrackets(env.inReplyTo)] : null,
    references: referencesIds,
    sender: addr(env?.sender),
    from: addr(env?.from),
    to: addr(env?.to),
    cc: addr(env?.cc),
    bcc: addr(env?.bcc),
    replyTo: addr(env?.replyTo),
    subject: env?.subject ?? null,
    sentAt: env?.date ? new Date(env.date).toISOString() : null,
    hasAttachment: p.sel.hasAttachment,
    preview,
    bodyStructure: p.root,
    textBody: p.sel.textBody,
    htmlBody: p.sel.htmlBody,
    attachments: p.sel.attachments,
    bodyValues,
    _headers: p.headers,
  };
}

// Which body parts a message needs fetched to satisfy the bodyValues options.
function wantedBodyParts(sel: ReturnType<typeof selectBodies>, opts: BodyFetchOpts): Map<string, EmailBodyPart> {
  const wanted = new Map<string, EmailBodyPart>();
  const includeAll = opts.fetchAllBodyValues === true;
  if (opts.fetchTextBodyValues || includeAll) {
    for (const part of sel.textBody) if (part.partId) wanted.set(part.partId, part);
  }
  if (opts.fetchHTMLBodyValues || includeAll) {
    for (const part of sel.htmlBody) if (part.partId) wanted.set(part.partId, part);
  }
  if (includeAll) {
    for (const part of sel.attachments) {
      if (part.partId && part.type.startsWith("text/")) wanted.set(part.partId, part);
    }
  }
  return wanted;
}

// Limits on body values. A client's maxBodyValueBytes is honoured up to
// MAX_BODY_VALUE_BYTES (0, "no limit" in RFC 8621, also means that maximum).
// Each part is fetched as a partial BODY[part]<0.N>, N the most encoded bytes
// that can decode to the value's limit, so a sender's 100 MB text part costs
// no more than the bytes we return. Per Email/get call, at most
// MAX_BODY_FETCH_BYTES are fetched over all messages and parts (one budget
// for the whole HTTP request, see RequestBudgets); values past that come back
// empty with isTruncated, like any other cut value.
const DEFAULT_BODY_VALUE_BYTES = 256_000;
export const MAX_BODY_VALUE_BYTES = 4 * 1024 * 1024;
export const MAX_BODY_FETCH_BYTES = 32 * 1024 * 1024;

function bodyValueCap(requested: number | undefined): number {
  if (requested === undefined || requested === null) return DEFAULT_BODY_VALUE_BYTES;
  if (!Number.isFinite(requested) || requested <= 0) return MAX_BODY_VALUE_BYTES;
  return Math.min(Math.floor(requested), MAX_BODY_VALUE_BYTES);
}

/**
 * The most transfer-encoded bytes worth fetching for a value of `cap` decoded
 * bytes, plus a little more so a longer part is recognisably longer. An
 * estimate that falls short only shortens the value; isTruncated stays right.
 */
export function encodedCeiling(cap: number, encoding: string | null): number {
  const want = cap + 4;
  switch ((encoding ?? "").toLowerCase()) {
    case "base64":
      // 4 chars per 3 bytes, plus a line break every 64-76 chars.
      return Math.ceil((Math.ceil(want / 3) * 4 * 66) / 64) + 64;
    case "quoted-printable":
      // At worst "=XX" per byte, plus a soft break ("=\r\n") per 76 chars.
      return Math.ceil((want * 3 * 79) / 76) + 64;
    default:
      return want;
  }
}

// Fetch bodyValues for many messages, batching one FETCH per distinct
// part-id set instead of one FETCH per message. Sibling messages in a thread
// almost always share the same MIME shape ("1" or "1.1"+"1.2"), so an open
// thread of N messages collapses to one or two round trips.
// Fill rawByUid for `m` from the body cache when every one of its parts is
// there; true if so.
function cachedParts(
  cache: BodyCache,
  m: { uid: number; wanted: Map<string, EmailBodyPart> },
  parts: { partId: string; maxLength: number }[],
  rawByUid: Map<number, Map<string, Buffer>>,
): boolean {
  const got = new Map<string, Buffer>();
  for (const p of parts) {
    const blobId = m.wanted.get(p.partId)?.blobId;
    const raw = blobId ? cache.get(blobId, p.maxLength) : null;
    if (!raw) return false;
    got.set(p.partId, raw);
  }
  rawByUid.set(m.uid, got);
  return true;
}

function cacheParts(
  cache: BodyCache,
  m: { wanted: Map<string, EmailBodyPart> } | undefined,
  parts: { partId: string; maxLength: number }[],
  fetched: Map<string, Buffer>,
): void {
  if (!m) return;
  for (const p of parts) {
    const blobId = m.wanted.get(p.partId)?.blobId;
    const raw = fetched.get(p.partId);
    if (blobId && raw) cache.put(blobId, p.maxLength, raw);
  }
}

async function fetchBodyValuesBatched(
  client: ImapFlow,
  items: { uid: number; wanted: Map<string, EmailBodyPart> }[],
  opts: BodyFetchOpts,
): Promise<Map<number, JmapEmail["bodyValues"]>> {
  const cap = bodyValueCap(opts.maxBodyValueBytes);
  const out = new Map<number, JmapEmail["bodyValues"]>();
  const groups = new Map<string, { parts: { partId: string; maxLength: number }[]; members: typeof items }>();
  const budget = opts.bodyBudget ?? { remaining: MAX_BODY_FETCH_BYTES };
  for (const item of items) {
    if (item.wanted.size === 0) {
      out.set(item.uid, {});
      continue;
    }
    const parts = [...item.wanted.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([partId, part]) => ({ partId, maxLength: encodedCeiling(cap, part.encoding) }));
    // What the server will actually send: the part's size from BODYSTRUCTURE
    // when smaller than the ceiling.
    const cost = parts.reduce((n, p) => {
      const size = item.wanted.get(p.partId)!.size;
      return n + (size > 0 ? Math.min(size, p.maxLength) : p.maxLength);
    }, 0);
    if (cost > budget.remaining) {
      // Over the request's budget: answer without fetching.
      const values: JmapEmail["bodyValues"] = {};
      for (const partId of item.wanted.keys()) values[partId] = { value: "", isEncodingProblem: false, isTruncated: true };
      out.set(item.uid, values);
      continue;
    }
    budget.remaining -= cost;
    const key = parts.map((p) => `${p.partId}<${p.maxLength}>`).join(",");
    let g = groups.get(key);
    if (!g) {
      g = { parts, members: [] };
      groups.set(key, g);
    }
    g.members.push(item);
  }

  for (const g of groups.values()) {
    checkAborted(opts.signal);
    const byUid = new Map(g.members.map((m) => [m.uid, m]));
    const rawByUid = new Map<number, Map<string, Buffer>>();
    // Members whose every part is in the body cache need no FETCH.
    const toFetch = opts.bodyCache ? g.members.filter((m) => !cachedParts(opts.bodyCache!, m, g.parts, rawByUid)) : g.members;
    try {
      if (toFetch.length > 0) for await (const msg of fetchByUid(
        client,
        toFetch.map((m) => m.uid),
        { uid: true, bodyParts: g.parts.map((p) => ({ key: p.partId, start: 0, maxLength: p.maxLength })) },
      )) {
        checkAborted(opts.signal);
        if (msg.uid != null && msg.bodyParts) {
          rawByUid.set(msg.uid, msg.bodyParts);
          if (opts.bodyCache) cacheParts(opts.bodyCache, byUid.get(msg.uid), g.parts, msg.bodyParts);
        }
      }
    } catch (e) {
      // An abandoned request stops here; only IMAP failures are best-effort.
      if (e instanceof BudgetExceededError) throw e;
      // fall through: members without raw parts get isEncodingProblem below
      log.warn({ uids: g.members.map((m) => m.uid), partIds: g.parts.map((p) => p.partId), ...imapErrorDetails(e) }, "body part FETCH failed");
    }
    const ceiling = new Map(g.parts.map((p) => [p.partId, p.maxLength]));
    checkAborted(opts.signal);
    for (const m of g.members) {
      const bodyParts = rawByUid.get(m.uid);
      const values: JmapEmail["bodyValues"] = {};
      for (const [partId, part] of byUid.get(m.uid)!.wanted) {
        const raw = bodyParts?.get(partId);
        if (!raw) {
          values[partId] = { value: "", isEncodingProblem: true, isTruncated: false };
          continue;
        }
        const decoded = decodeTransferEncoding(raw, part.encoding);
        // Cut short on the wire: the part is longer than what we fetched.
        const cutOnWire = raw.length >= ceiling.get(partId)! && !(part.size > 0 && part.size <= raw.length);
        const truncated = decoded.length > cap || cutOnWire;
        const slice = decoded.length > cap ? decoded.subarray(0, cap) : decoded;
        const text = decodePartTextChecked(slice, part.charset, truncated);
        values[partId] = {
          value: text.value,
          isEncodingProblem: text.problem,
          isTruncated: truncated,
        };
      }
      out.set(m.uid, values);
    }
  }
  return out;
}

// Fetch preview snippets for the given messages, batching one FETCH per
// distinct (part id, length) (typically one or two groups per page). A
// plain-text part that yields no preview (empty, or nothing but a leftover
// style sheet) falls back to the message's HTML part in a second round.
async function fetchPreviewsBatched(
  client: ImapFlow,
  targets: ProcessedMeta[],
): Promise<Map<number, string>> {
  interface PreviewTask {
    uid: number;
    part: EmailBodyPart;
    isHtml: boolean;
    maxLength: number;
    fallback: EmailBodyPart | null;
  }
  const out = new Map<number, string>();
  let budget = PREVIEW_FETCH_BUDGET;
  const task = (uid: number, part: EmailBodyPart, isHtml: boolean, fallback: EmailBodyPart | null): PreviewTask | null => {
    const cap = isHtml ? PREVIEW_HTML_FETCH_BYTES : PREVIEW_TEXT_FETCH_BYTES;
    const maxLength = part.size > 0 ? Math.min(part.size, cap) : cap;
    if (maxLength > budget) return null; // no preview this time, and none cached
    budget -= maxLength;
    return { uid, part, isHtml, maxLength, fallback };
  };

  let tasks: PreviewTask[] = [];
  for (const p of targets) {
    const { text, html } = previewParts(p.sel);
    const part = text ?? html;
    if (!part) {
      // No previewable part at all: the empty preview is final, cacheable.
      out.set(p.raw.uid, "");
      continue;
    }
    const t = task(p.raw.uid, part, part === html, part === html ? null : html);
    if (t) tasks.push(t);
  }

  while (tasks.length > 0) {
    const retry: PreviewTask[] = [];
    const groups = new Map<string, PreviewTask[]>();
    for (const t of tasks) {
      const k = `${t.part.partId}\0${t.maxLength}`;
      let arr = groups.get(k);
      if (!arr) groups.set(k, (arr = []));
      arr.push(t);
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      const partId = first.part.partId!;
      const taskByUid = new Map(group.map((t) => [t.uid, t]));
      try {
        for await (const m of fetchByUid(
          client,
          group.map((t) => t.uid),
          { uid: true, bodyParts: [{ key: partId, start: 0, maxLength: first.maxLength }] },
        )) {
          if (m.uid == null) continue;
          const buf = m.bodyParts?.get(partId);
          const t = taskByUid.get(m.uid);
          if (!buf || !t) continue;
          const decoded = decodeTransferEncoding(buf, t.part.encoding);
          const preview = buildPreview(decodePartText(decoded, t.part.charset), t.isHtml);
          if (preview === "" && t.fallback) {
            const next = task(t.uid, t.fallback, true, null);
            if (next) retry.push(next);
            continue;
          }
          out.set(m.uid, preview);
        }
      } catch (e) {
        // best-effort: leave preview empty (and uncached) for this group
        log.warn({ partId, uids: group.map((t) => t.uid), ...imapErrorDetails(e) }, "preview FETCH failed");
      }
    }
    tasks = retry;
  }
  return out;
}

// Bulk fetch: serve immutable metadata from the SQLite cache when a Store is
// supplied, FETCH only the cache misses (plus one cheap flags-only FETCH for
// the hits, since flags are mutable), then batch previews and bodyValues
// across the whole page. Returns a Map keyed by uid so callers can match
// notFound by id.
export async function fetchEmailsBatch(
  client: ImapFlow,
  account: AccountRow,
  mailbox: MailboxRow,
  uids: number[],
  bodyOpts: BodyFetchOpts = {},
  store?: Store,
): Promise<Map<number, JmapEmail>> {
  const out = new Map<number, JmapEmail>();
  // Each message once, whatever the caller passed: everything below is per UID.
  uids = [...new Set(uids)];
  if (uids.length === 0) return out;
  const needsFull = bodyOpts.needsFullHeaders === true;
  const budget = bodyOpts.headerBudget ?? { remaining: MAX_FULL_HEADER_BYTES_PER_CALL };

  // Scalar columns only; a cached header block is read below, one at a time
  // and only within the budget.
  const cachedRows = store
    ? store.getEmailCacheRows(account.id, mailbox.id, mailbox.uidvalidity, uids)
    : new Map<number, never>();
  const raws = new Map<number, RawMeta>();
  const missing: number[] = [];
  for (const uid of uids) {
    const row = cachedRows.get(uid);
    const thread = parseThreadInputs(row?.thread_inputs);
    if (
      row &&
      thread &&
      (row.envelope_len ?? 0) > 0 &&
      (row.bodystructure_len ?? 0) > 0 &&
      (row.envelope_len ?? 0) <= MAX_ENVELOPE_JSON_CHARS &&
      (row.bodystructure_len ?? 0) <= MAX_BODYSTRUCTURE_JSON_CHARS &&
      (!needsFull || (row.headers_full === 1 && (row.headers_len ?? 0) > 0))
    ) {
      try {
        // Sizes first, then this row's metadata only.
        chargeMetadata(bodyOpts.metadataBudget, (row.envelope_len ?? 0) + (row.bodystructure_len ?? 0));
        const meta = store!.getEmailCacheMeta(account.id, mailbox.id, mailbox.uidvalidity, uid);
        if (!meta?.envelope || !meta.bodystructure) throw new Error("incomplete cache row");
        const envelope = boundEnvelope(JSON.parse(meta.envelope) as EnvelopeLike | null);
        const bodystructure = boundBodyStructure(JSON.parse(meta.bodystructure));
        // Rows written before the guards above can hold the string "null".
        if (!envelope || !bodystructure) throw new Error("incomplete cache row");
        let headersRaw: Buffer | null = null;
        const len = row.headers_len ?? 0;
        if (needsFull && store && len <= budget.remaining) {
          budget.remaining -= len;
          headersRaw = headersToBuffer(store.getEmailCacheHeaders(account.id, mailbox.id, mailbox.uidvalidity, uid) ?? undefined);
        }
        const full = headersRaw !== null;
        raws.set(uid, {
          uid,
          flags: null,
          size: row.size ?? 0,
          internaldate: row.internaldate,
          envelope,
          bodystructure,
          headersRaw,
          headersFull: full,
          headersTruncated: row.headers_truncated === 1,
          thread,
          cachedThreadId: row.thread_id,
          preview: row.preview,
          fromCache: true,
        });
        continue;
      } catch (e) {
        if (e instanceof BudgetExceededError) throw e;
        // corrupt cache row: fall through to a live fetch
      }
    }
    missing.push(uid);
  }

  if (missing.length > 0) {
    const fetchedMeta = new Map<number, FetchMessageObject>();
    for await (const m of fetchByUid(client, missing, META_QUERY)) {
      // imapflow hands back every untagged FETCH that arrives during the
      // command, including the FLAGS-only ones a server pushes when another
      // session changes flags. Those carry no structure; keep the real answer.
      if (m.uid == null || !m.bodyStructure || !m.envelope) continue;
      // Bound this message's metadata before reading the next one.
      const envelope = boundEnvelope(m.envelope as EnvelopeLike);
      const bodyStructure = boundBodyStructure(m.bodyStructure);
      chargeMetadata(bodyOpts.metadataBudget, jsonSize(envelope) + jsonSize(bodyStructure));
      checkAborted(bodyOpts.signal);
      fetchedMeta.set(m.uid, { uid: m.uid, flags: m.flags, size: m.size, internalDate: m.internalDate,
        envelope, bodyStructure } as FetchMessageObject);
    }
    // One block at a time: derive the ThreadInputs (or reuse the ones the
    // thread scan already cached for this message), keep the full block only
    // when asked for and within the call's budget.
    const reduced = new Map<number, { thread: ThreadInputs; full: Buffer | null; truncated: boolean }>();
    for await (const { uid, block } of headerBlocksBounded(
      client,
      [...fetchedMeta.keys()],
      (u) => fetchedMeta.get(u)?.size,
      needsFull,
    )) {
      const thread = parseThreadInputs(cachedRows.get(uid)?.thread_inputs) ?? threadInputs(parseHeaderBlock(block));
      let full: Buffer | null = null;
      if (needsFull && block.length <= budget.remaining) {
        budget.remaining -= block.length;
        full = block;
      }
      // A block that fills the bound of a larger message is only its prefix.
      const truncated = block.length >= MAX_HEADER_BLOCK_BYTES && (fetchedMeta.get(uid)?.size ?? Infinity) > block.length;
      reduced.set(uid, { thread, full, truncated });
    }
    for (const [uid, m] of fetchedMeta) {
      const r = reduced.get(uid);
      const raw = rawFromFetch(m, r?.thread ?? EMPTY_THREAD, r?.full ?? null, r?.truncated ?? false);
      raw.cachedThreadId = cachedRows.get(uid)?.thread_id ?? null;
      raws.set(uid, raw);
    }
  }

  // Flags for cache-served messages: one flags-only FETCH for the whole set.
  const flagUids = uids.filter((uid) => raws.get(uid)?.flags === null);
  if (flagUids.length > 0) {
    for await (const m of fetchByUid(client, flagUids, { uid: true, flags: true })) {
      if (m.uid == null) continue;
      const r = raws.get(m.uid);
      if (r) r.flags = new Set(m.flags ?? []);
    }
  }

  const processed: ProcessedMeta[] = [];
  for (const uid of uids) {
    const r = raws.get(uid);
    // A cache hit whose flags FETCH returned nothing means the message was
    // expunged; drop it (and the stale row) so the caller reports notFound.
    if (!r || (r.fromCache && r.flags === null)) {
      if (r && store) store.deleteEmailCacheUids(account.id, mailbox.id, [uid]);
      continue;
    }
    processed.push(processMeta(account, mailbox, r));
  }

  const wantsBodies =
    bodyOpts.fetchTextBodyValues === true ||
    bodyOpts.fetchHTMLBodyValues === true ||
    bodyOpts.fetchAllBodyValues === true;
  const wantsPreview = bodyOpts.wantsPreview !== false;

  let bodyValuesByUid = new Map<number, JmapEmail["bodyValues"]>();
  if (wantsBodies) {
    bodyValuesByUid = await fetchBodyValuesBatched(
      client,
      processed.map((p) => ({ uid: p.raw.uid, wanted: wantedBodyParts(p.sel, bodyOpts) })),
      store && !bodyOpts.bodyCache ? { ...bodyOpts, bodyCache: storeBodyCache(store, account.id) } : bodyOpts,
    );
  }

  const previewByUid = new Map<number, string>();
  for (const p of processed) {
    if (p.raw.preview !== null) previewByUid.set(p.raw.uid, p.raw.preview);
  }
  if (wantsPreview) {
    if (wantsBodies) {
      // Derive previews from the body values we already have in hand.
      for (const p of processed) {
        if (previewByUid.has(p.raw.uid)) continue;
        const values = bodyValuesByUid.get(p.raw.uid) ?? {};
        let preview = "";
        const { text, html } = previewParts(p.sel);
        const textValue = text ? values[text.partId!] : undefined;
        const htmlValue = html ? values[html.partId!] : undefined;
        if (textValue) preview = buildPreview(textValue.value, false);
        if (!preview && htmlValue) preview = buildPreview(htmlValue.value, true);
        if (preview) previewByUid.set(p.raw.uid, preview);
      }
    }
    const needPreview = processed.filter((p) => !previewByUid.has(p.raw.uid));
    if (needPreview.length > 0) {
      const fetched = await fetchPreviewsBatched(client, needPreview);
      for (const [uid, preview] of fetched) previewByUid.set(uid, preview);
    }
    // Persist previews computed for rows that were served from cache without
    // one; fresh rows get theirs in the upsert below.
    if (store) {
      for (const p of processed) {
        if (!p.raw.fromCache || p.raw.preview !== null) continue;
        const preview = previewByUid.get(p.raw.uid);
        if (preview !== undefined) store.setEmailCachePreview(account.id, mailbox.id, p.raw.uid, preview);
      }
    }
  }

  if (store) {
    const upserts: EmailCacheUpsert[] = [];
    for (const p of processed) {
      if (p.raw.fromCache) continue;
      upserts.push({
        accountId: account.id,
        mailboxId: mailbox.id,
        uidvalidity: mailbox.uidvalidity,
        uid: p.raw.uid,
        threadId: p.threadId,
        internaldate: p.raw.internaldate,
        size: p.raw.size,
        envelope: JSON.stringify(p.raw.envelope),
        bodystructure: JSON.stringify(p.raw.bodystructure),
        headersRaw: p.raw.headersRaw,
        headersFull: p.raw.headersFull,
        headersTruncated: p.raw.headersTruncated,
        threadInputs: JSON.stringify(p.raw.thread),
        preview: previewByUid.get(p.raw.uid) ?? null,
      });
    }
    store.upsertEmailCacheRows(upserts);
  }

  for (const p of processed) {
    out.set(
      p.raw.uid,
      assembleEmail(
        account,
        mailbox,
        p,
        previewByUid.get(p.raw.uid) ?? "",
        bodyValuesByUid.get(p.raw.uid) ?? {},
      ),
    );
  }
  return out;
}

function stripBrackets(s: string): string {
  return s.replace(/^<|>$/g, "");
}
