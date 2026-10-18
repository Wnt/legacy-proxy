// Performance regression gates for opening messages and conversations.
//
// CI runs on loaded shared hosts, so these count work, not time: IMAP
// commands on the wire (the fake server logs every one), SQLite rows read,
// new LOGINs. Wall-clock budgets are generous backstops only. Each block
// names the change it guards; reverting that change makes it fail.
//
// The request path is the real one: the JMAP method table, ImapPool, imapflow
// over a socket, and a SQLite Store (test/support/harness.ts).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { FakeImapServer, type CommandLog } from "../support/fake-imap.js";
import { startHarness, type Harness } from "../support/harness.js";
import { decodeEmailId, decodeMailboxId } from "../../src/mapping/ids.js";
import { PushIdleManager } from "../../src/push/idle.js";

// What Bulwark asks for when it opens a message (lib/jmap/client.ts getEmail).
const OPEN_PROPS = ["id", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "sentAt", "from", "to", "cc", "bcc", "replyTo",
  "subject", "preview", "textBody", "htmlBody", "bodyValues", "hasAttachment", "attachments", "messageId", "inReplyTo", "references",
  "headers", "bodyStructure", "blobId"];
const OPEN_OPTS = { fetchTextBodyValues: true, fetchHTMLBodyValues: true, fetchAllBodyValues: true, maxBodyValueBytes: 256000 };

const isFetch = (l: CommandLog) => l.cmd === "UID FETCH" || l.cmd === "FETCH";
// A FETCH that reads message data (structure, envelope, headers, body), as
// opposed to a flags-only FETCH.
const readsContent = (l: CommandLog) => /BODY|ENVELOPE|RFC822/i.test(l.line.replace(/^\S+ \S+( FETCH)? \S+ /, ""));
const bodyFetches = (h: Harness) => h.imap.log.filter((l) => isFetch(l) && readsContent(l));

// SQLite rows handed to JS by any statement, counted at the Statement prototype.
const rowsRead = { n: 0 };
beforeAll(() => {
  const db = new Database(":memory:");
  const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as Record<string, (...a: unknown[]) => unknown>;
  db.close();
  if ((proto as { __counted?: boolean }).__counted) return;
  (proto as { __counted?: boolean }).__counted = true;
  const all = proto.all!, get = proto.get!, iterate = proto.iterate!;
  proto.all = function (this: unknown, ...a: unknown[]) {
    const r = all.apply(this, a) as unknown[];
    rowsRead.n += r.length;
    return r;
  };
  proto.get = function (this: unknown, ...a: unknown[]) {
    const r = get.apply(this, a);
    if (r !== undefined) rowsRead.n++;
    return r;
  };
  proto.iterate = function* (this: unknown, ...a: unknown[]) {
    for (const r of iterate.apply(this, a) as Iterable<unknown>) {
      rowsRead.n++;
      yield r;
    }
  };
});

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function settle(imap: FakeImapServer, quietMs = 150, maxMs = 10_000): Promise<void> {
  const t0 = Date.now();
  let last = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, quietMs));
    if (imap.log.length === last || Date.now() - t0 > maxMs) return;
    last = imap.log.length;
  }
}

