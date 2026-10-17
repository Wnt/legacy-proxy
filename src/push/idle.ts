// Holds one dedicated IMAP connection per account that has at least one
// verified PushSubscription. The connection sits in INBOX with IDLE running,
// so EXISTS/EXPUNGE/FETCH-FLAGS untaggeds wake us as soon as the server emits
// them — no client polling, no cron, no second JMAP request. New arrivals
// bump `email_delivery` (the type the webmail subscribes to for system
// notifications); structural changes also bump `email` and `mailbox` so SSE
// clients refresh.
//
// The connection here is separate from the request-path ImapPool: imapflow
// only allows one mailbox-lock at a time, and we can't have a long-running
// IDLE blocking every Email/get the user issues. The dedicated socket also
// means a request-path connection drop never costs us push uptime.

import { ImapFlow } from "imapflow";
import { prefetchEmails } from "../imap/prefetch.js";
import type { Credentials } from "../auth/credentials.js";
import { openCredentials } from "../auth/credentials.js";
import { resolveProvider } from "../auth/providers.js";
import { openImap, withMailbox } from "../imap/client.js";
import type { ImapPool } from "../imap/pool.js";
import type { Store, AccountRow } from "../state/store.js";
import type { AppConfig } from "../util/config.js";
import { log } from "../util/log.js";
import { encodeEmailId } from "../mapping/ids.js";

// Reconnect backoff. Most disconnects are transient (mid-air NAT timeout,
// server restart), so start aggressive; cap so we don't hammer a server
// that's actually down. The cap is also the worst-case latency a user sees
// for the first push after extended downtime.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

// Most servers force-terminate IDLE after ~29 minutes (RFC 2177). We restart
// IDLE before that to keep the channel alive.
const IDLE_REFRESH_MS = 25 * 60_000;

// How long after sending IDLE we assume the server has acknowledged it, and
// run the catch-up diff (see enterIdle). Generous next to one round trip.
const IDLE_SETTLE_MS = 1_000;

// imapflow's IDLE helper is fire-and-await: it returns when IDLE ends. We
// kick it off in the background and rotate before the server times us out.
interface Worker {
  client: ImapFlow | null;
  closing: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  refreshTimer: NodeJS.Timeout | null;
  backoffMs: number;
  // INBOX UIDs this worker has reported, ascending (= sequence order). Kept
  // across reconnects so the next connection can report what changed while
  // the socket was down. Null until the first connection has listed INBOX.
  inbox: { uidValidity: number; uids: number[] } | null;
  // Diffs run one at a time, in event order, on this chain.
  queue: Promise<void>;
}

export class PushIdleManager {
  private workers = new Map<number, Worker>();

  constructor(
    private cfg: AppConfig,
    private store: Store,
    // Request-path connections, used to look up the UIDs behind IDLE events
    // so the IDLE socket itself never leaves IDLE for it.
    private pool: ImapPool,
  ) {}

  // Compute the desired set from the DB and converge `workers` onto it.
  // Idempotent — safe to call any time the subscription set changes.
  async sync(): Promise<void> {
    const desired = new Set(this.store.accountsWithActivePushSubs());

    // Drop workers for accounts that no longer need one.
    for (const [accountId, worker] of this.workers) {
      if (!desired.has(accountId)) {
        await this.stop(accountId, worker);
      }
    }

    // Spin up workers for newly active accounts.
    for (const accountId of desired) {
      if (this.workers.has(accountId)) continue;
      this.start(accountId);
    }
  }

  // Hook the dispatcher fires whenever a PushSubscription/set mutation lands.
  // We lazy-sync rather than tracking every transition by hand so the truth
  // always lives in SQLite.
  onSubscriberChange = (_accountId: number): void => {
    void this.sync();
  };

  async closeAll(): Promise<void> {
    for (const [accountId, worker] of this.workers) {
      await this.stop(accountId, worker);
    }
  }

  private start(accountId: number): void {
    const account = this.store.getAccountById(accountId);
    if (!account) return;
    const worker: Worker = {
      client: null,
      closing: false,
      reconnectTimer: null,
      refreshTimer: null,
      backoffMs: RECONNECT_MIN_MS,
      inbox: null,
      queue: Promise.resolve(),
    };
    this.workers.set(accountId, worker);
    this.connect(account, worker).catch((err) => {
      log.warn({ accountId, err: (err as Error).message }, "idle: initial connect failed");
      this.scheduleReconnect(account, worker);
    });
  }

  private async stop(accountId: number, worker: Worker): Promise<void> {
    worker.closing = true;
    if (worker.reconnectTimer) clearTimeout(worker.reconnectTimer);
    if (worker.refreshTimer) clearTimeout(worker.refreshTimer);
    if (worker.client) {
      try {
        await worker.client.logout();
      } catch {
        // best effort
      }
      worker.client = null;
    }
    this.workers.delete(accountId);
  }

