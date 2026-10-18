// Email/query and Email/queryChanges draw on the request's budgets, and every
// read stops when its request is abandoned, also while the IMAP server is not
// answering (a stalled SEARCH, FETCH or download): the connection is closed
// under it. Joined full-text searches keep running for the requests still
// waiting for them.
//
// The request path is the real one (method table, ImapPool, imapflow over a
// socket, SQLite) against the fake IMAP server. All mail here is invented.
import { afterEach, describe, expect, it } from "vitest";
import { FakeImapServer } from "../support/fake-imap.js";
import { startHarness, type Harness } from "../support/harness.js";
import { newRequestBudgets, QUERY_HIT_UNITS } from "../../src/imap/fetcher.js";
import { RequestAbortedError } from "../../src/imap/abort.js";
import { readBlob } from "../../src/jmap/blobs.js";
import {
  inflightSearchCount,
  resetSearchCachesInMemory,
  setSharedSearchGraceMs,
  sharedSearchWaiters,
} from "../../src/jmap/methods/email.js";
import { decodeMailboxId, encodeBlobId, encodeEmailId } from "../../src/mapping/ids.js";

let h: Harness | null = null;
const releases: Array<() => void> = [];
afterEach(async () => {
  setSharedSearchGraceMs(10_000);
  for (const r of releases.splice(0)) r();
  await h?.close();
  h = null;
});

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const sort = [{ property: "receivedAt", isAscending: false }];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await pause(10);
  }
}

/**
 * Commands matching `re` wait until the test opens the gate (a server that
 * stopped answering them). Held commands are logged by the fake server only
 * once they run, so the gate records their connections itself.
 */
function gate(imap: FakeImapServer, re: RegExp) {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  releases.push(open);
  const conns: number[] = [];
  let isOpen = false;
  imap.commandGate = (line, conn) => {
    if (isOpen || !re.test(line)) return null;
    conns.push(conn);
    return p;
  };
  return {
    open: () => {
      isOpen = true;
      open();
    },
    held: () => conns.length,
    conns,
  };
}

const errorOf = (r: unknown[]) => (r[0] === "error" ? (r[1] as { type: string; description?: string }) : null);
const cmds = (imap: FakeImapServer, cmd: string) => imap.log.filter((l) => l.cmd === cmd);
const noRepeats = (lines: string[]) => expect(new Set(lines).size).toBe(lines.length);

function manyFolders(n: number, perFolder: number) {
  const imap = new FakeImapServer([{ name: "INBOX" }, ...Array.from({ length: n - 1 }, (_, i) => ({ name: `Projects/P${i}` }))]);
  for (const f of imap.folders.keys()) {
    for (let i = 0; i < perFolder; i++) imap.add(f, { from: "Ledger <ledger@books.test>", subject: `Entry ${i}`, date: daysAgo(i + 1) });
  }
  return imap;
}