describe("Thread/get reads only the requested thread (b9aa421)", () => {
  it("on a 50k-message account: a few rows, no SELECT, no FETCH", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Archive", specialUse: "\\Archive" }]);
    const N_ARCHIVE = 49_000, N_INBOX = 1_000;
    for (let i = 0; i < N_INBOX; i++) imap.add("INBOX");
    for (let i = 0; i < N_ARCHIVE; i++) imap.add("Archive");
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const idx = (name: string) => decodeMailboxId(mb[name]!).mailboxIdx;
    // The account as a past thread scan left it: 50k rows in threads of 5,
    // every folder's scan up to date with its LIST-STATUS. One conversation
    // (Tconv) spans both folders.
    const conv = new Set(["Archive:7", "INBOX:999", "INBOX:1000"]);
    const rows = [];
    for (const [name, n] of [["INBOX", N_INBOX], ["Archive", N_ARCHIVE]] as const) {
      for (let uid = 1; uid <= n; uid++) {
        const threadId = conv.has(`${name}:${uid}`) ? "Tconv" : `T${name}${Math.ceil(uid / 5)}`;
        rows.push({ accountId: h.account.id, mailboxId: idx(name), uidvalidity: 1, uid, threadId, internaldate: uid * 1000 });
      }
      h.store.putMailboxScan({ account_id: h.account.id, mailbox_id: idx(name), uidvalidity: 1, uidnext: n + 1, messages: n, scanned_at: Date.now() });
    }
    h.store.upsertEmailCacheRows(rows);

    const measure = async () => {
      h!.imap.reset();
      rowsRead.n = 0;
      const t0 = performance.now();
      const r = await h!.call<{ list: { id: string; emailIds: string[] }[] }>("Thread/get", { ids: ["Tconv"] });
      return { ms: performance.now() - t0, rows: rowsRead.n, list: r.list, log: h!.imap.log };
    };

    const cold = await measure();
    expect(cold.list[0]!.emailIds).toHaveLength(3);
    expect(cold.rows).toBeLessThan(100);
    expect(cold.log.filter((l) => l.cmd === "SELECT" || l.cmd === "EXAMINE")).toEqual([]);
    expect(cold.log.filter(isFetch)).toEqual([]);
    expect(cold.ms).toBeLessThan(2_000);

    // Opening a message elsewhere sets $seen: the account state moves, no
    // folder gains or loses mail. One LIST-STATUS, still no SELECT.
    imap.setFlags("INBOX", 999, "+", ["\\Seen"]);
    h.store.bumpState(h.account.id, "email");
    const afterSeen = await measure();
    expect(afterSeen.list[0]!.emailIds).toHaveLength(3);
    expect(afterSeen.rows).toBeLessThan(100);
    expect(afterSeen.log.filter((l) => l.cmd === "LIST").length).toBeLessThanOrEqual(1);
    expect(afterSeen.log.filter((l) => l.cmd === "SELECT" || l.cmd === "EXAMINE" || isFetch(l))).toEqual([]);
    expect(afterSeen.ms).toBeLessThan(2_000);

    // Fresh rows: the next one asks the server nothing.
    const warm = await measure();
    expect(warm.log).toEqual([]);
    expect(warm.rows).toBeLessThan(100);
  }, 60_000);
});

describe("message open is served from the body cache (f64a565)", () => {
  it("a second open, and an open after a restart, FETCH flags only", async () => {
    const imap = new FakeImapServer();
    for (let i = 0; i < 3; i++) imap.add("INBOX", { body: `Line one of ${i}\nLine two.` });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    // Not the first page: no prefetch, so the first open is cold.
    const q = await h.call<{ ids: string[] }>("Email/query", { filter: { inMailbox: mb.INBOX }, position: 1, limit: 1 });
    const id = q.ids[0]!;
    const open = () => h!.call<{ list: { bodyValues: Record<string, { value: string }> }[] }>("Email/get", { ids: [id], properties: OPEN_PROPS, ...OPEN_OPTS });

    imap.reset();
    const first = await open();
    expect(bodyFetches(h).length).toBeGreaterThan(0); // cold: the server is asked

    imap.reset();
    const second = await open();
    expect(second.list[0]!.bodyValues).toEqual(first.list[0]!.bodyValues);
    expect(bodyFetches(h)).toEqual([]);
    expect(imap.log.filter(isFetch)).toHaveLength(1); // the live flags, nothing else

    await h.restart();
    imap.reset();
    const third = await open();
    expect(third.list[0]!.bodyValues).toEqual(first.list[0]!.bodyValues);
    expect(bodyFetches(h)).toEqual([]);
    expect(imap.log.filter(isFetch)).toHaveLength(1);
  }, 30_000);
});

