// Header blocks are sized by whoever sent the mail, and imapflow buffers a
// whole literal before handing it over. So the bound must be on the wire, for
// Email/get (threading fields or the full block) and the thread-index scan
// alike, and every path must derive a message's threadId from the same bytes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { fetchEmailsBatch, MAX_FULL_HEADER_BYTES_PER_CALL } from "../../src/imap/fetcher.js";
import { buildThreadIndex } from "../../src/jmap/methods/threads.js";
import { computeThreadIdFromHeaders, MAX_HEADER_BLOCK_BYTES, parseHeaderBlock } from "../../src/imap/headers.js";

const FILLER = `X-Filler: ${"a".repeat(900)}\r\n`.repeat(Math.ceil((MAX_HEADER_BLOCK_BYTES * 1.5) / 912));
const SMALL_BODY = 10_000;

function fieldsOf(block: Buffer, names: string[]): Buffer {
  const lc = new Set(names.map((n) => n.toLowerCase()));
  const lines = parseHeaderBlock(block).filter((h) => lc.has(h.name.toLowerCase()));
  return Buffer.from(lines.map((h) => `${h.name}: ${h.rawValue}\r\n`).join("") + "\r\n");
}

// One-message IMAP server that honours the query shapes the proxy sends and
// counts the header bytes it would have put on the wire.
function fakeServer(block: Buffer, size = block.length + SMALL_BODY) {
  const wire = { headerBytes: 0, queries: [] as unknown[] };
  const msg = {
    uid: 7, flags: new Set<string>(), size,
    internalDate: new Date("2026-01-01T00:00:00Z"),
    envelope: { messageId: "<own@example.test>", subject: "s" },
    bodyStructure: { part: "1", type: "text/plain", encoding: "7bit", size: SMALL_BODY },
  };
  const client = {
    mailbox: null as unknown,
    list: async () => [{ path: "INBOX", name: "INBOX", delimiter: "/", subscribed: true, specialUse: "\\Inbox",
      status: { messages: 1, uidNext: 8, uidValidity: 1n, unseen: 0 } }],
    getMailboxLock: async () => {
      client.mailbox = { path: "INBOX", exists: 1, uidNext: 8, uidValidity: 1n };
      return { release: () => {} };
    },
    search: async () => [7],
    async *fetch(_range: unknown, query: any) {
      wire.queries.push(query);
      if (query.headers === true) {
        wire.headerBytes += block.length;
        yield { uid: 7, headers: block };
      } else if (Array.isArray(query.headers)) {
        const b = fieldsOf(block, query.headers);
        wire.headerBytes += b.length;
        yield { uid: 7, headers: b };
      } else if (query.bodyParts) {
        const p = query.bodyParts[0];
        expect(p.key.toUpperCase()).toBe("HEADER");
        const b = block.subarray(p.start ?? 0, (p.start ?? 0) + p.maxLength);
        wire.headerBytes += b.length;
        yield { uid: 7, headers: b };
      } else {
        yield { ...msg, ...(query.flags ? {} : { flags: undefined }) };
      }
    },
  };
  return { client: client as unknown as ImapFlow, wire };
}

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hdrfetch-"));
  store = new Store(dir);
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const account = { id: 1 } as never;
const mailbox = { id: 2, uidvalidity: 1 } as never;

