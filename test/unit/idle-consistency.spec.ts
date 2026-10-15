// Regression: the IDLE worker announces new mail (StateChange), but the
// request path answered from a pooled IMAP connection whose view was older.
// Some servers (Stalwart) tell a SELECTed session about new messages only on
// NOOP, never on SEARCH or FETCH, and the pool NOOPed only after 30 s idle.
// So a client polled often enough was told "Email state moved" and then got
// an Email/query without the new message, and Email/changes, fed by a state
// bump that had no change-log entry, could answer `created: []` with the new
// state.
//
// The fake server below behaves like that: every session has its own view of
// INBOX; an IDLE-ing session hears of new mail and expunges at once, any
// other session only on NOOP or a fresh SELECT.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface Msg {
  uid: number;
  subject: string;
  flags: Set<string>;
}

class FakeServer {
  uidValidity = 7;
  messages: Msg[] = [];
  sessions = new Set<FakeSession>();
  // Called when a session SELECTs INBOX with mailboxOpen (the IDLE worker).
  onOpen: (() => void) | null = null;
  private nextUid = 1;

  deliver(subject: string): number {
    const uid = this.nextUid++;
    this.messages.push({ uid, subject, flags: new Set() });
    for (const s of this.sessions) if (s.idling) s.announce();
    return uid;
  }

  // Another client sets a flag: IDLE-ing sessions get an untagged FETCH
  // with FLAGS and UID, as Stalwart sends it.
  flag(uid: number, flag: string): void {
    const m = this.messages.find((x) => x.uid === uid)!;
    m.flags.add(flag);
    for (const s of this.sessions) {
      const seq = s.view.findIndex((x) => x.uid === uid) + 1;
      if (s.idling && seq > 0) s.emit("flags", { path: "INBOX", seq, uid, flags: m.flags });
    }
  }

  expunge(uid: number): void {
    this.messages = this.messages.filter((m) => m.uid !== uid);
    for (const s of this.sessions) if (s.idling) s.announce();
  }
}

let server = new FakeServer();

class FakeSession extends EventEmitter {
  usable = true;
  noopCalls = 0;
  // True once the session sent IDLE. Like Stalwart, entering IDLE does not
  // announce what arrived before; only changes during IDLE (or a NOOP) do.
  idling = false;
  // What this session has been told INBOX contains.
  view: Msg[] = [];
  mailbox: false | { path: string; exists: number; uidValidity: bigint; highestModseq: bigint } = false;

  constructor() {
    super();
    server.sessions.add(this);
  }

  // Bring the view in step with the server, emitting what imapflow would.
  announce(): void {
    if (!this.mailbox) return;
    const live = new Set(server.messages.map((m) => m.uid));
    for (let i = this.view.length - 1; i >= 0; i--) {
      if (!live.has(this.view[i]!.uid)) {
        this.view.splice(i, 1);
        this.mailbox.exists--;
        this.emit("expunge", { path: "INBOX", seq: i + 1, vanished: false });
      }
    }
    const known = new Set(this.view.map((m) => m.uid));
    const fresh = server.messages.filter((m) => !known.has(m.uid));
    if (fresh.length > 0) {
      const prevCount = this.view.length;
      this.view.push(...fresh);
      this.mailbox.exists = this.view.length;
      this.emit("exists", { path: "INBOX", count: this.view.length, prevCount });
    }
  }

  private select(p: string): void {
    if (p !== "INBOX") throw new Error(`no such mailbox ${p}`);
    this.view = [...server.messages];
    this.mailbox = { path: p, exists: this.view.length, uidValidity: BigInt(server.uidValidity), highestModseq: 1n };
  }

  async mailboxOpen(p: string) {
    this.select(p);
    server.onOpen?.();
    return this.mailbox;
  }

  async idle(): Promise<void> {
    this.idling = true;
  }

  async getMailboxLock(p: string) {
    // imapflow re-SELECTs only when another mailbox is selected.
    if (!this.mailbox || this.mailbox.path !== p) this.select(p);
    return { release: () => {} };
  }

  async noop(): Promise<void> {
    this.noopCalls++;
    this.announce();
  }

  async search(q: { all?: boolean; uid?: string }, _opts: unknown): Promise<number[]> {
    let uids = this.view.map((m) => m.uid);
    if (q.uid) {
      const [lo, hi] = q.uid.split(":");
      const min = Number(lo);
      const max = hi === "*" ? Infinity : Number(hi ?? lo);
      const inRange = uids.filter((u) => u >= min && u <= max);
      // `n:*` always matches the highest UID, as on a real server.
      uids = inRange.length > 0 || hi !== "*" || uids.length === 0 ? inRange : [uids[uids.length - 1]!];
    }
    return uids;
  }

