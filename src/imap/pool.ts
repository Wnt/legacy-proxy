import type { ImapFlow } from "imapflow";
import type { Credentials } from "../auth/credentials.js";
import type { AppConfig } from "../util/config.js";
import { resolveProvider } from "../auth/providers.js";
import { openCredentials } from "../auth/credentials.js";
import { openImap } from "./client.js";
import type { Store, AccountRow } from "../state/store.js";
import { log } from "../util/log.js";
import { checkAborted, RequestAbortedError } from "./abort.js";

interface PoolEntry {
  client: ImapFlow;
  lastUsed: number;
  // True while a caller holds this connection. imapflow serialises commands
  // per socket, so handing one connection to two concurrent callers would
  // queue them behind each other — exactly what the pool exists to avoid.
  busy: boolean;
  // The account's mail state (see `mailState`) this connection's view is
  // known to include: read just before its last NOOP, or before it was
  // opened.
  synced: MailState;
}

// Account state counters that move whenever a mailbox's contents change:
// IDLE untaggeds (new mail, expunges, flag changes from other clients) and
// our own Email/set, Email/import, EmailSubmission and Mailbox/set all bump
// one of them.
interface MailState {
  email: number;
  mailbox: number;
}

function mailState(store: Store, accountId: number): MailState {
  return { email: store.getState(accountId, "email"), mailbox: store.getState(accountId, "mailbox") };
}

// The email state each pooled connection's view includes, for callers that
// stamp results with a state (Email/query's queryState, Email/get's state,
// the SEARCH cache). Keyed by client so it follows the connection.
const syncedEmailState = new WeakMap<ImapFlow, number>();

/**
 * The email state that results read on `client` are guaranteed to include,
 * or undefined for a connection that is not from the pool.
 */
export function viewEmailState(client: ImapFlow): number | undefined {
  return syncedEmailState.get(client);
}

// Skip the sanity-NOOP if the connection was used within this window AND the
// account's mail state has not moved since the connection last synced (see
// takeFree: a state change always forces the NOOP).
// Every JMAP method funnels through acquire, so a per-call NOOP adds one IMAP
// round-trip to every request - visible as multi-second latency on slow links.
// Most servers don't drop idle TCP for tens of seconds, so we only NOOP after
// a meaningful idle gap.
const NOOP_FRESHNESS_MS = 30_000;

// Two connection roles per account:
//   - "interactive": JMAP method calls (the latency-sensitive path).
//   - "bulk": blob downloads and thread-index scans — operations that can
//     hold the socket for seconds. Splitting them keeps a 20 MB attachment
//     download or a first-time account scan from freezing every other
//     request for the account.
export type PoolRole = "interactive" | "bulk";

// How many sockets each role may open per account. A browser issues several
// JMAP requests at once (folder list, message list, open message); with a
// single interactive socket they all queued behind one another inside
// imapflow. Kept small so one user cannot exhaust a server's per-account
// connection limit — IMAP servers commonly cap that in the 4-10 range, and
// the push IDLE worker holds one more outside this pool.
//
// Full-text searches split a large folder over the bulk connections (the
// server reads messages per connection, in parallel), so bulk has four: with
// interactive and the IDLE worker that is eight, under Dovecot's default of
// ten per user and IP. A server that refuses one sooner caps the role at what
// it accepted (see takeFree).
export const BULK_CONNECTIONS = 4;
const MAX_PER_ROLE: Record<PoolRole, number> = {
  interactive: 3,
  bulk: BULK_CONNECTIONS,
};

// After the server refused a new connection while the role already had some,
// the role stays at the count that worked for this long.
const REFUSED_CAP_MS = 10 * 60_000;

// Callers that may wait for a connection per pool key. JMAP requests are also
// limited per account (maxConcurrentRequests) before they get here; this bounds
// everything else (downloads, IDLE lookups) as well.
const MAX_WAITERS = 64;

/** Thrown when too many callers are already waiting for a connection. */
export class PoolBusyError extends Error {
  constructor(key: string) {
    super(`too many requests waiting for an IMAP connection (${key})`);
  }
}

/** A borrowed connection. `release` must be called exactly once. */
export interface Lease {
  client: ImapFlow;
  release: () => void;
}

export class ImapPool {
  private entries = new Map<string, PoolEntry[]>();
  // Callers parked waiting for a connection to come free, per pool key.
  private waiters = new Map<string, Array<() => void>>();
  // Slots reserved by opens still in flight (credential decrypt, TCP, TLS,
  // LOGIN), per pool key. Counted with the established entries against the
  // cap, so concurrent callers can't all pass the check before any of them
  // has attached its connection.
  private opening = new Map<string, number>();

  constructor(
    private cfg: AppConfig,
    private store: Store,
  ) {}

  /**
   * Borrow a connection for the duration of `fn`. The connection returns to
   * the pool whether `fn` resolves or throws. With `signal`, see `acquire`.
   */
  async withConnection<T>(
    account: AccountRow,
    role: PoolRole,
    fn: (client: ImapFlow) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lease = await this.acquire(account, role, signal);
    try {
      return await fn(lease.client);
    } finally {
      lease.release();
    }
  }