describe("prefetch warms at most the top 20 and never sets $seen (f64a565)", () => {
  it("an INBOX list load prefetches the newest 20; opening one then FETCHes flags only", async () => {
    const imap = new FakeImapServer();
    for (let i = 0; i < 30; i++) imap.add("INBOX");
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    imap.reset();
    const q = await h.call<{ ids: string[] }>("Email/query", {
      filter: { inMailbox: mb.INBOX }, sort: [{ property: "receivedAt", isAscending: false }], position: 0, limit: 30,
    });
    expect(q.ids).toHaveLength(30);
    await settle(imap);

    const warmed = prefetchedUids(h);
    expect(warmed.size).toBeGreaterThan(0);
    expect(warmed.size).toBeLessThanOrEqual(20);
    expect([...warmed].every((u) => u > 10)).toBe(true); // the newest (UIDs 11..30)
    expectReadOnly(h);

    imap.reset();
    await h.call("Email/get", { ids: [q.ids[0]], properties: OPEN_PROPS, ...OPEN_OPTS });
    expect(bodyFetches(h)).toEqual([]);
    expect(imap.log.filter(isFetch)).toHaveLength(1);
  }, 30_000);

  it("new INBOX mail seen by the IDLE worker is prefetched, at most 20, read-only", async () => {
    const imap = new FakeImapServer();
    for (let i = 0; i < 5; i++) imap.add("INBOX");
    h = await startHarness(imap);
    await h.mailboxIds();
    const idle = new PushIdleManager(h.cfg, h.store, h.pool);
    const client = {};
    const worker = { closing: false, client, inbox: { uidValidity: 1, uids: [1, 2, 3, 4, 5] }, queue: Promise.resolve() };
    for (let i = 0; i < 25; i++) imap.add("INBOX");
    imap.reset();
    await (idle as unknown as { syncInbox(a: unknown, w: unknown, c: unknown, k: string): Promise<void> })
      .syncInbox(h.account, worker, client, "arrival");
    expect(worker.inbox.uids).toHaveLength(30);
    await settle(imap);
    const warmed = prefetchedUids(h);
    expect(warmed.size).toBeGreaterThan(0);
    expect(warmed.size).toBeLessThanOrEqual(20);
    expect([...warmed].every((u) => u > 10)).toBe(true);
    expectReadOnly(h);
  }, 30_000);
});

// UIDs whose text parts were fetched.
function prefetchedUids(h: Harness): Set<number> {
  const out = new Set<number>();
  for (const l of h.imap.log) {
    if (!isFetch(l) || !/BODY(\.PEEK)?\[1\]/i.test(l.line)) continue;
    const set = l.line.split(" ")[3]!;
    for (const r of set.split(",")) {
      const [a, b] = r.split(":").map(Number);
      for (let u = a!; u <= (b ?? a!); u++) out.add(u);
    }
  }
  return out;
}