  private async connect(account: AccountRow, worker: Worker): Promise<void> {
    if (worker.closing) return;
    const provider = resolveProvider(this.cfg, account.kind);
    const creds: Credentials = await openCredentials(this.cfg.vaultKey, account.vault);
    const client = await openImap({ provider, creds });

    // Every event below becomes a change-log entry naming the ids, so
    // Email/changes from the previous state lists exactly what arrived or
    // vanished. Where the ids cannot be known, the state is bumped as a gap
    // (Store.bumpState) and Email/changes answers cannotCalculateChanges:
    // never an empty `created` with a newer state. The ids are looked up on a
    // pooled connection (syncInbox), never on this socket: it stays in IDLE.
    //
    // imapflow's `'exists'` event tells us the post-mutation count + the
    // previous count. A higher count is a new arrival; equal/lower happens on
    // EXPUNGE-driven renumbering and is covered by the expunge handler.
    client.on("exists", (ev: { count: number; prevCount: number }) => {
      if (ev.count > ev.prevCount) {
        this.enqueue(account, worker, client, "arrival");
      } else {
        // The count moved without new mail; bump mailbox so cached counts refresh.
        this.store.bumpState(account.id, "mailbox");
      }
    });

    client.on("expunge", () => {
      // Deletes don't deserve a system notification but they do invalidate
      // any in-memory Email/Mailbox state on connected clients. EXPUNGE only
      // carries a sequence number, so re-list INBOX and diff.
      this.enqueue(account, worker, client, "full");
    });

    client.on("flags", (ev: { uid?: number }) => {
      // Read/Flagged toggles from another device land here. No EmailDelivery
      // bump (no new mail), but Email state moved. Servers usually include
      // the UID (Stalwart does); without it the change is a gap.
      const inbox = worker.inbox;
      if (inbox && ev.uid !== undefined) {
        this.store.recordChanges(account.id, "email", {
          updated: [this.emailId(account.id, inbox.uidValidity, ev.uid)],
        });
      } else {
        this.store.bumpState(account.id, "email");
      }
    });

    client.on("close", () => {
      log.info({ accountId: account.id }, "idle: connection closed");
      if (worker.refreshTimer) clearTimeout(worker.refreshTimer);
      if (worker.client === client) worker.client = null;
      this.scheduleReconnect(account, worker);
    });

    client.on("error", (err: Error) => {
      log.warn({ accountId: account.id, err: err.message }, "idle: connection error");
    });

    // Open INBOX. imapflow returns a lock that other ops would normally need;
    // we hold it for the lifetime of the connection so IDLE never gets
    // interrupted by a mid-flight FETCH on this socket.
    await client.mailboxOpen("INBOX");

    worker.client = client;
    worker.backoffMs = RECONNECT_MIN_MS;
    log.info({ accountId: account.id, host: provider.imap.host }, "idle: connected");

    // IDLE now, then learn (first connection) or diff (reconnect) INBOX's
    // UIDs: see enterIdle.
    this.enterIdle(account, worker, client);

    // Start the IDLE rotation. imapflow runs IDLE automatically when the
    // connection is otherwise quiet, but we explicitly cycle it before the
    // RFC 2177 30-minute server-side timeout would kill us.
    this.scheduleIdleRefresh(account, worker);
  }

  // Put the socket into IDLE at once, then catch up on a pooled connection.
  // Some servers (Stalwart) tell a session about mail that arrived while it
  // was not IDLE only on NOOP: not on SEARCH, and not when IDLE starts. So
  // whenever this socket is outside IDLE (after connecting, after the refresh
  // NOOP; imapflow on its own would wait autoIdleDelay, 15 s) mail can arrive
  // unannounced. The "full" diff afterwards finds it. imapflow does not expose
  // the server's IDLE acknowledgement, so it runs IDLE_SETTLE_MS later.
  private enterIdle(account: AccountRow, worker: Worker, client: ImapFlow): void {
    client.idle().catch(() => {}); // resolves when IDLE ends; failures surface as close
    const timer = setTimeout(() => this.enqueue(account, worker, client, "full"), IDLE_SETTLE_MS);
    timer.unref?.();
  }

  // Run diffs one at a time in event order: each one reads and replaces
  // worker.inbox.
  private enqueue(account: AccountRow, worker: Worker, client: ImapFlow, kind: "arrival" | "full"): void {
    worker.queue = worker.queue.then(() => this.syncInbox(account, worker, client, kind));
  }