describe("query budgets", () => {
  it("a query over the request's allowance fails with requestTooLarge: one folder, all folders, queryChanges", async () => {
    const imap = manyFolders(12, 30);
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const small = () => {
      const b = newRequestBudgets();
      b.query.remaining = 20 * QUERY_HIT_UNITS;
      return b;
    };

    const one = await h.jmap([["Email/query", { accountId: h.accountId, filter: { inMailbox: mb.INBOX }, sort, limit: 10 }, "q"]], { budgets: small() });
    expect(errorOf(one[0]!)).toMatchObject({ type: "requestTooLarge" });

    imap.reset();
    const all = await h.jmap([["Email/query", { accountId: h.accountId, filter: { from: "ledger" }, sort, limit: 10 }, "q"]], { budgets: small() });
    expect(errorOf(all[0]!)).toMatchObject({ type: "requestTooLarge" });
    // The first folder over the allowance stops the scan: no folder starts
    // after it (the per-folder catch used to skip it and go on).
    expect(new Set(cmds(imap, "UID SEARCH").map((l) => l.folder)).size).toBeLessThan(12);

    // Email/queryChanges re-runs the query under the same allowance.
    const first = await h.call<{ queryState: string }>("Email/query", { filter: { inMailbox: mb.INBOX }, sort, limit: 10 });
    const id = encodeEmailId({ accountIdx: h.account.id, mailboxIdx: decodeMailboxId(mb.INBOX!).mailboxIdx, uidvalidity: 1, uid: 1 });
    await h.call("Email/set", { update: { [id]: { "keywords/$flagged": true } } });
    const changes = await h.jmap(
      [["Email/queryChanges", { accountId: h.accountId, filter: { inMailbox: mb.INBOX }, sort, sinceQueryState: first.queryState }, "c"]],
      { budgets: small() },
    );
    expect(errorOf(changes[0]!)).toMatchObject({ type: "requestTooLarge" });

    // With the normal allowance the same queries answer in full.
    const ok = await h.call<{ ids: string[]; total: number }>("Email/query", { filter: { from: "ledger" }, sort, limit: 10, calculateTotal: true });
    expect(ok.total).toBe(12 * 30);
  }, 60_000);

  it("sort keys count against the allowance, and the queries of one request share it", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }]);
    for (let i = 0; i < 10; i++) imap.add("INBOX", { subject: `Quarterly report ${i} ${"z".repeat(240)}`, date: daysAgo(i + 1) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const budget = () => {
      const b = newRequestBudgets();
      b.query.remaining = 10 * QUERY_HIT_UNITS + 500;
      return b;
    };
    const q = (s: unknown): [string, Record<string, unknown>, string] =>
      ["Email/query", { accountId: h!.accountId, filter: { inMailbox: mb.INBOX }, sort: s, limit: 5 }, "q"];
    // Ten hits fit; their ten 256-character subject keys do not.
    expect(errorOf((await h.jmap([q(sort)], { budgets: budget() }))[0]!)).toBeNull();
    expect(errorOf((await h.jmap([q([{ property: "subject", isAscending: true }])], { budgets: budget() }))[0]!)).toMatchObject({
      type: "requestTooLarge",
    });
    // Two queries that each fit alone, in one request (independent reads run
    // side by side, so either may be the one over).
    const both = await h.jmap([q(sort), q(sort)], { budgets: budget() });
    expect(both.map((r) => errorOf(r)?.type ?? "ok").sort()).toEqual(["ok", "requestTooLarge"]);
  }, 30_000);

  it("size and keyword sorts fetch no envelopes; subject sorts do", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Archive" }]);
    [3, 1, 4, 1.5, 9].forEach((k, i) =>
      imap.add("INBOX", { subject: `Size ${i}`, body: "b".repeat(k * 1000), date: daysAgo(i + 1), flags: i === 2 ? ["\\Flagged"] : [] }));
    imap.add("Archive", { subject: "Archived", body: "b".repeat(5000), date: daysAgo(30) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    // In the query's order (Email/get answers mailbox by mailbox).
    const subjects = async (ids: string[]) => {
      const { list } = await h!.call<{ list: { id: string; subject: string }[] }>("Email/get", { ids, properties: ["subject"] });
      return ids.map((id) => list.find((e) => e.id === id)?.subject);
    };
    // The sort's own FETCHes, not the prefetch an INBOX first page starts.
    const fetches = () => cmds(imap, "UID FETCH").map((l) => l.line).filter((l) => /INTERNALDATE/.test(l) && !/BODYSTRUCTURE/.test(l));

    for (const [filter, largest] of [
      [{ inMailbox: mb.INBOX }, ["Size 4", "Size 2", "Size 0"]],
      [{}, ["Size 4", "Archived", "Size 2"]],
    ] as const) {
      imap.reset();
      const bySize = await h.call<{ ids: string[] }>("Email/query", { filter, sort: [{ property: "size", isAscending: false }], limit: 3 });
      expect(fetches().some((l) => /RFC822\.SIZE/.test(l))).toBe(true);
      expect(fetches().some((l) => /ENVELOPE|FLAGS/.test(l))).toBe(false);
      expect(await subjects(bySize.ids)).toEqual(largest);

      imap.reset();
      const byFlag = await h.call<{ ids: string[] }>("Email/query", {
        filter,
        sort: [{ property: "hasKeyword", keyword: "$flagged", isAscending: false }, ...sort],
        limit: 1,
      });
      expect(fetches().some((l) => /FLAGS/.test(l))).toBe(true);
      expect(fetches().some((l) => /ENVELOPE|RFC822\.SIZE/.test(l))).toBe(false);
      expect(await subjects(byFlag.ids)).toEqual(["Size 2"]);

      imap.reset();
      await h.call("Email/query", { filter, sort: [{ property: "subject", isAscending: true }], limit: 3 });
      expect(fetches().some((l) => /ENVELOPE/.test(l))).toBe(true);
    }
  }, 30_000);
});

