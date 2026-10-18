// INBOX flags the IDLE worker vouches for.
//
// Opening a message whose body and metadata are cached still cost one IMAP
// round trip: a flags-only UID FETCH, which reads the keywords and notices a
// message that is gone. For INBOX, while an IDLE worker watches it, both are
// known without asking: the worker lists INBOX's UIDs after every change it
// hears of, and hears every flag change (with the UID, or by sequence number,
// see idle.ts). So the flags a request read live are kept here and answer the
// next open, for as long as nothing could have changed them unnoticed:
//
//  - the worker is connected and its last listing is current (no diff queued
//    or running), and lists the UID;
//  - no gap since the entry was written: anything the worker cannot name, any
//    Email/set through this proxy (before and after it runs), a reconnect;
//  - the entry is younger than INBOX_FLAGS_MAX_AGE_MS.
//
// Otherwise the request FETCHes, as before. A write is kept only when no flag
// change and no gap happened while its FETCH was out (the token), so a value
// read before a change never outlives it.

export const INBOX_FLAGS_MAX_AGE_MS = 10 * 60_000;
const MAX_ENTRIES = 5000;

interface View {
  live: boolean;
  uidValidity: number;
  uids: Set<number>;
  pending: number;
  // Bumped by every gap and every flag change heard: entries and tokens from
  // before a gap are void.
  gen: number;
  token: number;
  flags: Map<number, { flags: string[]; gen: number; at: number }>;
}

const views = new Map<number, View>();

function view(accountId: number): View {
  let v = views.get(accountId);
  if (!v) {
    v = { live: false, uidValidity: 0, uids: new Set(), pending: 0, gen: 0, token: 0, flags: new Map() };
    views.set(accountId, v);
  }
  return v;
}

/** The worker queued a diff of INBOX: its listing may not match the server until it ran. */
export function inboxSyncQueued(accountId: number): void {
  view(accountId).pending++;
}

/** A queued diff finished (successfully or not). */
export function inboxSyncDone(accountId: number): void {
  const v = view(accountId);
  v.pending = Math.max(0, v.pending - 1);
}

/** The worker listed INBOX: these UIDs exist, under this UIDVALIDITY. */
export function inboxListed(accountId: number, uidValidity: number, uids: number[]): void {
  const v = view(accountId);
  if (v.uidValidity !== uidValidity) inboxGap(accountId);
  v.live = true;
  v.uidValidity = uidValidity;
  v.uids = new Set(uids);
}

/** Something changed that nobody can name (or the worker stopped watching): forget every entry. */
export function inboxGap(accountId: number): void {
  const v = view(accountId);
  v.gen++;
  v.token++;
  v.flags.clear();
}

/** The worker stopped watching (closed, failed): nothing here may be trusted until it lists INBOX again. */
export function inboxUnwatched(accountId: number): void {
  inboxGap(accountId);
  view(accountId).live = false;
}

/** The worker heard the flags of `uid` change to `flags`. */
export function inboxFlagsChanged(accountId: number, uid: number, flags: Iterable<string>): void {
  const v = view(accountId);
  v.token++;
  if (v.live) setEntry(v, uid, [...flags]);
}

/** Taken before a live FETCH of flags; rememberInboxFlags keeps the result only if nothing changed meanwhile. */
export function inboxFlagsToken(accountId: number): number {
  return view(accountId).token;
}

/** Flags read live by a request (FETCH sent after `token` was taken). */
export function rememberInboxFlags(accountId: number, uidValidity: number, read: Map<number, Iterable<string>>, token: number): void {
  const v = view(accountId);
  if (!v.live || v.pending > 0 || v.uidValidity !== uidValidity || v.token !== token) return;
  for (const [uid, flags] of read) if (v.uids.has(uid)) setEntry(v, uid, [...flags]);
}

/** The flags of INBOX's `uid`, when the worker vouches for them; null means FETCH. */
export function knownInboxFlags(accountId: number, uidValidity: number, uid: number, now: number = Date.now()): string[] | null {
  const v = views.get(accountId);
  if (!v || !v.live || v.pending > 0 || v.uidValidity !== uidValidity || !v.uids.has(uid)) return null;
  const e = v.flags.get(uid);
  if (!e || e.gen !== v.gen || now - e.at > INBOX_FLAGS_MAX_AGE_MS) return null;
  return e.flags;
}

function setEntry(v: View, uid: number, flags: string[]): void {
  v.flags.delete(uid);
  v.flags.set(uid, { flags, gen: v.gen, at: Date.now() });
  if (v.flags.size > MAX_ENTRIES) {
    const oldest = v.flags.keys().next().value;
    if (oldest !== undefined) v.flags.delete(oldest);
  }
}

/** Tests only. */
export function __resetInboxFlags(): void {
  views.clear();
}