  /**
   * Borrow a connection with an explicit release. Prefer `withConnection`;
   * this exists for callers whose use outlives a single async scope, such as
   * the blob download route streaming a response body.
   *
   * With `signal`, a caller whose request is abandoned while it waits leaves
   * the queue at once, and a connection it obtains after that is given back
   * unused: nothing queued for a request that has gone starts afterwards.
   */
  async acquire(account: AccountRow, role: PoolRole = "interactive", signal?: AbortSignal): Promise<Lease> {
    const key = `${account.id}:${role}`;
    for (;;) {
      checkAborted(signal);
      const got = await this.takeFree(account, key, role, signal);
      if ("entry" in got) {
        const lease = this.leaseFor(key, got.entry);
        // Aborted while a NOOP or the LOGIN of a new connection ran.
        if (signal?.aborted) {
          lease.release();
          throw new RequestAbortedError();
        }
        return lease;
      }
      // At the cap with everything busy: park until someone releases, then
      // re-run the whole selection (the freed entry may have died meanwhile).
      // takeFree registered the wait in the same synchronous step as the cap
      // check, so a release in between can't be missed.
      await got.wait;
    }
  }

  /**
   * Claim a usable idle connection, or open one if the role is under its cap.
   * When every slot is taken, returns a wait already registered for the next
   * release.
   */
  private async takeFree(
    account: AccountRow,
    key: string,
    role: PoolRole,
    signal?: AbortSignal,
  ): Promise<{ entry: PoolEntry } | { wait: Promise<void> }> {
    const list = [...(this.entries.get(key) ?? [])];
    for (const entry of list) {
      if (entry.busy) continue;
      if (!entry.client.usable) {
        this.drop(key, entry);
        continue;
      }
      entry.busy = true;
      const idleMs = Date.now() - entry.lastUsed;
      entry.lastUsed = Date.now();
      // A SELECTed IMAP session sees other sessions' changes (new mail,
      // expunges, flag changes) only when the server announces them, and some
      // servers (Stalwart) do so on NOOP but not on SEARCH or FETCH. So once
      // the IDLE worker or another request has advanced the account's state,
      // this connection may answer from a view older than the state we have
      // already advertised: a StateChange says "new mail" and the next
      // Email/query or Email/get would not show it. NOOP first in that case.
      // Read the target state BEFORE the NOOP: anything counted in it was
      // committed on the server before we ask, so the NOOP is sure to see it.
      const target = mailState(this.store, account.id);
      const stale = target.email !== entry.synced.email || target.mailbox !== entry.synced.mailbox;
      if (idleMs < NOOP_FRESHNESS_MS && !stale) return { entry };
      try {
        await entry.client.noop();
        this.markSynced(entry, target);
        return { entry };
      } catch {
        // Dead despite looking usable; drop it and keep looking.
        entry.busy = false;
        this.drop(key, entry);
      }
    }

    // Check and reserve in the same synchronous step, before any await.
    if (this.slotsInUse(key) >= this.capFor(key, role)) {
      // A connection released while we awaited a NOOP above woke nobody (we
      // weren't queued yet): take another pass instead of parking.
      const freed = (this.entries.get(key) ?? []).some((e) => !e.busy && e.client.usable);
      return { wait: freed ? Promise.resolve() : this.waitForRelease(key, signal) };
    }
    this.opening.set(key, (this.opening.get(key) ?? 0) + 1);
    let entry: PoolEntry;
    try {
      const provider = resolveProvider(this.cfg, account.kind);
      const creds: Credentials = await openCredentials(this.cfg.vaultKey, account.vault);
      const synced = mailState(this.store, account.id);
      const client = await openImap({ provider, creds });
      entry = { client, lastUsed: Date.now(), busy: true, synced };
      this.markSynced(entry, synced);
    } catch (e) {
      this.unreserve(key);
      // Connections that work, or may: established ones and others still opening.
      const established = this.slotsInUse(key);
      if (established > 0 && isConnectionLimit(e)) {
        // The server refused one more (a per-user connection limit): keep to
        // the connections that work and wait for one of them, rather than fail
        // a caller that only wanted capacity. Other failures (a bad login)
        // still reach the caller.
        this.refusedCap.set(key, { cap: established, until: Date.now() + REFUSED_CAP_MS });
        log.warn({ key, cap: established, err: (e as Error).message }, "imap connection refused; capping the role");
        const freed = (this.entries.get(key) ?? []).some((x) => !x.busy && x.client.usable);
        return { wait: freed ? Promise.resolve() : this.waitForRelease(key, signal) };
      }
      // The slot is free again: let a parked caller try to open it.
      this.wake(key);
      throw e;
    }
    // Hand the reservation over to the attached entry in one step.
    this.unreserve(key);
    this.attach(account, key, entry);
    return { entry };
  }

  private refusedCap = new Map<string, { cap: number; until: number }>();