describe("an abandoned request stops its reads", () => {
  it("an account-wide query: its stalled folder SEARCHes are cut off and no other folder starts", async () => {
    const imap = manyFolders(12, 5);
    h = await startHarness(imap);
    await h.mailboxIds();
    imap.reset();
    const g = gate(imap, /UID SEARCH .*FROM/i);
    const ac = new AbortController();
    const res = h.jmap([["Email/query", { accountId: h.accountId, filter: { from: "ledger" }, sort, limit: 10 }, "q"]], { signal: ac.signal });
    await until(() => g.held() >= 4, "four folder SEARCHes on the bulk connections");
    await pause(50);
    const held = g.held();
    ac.abort();
    expect((await res)[0]![0]).toBe("error");
    const after = imap.log.length;
    await pause(200);
    // Nothing else was selected or searched for the abandoned request.
    expect(g.held()).toBe(held);
    expect(imap.log.slice(after).filter((l) => /^(SELECT|EXAMINE|UID SEARCH)$/.test(l.cmd))).toEqual([]);
    await until(() => g.conns.every((c) => imap.closedConns.has(c)), "the stalled connections to close");
    // The pool serves the next request at once.
    g.open();
    const ok = await h.call<{ total: number }>("Email/query", { filter: { from: "ledger" }, sort, limit: 10, calculateTotal: true });
    expect(ok.total).toBe(60);
  }, 30_000);

  it("a folder query whose SEARCH stalls, and an Email/get whose body FETCH stalls", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }]);
    const m = imap.add("INBOX", { subject: "Minutes", body: "Agreed on the budget.", date: daysAgo(1) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();

    let g = gate(imap, /UID SEARCH .*FLAGGED/i);
    let ac = new AbortController();
    const q = h.jmap([["Email/query", { accountId: h.accountId, filter: { inMailbox: mb.INBOX, hasKeyword: "$flagged" }, sort }, "q"]], { signal: ac.signal });
    await until(() => g.held() === 1, "the SEARCH");
    ac.abort();
    expect((await q)[0]![0]).toBe("error");
    await until(() => imap.closedConns.has(g.conns[0]!), "the query's connection to close");
    g.open();

    g = gate(imap, /BODY\.PEEK\[1\]/i);
    ac = new AbortController();
    const id = encodeEmailId({ accountIdx: h.account.id, mailboxIdx: decodeMailboxId(mb.INBOX!).mailboxIdx, uidvalidity: 1, uid: m.uid });
    const get = h.jmap(
      [["Email/get", { accountId: h.accountId, ids: [id], properties: ["bodyValues", "textBody"], fetchTextBodyValues: true }, "g"]],
      { signal: ac.signal },
    );
    await until(() => g.held() === 1, "the body FETCH");
    ac.abort();
    expect((await get)[0]![0]).toBe("error");
    await until(() => imap.closedConns.has(g.conns[0]!), "the Email/get connection to close");
    g.open();
    // The next open works.
    const again = await h.call<{ list: { bodyValues: Record<string, { value: string }> }[] }>("Email/get", {
      ids: [id], properties: ["bodyValues", "textBody"], fetchTextBodyValues: true,
    });
    expect(Object.values(again.list[0]!.bodyValues)[0]!.value).toContain("Agreed");
  }, 30_000);

  it("a blob read stalled before or during its download wakes up, closes its connection and frees the lease", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }]);
    // Three 64 KiB download chunks' worth of text.
    const body = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
    const m = imap.add("INBOX", { subject: "Scan", body, date: daysAgo(1) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const emailId = encodeEmailId({ accountIdx: h.account.id, mailboxIdx: decodeMailboxId(mb.INBOX!).mailboxIdx, uidvalidity: 1, uid: m.uid });
    const ctx = { account: h.account, store: h.store, client: null as never, pool: h.pool };

    // Mid-stream (the second chunk never comes), then before the first byte.
    for (const stallAt of [/\[TEXT\]<65536\./i, /\[TEXT\]<0\./i]) {
      const g = gate(imap, stallAt);
      const ac = new AbortController();
      const read = readBlob(encodeBlobId(emailId, "1"), ctx, undefined, ac.signal);
      await until(() => g.held() === 1, "the download to stall");
      ac.abort();
      await expect(read).rejects.toBeInstanceOf(RequestAbortedError);
      await until(() => imap.closedConns.has(g.conns[0]!), "the download's connection to close");
      g.open();
      // The lease was given back: a whole read succeeds.
      const full = await readBlob(encodeBlobId(emailId, "1"), ctx);
      expect(full!.body.length).toBeGreaterThan(3 * 65536);
    }
  }, 30_000);

  it("a bulk lease that comes free after the request was abandoned starts nothing", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }]);
    const m = imap.add("INBOX", { subject: "Attachment", body: "data", date: daysAgo(1) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const emailId = encodeEmailId({ accountIdx: h.account.id, mailboxIdx: decodeMailboxId(mb.INBOX!).mailboxIdx, uidvalidity: 1, uid: m.uid });
    const ctx = { account: h.account, store: h.store, client: null as never, pool: h.pool };
    const held = await Promise.all(Array.from({ length: 4 }, () => h!.pool.acquire(h!.account, "bulk")));
    imap.reset();

    // Queued behind the four, then abandoned: it leaves the queue at once.
    const ac = new AbortController();
    const queued = readBlob(encodeBlobId(emailId, "1"), ctx, undefined, ac.signal);
    await pause(50);
    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(RequestAbortedError);

    // Woken by a release in the same moment it is abandoned: the connection
    // it then obtains goes back unused.
    let ran = false;
    const ac2 = new AbortController();
    const second = h.pool.withConnection(h.account, "bulk", async () => {
      ran = true;
    }, ac2.signal);
    await pause(50);
    held[0]!.release();
    ac2.abort();
    await expect(second).rejects.toBeInstanceOf(RequestAbortedError);
    expect(ran).toBe(false);
    for (const l of held.slice(1)) l.release();
    expect(imap.log.filter((l) => l.cmd === "UID FETCH" || l.cmd === "FETCH" || l.cmd === "SELECT")).toEqual([]);
    // Nothing is left parked or busy: all four come back at once.
    const free = await Promise.all(Array.from({ length: 4 }, () => h!.pool.acquire(h!.account, "bulk")));
    for (const l of free) l.release();
  }, 30_000);
});