  async *fetch(set: string, _query: unknown, _opts: unknown) {
    const wanted = new Set<number>();
    for (const part of set.split(",")) {
      const [a, b] = part.split(":").map(Number);
      for (let u = a!; u <= (b ?? a!); u++) wanted.add(u);
    }
    for (const m of this.view) {
      if (!wanted.has(m.uid)) continue;
      yield {
        uid: m.uid,
        flags: m.flags,
        size: 100,
        internalDate: new Date(1_700_000_000_000 + m.uid * 1000),
        envelope: { subject: m.subject, messageId: `<m${m.uid}@test>`, from: [{ name: "A", address: "a@test" }] },
        bodyStructure: { type: "text/plain", parameters: { charset: "utf-8" }, encoding: "7bit", size: 10 },
        headers: Buffer.from(`Message-ID: <m${m.uid}@test>\r\n\r\n`),
      };
    }
  }

  async logout(): Promise<void> {
    this.usable = false;
    server.sessions.delete(this);
  }
}

vi.mock("../../src/imap/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/imap/client.js")>()),
  openImap: vi.fn(async () => new FakeSession()),
}));
vi.mock("../../src/auth/credentials.js", () => ({
  openCredentials: vi.fn(async () => ({ mech: "PLAIN", username: "u", password: "p" })),
}));
vi.mock("../../src/auth/providers.js", () => ({
  resolveProvider: vi.fn(() => ({ imap: { host: "imap.test", port: 993 } })),
}));

const { Store } = await import("../../src/state/store.js");
const { ImapPool } = await import("../../src/imap/pool.js");
const { PushIdleManager } = await import("../../src/push/idle.js");
const { emailChanges, emailGet, emailQuery } = await import("../../src/jmap/methods/email.js");
const { encodeMailboxId } = await import("../../src/mapping/ids.js");
const { encodeEmailState } = await import("../../src/state/states.js");
import type { AppConfig } from "../../src/util/config.js";
import type { AccountRow, Store as StoreT } from "../../src/state/store.js";

const cfg = { vaultKey: Buffer.alloc(32) } as AppConfig;
let dir: string;
let store: StoreT;
let account: AccountRow;
let pool: InstanceType<typeof ImapPool>;
let idle: InstanceType<typeof PushIdleManager>;
let inboxId: string;

/** Wait past the worker's post-IDLE catch-up (IDLE_SETTLE_MS = 1 s). */
async function caughtUp(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1_100));
  await settled();
}

/** Wait until the IDLE worker has finished processing what it was told. */
async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function query() {
  return pool.withConnection(account, "interactive", (client) =>
    emailQuery(
      { accountId: String(account.id), filter: { inMailbox: inboxId }, sort: [{ property: "receivedAt", isAscending: false }] },
      { account, client, store, pool },
    ),
  );
}

function get(ids: string[]) {
  return pool.withConnection(account, "interactive", (client) =>
    emailGet(
      { accountId: String(account.id), ids, properties: ["id", "mailboxIds", "subject"] },
      { account, client, store, pool },
    ),
  );
}

function changes(sinceState: string) {
  return emailChanges({ accountId: String(account.id), sinceState }, { account, store });
}

beforeEach(async () => {
  server = new FakeServer();
  dir = mkdtempSync(path.join(tmpdir(), "idle-consistency-"));
  store = new Store(dir);
  account = store.upsertAccount({ slug: "t:u", kind: "test", host: "h", username: "u", vault: Buffer.from("v") });
  const row = store
    .prep(`INSERT INTO mailbox(account_id, name, role, subscribed) VALUES(?, 'INBOX', 'inbox', 1) RETURNING id`)
    .get(account.id) as { id: number };
  inboxId = encodeMailboxId({ accountIdx: account.id, mailboxIdx: row.id });
  server.deliver("old one");
  server.deliver("old two");

  pool = new ImapPool(cfg, store);
  idle = new PushIdleManager(cfg, store, pool);
  store.accountsWithActivePushSubs = () => [account.id];
  await idle.sync();
  await caughtUp();
});

