// Free-text search as a webmail client sends it: `text` with the folder or
// "all folders except Trash and Junk" scope, newest first.
//
// A search for the first letters of a sender's name came back empty: the
// IMAP server (no full-text index) scanned every message of every folder,
// the request outlived the client's timeout, and the client showed "No
// results found". Searches without a requested total now run over date
// windows, newest first, and stop once the page is decided.
//
// All names, addresses and texts here are invented.
import { afterEach, describe, expect, it } from "vitest";
import { FakeImapServer } from "../support/fake-imap.js";
import { startHarness, type Harness } from "../support/harness.js";
import { inflightSearchCount, textSearchWindows, uidRanges } from "../../src/jmap/methods/email.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

type Query = { ids: string[]; total?: number; position: number };

function folders() {
  return new FakeImapServer([
    { name: "INBOX" },
    { name: "Archive", specialUse: "\\Archive" },
    { name: "Trash", specialUse: "\\Trash" },
    { name: "Junk", specialUse: "\\Junk" },
  ]);
}

const searches = (imap: FakeImapServer) => imap.log.filter((l) => l.cmd === "UID SEARCH" || l.cmd === "SEARCH");

describe("text search finds a partial sender name in any case", () => {
  it("a sender whose name and address start with the query, and a subject naming it", async () => {
    const imap = folders();
    for (let i = 0; i < 40; i++) imap.add("INBOX", { from: "News <news@letters.test>", subject: `Weekly ${i}`, date: daysAgo(400 - i) });
    // The sender's display name and address both contain the query as a prefix.
    const direct = imap.add("INBOX", { from: "Samplepaja <info@samplepaja.test>", subject: "Order confirmed", body: "Thanks.", date: daysAgo(30) });
    // A billing service writing about the same company: only the subject names it.
    const billed = imap.add("INBOX", { from: "Billing <no-reply@billing.test>", subject: "Invoice 1001, Samplepaja Oy", body: "Due in 14 days.", date: daysAgo(3) });
    const archived = imap.add("Archive", { from: "Samplepaja <info@samplepaja.test>", subject: "Old order", date: daysAgo(900) });
    imap.add("Trash", { from: "Samplepaja <info@samplepaja.test>", subject: "Deleted", date: daysAgo(2) });
    for (let i = 0; i < 10; i++) imap.add("Archive", { from: "Someone <someone@else.test>", subject: `Other ${i}`, date: daysAgo(800 + i) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const byUid = async (ids: string[]) => {
      const r = await h!.call<{ list: { id: string; subject: string }[] }>("Email/get", { ids, properties: ["subject"] });
      return r.list.map((e) => e.subject);
    };

    for (const q of ["Sample", "sample", "SAMPLE", "sAmPlE", "Samplepaja", "samplepaja.test"]) {
      // The address alone is not in the billing mail.
      const inboxHits = q.endsWith(".test") ? [direct] : [billed, direct];
      // The folder scope.
      for (const calculateTotal of [false, true]) {
        const inbox = await h.call<Query>("Email/query", {
          filter: { operator: "AND", conditions: [{ inMailbox: mb.INBOX }, { text: q }] },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 50,
          calculateTotal,
        });
        expect(await byUid(inbox.ids), `INBOX ${q} total=${calculateTotal}`).toEqual(inboxHits.map(subjectOf));

        // "All folders except Trash and Junk".
        const all = await h.call<Query>("Email/query", {
          filter: { operator: "AND", conditions: [{ text: q }, { inMailboxOtherThan: [mb.Trash, mb.Junk] }] },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 50,
          calculateTotal,
        });
        expect(await byUid(all.ids), `all ${q} total=${calculateTotal}`).toEqual([...inboxHits, archived].map(subjectOf));
        if (calculateTotal) expect(all.total).toBe(inboxHits.length + 1);
      }
      // The sender field alone.
      const from = await h.call<Query>("Email/query", {
        filter: { operator: "AND", conditions: [{ inMailbox: mb.INBOX }, { from: q }] },
        sort: [{ property: "receivedAt", isAscending: false }],
      });
      expect(await byUid(from.ids), `from ${q}`).toEqual([direct].map(subjectOf));
    }
  }, 60_000);
});

function subjectOf(m: { header: string }): string {
  return /^Subject: (.*)$/m.exec(m.header)![1]!.trim();
}

describe("newest-first text search without a total reads only the newest date windows", () => {
  it("a common term: one window, the same page as the full search, no total", async () => {
    const imap = folders();
    // 400 matches over three years in INBOX and Archive; 80 of them in the last
    // two weeks. Archive has mail filed late: a high UID with an old date.
    for (let i = 0; i < 320; i++) imap.add(i % 2 ? "INBOX" : "Archive", { subject: `Common term ${i}`, date: daysAgo(1100 - i * 3) });
    for (let i = 0; i < 80; i++) imap.add(i % 3 ? "INBOX" : "Archive", { subject: `Common term recent ${i}`, date: new Date(Date.now() - (14 * DAY * (80 - i)) / 80) });
    for (let i = 0; i < 5; i++) imap.add("Archive", { subject: `Common term filed late ${i}`, date: daysAgo(700 + i) });
    for (let i = 0; i < 100; i++) imap.add("INBOX", { subject: `Unrelated ${i}`, date: daysAgo(5) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    const filter = { operator: "AND", conditions: [{ text: "common TERM" }, { inMailboxOtherThan: [mb.Trash, mb.Junk] }] };
    const sort = [{ property: "receivedAt", isAscending: false }];

    const full = await h.call<Query>("Email/query", { filter, sort, limit: 500, calculateTotal: true });
    expect(full.total).toBe(405);

    imap.reset();
    const page1 = await h.call<Query>("Email/query", { filter, sort, limit: 50 });
    expect(page1.ids).toEqual(full.ids.slice(0, 50));
    expect(page1.total).toBeUndefined();
    // Only the newest window was searched: every SEARCH carries its SINCE
    // and none reaches into an older window.
    const s1 = searches(imap);
    expect(s1.length).toBeGreaterThan(0);
    expect(s1.every((l) => /\bSINCE\b/.test(l.line) && !/\bBEFORE\b/.test(l.line))).toBe(true);

    // The next page still fits in the newest window; the one after needs older ones.
    const page2 = await h.call<Query>("Email/query", { filter, sort, limit: 50, position: 50 });
    expect(page2.ids).toEqual(full.ids.slice(50, 100));
    const page3 = await h.call<Query>("Email/query", { filter, sort, limit: 50, position: 100 });
    expect(page3.ids).toEqual(full.ids.slice(100, 150));
    const tail = await h.call<Query>("Email/query", { filter, sort, limit: 50, position: 400 });
    expect(tail.ids).toEqual(full.ids.slice(400));
    // Reaching the oldest window reads everything: the total is known again.
    expect(tail.total).toBe(405);

    // The same within one folder.
    const inboxFilter = { operator: "AND", conditions: [{ inMailbox: mb.INBOX }, { text: "common term" }] };
    const inboxFull = await h.call<Query>("Email/query", { filter: inboxFilter, sort, limit: 500, calculateTotal: true });
    imap.reset();
    const inboxPage = await h.call<Query>("Email/query", { filter: inboxFilter, sort, limit: 30 });
    expect(inboxPage.ids).toEqual(inboxFull.ids.slice(0, 30));
    expect(searches(imap).every((l) => /\bSINCE\b/.test(l.line) && !/\bBEFORE\b/.test(l.line))).toBe(true);
  }, 60_000);

  it("a rare term: the newest window, then all older mail at once; all matches and the total", async () => {
    const imap = folders();
    for (let i = 0; i < 50; i++) imap.add("INBOX", { subject: `Plain ${i}`, date: daysAgo(i * 20) });
    imap.add("INBOX", { subject: "Rareword recent", date: daysAgo(1) });
    imap.add("Archive", { subject: "Rareword old", date: daysAgo(2000) });
    h = await startHarness(imap);
    const mb = await h.mailboxIds();
    imap.reset();
    const r = await h.call<Query>("Email/query", {
      filter: { operator: "AND", conditions: [{ text: "rareword" }, { inMailboxOtherThan: [mb.Trash, mb.Junk] }] },
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: 50,
    });
    expect(r.ids).toHaveLength(2);
    expect(r.total).toBe(2);
    // Next to nothing in the newest window: everything older is read in one
    // go, so each non-empty folder is searched twice, not once per window.
    expect(searches(imap)).toHaveLength(2 * 2);
    expect(searches(imap).filter((l) => /\bBEFORE\b/.test(l.line) && !/\bSINCE\b/.test(l.line))).toHaveLength(2);
  }, 60_000);
});

describe("textSearchWindows", () => {
  it("partitions time at UTC month starts, newest first", () => {
    const w = textSearchWindows(new Date(Date.UTC(2026, 0, 18, 12)));
    const iso = (d?: Date) => d?.toISOString().slice(0, 10) ?? null;
    expect(w.map((x) => [iso(x.since), iso(x.before)])).toEqual([
      ["2025-12-01", null],
      ["2025-09-01", "2025-12-01"],
      ["2024-12-01", "2025-09-01"],
      ["2022-12-01", "2024-12-01"],
      [null, "2022-12-01"],
    ]);
  });
});

describe("a full-text search of a large folder runs in UID slices, in parallel", () => {
  // Invented word; three matches spread over the folder's UID range.
  async function bigInbox(maxConnections = Infinity) {
    const imap = folders();
    imap.maxConnections = maxConnections;
    const N = 6000;
    const at = new Set([3, 3100, 5990]);
    for (let i = 1; i <= N; i++) {
      imap.add(i % 7 ? "INBOX" : "Archive", {
        subject: at.has(i) ? `Note ${i}` : `Plain ${i}`,
        body: at.has(i) ? "Meet at the Zorblatt kiosk." : "Nothing here.",
        date: daysAgo(3000 - i / 2),
      });
    }
    h = await startHarness(imap);
    return { imap, mb: await h.mailboxIds() };
  }
  const sliceSearches = (imap: FakeImapServer) => searches(imap).filter((l) => /\bUID \d+:(\d+|\*)/.test(l.line.replace(/^\S+ UID SEARCH /, "")));

  it("one folder: every match, the SEARCH spread over several connections", async () => {
    const { imap, mb } = await bigInbox();
    imap.reset();
    const r = await h!.call<Query>("Email/query", {
      filter: { operator: "AND", conditions: [{ inMailbox: mb.INBOX }, { text: "zorblatt" }] },
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: 50,
    });
    expect(r.ids).toHaveLength(3);
    const sliced = sliceSearches(imap);
    expect(sliced.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sliced.map((l) => l.conn)).size).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("all folders: the same matches as one SEARCH per folder", async () => {
    const { imap, mb } = await bigInbox();
    const filter = { operator: "AND", conditions: [{ text: "ZORBLATT" }, { inMailboxOtherThan: [mb.Trash, mb.Junk] }] };
    const sort = [{ property: "receivedAt", isAscending: false }];
    imap.reset();
    const r = await h!.call<Query>("Email/query", { filter, sort, limit: 50 });
    expect(r.ids).toHaveLength(3);
    expect(sliceSearches(imap).length).toBeGreaterThanOrEqual(2);
    const subjects = (await h!.call<{ list: { subject: string }[] }>("Email/get", { ids: r.ids, properties: ["subject"] })).list.map((e) => e.subject);
    expect(subjects).toEqual(["Note 5990", "Note 3100", "Note 3"]);
  }, 60_000);

  it.each([
    ["fewer bulk connections than slices", 4, true],
    ["no bulk connection at all", 2, false],
  ])("a server that refuses extra connections (%s): the search still finds every match", async (_label, max, sliced) => {
    // The request's own connection (plus the one the harness's mailbox
    // listing may hold), then only what the limit leaves.
    const { imap, mb } = await bigInbox(max);
    imap.reset();
    const r = await h!.call<Query>("Email/query", {
      filter: { operator: "AND", conditions: [{ inMailbox: mb.INBOX }, { text: "zorblatt" }] },
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: 50,
    });
    expect(r.ids).toHaveLength(3);
    // With some bulk connections the slices queue for them; with none the
    // folder is searched in one go on the request's own connection.
    expect(sliceSearches(imap).length >= 2).toBe(sliced);
  }, 60_000);

  it("a second identical search while the first runs reads no message twice", async () => {
    // A client that gave up (a proxy's request limit) asks again while the
    // first search still runs: it waits for that one.
    const { imap, mb } = await bigInbox();
    const filter = { operator: "AND", conditions: [{ text: "zorblatt" }, { inMailboxOtherThan: [mb.Trash, mb.Junk] }] };
    const sort = [{ property: "receivedAt", isAscending: false }];
    imap.reset();
    const [a, b] = await Promise.all([
      h!.call<Query>("Email/query", { filter, sort, limit: 50 }),
      h!.call<Query>("Email/query", { filter, sort, limit: 50 }),
    ]);
    expect(a.ids).toHaveLength(3);
    expect(b.ids).toEqual(a.ids);
    const twice = searches(imap).map((l) => `${l.folder} ${l.line.replace(/^\S+ /, "")}`);
    expect(new Set(twice).size).toBe(twice.length);
    expect(inflightSearchCount()).toBe(0);
  }, 60_000);
});

describe("uidRanges", () => {
  it("covers every UID once, the last range open-ended", () => {
    expect(uidRanges(11, 4)).toEqual(["1:3", "4:6", "7:9", "10:*"]);
    expect(uidRanges(6, 4)).toEqual(["1:2", "3:4", "5:*"]);
    expect(uidRanges(2, 3)).toEqual(["1:*"]);
  });
});
