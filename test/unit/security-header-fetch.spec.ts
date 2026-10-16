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
import { fetchEmailsBatch } from "../../src/imap/fetcher.js";
import { buildThreadIndex } from "../../src/jmap/methods/threads.js";
import { computeThreadIdFromHeaders, MAX_HEADER_BLOCK_BYTES, parseHeaderBlock } from "../../src/imap/headers.js";

const FILLER = `X-Filler: ${"a".repeat(900)}\r\n`.repeat(Math.ceil((MAX_HEADER_BLOCK_BYTES * 1.5) / 912));
const SMALL_BODY = 100;

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
          const { client } = fakeServer(Buffer.from(block));
          const got = await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false, needsFullHeaders }, s);
          ids.push(got.get(7)!.threadId);
        }
        s.db.close();
      }
      // Uncached, and the thread-index scan.
      for (const needsFullHeaders of [false, true]) {
        const { client } = fakeServer(Buffer.from(block));
        ids.push((await fetchEmailsBatch(client, account, mailbox, [7], { wantsPreview: false, needsFullHeaders })).get(7)!.threadId);
      }
      const { client } = fakeServer(Buffer.from(block));
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

describe("cached header blocks", () => {
  it("drops oversized blocks cached before the bound when the store opens", () => {
    const d = mkdtempSync(path.join(tmpdir(), "hdrfetch-"));
    const s1 = seededStore(d);
    s1.upsertEmailCacheRows([{
      accountId: 1, mailboxId: 2, uidvalidity: 1, uid: 7, threadId: "T", internaldate: 0,
      headersRaw: Buffer.alloc(MAX_HEADER_BLOCK_BYTES + 1, 65), headersFull: true,
    }]);
    s1.db.close();
    const s2 = new Store(d);
    const row = s2.getEmailCacheRows(1, 2, 1, [7]).get(7)!;
    expect(row.headers_raw).toBeNull();
    expect(row.headers_full).toBe(0);
    s2.db.close();
    rmSync(d, { recursive: true, force: true });
  });
});