  /** The role's cap, lowered for a while after the server refused a connection. */
  private capFor(key: string, role: PoolRole): number {
    const r = this.refusedCap.get(key);
    if (r && r.until > Date.now()) return Math.min(MAX_PER_ROLE[role], Math.max(1, r.cap));
    if (r) this.refusedCap.delete(key);
    return MAX_PER_ROLE[role];
  }

  /** Established plus still-opening connections for a pool key. */
  private slotsInUse(key: string): number {
    return (this.entries.get(key)?.length ?? 0) + (this.opening.get(key) ?? 0);
  }

  private unreserve(key: string): void {
    const n = (this.opening.get(key) ?? 1) - 1;
    if (n > 0) this.opening.set(key, n);
    else this.opening.delete(key);
  }

  private markSynced(entry: PoolEntry, state: MailState): void {
    entry.synced = state;
    syncedEmailState.set(entry.client, state.email);
  }

  private leaseFor(key: string, entry: PoolEntry): Lease {
    let released = false;
    return {
      client: entry.client,
      release: () => {
        if (released) return;
        released = true;
        entry.busy = false;
        entry.lastUsed = Date.now();
        // A caller that killed the socket (or found it dead) must not leave a
        // corpse in the pool for the next borrower to trip over.
        if (!entry.client.usable) this.drop(key, entry);
        this.wake(key);
      },
    };
  }

  private waitForRelease(key: string, signal?: AbortSignal): Promise<void> {
    const queue = this.waiters.get(key) ?? [];
    // Each parked caller is a request holding memory; past this many, fail
    // fast instead of queueing without bound.
    if (queue.length >= MAX_WAITERS) throw new PoolBusyError(key);
    checkAborted(signal);
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", leave);
        resolve();
      };
      // An abandoned caller leaves its place in the queue rather than waiting
      // for a connection it would only give back.
      const leave = () => {
        const q = this.waiters.get(key);
        const i = q ? q.indexOf(wake) : -1;
        if (i >= 0) {
          q!.splice(i, 1);
          if (q!.length === 0) this.waiters.delete(key);
        }
        reject(new RequestAbortedError());
      };
      queue.push(wake);
      this.waiters.set(key, queue);
      signal?.addEventListener("abort", leave, { once: true });
    });
  }

  private wake(key: string): void {
    const queue = this.waiters.get(key);
    if (!queue || queue.length === 0) return;
    const next = queue.shift()!;
    if (queue.length === 0) this.waiters.delete(key);
    next();
  }

  // Hand a live, already-authenticated connection to the pool. The auth paths
  // open a probe connection to validate credentials; adopting it saves the
  // immediately-following JMAP request from paying a second TCP+TLS+LOGIN
  // handshake. If the interactive role is already at its cap the probe is
  // logged out.
  adopt(account: AccountRow, client: ImapFlow): void {
    const key = `${account.id}:interactive`;
    if (this.slotsInUse(key) >= MAX_PER_ROLE.interactive) {
      client.logout().catch(() => {});
      return;
    }
    // The probe has not SELECTed anything yet, so its first SELECT will be
    // current; the state read now is a safe lower bound for its view.
    const entry: PoolEntry = { client, lastUsed: Date.now(), busy: false, synced: mailState(this.store, account.id) };
    this.markSynced(entry, entry.synced);
    this.attach(account, key, entry);
    this.wake(key);
  }

  private attach(account: AccountRow, key: string, entry: PoolEntry): void {
    entry.client.on("close", () => {
      log.warn({ account: account.slug, key }, "imap connection closed");
      this.drop(key, entry);
      // A slot just opened up, so let a parked caller dial a replacement.
      this.wake(key);
    });
    entry.client.on("error", (err: Error) => {
      log.warn({ account: account.slug, key, err: err.message }, "imap connection error");
      this.drop(key, entry);
      this.wake(key);
    });
    const list = this.entries.get(key) ?? [];
    list.push(entry);
    this.entries.set(key, list);
  }

  private drop(key: string, entry: PoolEntry): void {
    const list = this.entries.get(key);
    if (!list) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.entries.delete(key);
  }

  async closeAll(): Promise<void> {
    for (const list of this.entries.values()) {
      for (const e of list) {
        try {
          await e.client.logout();
        } catch {
          // best effort
        }
      }
    }
    this.entries.clear();
    // Nobody is coming back for these; unblock anyone still parked.
    for (const queue of this.waiters.values()) for (const resolve of queue) resolve();
    this.waiters.clear();
  }
}

/**
 * A refusal because of the server's connection limit, as Dovecot words it
 * ("NO [LIMIT] Maximum number of connections from user+IP exceeded") and
 * others do ("too many connections").
 */
export function isConnectionLimit(e: unknown): boolean {
  const x = (e ?? {}) as { message?: unknown; responseText?: unknown; serverResponseCode?: unknown; response?: unknown };
  const text = [x.message, x.responseText, x.serverResponseCode, typeof x.response === "string" ? x.response : ""]
    .filter((v) => typeof v === "string")
    .join(" ");
  return /\[?LIMIT\]?|maximum number of connections|too many (simultaneous |concurrent )?connections/i.test(text);
}