// A store with account 1 and mailbox 2, matching `account` and `mailbox`.
function seededStore(d: string): Store {
  const s = new Store(d);
  s.upsertAccount({ slug: "seed", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  s.prep(`INSERT INTO mailbox(id, account_id, name, role, subscribed) VALUES(2, 1, 'Seeded', NULL, 1)`).run();
  return s;
}
const OWN = computeThreadIdFromHeaders([], "<own@example.test>");
const ROOT = computeThreadIdFromHeaders(parseHeaderBlock("References: <root@example.test>\r\n\r\n"), null);

describe("header fetches are bounded on the wire", () => {
  it.each([false, true])("Email/get (needsFullHeaders=%s) transfers at most the bound", async (needsFullHeaders) => {
    const { client, wire } = fakeServer(Buffer.from(`${FILLER}References: <root@example.test>\r\n\r\n`));
    const got = await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false, needsFullHeaders });
    expect(got.get(7)).toBeTruthy();
    expect(wire.headerBytes).toBeLessThanOrEqual(MAX_HEADER_BLOCK_BYTES);
    // Never an unbounded header fetch for a message larger than the bound.
    expect(wire.queries.some((q: any) => q.headers !== undefined)).toBe(false);
  });

  it("keeps the cheap HEADER.FIELDS fetch for a message within the bound", async () => {
    const { client, wire } = fakeServer(Buffer.from("References: <root@example.test>\r\nSubject: s\r\n\r\n"));
    const got = await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false });
    expect(got.get(7)?.threadId).toBe(ROOT);
    expect(wire.queries.some((q: any) => Array.isArray(q.headers))).toBe(true);
  });

  it("thread-index scan transfers at most the bound", async () => {
    const { client, wire } = fakeServer(Buffer.from(`${FILLER}References: <root@example.test>\r\n\r\n`));
    const acct = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    await buildThreadIndex({ account: acct, client, store });
    expect(wire.headerBytes).toBeLessThanOrEqual(MAX_HEADER_BLOCK_BYTES);
    expect(wire.queries.some((q: any) => q.headers !== undefined)).toBe(false);
  });
});

describe("one threadId per message, whichever path fetched it", () => {
  const cases = {
    "References inside the bound": { block: `References: <root@example.test>\r\n${FILLER}\r\n`, want: ROOT },
    "References past the bound": { block: `${FILLER}References: <root@example.test>\r\n\r\n`, want: OWN },
    "small message": { block: "References: <root@example.test>\r\n\r\n", want: ROOT },
    // Review round 2: many malformed References lines right up to the bound,
    // the valid one last. Any re-serialisation that grows the block would push
    // it past a second cap in one path only.
    "malformed References up to the bound": {
      block: `${"References:" + "x".repeat(900) + "\r\n"}`.repeat(574) + "References:<root@x>\r\nMessage-ID:<own@x>\r\n\r\n",
      want: computeThreadIdFromHeaders(parseHeaderBlock("References: <root@x>\r\n\r\n"), null),
    },
    "invalid UTF-8 in the threading fields": {
      block: Buffer.concat([Buffer.from("References: <r\xff\xfe@x>\r\n", "latin1"), Buffer.from(FILLER), Buffer.from("\r\n")]).toString("latin1"),
      want: computeThreadIdFromHeaders(parseHeaderBlock(Buffer.from("References: <r\xff\xfe@x>\r\n\r\n", "latin1")), null),
    },
  };

  let caseNo = 0;
  for (const [name, { block, want }] of Object.entries(cases)) {
    it(name, async () => {
      caseNo += 1;
      const ids: string[] = [];
      for (const order of [[false, true], [true, false]]) {
        // Cached: the first fetch fills the cache, the second may be served from it.
        const s = seededStore(mkdtempSync(path.join(tmpdir(), "hdrfetch-")));
        for (const needsFullHeaders of order) {
          const { client } = fakeServer(Buffer.from(block, "latin1"));
          const got = await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false, needsFullHeaders }, s);
          ids.push(got.get(7)!.threadId);
        }
        s.db.close();
      }
      // Uncached, and the thread-index scan.
      for (const needsFullHeaders of [false, true]) {
        const { client } = fakeServer(Buffer.from(block, "latin1"));
        ids.push((await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false, needsFullHeaders })).get(7)!.threadId);
      }
      const { client } = fakeServer(Buffer.from(block, "latin1"));
      const acct = store.upsertAccount({ slug: "t", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
      // The index is memoised per account id and email state across stores;
      // move the state past any earlier case's.
      for (let i = 0; i <= caseNo; i++) store.bumpState(acct.id, "email");
      const index = await buildThreadIndex({ account: acct, client, store });
      ids.push(...index.members.keys());
      expect(ids.map((x) => x === want)).toEqual(ids.map(() => true));
    });
  }
});