describe("joined full-text searches", () => {
  // Invented word; three matches spread over a folder large enough to be
  // searched in UID slices on several connections, and one in a small folder.
  async function bigInbox() {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Archive" }]);
    const at = new Set([3, 3100, 5990]);
    for (let i = 1; i <= 6000; i++) {
      imap.add("INBOX", {
        subject: at.has(i) ? `Note ${i}` : `Plain ${i}`,
        body: at.has(i) ? "Meet at the Quorvex stand." : "Nothing here.",
        date: daysAgo(3000 - i / 2),
      });
    }
    imap.add("Archive", { subject: "Old note", body: "The Quorvex stand moved.", date: daysAgo(4000) });
    h = await startHarness(imap);
    return { imap, mb: await h.mailboxIds() };
  }
  const inFolder = (folder: string) => ({
    filter: { operator: "AND", conditions: [{ inMailbox: folder }, { text: "quorvex" }] },
    sort,
    limit: 50,
  });
  const searchLines = (imap: FakeImapServer) => cmds(imap, "UID SEARCH").map((l) => `${l.folder} ${l.line.replace(/^\S+ /, "")}`);

  it("one waiter abandoning a sliced search does not stop it for the other", async () => {
    const { imap, mb } = await bigInbox();
    imap.reset();
    const g = gate(imap, /UID SEARCH .*TEXT/i);
    const a = new AbortController();
    const first = h!.call<{ ids: string[] }>("Email/query", inFolder(mb.INBOX!), { signal: a.signal });
    await until(() => g.held() >= 2, "the slices to start");
    const second = h!.call<{ ids: string[] }>("Email/query", inFolder(mb.INBOX!));
    await until(() => sharedSearchWaiters() === 2, "the second request to join");
    a.abort();
    await expect(first).rejects.toThrow();
    await pause(100);
    // The slices run on.
    expect(g.conns.some((c) => imap.closedConns.has(c))).toBe(false);
    g.open();
    expect((await second).ids).toHaveLength(3);
    noRepeats(searchLines(imap));
    expect(inflightSearchCount()).toBe(0);
  }, 60_000);

  it("the request whose connection runs a joined SEARCH keeps it running for the other", async () => {
    const { imap, mb } = await bigInbox();
    // No grace: the SEARCH would be cut off as soon as nobody waited.
    setSharedSearchGraceMs(0);
    imap.reset();
    // A small folder is searched in one go on the first request's connection.
    const g = gate(imap, /UID SEARCH .*TEXT/i);
    const a = new AbortController();
    const first = h!.call<{ ids: string[] }>("Email/query", inFolder(mb.Archive!), { signal: a.signal });
    await until(() => g.held() === 1, "the SEARCH");
    const second = h!.call<{ ids: string[] }>("Email/query", inFolder(mb.Archive!));
    await until(() => sharedSearchWaiters() === 2, "the second request to join");
    a.abort();
    await pause(100);
    expect(imap.closedConns.has(g.conns[0]!)).toBe(false);
    g.open();
    await expect(first).rejects.toThrow();
    expect((await second).ids).toHaveLength(1);
    noRepeats(searchLines(imap));

    // Alone, the same abandoned search is cut off.
    resetSearchCachesInMemory();
    imap.reset();
    const g2 = gate(imap, /UID SEARCH .*TEXT/i);
    const b = new AbortController();
    const lone = h!.call("Email/query", inFolder(mb.Archive!), { signal: b.signal });
    await until(() => g2.held() === 1, "the SEARCH");
    b.abort();
    await expect(lone).rejects.toThrow();
    await until(() => imap.closedConns.has(g2.conns[0]!), "its connection to close");
  }, 60_000);

  it("a search nobody waits for stops after the grace; a retry within it joins", async () => {
    const { imap, mb } = await bigInbox();

    // A retry (a client whose proxy gave up) within the grace joins the search.
    setSharedSearchGraceMs(5_000);
    imap.reset();
    let g = gate(imap, /UID SEARCH .*TEXT/i);
    let a = new AbortController();
    const first = h!.call("Email/query", inFolder(mb.INBOX!), { signal: a.signal });
    await until(() => g.held() >= 2, "the slices to start");
    a.abort();
    await expect(first).rejects.toThrow();
    const retry = h!.call<{ ids: string[] }>("Email/query", inFolder(mb.INBOX!));
    await until(() => sharedSearchWaiters() === 1, "the retry to join");
    g.open();
    expect((await retry).ids).toHaveLength(3);
    noRepeats(searchLines(imap));

    // Nobody comes back: past the grace its slices are cut off.
    setSharedSearchGraceMs(100);
    resetSearchCachesInMemory();
    imap.reset();
    g = gate(imap, /UID SEARCH .*TEXT/i);
    a = new AbortController();
    const lone = h!.call("Email/query", inFolder(mb.INBOX!), { signal: a.signal });
    await until(() => g.held() >= 2, "the slices to start");
    a.abort();
    await expect(lone).rejects.toThrow();
    await until(() => g.conns.every((c) => imap.closedConns.has(c)), "the slices to be cut off", 5000);
    await until(() => inflightSearchCount() === 0, "the search to end", 5000);
  }, 60_000);
});

