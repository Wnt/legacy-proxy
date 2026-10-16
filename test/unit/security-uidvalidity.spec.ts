import { expect, it, vi } from "vitest";
import { emailSet } from "../../src/jmap/methods/email.js";
import { encodeEmailId } from "../../src/mapping/ids.js";

it.each([100, 200])("does not delete through an old UIDVALIDITY when cached UIDVALIDITY is %i", async (cachedValidity) => {
  const oldId = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 100, uid: 7 });
  const client = {
    mailbox: { uidValidity: 200n },
    getMailboxLock: vi.fn(async () => ({ release() {} })),
    messageDelete: vi.fn(async () => true),
  };
  const store = {
    getState: () => 1,
    prep: () => ({ get: () => ({ id: 2, name: "INBOX", uidvalidity: cachedValidity }) }),
    deleteEmailCacheUids: vi.fn(), recordChanges: vi.fn(), bumpState: vi.fn(),
  };
  const result = await emailSet({ accountId: "1", destroy: [oldId] },
    { account: { id: 1 }, client, store } as never);
  expect(client.messageDelete).not.toHaveBeenCalled();
  expect(result.notDestroyed?.[oldId]?.type).toBe("notFound");
});
