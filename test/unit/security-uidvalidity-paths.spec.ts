// Every path that acts on a message by id must check the id's UIDVALIDITY
// against the mailbox as selected, under the lock: after a mailbox reset the
// same UID can be a different message. Mocked IMAP only.

import { describe, expect, it, vi } from "vitest";
import { emailCopy, emailGet, emailSet } from "../../src/jmap/methods/email.js";
import { readBlob } from "../../src/jmap/blobs.js";
import { encodeBlobId, encodeEmailId, encodeMailboxId } from "../../src/mapping/ids.js";

const LIVE = 200;
const stale = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 100, uid: 7 });
const fresh = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: LIVE, uid: 8 });
const otherAccount = encodeEmailId({ accountIdx: 9, mailboxIdx: 2, uidvalidity: LIVE, uid: 8 });
const target = encodeMailboxId({ accountIdx: 1, mailboxIdx: 3 });

function setup() {
  const touched: number[] = [];
  const record = (uids: unknown) => {
    for (const u of String(Array.isArray(uids) ? uids.join(",") : uids).split(",")) touched.push(Number(u));
    return true;
  };
  const client = {
    mailbox: { uidValidity: BigInt(LIVE), exists: 10 },
    getMailboxLock: vi.fn(async () => ({ release() {} })),
    messageDelete: vi.fn(async (u: unknown) => record(u)),
    messageFlagsAdd: vi.fn(async (u: unknown) => record(u)),
    messageFlagsSet: vi.fn(async (u: unknown) => record(u)),
    messageFlagsRemove: vi.fn(async (u: unknown) => record(u)),
    messageMove: vi.fn(async (u: unknown) => record(u)),
    messageCopy: vi.fn(async (u: unknown) => (record(u), { uidValidity: BigInt(LIVE), uidMap: new Map([[8, 50]]) })),
    download: vi.fn(async (u: unknown) => (record(u), { content: (async function* () { yield Buffer.from("x"); })(), meta: {} })),
    fetchOne: vi.fn(async (u: unknown) => (record(u), { uid: Number(u), size: 1, source: Buffer.from("x") })),
    async *fetch(range: unknown) {
      record(range);
    },
  };
  const rows: Record<number, { id: number; name: string; uidvalidity: number }> = {
    2: { id: 2, name: "INBOX", uidvalidity: 100 },
    3: { id: 3, name: "Archive", uidvalidity: 5 },
  };
  const store = {
    getState: () => 1,
    prep: () => ({ get: (id: number) => rows[id] }),
    deleteEmailCacheUids: vi.fn(), recordChanges: vi.fn(), bumpState: vi.fn(),
    getEmailCacheRows: () => new Map(), getEmailCacheRowsLean: () => new Map(), upsertEmailCacheRows: vi.fn(),
    getCachedBlob: () => null, getCachedBlobSize: () => null,
  };
  const ctx = { account: { id: 1 }, client, store } as never;
  return { ctx, client, touched };
}

describe("stale ids after a UIDVALIDITY change", () => {
  it("Email/set update: keywords and moves skip the stale id, apply the fresh one", async () => {
    const { ctx, touched } = setup();
    const res = await emailSet({ accountId: "1", update: {
      [stale]: { "keywords/$seen": true },
      [fresh]: { "keywords/$seen": true },
    } }, ctx);
    expect(res.notUpdated?.[stale]?.type).toBe("notFound");
    expect(res.updated?.[fresh]).toBeNull();
    expect(touched).not.toContain(7);
    expect(touched).toContain(8);
  });

  it("Email/set update with a move skips the stale id", async () => {
    const { ctx, touched } = setup();
    const res = await emailSet({ accountId: "1", update: { [stale]: { mailboxIds: { [target]: true } } } }, ctx);
    expect(res.notUpdated?.[stale]?.type).toBe("notFound");
    expect(touched).not.toContain(7);
  });

  it("Email/set destroy deletes only the fresh id", async () => {
    const { ctx, touched } = setup();
    const res = await emailSet({ accountId: "1", destroy: [stale, fresh] }, ctx);
    expect(res.notDestroyed?.[stale]?.type).toBe("notFound");
    expect(res.destroyed).toEqual([fresh]);
    expect(touched).not.toContain(7);
  });

  it("Email/get reports the stale id and another account's id as notFound without fetching them", async () => {
    const { ctx, touched } = setup();
    const res = await emailGet({ accountId: "1", ids: [stale, otherAccount] }, ctx);
    expect(res.notFound.sort()).toEqual([stale, otherAccount].sort());
    expect(touched).not.toContain(7);
  });

  it("Email/copy refuses a stale source", async () => {
    const { ctx, client } = setup();
    const res = await emailCopy({ accountId: "1", fromAccountId: "1", create: {
      c: { id: stale, mailboxIds: { [target]: true } },
    } } as never, ctx);
    expect(res.notCreated?.c?.type).toBe("notFound");
    expect(client.messageCopy).not.toHaveBeenCalled();
  });

  it("readBlob (forwarded attachments) refuses a stale blob id", async () => {
    const { ctx, client } = setup();
    expect(await readBlob(encodeBlobId(stale, "2"), ctx)).toBeNull();
    expect(client.download).not.toHaveBeenCalled();
    expect(await readBlob(encodeBlobId(fresh, "2"), ctx)).not.toBeNull();
  });

  it("refuses when no mailbox UIDVALIDITY is known", async () => {
    const { ctx, client, touched } = setup();
    (client as { mailbox: unknown }).mailbox = false;
    const res = await emailSet({ accountId: "1", destroy: [fresh] }, ctx);
    expect(res.notDestroyed?.[fresh]?.type).toBe("notFound");
    expect(touched).toEqual([]);
  });
});

describe("submission", () => {
  it("never sends the message that now holds a stale id's UID", async () => {
    const { fetchRfc822 } = await import("../../src/jmap/methods/submission.js");
    const { ctx, client } = setup();
    const c = ctx as unknown as { client: never; store: never };
    await expect(fetchRfc822(c.client, stale, c.store, 1)).rejects.toMatchObject({ type: "notFound" });
    expect(client.fetchOne).not.toHaveBeenCalled();
    await expect(fetchRfc822(c.client, fresh, c.store, 1)).resolves.toMatchObject({ mailboxName: "INBOX" });
  });

  it("refuses to buffer a message over the submission size limit", async () => {
    const { fetchRfc822 } = await import("../../src/jmap/methods/submission.js");
    const { ctx, client } = setup();
    client.fetchOne.mockImplementation(async (u: unknown, q: { source?: boolean }) =>
      q.source ? { uid: Number(u), source: Buffer.from("x") } : { uid: Number(u), size: 200 * 1024 * 1024 });
    const c = ctx as unknown as { client: never; store: never };
    await expect(fetchRfc822(c.client, fresh, c.store, 1)).rejects.toMatchObject({ type: "tooLarge" });
    expect(client.fetchOne.mock.calls.some(([, q]) => (q as { source?: boolean }).source)).toBe(false);
  });
});