afterEach(async () => {
  await idle.closeAll();
  await pool.closeAll();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("IDLE-announced changes are visible on the request path", () => {
  it("Email/query, Email/changes and Email/get all show mail the IDLE worker announced", async () => {
    // A client syncs; its pooled connection is now recently used.
    const before = await query();
    expect(before.total).toBe(2);
    const since = before.queryState;
    const delivery0 = store.getState(account.id, "email_delivery");

    const uid = server.deliver("brand new");
    await settled();

    // The worker announced it ...
    expect(store.getState(account.id, "email_delivery")).toBe(delivery0 + 1);
    const ch = await changes(since);
    // ... Email/changes names it ...
    expect(ch.created).toHaveLength(1);
    expect(ch.updated).toEqual([]);
    expect(ch.destroyed).toEqual([]);
    const newId = ch.created[0]!;

    // ... and the very next Email/query, on the same (recently used) pooled
    // connection, lists it first, stamped with the announced state.
    const after = await query();
    expect(after.total).toBe(3);
    expect(after.ids[0]).toBe(newId);
    expect(after.queryState).toBe(ch.newState);

    // Email/get finds it, with its mailbox and the same state.
    const got = await get([newId]);
    expect(got.notFound).toEqual([]);
    expect(got.list[0]).toMatchObject({ id: newId, subject: "brand new", mailboxIds: { [inboxId]: true } });
    expect(got.state).toBe(ch.newState);
    expect(uid).toBe(3);
  });

  it("Email/query on a recently used connection lists mail the IDLE worker just announced", async () => {
    expect((await query()).total).toBe(2);
    const announced = store.getState(account.id, "email");
    server.deliver("brand new");
    await settled();
    expect(store.getState(account.id, "email")).toBeGreaterThan(announced);
    // Stock legacy-proxy answered 2 here until the connection sat idle 30 s.
    expect((await query()).total).toBe(3);
  });

  it("Email/changes names the arrival even when the log already holds other entries", async () => {
    const before = await query();
    // An Email/set (say, a flag change) puts an entry in the change log.
    const since = encodeState(store.recordChanges(account.id, "email", { updated: [before.ids[0]!] }));
    server.deliver("brand new");
    await settled();
    // Stock legacy-proxy answered `created: []` with the newer state here,
    // which tells a client nothing arrived.
    const ch = await changes(since);
    expect(ch.newState).not.toBe(since);
    expect(ch.created).toHaveLength(1);
  });

  it("does not NOOP a recently used connection while nothing changed", async () => {
    await query();
    const noops = () => [...server.sessions].reduce((n, s) => n + s.noopCalls, 0);
    const before = noops();
    await query();
    await get([]);
    expect(noops()).toBe(before);
  });

  it("reports expunges as destroyed and stays consistent", async () => {
    const before = await query();
    const victim = before.ids[1]!; // the oldest message
    server.expunge(1);
    await settled();

    const ch = await changes(before.queryState);
    expect(ch.destroyed).toEqual([victim]);
    expect(ch.created).toEqual([]);
    const after = await query();
    expect(after.ids).not.toContain(victim);
    expect(after.queryState).toBe(ch.newState);
  });

  it("reports a flag change from another client as updated", async () => {
    const before = await query();
    server.flag(2, "\\Seen");
    await settled();
    const ch = await changes(before.queryState);
    expect(ch.updated).toEqual([before.ids[0]]);
    expect(ch.created).toEqual([]);
  });

  it("lists mail that arrived while the IDLE socket was down", async () => {
    const before = await query();
    const worker = [...server.sessions].find((s) => s.idling)!;
    // Drop the IDLE socket; mail arrives before it reconnects.
    worker.usable = false;
    server.sessions.delete(worker);
    worker.emit("close");
    server.deliver("while away");
    await new Promise((r) => setTimeout(r, 1_000)); // reconnect backoff
    await caughtUp();

    const ch = await changes(before.queryState);
    expect(ch.created).toHaveLength(1);
    const after = await query();
    expect(after.ids[0]).toBe(ch.created[0]);
  });

  it("finds mail that arrived after SELECT but before IDLE started", async () => {
    // The server announces nothing for that window, neither on IDLE start
    // nor later, until something else happens: the catch-up must find it.
    const before = await query();
    const worker = [...server.sessions].find((s) => s.idling)!;
    server.onOpen = () => {
      server.onOpen = null;
      server.deliver("in the blind window");
    };
    worker.usable = false;
    server.sessions.delete(worker);
    worker.emit("close");
    await new Promise((r) => setTimeout(r, 1_000)); // reconnect backoff
    await caughtUp();

    const ch = await changes(before.queryState);
    expect(ch.created).toHaveLength(1);
    const got = await get(ch.created);
    expect(got.list[0]).toMatchObject({ subject: "in the blind window" });
  });
});

describe("Email/changes never claims an empty diff it cannot know", () => {
  it("answers cannotCalculateChanges across a state bumped without ids", async () => {
    const s0 = (await query()).queryState;
    // e.g. a submission's Sent copy: the state moves, the ids are unknown.
    store.bumpState(account.id, "email");
    await expect(changes(s0)).rejects.toMatchObject({ type: "cannotCalculateChanges" });
  });

  it("answers cannotCalculateChanges for states from before the IDLE worker watched", async () => {
    // The worker's first connection (in beforeEach) bumped the state as a gap:
    // mail that arrived while nobody watched is not in the log.
    const beforeWorker = encodeState(store.getState(account.id, "email") - 1);
    await expect(changes(beforeWorker)).rejects.toMatchObject({ type: "cannotCalculateChanges" });
  });
});

function encodeState(n: number): string {
  return encodeEmailState({ uidvalidity: 0, modseq: n });
}
