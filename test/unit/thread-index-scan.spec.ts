// The thread index used to SELECT every non-empty folder on each build; on
// Gmail, where every label is a folder, that took tens of seconds. Now one
// LIST-STATUS tells which folders moved, and only those are opened.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { vi } from "vitest";
import { buildThreadIndex, resetThreadCaches, syncThreadRows, threadGet, threadIdsOf } from "../../src/jmap/methods/threads.js";
import { encodeEmailId } from "../../src/mapping/ids.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "threadscan-"));
  store = new Store(dir);
  resetThreadCaches();
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Status = { messages: number; uidNext: number; uidValidity: bigint };

function fakeServer(folders: Record<string, Status>) {
  const log = { lists: 0, selects: [] as string[] };
  const client = {
    mailbox: null as unknown,
    list: async () => {
      log.lists++;
      await new Promise((r) => setTimeout(r, 5));
      return Object.entries(folders).map(([p, status]) => ({ path: p, name: p, delimiter: "/", subscribed: true, status: { ...status, unseen: 0 } }));
    },
    getMailboxLock: async (p: string) => {
      log.selects.push(p);
      const st = folders[p]!;
      client.mailbox = { path: p, exists: st.messages, uidNext: st.uidNext, uidValidity: st.uidValidity };
      return { release: () => {} };
    },
    fetch: async function* () {},
    search: async () => [],
  };
  return { client: client as unknown as ImapFlow, log };
}

describe("thread index scan", () => {
  it("opens only the folders whose STATUS moved since the last scan", async () => {
    const folders: Record<string, Status> = {
      INBOX: { messages: 3, uidNext: 10, uidValidity: 1n },
      "[Gmail]/All Mail": { messages: 9, uidNext: 50, uidValidity: 1n },
      Work: { messages: 2, uidNext: 7, uidValidity: 1n },
      Empty: { messages: 0, uidNext: 1, uidValidity: 1n },
    };
    const { client, log } = fakeServer(folders);
    const account = store.upsertAccount({ slug: "a", kind: "gmail", host: "h", username: "u", vault: Buffer.from("v") });
    const ctx = { account, client, store };

    await buildThreadIndex(ctx);
    expect(log.selects.sort()).toEqual(["INBOX", "Work", "[Gmail]/All Mail"]);

    log.selects = [];
    store.bumpState(account.id, "email");
    await buildThreadIndex(ctx);
    expect(log.selects).toEqual([]);

    folders.INBOX = { messages: 4, uidNext: 11, uidValidity: 1n };
    folders["[Gmail]/All Mail"] = { messages: 10, uidNext: 51, uidValidity: 1n };
    store.bumpState(account.id, "email");
    await buildThreadIndex(ctx);
    expect(log.selects.sort()).toEqual(["INBOX", "[Gmail]/All Mail"]);
  });

  it("shares one build between requests that arrive together", async () => {
    const { client, log } = fakeServer({ INBOX: { messages: 1, uidNext: 2, uidValidity: 1n } });
    const account = store.upsertAccount({ slug: "b", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    const ctx = { account, client, store };
    await Promise.all([buildThreadIndex(ctx), buildThreadIndex(ctx), buildThreadIndex(ctx)]);
    expect(log.lists).toBe(1);
    expect(log.selects).toEqual(["INBOX"]);
  });

  it("answers Thread/get from the requested threads' rows, without loading the whole index", async () => {
    const { client, log } = fakeServer({
      INBOX: { messages: 2, uidNext: 3, uidValidity: 1n },
      Sent: { messages: 1, uidNext: 6, uidValidity: 1n },
    });
    const account = store.upsertAccount({ slug: "c", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    const ctx = { account, client, store };
    await syncThreadRows(ctx);
    const mbox = new Map((store.db.prepare("SELECT id, name FROM mailbox WHERE account_id = ?").all(account.id) as { id: number; name: string }[]).map((r) => [r.name, r.id]));
    const inbox = mbox.get("INBOX")!, sent = mbox.get("Sent")!;
    store.upsertEmailCacheRows([
      { accountId: account.id, mailboxId: inbox, uidvalidity: 1, uid: 1, threadId: "T1", internaldate: 100 },
      { accountId: account.id, mailboxId: sent, uidvalidity: 1, uid: 5, threadId: "T1", internaldate: 50 },
      { accountId: account.id, mailboxId: inbox, uidvalidity: 1, uid: 2, threadId: "T2", internaldate: 200 },
    ]);
    const id = (mailboxIdx: number, uid: number) => encodeEmailId({ accountIdx: account.id, mailboxIdx, uidvalidity: 1, uid });
    const full = vi.spyOn(store, "getThreadIndexRows");
    const r = await threadGet({ accountId: String(account.id), ids: ["T1", "T2", "nope"] }, ctx);
    expect(r.list).toEqual([
      { id: "T1", emailIds: [id(sent, 5), id(inbox, 1)] },
      { id: "T2", emailIds: [id(inbox, 2)] },
    ]);
    expect(r.notFound).toEqual(["nope"]);
    expect(full).not.toHaveBeenCalled();
    // Fresh rows are reused until the state moves.
    expect(log.lists).toBe(1);
    await threadGet({ accountId: String(account.id), ids: ["T1"] }, ctx);
    expect(log.lists).toBe(1);
    store.bumpState(account.id, "email");
    await threadGet({ accountId: String(account.id), ids: ["T1"] }, ctx);
    expect(log.lists).toBe(2);

    const tids = threadIdsOf(store, account.id, [id(inbox, 1), id(inbox, 2), id(sent, 5), id(sent, 9), "garbage"]);
    expect(Object.fromEntries(tids)).toEqual({ [id(inbox, 1)]: "T1", [id(inbox, 2)]: "T2", [id(sent, 5)]: "T1" });
  });
});
