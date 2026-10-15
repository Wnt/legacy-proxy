import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { emailSet } from "../../src/jmap/methods/email.js";
import { encodeMailboxId } from "../../src/mapping/ids.js";

it("rejects a file-source object where JMAP requires a body-value string", async () => {
  const mailboxId = encodeMailboxId({ accountIdx: 1, mailboxIdx: 2 });
  const path = fileURLToPath(new URL("../fixtures/security-mime-body.txt", import.meta.url));
  let appended: Buffer | undefined;
  const client = {
    append: vi.fn(async (_mailbox: string, bytes: Buffer) => {
      appended = bytes;
      return { uid: 7, uidValidity: 1n };
    }),
  };
  const store = {
    getState: () => 1,
    prep: () => ({ get: () => ({ id: 2, name: "Drafts", uidvalidity: 1 }) }),
    recordChanges: vi.fn(), bumpState: vi.fn(),
  };
  const result = await emailSet({ accountId: "1", create: {
    draft: {
      mailboxIds: { [mailboxId]: true },
      bodyStructure: { type: "text/plain", partId: "1" },
      bodyValues: { "1": { value: { path } } },
    },
  } }, { account: { id: 1, host: "example.test" }, client, store } as never);

  // Only the checked-in harmless fixture is read; IMAP APPEND is mocked.
  const parsed = appended ? await simpleParser(appended) : null;
  expect(parsed?.text ?? "").not.toContain("audit-only file-read sentinel");
  expect(client.append).not.toHaveBeenCalled();
  expect(result.notCreated?.draft?.type).toBe("invalidProperties");
});