function expectReadOnly(h: Harness): void {
  expect(h.imap.log.filter((l) => /STORE/.test(l.cmd))).toEqual([]);
  // Every content FETCH peeks; a plain BODY[...] sets \Seen on the server.
  expect(h.imap.log.filter((l) => isFetch(l) && /[ (]BODY\[|RFC822[ )]|RFC822\.TEXT/i.test(l.line))).toEqual([]);
  for (const f of h.imap.folders.values()) for (const m of f.msgs) expect(m.flags.has("\\Seen")).toBe(false);
}

describe("tag counts re-SEARCH only folders that changed (b9aa421, c14e491)", () => {
  // Bulwark's tag counts: 2 account-wide queries per tag.
  const tagCounts = async (h: Harness, excl: string[]) => {
    const calls: [string, Record<string, unknown>, string][] = [];
    for (const t of ["a", "b", "c"]) {
      const kw = `$label:${t}`;
      calls.push(["Email/query", { accountId: h.accountId, filter: { operator: "AND", conditions: [{ hasKeyword: kw }, { inMailboxOtherThan: excl }] }, limit: 1, calculateTotal: true }, `t${t}`]);
      calls.push(["Email/query", { accountId: h.accountId, filter: { operator: "AND", conditions: [{ hasKeyword: kw }, { notKeyword: "$seen" }, { inMailboxOtherThan: excl }] }, limit: 1, calculateTotal: true }, `u${t}`]);
    }
    const out = await h.jmap(calls);
    for (const [name, args] of out) if (name === "error") throw new Error(JSON.stringify(args));
    return Object.fromEntries(out.map(([, a, id]) => [id, (a as { total: number }).total]));
  };
  const searchedFolders = (h: Harness) =>
    [...new Set(h.imap.log.filter((l) => l.cmd === "UID SEARCH" || l.cmd === "SEARCH").map((l) => l.folder ?? "?"))].sort();

  const setup = async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Archive", specialUse: "\\Archive" }, { name: "Sent", specialUse: "\\Sent" }, { name: "Work" }, { name: "Trash", specialUse: "\\Trash" }]);
    for (const f of ["INBOX", "Archive", "Sent", "Work"]) {
      for (let i = 0; i < 6; i++) imap.add(f, { flags: i % 2 ? ["$label:a"] : i % 3 ? ["$label:b"] : [] });
    }
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const excl = [mb.Trash!];
    imap.reset();
    const before = await tagCounts(h, excl);
    expect(before.ta).toBe(12);
    expect(before.ua).toBe(12);
    expect(searchedFolders(h)).toEqual(["Archive", "INBOX", "Sent", "Work"]);
    return { h, imap, mb, excl };
  };
  // Another client (a phone) reads a message: the IDLE worker or the next
  // pooled NOOP moves the account state, INBOX's HIGHESTMODSEQ goes up.
  const seenElsewhere = (imap: FakeImapServer, h: Harness) => {
    const inbox = imap.folders.get("INBOX")!;
    imap.setFlags("INBOX", inbox.msgs.find((m) => m.flags.has("$label:a") && !m.flags.has("\\Seen"))!.uid, "+", ["\\Seen"]);
    h.store.bumpState(h.account.id, "email");
  };

  it("a $seen change by another client: only INBOX is searched again", async () => {
    const { h, imap, excl } = await setup();
    seenElsewhere(imap, h);
    imap.reset();
    const after = await tagCounts(h, excl);
    expect(after.ua).toBe(11);
    expect(searchedFolders(h)).toEqual(["INBOX"]);
  }, 30_000);

  it("our own Email/set $seen (an open in Bulwark): only INBOX is searched again", async () => {
    const { h, imap, mb, excl } = await setup();
    const { ids } = await h.call<{ ids: string[] }>("Email/query", { filter: { operator: "AND", conditions: [{ inMailbox: mb.INBOX }, { hasKeyword: "$label:a" }] }, limit: 1 });
    const set = await h.call<{ updated: Record<string, unknown> }>("Email/set", { update: { [ids[0]!]: { "keywords/$seen": true } } });
    expect(Object.keys(set.updated ?? {})).toEqual([ids[0]]);
    imap.reset();
    const after = await tagCounts(h, excl);
    expect(after.ta).toBe(12);
    expect(after.ua).toBe(11);
    expect(searchedFolders(h)).toEqual(["INBOX"]);
  }, 30_000);

  it("after a restart (only SQLite left), unchanged folders are not searched", async () => {
    const { h, imap, excl } = await setup();
    const before = await tagCounts(h, excl);
    await h.restart();
    imap.reset();
    expect(await tagCounts(h, excl)).toEqual(before);
    expect(searchedFolders(h)).toEqual([]);
    // And a change after the restart still searches just that folder.
    seenElsewhere(imap, h);
    imap.reset();
    expect((await tagCounts(h, excl)).ua).toBe(11);
    expect(searchedFolders(h)).toEqual(["INBOX"]);
  }, 30_000);
});

describe("the pool reuses connections (no LOGIN per request)", () => {
  it("20 opens and lists after warm-up log in zero more times", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Archive" }]);
    for (let i = 0; i < 20; i++) imap.add("INBOX");
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const list = () => h!.call<{ ids: string[] }>("Email/query", { filter: { inMailbox: mb.INBOX }, position: 5, limit: 10 });
    const { ids } = await list();
    await Promise.all(ids.slice(0, 3).map((id) => h!.call("Email/get", { ids: [id], properties: OPEN_PROPS, ...OPEN_OPTS })));
    await settle(imap, 50);
    const logins = imap.count("LOGIN");
    expect(logins).toBeLessThanOrEqual(5); // at most the pool's caps (3 interactive + 2 bulk)
    for (let i = 0; i < 10; i++) {
      await list();
      await h.call("Email/get", { ids: [ids[i % ids.length]], properties: OPEN_PROPS, ...OPEN_OPTS });
    }
    expect(imap.count("LOGIN")).toBe(logins);
    expect(imap.connections).toBe(logins);
  }, 30_000);
});

