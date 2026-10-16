// ENVELOPE and BODYSTRUCTURE come from sender-written headers: bounded as they
// arrive and when read from the cache, charged per request, and the response
// is charged at its serialized size. Mocked IMAP, real SQLite.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/state/store.js";
import {
  boundBodyStructure,
  boundEnvelope,
  fetchEmailsBatch,
  MAX_BODYSTRUCTURE_JSON_CHARS,
  MAX_ENVELOPE_JSON_CHARS,
  newRequestBudgets,
} from "../../src/imap/fetcher.js";
import { emailGet, emailQuery } from "../../src/jmap/methods/email.js";
import { encodeMailboxId } from "../../src/mapping/ids.js";
import { buildThreadIndex } from "../../src/jmap/methods/threads.js";
import { encodeEmailId } from "../../src/mapping/ids.js";
import { KeyedLimiter, LimitError } from "../../src/util/limiter.js";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "metabounds-"));
  store = new Store(dir);
  store.upsertAccount({ slug: "s", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  store.prep(`INSERT INTO mailbox(id, account_id, name, role, subscribed) VALUES(2, 1, 'INBOX', 'inbox', 1)`).run();
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const account = { id: 1 } as never;
const mailbox = { id: 2, uidvalidity: 1 } as never;

function server(envelope: object, bodyStructure: object = { part: "1", type: "text/plain", encoding: "7bit", size: 1 }, headers = "Subject: s\r\n\r\n") {
  return {
    mailbox: { uidValidity: 1n, exists: 1, uidNext: 8, path: "INBOX" },
    list: async () => [{ path: "INBOX", name: "INBOX", delimiter: "/", subscribed: true, specialUse: "\\Inbox",
      status: { messages: 1, uidNext: 8, uidValidity: 1n, unseen: 0 } }],
    getMailboxLock: async () => ({ release() {} }),
    search: async () => [7],
    async *fetch(_r: string, q: any) {
      if (q.headers || q.bodyParts) yield { uid: 7, headers: Buffer.from(headers) };
      else if (q.flags && !q.envelope) yield { uid: 7, flags: new Set() };
      else yield { uid: 7, flags: new Set(), size: 100, internalDate: new Date(0), envelope, bodyStructure };
    },
  } as never;
}

describe("metadata bounds", () => {
  it("bounds a cached envelope the same as a fetched one", async () => {
    store.upsertEmailCacheRows([{ accountId: 1, mailboxId: 2, uidvalidity: 1, uid: 7, threadId: "T", internaldate: 0,
      threadInputs: JSON.stringify({ messageId: null, inReplyTo: null, references: null }),
      envelope: JSON.stringify({ subject: "s".repeat(50_000) }),
      bodystructure: JSON.stringify({ part: "1", type: "text/plain", size: 1 }) }]);
    const got = await fetchEmailsBatch(server({}), account, mailbox, [7], { wantsPreview: false }, store);
    expect(got.get(7)!.subject!.length).toBe(16 * 1024);
  });

  it("stores a bounded BODYSTRUCTURE even for an id-only read", async () => {
    const bs = { type: "multipart/mixed", childNodes: Array.from({ length: 2000 }, (_, i) => ({
      part: String(i + 1), type: "application/octet-stream", disposition: "attachment",
      dispositionParameters: { filename: "f".repeat(256 * 1024) } })) };
    const budgets = newRequestBudgets();
    const id = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 1, uid: 7 });
    await emailGet({ accountId: "1", ids: [id], properties: ["id"] }, { account: store.getAccountById(1)!, client: server({ subject: "s" }, bs), store, budgets } as never);
    const meta = store.getEmailCacheMeta(1, 2, 1, 7)!;
    expect(meta.bodystructure!.length).toBeLessThanOrEqual(MAX_BODYSTRUCTURE_JSON_CHARS);
  });

  it("charges the response at its serialized size", async () => {
    const budgets = newRequestBudgets();
    budgets.response.remaining = 10_000;
    const id = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 1, uid: 7 });
    // 8,000 control characters: 8,000 chars, ~48,000 bytes of JSON.
    await expect(emailGet({ accountId: "1", ids: [id], properties: ["id", "subject"] },
      { account: store.getAccountById(1)!, client: server({ subject: "\u0001".repeat(8000) }), store, budgets } as never))
      .rejects.toMatchObject({ type: "requestTooLarge" });
  });

  it("an overlong Message-ID gives the same thread on Email/get and the thread scan, either order", async () => {
    const long = `<${"m".repeat(1102)}@x>`;
    const id = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 1, uid: 7 });
    for (const order of ["get-first", "scan-first"]) {
      store.db.exec("DELETE FROM email_cache; DELETE FROM mailbox_scan;");
      store.bumpState(1, "email");
      const client = server({ messageId: long, subject: "s" }, undefined, `Message-ID: ${long}\r\n\r\n`);
      const acct = store.getAccountById(1)!;
      let fromGet: string;
      if (order === "get-first") {
        fromGet = (await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false }, store)).get(7)!.threadId;
        await buildThreadIndex({ account: acct, client, store });
      } else {
        await buildThreadIndex({ account: acct, client, store });
        fromGet = (await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false }, store)).get(7)!.threadId;
      }
      expect(fromGet).toBe(id);
      expect(store.getThreadIndexRows(1).map((r) => r.thread_id)).toEqual([id]);
    }
  });
});