describe("review round 1: variants and failure paths", () => {
  // Three invented messages in a folder, plus an empty INBOX.
  async function small(n = 3) {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Archive" }]);
    for (let i = 0; i < n; i++) imap.add("Archive", { subject: `Quorvex ${i} ${"z".repeat(200)}`, body: "quorvex", date: daysAgo(i + 1) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    imap.reset();
    return { imap, mb };
  }
  const settles = (p: Promise<unknown>) => {
    const s = { done: false };
    p.finally(() => (s.done = true)).catch(() => {});
    return s;
  };

  it("an abandoned query stops in the account's LIST-STATUS and in a stale connection's NOOP", async () => {
    const { imap, mb } = await small();
    let g = gate(imap, / LIST /i);
    let ac = new AbortController();
    let p = h!.jmap([["Email/query", { accountId: h!.accountId, filter: { from: "x" }, calculateTotal: true }, "q"]], { signal: ac.signal });
    let s = settles(p);
    await until(() => g.held() > 0, "the LIST");
    ac.abort();
    await until(() => s.done, "the query to stop", 2000);
    expect(imap.closedConns.has(g.conns[0]!)).toBe(true);
    g.open();

    // A pooled connection again; a state change makes its next borrower NOOP it first.
    await h!.call("Email/query", { filter: { inMailbox: mb.Archive } });
    h!.store.bumpState(h!.account.id, "email");
    g = gate(imap, / NOOP/i);
    ac = new AbortController();
    p = h!.jmap([["Email/query", { accountId: h!.accountId, filter: { inMailbox: mb.Archive } }, "q"]], { signal: ac.signal });
    s = settles(p);
    await until(() => g.held() > 0, "the NOOP");
    ac.abort();
    await until(() => s.done, "the query to stop", 2000);
    g.open();
    expect((await h!.call<{ ids: string[] }>("Email/query", { filter: { inMailbox: mb.Archive } })).ids).toHaveLength(3);
  }, 30_000);

  it("collapseThreads: an abandoned query stops waiting for the thread scan, which stops", async () => {
    const { imap, mb } = await small();
    const g = gate(imap, /UID FETCH .*ENVELOPE/i);
    const ac = new AbortController();
    const p = h!.jmap([["Email/query", { accountId: h!.accountId, filter: { inMailbox: mb.Archive }, collapseThreads: true, calculateTotal: true }, "q"]], { signal: ac.signal });
    const s = settles(p);
    await until(() => g.held() > 0, "the scan's FETCH");
    ac.abort();
    await until(() => s.done, "the query to stop", 2000);
    expect((await p)[0]![0]).toBe("error");
    await until(() => imap.closedConns.has(g.conns[0]!), "the scan's connection to close", 2000);
    g.open();
    expect((await h!.call<{ ids: string[] }>("Email/query", { filter: { inMailbox: mb.Archive }, collapseThreads: true })).ids).toHaveLength(3);
  }, 30_000);

  it("noneInThreadHaveKeyword reads only the matched threads, charges their members, and filters right", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Archive" }, { name: "Sent" }]);
    // Thread A: an INBOX mail and a flagged reply in Sent. Thread B: one INBOX mail.
    imap.add("INBOX", { subject: "Plan A", messageId: "<a1@example.test>", date: daysAgo(3) });
    imap.add("Sent", { subject: "Re: Plan A", messageId: "<a2@example.test>", inReplyTo: "<a1@example.test>", references: "<a1@example.test>", flags: ["\\Flagged"], date: daysAgo(2) });
    imap.add("INBOX", { subject: "Plan B", messageId: "<b1@example.test>", date: daysAgo(1) });
    for (let i = 0; i < 30; i++) imap.add("Archive", { subject: `Unrelated ${i}`, flags: ["\\Flagged"], date: daysAgo(100 + i) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const filter = { inMailbox: mb.INBOX, noneInThreadHaveKeyword: "$flagged" };
    const r = await h.call<{ ids: string[] }>("Email/query", { filter, sort });
    const subjects = (await h.call<{ list: { subject: string }[] }>("Email/get", { ids: r.ids, properties: ["subject"] })).list.map((e) => e.subject);
    expect(subjects).toEqual(["Plan B"]);
    // No FLAGS FETCH of whole folders, nor of the unrelated archive.
    imap.reset();
    await h.call("Email/query", { filter, sort });
    const flagFetches = cmds(imap, "UID FETCH").filter((l) => /FLAGS/.test(l.line) && !/BODYSTRUCTURE/.test(l.line));
    expect(flagFetches.some((l) => l.folder === "Archive" || /\b1:\*/.test(l.line))).toBe(false);
    // The members of the matched threads count against the allowance.
    const b = newRequestBudgets();
    b.query.remaining = 2 * QUERY_HIT_UNITS;
    const over = await h.jmap([["Email/query", { accountId: h.accountId, filter, sort }, "q"]], { budgets: b });
    expect(errorOf(over[0]!)).toMatchObject({ type: "requestTooLarge" });
  }, 30_000);

  it("a spent allowance mid-FETCH retires the connection rather than pooling it with the FETCH on it", async () => {
    const { imap, mb } = await small();
    imap.stallAfterFirst = /UID FETCH .*ENVELOPE/i;
    releases.push(() => imap.releaseStalled());
    const b = newRequestBudgets();
    // Three hits fit; the first subject key does not.
    b.query.remaining = 3 * QUERY_HIT_UNITS + 1;
    const r = await h!.jmap([["Email/query", { accountId: h!.accountId, filter: { inMailbox: mb.Archive }, sort: [{ property: "subject" }], calculateTotal: true }, "q"]],
      { budgets: b });
    expect(errorOf(r[0]!)).toMatchObject({ type: "requestTooLarge" });
    const conn = cmds(imap, "UID FETCH").find((l) => /ENVELOPE/.test(l.line))!.conn;
    await until(() => imap.closedConns.has(conn), "the connection to be retired", 2000);
    imap.stallAfterFirst = null;
    imap.releaseStalled();
    expect((await h!.call<{ ids: string[] }>("Email/query", { filter: { inMailbox: mb.Archive }, sort: [{ property: "subject" }] })).ids).toHaveLength(3);
  }, 30_000);

  it("a spent allowance in one folder cuts off a sibling folder's stalled SEARCH", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Archive" }]);
    for (const f of ["INBOX", "Archive"]) for (let i = 0; i < 3; i++) imap.add(f, { subject: "Entry", date: daysAgo(i + 1) });
    h = await startHarness(imap);
    await h.mailboxIds();
    let first = true;
    let open!: () => void;
    const held = new Promise<void>((r) => (open = r));
    releases.push(open);
    let heldConn = 0;
    imap.commandGate = (line, conn) => {
      if (!/UID SEARCH /i.test(line) || !first) return null;
      first = false;
      heldConn = conn;
      return held;
    };
    const b = newRequestBudgets();
    b.query.remaining = 1;
    const p = h.jmap([["Email/query", { accountId: h.accountId, calculateTotal: true }, "q"]], { budgets: b });
    const s = settles(p);
    await until(() => heldConn > 0 && b.query.remaining < 0, "one folder over the allowance, the other stalled");
    await until(() => s.done, "the query to answer", 2000);
    expect(errorOf((await p)[0]!)).toMatchObject({ type: "requestTooLarge" });
    expect(imap.closedConns.has(heldConn)).toBe(true);
  }, 30_000);

  it("a search that finishes while nobody waits is filed for the retry", async () => {
    const { imap, mb } = await small();
    setSharedSearchGraceMs(5_000);
    const g = gate(imap, /UID SEARCH .*TEXT/i);
    const ac = new AbortController();
    const args = { filter: { operator: "AND", conditions: [{ inMailbox: mb.Archive }, { text: "quorvex" }] }, calculateTotal: true };
    const p = h!.jmap([["Email/query", { accountId: h!.accountId, ...args }, "q"]], { signal: ac.signal });
    await until(() => g.held() > 0, "the SEARCH");
    ac.abort();
    g.open();
    await p;
    await until(() => inflightSearchCount() === 0, "the search to end");
    expect((await h!.call<{ ids: string[] }>("Email/query", args)).ids).toHaveLength(3);
    expect(cmds(imap, "UID SEARCH")).toHaveLength(1);
  }, 30_000);

  it("hits are charged once when a cached result lacks the dates and the folder is scanned", async () => {
    await small();
    // A subject sort files the folder's result without caching the dates.
    await h!.call("Email/query", { calculateTotal: true, sort: [{ property: "subject" }] });
    const b = newRequestBudgets();
    b.query.remaining = 3 * QUERY_HIT_UNITS;
    const r = await h!.jmap([["Email/query", { accountId: h!.accountId, calculateTotal: true }, "q"]], { budgets: b });
    expect(r[0]![0]).toBe("Email/query");
  }, 30_000);
});