describe("an INBOX open the IDLE worker vouches for asks the server nothing (inbox-flags)", () => {
  it("cached body and IDLE-tracked flags: no FETCH; a heard flag change shows; our own Email/set and a gap FETCH again", async () => {
    const imap = new FakeImapServer();
    for (let i = 0; i < 3; i++) imap.add("INBOX", { body: `Line one of ${i}\nLine two.` });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const q = await h.call<{ ids: string[] }>("Email/query", { filter: { inMailbox: mb.INBOX }, position: 1, limit: 1 });
    const id = q.ids[0]!;
    const { uid, uidvalidity } = decodeEmailId(id);
    // The instance the request path uses (a restart above reloads the modules).
    const { __resetInboxFlags, inboxFlagsChanged, inboxGap, inboxListed, inboxUnwatched } = await import("../../src/push/inbox-flags.js");
    // What the IDLE worker does once it has listed INBOX (push/idle.ts).
    __resetInboxFlags();
    inboxListed(h.account.id, uidvalidity, [1, 2, 3]);
    const open = () => h!.call<{ list: { keywords: Record<string, boolean> }[] }>("Email/get", { ids: [id], properties: OPEN_PROPS, ...OPEN_OPTS });

    await open(); // cold: body and flags from the server, flags kept
    imap.reset();
    const second = await open();
    expect(imap.log.filter(isFetch)).toEqual([]);
    expect(second.list[0]!.keywords).toEqual({});

    // Another client marks it read; the worker hears it.
    imap.setFlags("INBOX", uid, "+", ["\\Seen"]);
    inboxFlagsChanged(h.account.id, uid, ["\\Seen"]);
    imap.reset();
    expect((await open()).list[0]!.keywords).toEqual({ $seen: true });
    expect(imap.log.filter(isFetch)).toEqual([]);

    // Our own write: the next open asks the server again.
    await h.call("Email/set", { update: { [id]: { "keywords/$flagged": true } } });
    imap.reset();
    expect((await open()).list[0]!.keywords).toEqual({ $seen: true, $flagged: true });
    expect(imap.log.filter(isFetch)).toHaveLength(1);

    // A change nobody can name: asked again too.
    imap.reset();
    await open();
    expect(imap.log.filter(isFetch)).toEqual([]);
    inboxGap(h.account.id);
    imap.reset();
    await open();
    expect(imap.log.filter(isFetch)).toHaveLength(1);
    inboxUnwatched(h.account.id);
  }, 30_000);
});