  // Bring worker.inbox in step with the server and record the difference.
  // "arrival" only asks for UIDs above the highest known one (new mail always
  // gets a higher UID); "full" re-lists INBOX, which an expunge needs. The
  // first listing, or one after UIDVALIDITY changed, is a gap: nobody watched
  // before, so Email/changes from an earlier state must not pretend to know
  // what arrived meanwhile.
  private async syncInbox(
    account: AccountRow,
    worker: Worker,
    client: ImapFlow,
    kind: "arrival" | "full",
  ): Promise<void> {
    if (worker.closing || worker.client !== client) return; // superseded by a reconnect
    const inbox = worker.inbox;
    try {
      const seen = await this.pool.withConnection(account, "interactive", (c) =>
        withMailbox(c, "INBOX", async () => {
          // The pooled session may not have been told about the change yet.
          await c.noop();
          const uidValidity = c.mailbox ? Number(c.mailbox.uidValidity) : 0;
          if (kind === "arrival" && inbox && inbox.uidValidity === uidValidity) {
            const max = inbox.uids.length > 0 ? inbox.uids[inbox.uids.length - 1]! : 0;
            // `n:*` always includes the highest UID, even when it is below n.
            const above = (await searchUids(c, { uid: `${max + 1}:*` })).filter((u) => u > max);
            return { uidValidity, uids: inbox.uids.concat(above) };
          }
          return { uidValidity, uids: await searchUids(c, { all: true }) };
        }),
      );
      worker.inbox = seen;
      if (inbox && inbox.uidValidity === seen.uidValidity) {
        this.recordDiff(account, inbox.uids, seen.uids, seen.uidValidity);
      } else {
        this.store.bumpState(account.id, "email");
        if (kind === "arrival") this.store.bumpState(account.id, "email_delivery");
        this.store.bumpState(account.id, "mailbox");
      }
    } catch (err) {
      // We can't name the ids: announce the change as a gap, and forget the
      // list so the next sync starts over.
      log.warn({ accountId: account.id, err: (err as Error).message }, "idle: inbox sync failed");
      worker.inbox = null;
      this.store.bumpState(account.id, "email");
      if (kind === "arrival") this.store.bumpState(account.id, "email_delivery");
      this.store.bumpState(account.id, "mailbox");
    }
  }

  // Record created/destroyed ids between two UID lists. The email state moves
  // (with its log entry) BEFORE email_delivery, so by the time anyone hears
  // "new mail" Email/changes can name it, and the request path's pooled
  // connections see a newer state and refresh their view (ImapPool).
  private recordDiff(account: AccountRow, before: number[], after: number[], uidValidity: number): void {
    const was = new Set(before);
    const is = new Set(after);
    const created = after.filter((u) => !was.has(u)).map((u) => this.emailId(account.id, uidValidity, u));
    const destroyed = before.filter((u) => !is.has(u)).map((u) => this.emailId(account.id, uidValidity, u));
    if (created.length === 0 && destroyed.length === 0) return;
    this.store.recordChanges(account.id, "email", { created, destroyed });
    // New mail is what gets opened next: warm it (newest first).
    if (created.length > 0) prefetchEmails(this.pool, this.store, account, [...created].reverse());
    // New arrivals bump the counter the webmail's PushSubscription opts in
    // to; mailbox counts moved either way.
    if (created.length > 0) this.store.bumpState(account.id, "email_delivery");
    this.store.bumpState(account.id, "mailbox");
  }

  // Ids must match what Email/query and Email/get produce for INBOX, so use
  // INBOX's mailbox row (created here if no Mailbox/get has listed it yet;
  // listMailboxes upserts the same row by name).
  private emailId(accountId: number, uidValidity: number, uid: number): string {
    this.store
      .prep(
        `INSERT INTO mailbox(account_id, name, role, subscribed) VALUES(?, 'INBOX', 'inbox', 1)
         ON CONFLICT(account_id, name) DO NOTHING`,
      )
      .run(accountId);
    const row = this.store
      .prep(`SELECT id FROM mailbox WHERE account_id = ? AND name = 'INBOX'`)
      .get(accountId) as { id: number };
    return encodeEmailId({ accountIdx: accountId, mailboxIdx: row.id, uidvalidity: uidValidity, uid });
  }

  private scheduleIdleRefresh(account: AccountRow, worker: Worker): void {
    if (worker.refreshTimer) clearTimeout(worker.refreshTimer);
    worker.refreshTimer = setTimeout(() => {
      const c = worker.client;
      if (!c || worker.closing) return;
      // A NOOP both bumps the inactivity counter on the server side and
      // forces imapflow to drop+resume IDLE. Any failure here cascades to
      // the close handler, which will reconnect.
      c.noop()
        .then(() => this.enterIdle(account, worker, c))
        .catch((err: Error) => {
          log.warn({ accountId: account.id, err: err.message }, "idle: refresh noop failed");
        });
      this.scheduleIdleRefresh(account, worker);
    }, IDLE_REFRESH_MS);
  }

  private scheduleReconnect(account: AccountRow, worker: Worker): void {
    if (worker.closing) return;
    if (worker.reconnectTimer) clearTimeout(worker.reconnectTimer);
    const delay = worker.backoffMs;
    worker.backoffMs = Math.min(worker.backoffMs * 2, RECONNECT_MAX_MS);
    log.info({ accountId: account.id, delayMs: delay }, "idle: scheduling reconnect");
    worker.reconnectTimer = setTimeout(() => {
      worker.reconnectTimer = null;
      this.connect(account, worker).catch((err) => {
        log.warn({ accountId: account.id, err: (err as Error).message }, "idle: reconnect failed");
        this.scheduleReconnect(account, worker);
      });
    }, delay);
  }
}

async function searchUids(client: ImapFlow, query: Record<string, unknown>): Promise<number[]> {
  const found = await client.search(query, { uid: true });
  return Array.isArray(found) ? [...found].sort((a, b) => a - b) : [];
}
