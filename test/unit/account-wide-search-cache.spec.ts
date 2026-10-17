// An account-wide Email/query (a client's tag counts) re-searched every folder
// whenever the account's email state moved, and opening a message moves it
// ($seen). Now each folder's SEARCH result is reused while the folder's
// LIST-STATUS (HIGHESTMODSEQ, UIDNEXT, MESSAGES) is unchanged.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { emailQuery } from "../../src/jmap/methods/email.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "awsearch-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Folder = { modseq: bigint; uidNext: number; msgs: { uid: number; kw: string[]; date: number }[] };

function fakeServer(folders: Record<string, Folder>) {
  const log = { lists: 0, searches: [] as string[], selects: 0 };
  let lock: Promise<void> = Promise.resolve();
  const client = {
    usable: true,
    mailbox: null as null | { path: string; exists: number; uidValidity: bigint; highestModseq: bigint },
    list: async () => {
      log.lists++;
      return Object.entries(folders).map(([p, f]) => ({
        path: p, name: p, delimiter: "/", subscribed: true,
        status: { messages: f.msgs.length, unseen: 0, uidNext: f.uidNext, uidValidity: 1n, highestModseq: f.modseq },
      }));
    },
    // One SELECTed folder per session, as imapflow's mailbox lock ensures.
    getMailboxLock: async (p: string) => {
      const prev = lock;
      let release!: () => void;
      lock = new Promise<void>((r) => (release = r));
      await prev;
      log.selects++;
      const f = folders[p]!;
      client.mailbox = { path: p, exists: f.msgs.length, uidValidity: 1n, highestModseq: f.modseq };
      return { release };
    },
    search: async (q: { keyword?: string }) => {
      const f = folders[client.mailbox!.path]!;
      log.searches.push(client.mailbox!.path);
      return f.msgs.filter((m) => !q.keyword || m.kw.includes(q.keyword)).map((m) => m.uid);
    },
    fetch: async function* (range: string) {
      const f = folders[client.mailbox!.path]!;
      const want = new Set(range.split(",").flatMap((r) => {
        const [a, b] = r.split(":").map(Number);
        return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i);
      }));
      for (const m of f.msgs) if (want.has(m.uid)) yield { uid: m.uid, internalDate: new Date(m.date) };
    },
  };
  return { client: client as unknown as ImapFlow, log };
}

describe("account-wide Email/query folder search cache", () => {
  it("searches again only the folders whose STATUS moved", async () => {
    const folders: Record<string, Folder> = {
      INBOX: { modseq: 10n, uidNext: 3, msgs: [{ uid: 1, kw: ["$label:a"], date: 1000 }, { uid: 2, kw: [], date: 2000 }] },
      Archive: { modseq: 5n, uidNext: 8, msgs: [{ uid: 7, kw: ["$label:a"], date: 500 }] },
      Empty: { modseq: 1n, uidNext: 1, msgs: [] },
    };
    const { client, log } = fakeServer(folders);
    const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    const ctx = { account, client, store };
    const q = () =>
      emailQuery({ accountId: String(account.id), filter: { hasKeyword: "$label:a" }, limit: 10, calculateTotal: true } as never, ctx);

    const first = await q();
    expect(first.total).toBe(2);
    expect(log.searches.sort()).toEqual(["Archive", "INBOX"]);

    // Opening a message elsewhere moves the account state but no folder: no SEARCH.
    log.searches = [];
    store.bumpState(account.id, "email");
    const second = await q();
    expect(second.ids).toEqual(first.ids);
    expect(log.searches).toEqual([]);

    // A flag change in INBOX raises its HIGHESTMODSEQ: only INBOX is searched.
    folders.INBOX!.msgs[1]!.kw.push("$label:a");
    folders.INBOX!.modseq = 11n;
    store.bumpState(account.id, "email");
    const third = await q();
    expect(third.total).toBe(3);
    expect(log.searches).toEqual(["INBOX"]);

    // Without a state change, one LIST-STATUS serves the next queries.
    const lists = log.lists;
    await Promise.all([q(), q(), q()]);
    expect(log.lists).toBe(lists);
  });

  it("does not reuse a result when the folder's message count changed", async () => {
    const folders: Record<string, Folder> = {
      INBOX: { modseq: 10n, uidNext: 2, msgs: [{ uid: 1, kw: ["$label:a"], date: 1000 }] },
    };
    const { client, log } = fakeServer(folders);
    // Module-level caches are keyed by account id: use one the other test did not.
    for (const slug of ["x1", "x2", "x3"]) store.upsertAccount({ slug, kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    const account = store.upsertAccount({ slug: "b", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    const ctx = { account, client, store };
    const q = () => emailQuery({ accountId: String(account.id), filter: { hasKeyword: "$label:a" }, limit: 10 } as never, ctx);
    expect((await q()).total).toBe(1);
    folders.INBOX!.msgs.push({ uid: 2, kw: ["$label:a"], date: 3000 });
    folders.INBOX!.uidNext = 3; // same modseq on purpose: count and UIDNEXT still tell
    store.bumpState(account.id, "email");
    log.searches = [];
    expect((await q()).total).toBe(2);
    expect(log.searches).toEqual(["INBOX"]);
  });
});