describe("threading derived once per message", () => {
  it("Email/get reuses what the thread scan cached, in either order", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "hdrfetch-"));
    const s = seededStore(d);
    // The scan saw (and cached) References <root>; a later fetch of the same
    // message gets different bytes (another projection, a server quirk).
    s.upsertEmailCacheRows([{ accountId: 1, mailboxId: 2, uidvalidity: 1, uid: 7, threadId: ROOT!,
      threadInputs: JSON.stringify({ messageId: null, inReplyTo: null, references: ["root@example.test"] }), internaldate: 0 }]);
    for (const needsFullHeaders of [false, true, false]) {
      const { client } = fakeServer(Buffer.from("References: <other@example.test>\r\n\r\n"));
      const got = (await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false, needsFullHeaders }, s)).get(7)!;
      expect(got.threadId).toBe(ROOT);
      expect(got.references).toEqual(["root@example.test"]);
    }
    expect(s.getThreadIndexRows(1).map((r) => r.thread_id)).toEqual([ROOT]);
    s.db.close();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("upgrade from a cache written before the bound", () => {
  it("drops cached messages and scan checkpoints once, and moves the states", () => {
    const d = mkdtempSync(path.join(tmpdir(), "hdrfetch-"));
    const s1 = seededStore(d);
    // What the old code left behind: a filtered header block from beyond the
    // first 512 KiB, its thread id, an oversized full block, a scan checkpoint.
    s1.upsertEmailCacheRows([
      { accountId: 1, mailboxId: 2, uidvalidity: 1, uid: 7, threadId: "Told", internaldate: 0,
        headersRaw: Buffer.from("References: <root@x>\r\n\r\n"), headersFull: false },
      { accountId: 1, mailboxId: 2, uidvalidity: 1, uid: 8, threadId: "Told2", internaldate: 0,
        headersRaw: Buffer.alloc(MAX_HEADER_BLOCK_BYTES + 1, 65), headersFull: true },
    ]);
    s1.putMailboxScan({ account_id: 1, mailbox_id: 2, uidvalidity: 1, uidnext: 9, messages: 2, scanned_at: 0 });
    s1.bumpState(1, "email");
    const before = s1.getState(1, "email");
    s1.db.pragma("user_version = 0");
    s1.db.close();

    const s2 = new Store(d);
    expect(s2.getEmailCacheRows(1, 2, 1, [7, 8]).size).toBe(0);
    expect(s2.getThreadIndexRows(1)).toEqual([]);
    expect(s2.getMailboxScan(1, 2)).toBeFalsy();
    expect(s2.getState(1, "email")).toBeGreaterThan(before);
    // Only once: rows written after the upgrade survive the next open.
    s2.upsertEmailCacheRows([{ accountId: 1, mailboxId: 2, uidvalidity: 1, uid: 9, threadId: "Tnew", internaldate: 0 }]);
    s2.db.close();
    const s3 = new Store(d);
    expect(s3.getEmailCacheRows(1, 2, 1, [9]).size).toBe(1);
    s3.db.close();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("bounded retention", () => {
  it("the thread scan writes rows per batch, not per folder", async () => {
    const n = 600;
    const block = Buffer.from("References: <root@example.test>\r\n\r\n");
    const client = {
      mailbox: null as unknown,
      list: async () => [{ path: "INBOX", name: "INBOX", delimiter: "/", subscribed: true, specialUse: "\\Inbox",
        status: { messages: n, uidNext: n + 1, uidValidity: 1n, unseen: 0 } }],
      getMailboxLock: async () => {
        client.mailbox = { path: "INBOX", exists: n, uidNext: n + 1, uidValidity: 1n };
        return { release: () => {} };
      },
      search: async () => Array.from({ length: n }, (_, i) => i + 1),
      async *fetch(range: string, query: any) {
        const uids = String(range).includes("*") ? Array.from({ length: n }, (_, i) => i + 1)
          : String(range).split(",").flatMap((r) => { const [a, b] = r.split(":").map(Number); return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i); });
        for (const uid of uids) {
          if (query.headers) yield { uid, headers: block };
          else yield { uid, size: block.length + 10, envelope: { messageId: `<m${uid}@x>` }, internalDate: new Date(0) };
        }
      },
    };
    const acct = store.upsertAccount({ slug: "batch", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    const sizes: number[] = [];
    const orig = store.upsertEmailCacheRows.bind(store);
    store.upsertEmailCacheRows = (rows) => {
      sizes.push(rows.length);
      orig(rows);
    };
    for (let i = 0; i < 7; i++) store.bumpState(acct.id, "email");
    const index = await buildThreadIndex({ account: acct, client: client as unknown as ImapFlow, store });
    expect(index.members.get(ROOT!)?.length).toBe(n);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(256);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
  });

  it("Email/get keeps full header blocks only up to its budget; threading is unaffected", async () => {
    const big = Buffer.from(`References: <root@example.test>\r\n${FILLER}\r\n`).subarray(0, MAX_HEADER_BLOCK_BYTES);
    const uids = Array.from({ length: Math.ceil(MAX_FULL_HEADER_BYTES_PER_CALL / MAX_HEADER_BLOCK_BYTES) + 4 }, (_, i) => i + 1);
    const client = {
      async *fetch(range: string, query: any) {
        const want = String(range).split(",").flatMap((r) => { const [a, b] = r.split(":").map(Number); return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i); });
        for (const uid of want) {
          if (query.bodyParts) yield { uid, headers: big.subarray(0, query.bodyParts[0].maxLength) };
          else yield { uid, flags: new Set(), size: big.length * 2, internalDate: new Date(0),
            envelope: { messageId: "<own@example.test>" }, bodyStructure: { part: "1", type: "text/plain", encoding: "7bit", size: 1 } };
        }
      },
    };
    const got = await fetchEmailsBatch(client as never, account, mailbox, uids, { wantsPreview: false, needsFullHeaders: true });
    const kept = uids.filter((u) => got.get(u)!._headers.length > 0);
    expect(kept.length * MAX_HEADER_BLOCK_BYTES).toBeLessThanOrEqual(MAX_FULL_HEADER_BYTES_PER_CALL);
    expect(kept.length).toBeLessThan(uids.length);
    expect(new Set(uids.map((u) => got.get(u)!.threadId))).toEqual(new Set([ROOT]));
  });
});

describe("review round 3", () => {
  const LARGE = Buffer.from(`References: <root@example.test>\r\n${FILLER}\r\n`, "latin1").subarray(0, MAX_HEADER_BLOCK_BYTES);

  function manyServer(block: Buffer) {
    return {
      async *fetch(range: string, query: any) {
        const want = String(range).split(",").flatMap((r) => { const [a, b] = r.split(":").map(Number); return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i); });
        for (const uid of want) {
          if (query.bodyParts) yield { uid, headers: block.subarray(0, query.bodyParts[0].maxLength) };
          else if (query.headers) yield { uid, headers: block };
          else yield { uid, flags: new Set(), size: block.length * 2, internalDate: new Date(0),
            envelope: { messageId: "<own@example.test>" }, bodyStructure: { part: "1", type: "text/plain", encoding: "7bit", size: 1 } };
        }
      },
    } as never;
  }

  it("cached header blocks draw on the same budget, and metadata reads never load them", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "hdrfetch-"));
    const s = seededStore(d);
    const n = 40;
    const uids = Array.from({ length: n }, (_, i) => i + 1);
    // Fill the cache with 40 full blocks in two legitimate reads of 20.
    for (const half of [uids.slice(0, 20), uids.slice(20)]) {
      await fetchEmailsBatch(manyServer(LARGE), account, mailbox, half, { wantsPreview: false, needsFullHeaders: true }, s);
    }
    let loaded = 0;
    const orig = s.getEmailCacheHeaders.bind(s);
    s.getEmailCacheHeaders = (...a) => {
      const b = orig(...a);
      loaded += b?.length ?? 0;
      return b;
    };
    // Warm: all 40 from cache in one call.
    const got = await fetchEmailsBatch(manyServer(LARGE), account, mailbox, uids, { wantsPreview: false, needsFullHeaders: true }, s);
    expect(loaded).toBeLessThanOrEqual(MAX_FULL_HEADER_BYTES_PER_CALL);
    expect(uids.filter((u) => got.get(u)!._headers.length > 0).length * MAX_HEADER_BLOCK_BYTES).toBeLessThanOrEqual(MAX_FULL_HEADER_BYTES_PER_CALL);
    expect(new Set(uids.map((u) => got.get(u)!.threadId))).toEqual(new Set([ROOT]));
    // Metadata only: no header blob is read at all.
    loaded = 0;
    await fetchEmailsBatch(manyServer(LARGE), account, mailbox, uids, { wantsPreview: false }, s);
    expect(loaded).toBe(0);
    // Two groups (mailboxes) of one request share one budget.
    loaded = 0;
    const shared = { remaining: MAX_FULL_HEADER_BYTES_PER_CALL };
    await fetchEmailsBatch(manyServer(LARGE), account, mailbox, uids.slice(0, 20), { wantsPreview: false, needsFullHeaders: true, headerBudget: shared }, s);
    await fetchEmailsBatch(manyServer(LARGE), account, mailbox, uids.slice(20), { wantsPreview: false, needsFullHeaders: true, headerBudget: shared }, s);
    expect(loaded).toBeLessThanOrEqual(MAX_FULL_HEADER_BYTES_PER_CALL);
    s.db.close();
    rmSync(d, { recursive: true, force: true });
  });

  it("marks a header block cut at the bound as truncated", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "hdrfetch-"));
    const s = seededStore(d);
    await fetchEmailsBatch(manyServer(LARGE), account, mailbox, [1], { wantsPreview: false, needsFullHeaders: true }, s);
    const { client } = fakeServer(Buffer.from("References: <root@example.test>\r\n\r\n"));
    await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false, needsFullHeaders: true }, s);
    const rows = s.getEmailCacheRows(1, 2, 1, [1, 7]);
    expect(rows.get(1)!.headers_truncated).toBe(1);
    expect(rows.get(7)!.headers_truncated).toBe(0);
    s.db.close();
    rmSync(d, { recursive: true, force: true });
  });

  it.each(["get-first", "scan-first"])("a UID reused under a new UIDVALIDITY gets the new message's threading (%s)", async (order) => {
    const d = mkdtempSync(path.join(tmpdir(), "hdrfetch-"));
    const s = seededStore(d);
    const OLD = computeThreadIdFromHeaders(parseHeaderBlock("References: <old@x>\r\n\r\n"), null);
    const NEW = computeThreadIdFromHeaders(parseHeaderBlock("References: <new@x>\r\n\r\n"), null);
    if (order === "get-first") {
      const { client } = fakeServer(Buffer.from("References: <old@x>\r\n\r\n"));
      await fetchEmailsBatch(client, account, { id: 2, uidvalidity: 100 } as never, [7], { wantsPreview: false }, s);
    } else {
      s.upsertEmailCacheRows([{ accountId: 1, mailboxId: 2, uidvalidity: 100, uid: 7, threadId: OLD!, internaldate: 0,
        threadInputs: JSON.stringify({ messageId: null, inReplyTo: null, references: ["old@x"] }) }]);
    }
    for (let i = 0; i < 2; i++) {
      const { client } = fakeServer(Buffer.from("References: <new@x>\r\n\r\n"));
      const got = (await fetchEmailsBatch(client, account, { id: 2, uidvalidity: 200 } as never, [7], { wantsPreview: false }, s)).get(7)!;
      expect(got.threadId).toBe(NEW);
      expect(got.references).toEqual(["new@x"]);
    }
    expect(s.getThreadIndexRows(1)).toMatchObject([{ uidvalidity: 200, thread_id: NEW }]);
    s.db.close();
    rmSync(d, { recursive: true, force: true });
  });

  it("the upgrade moves implicit (never written) states too, so */changes resync", async () => {
    const { emailChanges } = await import("../../src/jmap/methods/email.js");
    const { threadChanges } = await import("../../src/jmap/methods/threads.js");
    const { encodeEmailState } = await import("../../src/state/states.js");
    const d = mkdtempSync(path.join(tmpdir(), "hdrfetch-"));
    const s1 = seededStore(d);
    expect(s1.getState(1, "email")).toBe(0);
    s1.db.pragma("user_version = 0");
    s1.db.close();
    const s2 = new Store(d);
    const acct = s2.getAccountById(1)!;
    expect(s2.getState(1, "email")).toBeGreaterThan(0);
    const since = encodeEmailState({ uidvalidity: 0, modseq: 0 });
    await expect(emailChanges({ accountId: "1", sinceState: since }, { account: acct, store: s2 })).rejects.toMatchObject({ type: "cannotCalculateChanges" });
    await expect(threadChanges({ accountId: "1", sinceState: since }, { account: acct, store: s2 } as never)).rejects.toMatchObject({ type: "cannotCalculateChanges" });
    s2.db.close();
    rmSync(d, { recursive: true, force: true });
  });

  it("Email/get refuses more ids than maxObjectsInGet", async () => {
    const { emailGet } = await import("../../src/jmap/methods/email.js");
    const ctx = { account: { id: 1 }, client: {}, store: { getState: () => 1 }, maxObjectsInGet: 3 } as never;
    await expect(emailGet({ accountId: "1", ids: ["a", "b", "c", "d"] }, ctx)).rejects.toMatchObject({ type: "requestTooLarge" });
  });
});