describe("a conversation's other copies are warmed with its new INBOX message (thread-prefetch)", () => {
  type Worker = { closing: boolean; client: object; inbox: { uidValidity: number; uids: number[] }; queue: Promise<void> };
  // What the IDLE worker does when it hears new INBOX mail (push/idle.ts).
  const arrival = async (h: Harness, worker: Worker) => {
    const idle = new PushIdleManager(h.cfg, h.store, h.pool);
    await (idle as unknown as { syncInbox(a: unknown, w: unknown, c: unknown, k: string): Promise<void> })
      .syncInbox(h.account, worker, worker.client, "arrival");
  };
  const inboxWorker = (uids: number[]): Worker => ({ closing: false, client: {}, inbox: { uidValidity: 1, uids }, queue: Promise.resolve() });
  // Bulwark's conversation open (lib/jmap/client.ts fetchThreadEmails): one request.
  const openConversation = (h: Harness, threadId: string) => h.jmap([
    ["Thread/get", { accountId: h.accountId, ids: [threadId] }, "t"],
    ["Email/get", { accountId: h.accountId, "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" }, properties: OPEN_PROPS, ...OPEN_OPTS }, "e"],
  ]);
  const threadOf = (h: Harness, folderIdx: number, uid: number) => h.store.getThreadIdsByUid(h.account.id, folderIdx, 1, [uid]).get(uid)!;
  const warmedIn = (h: Harness, folder: string) => {
    const out = new Set<number>();
    for (const l of h.imap.log) {
      if (l.folder !== folder || !isFetch(l) || !/BODY(\.PEEK)?\[1\]/i.test(l.line)) continue;
      for (const r of l.line.split(" ")[3]!.split(",")) {
        const [a, b] = r.split(":").map(Number);
        for (let u = a!; u <= (b ?? a!); u++) out.add(u);
      }
    }
    return out;
  };

  it("a message sent to oneself: the conversation open reads no message data, the Sent copy included", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Sent", specialUse: "\\Sent" }]);
    for (let i = 0; i < 3; i++) imap.add("INBOX");
    for (let i = 0; i < 2; i++) imap.add("Sent");
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    // The account's thread rows exist: Bulwark's conversation list scanned it once.
    await h.call("Thread/get", { ids: [] });
    // Sent: the draft moved to Sent at submission; then the delivery to INBOX.
    imap.add("Sent", { messageId: "<self.1@example.test>", subject: "Note to self", body: "Sent copy text." });
    const delivered = imap.add("INBOX", { messageId: "<self.1@example.test>", subject: "Note to self", body: "Inbox copy text." });
    await arrival(h, inboxWorker([1, 2, 3]));
    await settle(imap);
    expectReadOnly(h);
    const warmedSent = warmedIn(h, "Sent");

    const threadId = threadOf(h, decodeMailboxId(mb.INBOX!).mailboxIdx, delivered.uid);
    imap.reset();
    const out = await openConversation(h, threadId);
    const got = out[1]![1] as { list: { id: string; mailboxIds: Record<string, boolean>; bodyValues: Record<string, { value: string }> }[] };
    expect(out[1]![0]).toBe("Email/get");
    expect(got.list).toHaveLength(2);
    expect(got.list.map((e) => Object.keys(e.mailboxIds)[0]).sort()).toEqual([mb.INBOX, mb.Sent].sort());
    for (const e of got.list) expect(Object.values(e.bodyValues).map((v) => v.value.trim())).not.toEqual([]);
    expect(bodyFetches(h)).toEqual([]);
    expect(warmedSent).toEqual(new Set([3]));
  }, 30_000);

  it("bounded: newest SIBLINGS_MAX of a thread, long threads not followed, no first scan started", async () => {
    const { SIBLINGS_MAX, SIBLING_THREAD_MAX } = await import("../../src/imap/prefetch.js");
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Sent", specialUse: "\\Sent" }, { name: "Archive", specialUse: "\\Archive" }]);
    for (let i = 0; i < 3; i++) imap.add("INBOX");
    // Thread A: 14 of our replies in Sent. Thread B: longer than SIBLING_THREAD_MAX, in Archive.
    const A = "<thread-a@example.test>", B = "<thread-b@example.test>";
    imap.add("Sent", { messageId: A });
    for (let i = 0; i < 13; i++) imap.add("Sent", { inReplyTo: A, references: A });
    for (let i = 0; i < SIBLING_THREAD_MAX; i++) imap.add("Archive", { inReplyTo: B, references: B });
    h = await startHarness(imap);
    await h.mailboxIds();

    // Not scanned yet: the prefetch warms the new message only and starts no scan.
    imap.add("INBOX", { inReplyTo: A, references: A });
    await arrival(h, inboxWorker([1, 2, 3]));
    await settle(imap);
    const elsewhere = (l: CommandLog) =>
      l.folder === "Sent" || l.folder === "Archive" || ((l.cmd === "SELECT" || l.cmd === "EXAMINE") && /Sent|Archive/.test(l.line));
    expect(imap.log.filter(elsewhere)).toEqual([]);

    // Scanned (a Thread/get ran). A reply in the long thread B: not followed.
    await h.call("Thread/get", { ids: [] });
    imap.add("INBOX", { inReplyTo: B, references: B });
    imap.reset();
    await arrival(h, inboxWorker([1, 2, 3, 4]));
    await settle(imap);
    expect(warmedIn(h, "Archive")).toEqual(new Set());
    expect(imap.log.filter((l) => l.folder === "Archive")).toEqual([]);

    // A reply in thread A: its newest SIBLINGS_MAX copies in Sent.
    imap.add("INBOX", { inReplyTo: A, references: A });
    imap.reset();
    await arrival(h, inboxWorker([1, 2, 3, 4, 5]));
    await settle(imap);
    expectReadOnly(h);
    const sent = warmedIn(h, "Sent");
    expect(sent.size).toBe(SIBLINGS_MAX);
    expect(Math.min(...sent)).toBe(14 - SIBLINGS_MAX + 1); // the newest
  }, 30_000);
});