describe("disconnects", () => {
  it("a queued request whose client left gives up its place", async () => {
    const lim = new KeyedLimiter(1, 5);
    let release!: () => void;
    const first = lim.run("a", () => new Promise<void>((r) => (release = r)));
    const ac = new AbortController();
    const queued = lim.run("a", async () => "ran", ac.signal);
    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(LimitError);
    release();
    await first;
    await expect(lim.run("a", async () => "next")).resolves.toBe("next");
  });
});

describe("review round 4: hard bounds", () => {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

  it("bounds the serialized envelope even when the subject escapes", () => {
    const env = boundEnvelope({ subject: "\u0001".repeat(16_384), from: Array(5000).fill({ name: "n".repeat(900), address: "a@x" }) });
    expect(size(env)).toBeLessThanOrEqual(MAX_ENVELOPE_JSON_CHARS);
  });

  it("bounds BODYSTRUCTURE parameters, keys and the root", () => {
    const params = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, "v".repeat(900)]));
    expect(size(boundBodyStructure({ part: "1", type: "text/plain", parameters: params }))).toBeLessThanOrEqual(MAX_BODYSTRUCTURE_JSON_CHARS);
    const longKeys = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${i}`.padEnd(100_000, "k"), "v"]));
    expect(size(boundBodyStructure({ part: "1", type: "text/plain", parameters: longKeys }))).toBeLessThanOrEqual(MAX_BODYSTRUCTURE_JSON_CHARS);
    const wide = { type: "multipart/mixed", childNodes: Array.from({ length: 300 }, () => ({ type: "text/plain", parameters: params })) };
    expect(size(boundBodyStructure(wide))).toBeLessThanOrEqual(MAX_BODYSTRUCTURE_JSON_CHARS);
  });

  it("the hasAttachment filter caches bounded structures", async () => {
    const bs = { type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain" },
      { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "f".repeat(256 * 1024) } }] };
    const client = {
      mailbox: { uidValidity: 1n, exists: 1, highestModseq: 1n },
      getMailboxLock: async () => ({ release() {} }),
      search: async () => [7],
      async *fetch() { yield { uid: 7, bodyStructure: bs }; },
    };
    const res = await emailQuery({ accountId: "1", filter: { inMailbox: encodeMailboxId({ accountIdx: 1, mailboxIdx: 2 }), hasAttachment: true } } as never,
      { account: store.getAccountById(1)!, client, store } as never);
    expect(res.ids).toHaveLength(1);
    expect(store.getEmailCacheMeta(1, 2, 1, 7)!.bodystructure!.length).toBeLessThanOrEqual(MAX_BODYSTRUCTURE_JSON_CHARS);
  });

  it("refuses an invalid header property name instead of echoing it", async () => {
    const id = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 1, uid: 7 });
    await expect(emailGet({ accountId: "1", ids: [id], properties: ["id", "header:\u0001\u0002:asText"] },
      { account: store.getAccountById(1)!, client: server({ subject: "s" }), store, budgets: newRequestBudgets() } as never))
      .rejects.toMatchObject({ type: "invalidArguments" });
  });

  it("an upgrade from v1 resets the thread index together with its scan checkpoints", () => {
    store.upsertEmailCacheRows([{ accountId: 1, mailboxId: 2, uidvalidity: 1, uid: 7, threadId: "Tclipped", internaldate: 0,
      bodystructure: JSON.stringify({ x: "y".repeat(140_000) }) }]);
    store.putMailboxScan({ account_id: 1, mailbox_id: 2, uidvalidity: 1, uidnext: 8, messages: 1, scanned_at: 0 });
    const before = store.getState(1, "email");
    store.db.pragma("user_version = 1");
    store.db.close();
    store = new Store(dir);
    expect(store.getThreadIndexRows(1)).toEqual([]);
    expect(store.getMailboxScan(1, 2)).toBeFalsy();
    expect(store.getState(1, "email")).toBeGreaterThan(before);
  });
});

describe("final review quick fixes", () => {
  it("many absent header properties don't rescan a large header block each", async () => {
    const block = Array.from({ length: 20_000 }, (_, i) => `X-F${i}: v`).join("\r\n") + "\r\n\r\n";
    const id = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 1, uid: 7 });
    const ctx = () => ({ account: store.getAccountById(1)!, client: server({ subject: "s" }, undefined, block), store, budgets: newRequestBudgets() }) as never;
    const props = Array.from({ length: 128 }, (_, i) => `header:X-Absent-${i}`);
    const t = performance.now();
    const res = await emailGet({ accountId: "1", ids: [id], properties: ["id", ...props] }, ctx());
    expect(performance.now() - t).toBeLessThan(2000);
    expect(res.list[0]!["header:X-Absent-0"]).toBeNull();
    await expect(emailGet({ accountId: "1", ids: [id], properties: ["id", ...props, "header:One-Too-Many"] }, ctx()))
      .rejects.toMatchObject({ type: "requestTooLarge" });
  });

  it("an abandoned draft create stops mid-download and appends nothing", async () => {
    const { emailSet } = await import("../../src/jmap/methods/email.js");
    const ac = new AbortController();
    const budgets = { ...newRequestBudgets(), signal: ac.signal };
    const blobId = `P${encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 1, uid: 7 })}:2`;
    let chunksRead = 0;
    const client = {
      mailbox: { uidValidity: 1n },
      getMailboxLock: async () => ({ release() {} }),
      close() {},
      append: async () => ({ uid: 9, uidValidity: 1n }),
      download: async () => ({
        meta: { contentType: "application/pdf" },
        content: (async function* () {
          for (let i = 0; i < 5; i++) {
            if (i === 1) ac.abort();
            chunksRead++;
            yield Buffer.alloc(1024);
          }
        })(),
      }),
    };
    const appendSpy = { called: false };
    client.append = async () => ((appendSpy.called = true), { uid: 9, uidValidity: 1n });
    const res = await emailSet({ accountId: "1", create: { d: {
      mailboxIds: { [encodeMailboxId({ accountIdx: 1, mailboxIdx: 2 })]: true },
      bodyValues: { "1": { value: "hi" } }, textBody: [{ partId: "1" }],
      attachments: [{ blobId, type: "application/pdf" }],
    } } }, { account: store.getAccountById(1)!, client, store, budgets } as never);
    expect(res.created).toBeNull();
    expect(appendSpy.called).toBe(false);
    expect(chunksRead).toBeLessThan(5);
  });
});