describe("review round 4: one message, one result", () => {
  const LARGE = Buffer.from(`References: <root@example.test>\r\n${FILLER}\r\n`, "latin1").subarray(0, MAX_HEADER_BLOCK_BYTES);

  function ctxFor(s: Store) {
    const client = {
      mailbox: { uidValidity: 1n, exists: 1 },
      getMailboxLock: async () => ({ release() {} }),
      async *fetch(_range: string, query: any) {
        if (query.bodyParts) yield { uid: 7, headers: LARGE.subarray(0, query.bodyParts[0].maxLength) };
        else if (query.headers) yield { uid: 7, headers: LARGE };
        else if (query.flags && !query.envelope) yield { uid: 7, flags: new Set() };
        else yield { uid: 7, flags: new Set(), size: LARGE.length * 2, internalDate: new Date(0),
          envelope: { messageId: "<own@example.test>" }, bodyStructure: { part: "1", type: "text/plain", encoding: "7bit", size: 1 } };
      },
    };
    return { account: s.getAccountById(1)!, client, store: s } as never;
  }

  // The same message (account 1, mailbox 2, UIDVALIDITY 1, UID 7) spelled with
  // padded varints: a valid decode, but not an id the server ever issued.
  function aliases(n: number): string[] {
    const out: string[] = [];
    for (let pad = 0; pad < n; pad++) {
      const one = [...Array(pad).fill(0x80).map((_, i) => (i === 0 ? 0x81 : 0x80)), ...(pad ? [0x00] : [0x01])];
      out.push(Buffer.from([...one, 0x02, 0x01, 0x07]).toString("base64url"));
    }
    return out;
  }

  it.each(["repeated", "aliased"])("%s ids are fetched and projected once", async (kind) => {
    const { emailGet } = await import("../../src/jmap/methods/email.js");
    const { encodeEmailId } = await import("../../src/mapping/ids.js");
    const id = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 1, uid: 7 });
    const d = mkdtempSync(path.join(tmpdir(), "hdrfetch-"));
    const s = seededStore(d);
    const ids = kind === "repeated" ? Array(40).fill(id) : [id, ...aliases(39).slice(1)];
    const res = await emailGet({ accountId: "1", ids, properties: ["id", "headers", "threadId"] }, ctxFor(s));
    expect(res.list).toHaveLength(1);
    expect(res.list[0]!.id).toBe(id);
    const chars = (res.list as { headers: { name: string; value: string }[] }[])
      .flatMap((e) => e.headers).reduce((n, h) => n + h.name.length + h.value.length, 0);
    expect(chars).toBeLessThanOrEqual(MAX_FULL_HEADER_BYTES_PER_CALL);
    if (kind === "aliased") expect(res.notFound).toHaveLength(38);
    s.db.close();
    rmSync(d, { recursive: true, force: true });
  });
});
