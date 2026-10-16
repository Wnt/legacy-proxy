// Gmail can answer NO to UID MOVE from [Gmail]/Drafts to Sent after the draft
// was submitted, which left sent mail in Drafts (issue #25). On Gmail the move
// falls back to APPEND + expunge; other servers still report the failure.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { encodeEmailId, encodeMailboxId } from "../../src/mapping/ids.js";
import { applyEmailUpdate } from "../../src/jmap/methods/email.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "refile-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(kind: string) {
  const account = store.upsertAccount({ slug: `a-${kind}`, kind, host: "imap.example", username: "u", vault: Buffer.from("v") });
  const add = (name: string, role: string) =>
    Number(
      store
        .prep(`INSERT INTO mailbox(account_id, name, role, uidvalidity) VALUES (?, ?, ?, 1)`)
        .run(account.id, name, role).lastInsertRowid,
    );
  const drafts = add("[Gmail]/Drafts", "drafts");
  const sent = add("[Gmail]/Sent Mail", "sent");
  const emailId = encodeEmailId({ accountIdx: account.id, mailboxIdx: drafts, uidvalidity: 1, uid: 42 });
  const sentId = encodeMailboxId({ accountIdx: account.id, mailboxIdx: sent });
  return { account, emailId, sentId };
}

function fakeClient(opts: { moveOk: boolean }) {
  const calls: string[] = [];
  const client = {
    // What imapflow reports for the SELECTed mailbox; ids carry the same
    // UIDVALIDITY, so they are current.
    mailbox: { uidValidity: 1n },
    getMailboxLock: async (p: string) => {
      calls.push(`select ${p}`);
      return { release: () => {} };
    },
    messageFlagsRemove: async (range: string, flags: string[]) => {
      calls.push(`flags -${flags.join(",")} ${range}`);
      return true;
    },
    messageMove: async (range: string, dest: string) => {
      calls.push(`move ${range} ${dest}`);
      return opts.moveOk ? { path: "", destination: dest } : false;
    },
    fetchOne: async () => ({
      uid: 42,
      source: Buffer.from("Message-ID: <m@example>\r\n\r\nhi"),
      flags: new Set(["\\Seen", "\\Recent"]),
      internalDate: new Date(0),
    }),
    append: async (dest: string, _src: Buffer, flags?: string[]) => {
      calls.push(`append ${dest} ${(flags ?? []).join(",")}`);
      return { destination: dest };
    },
    messageDelete: async (range: string) => {
      calls.push(`delete ${range}`);
      return true;
    },
  };
  return { client: client as unknown as ImapFlow, calls };
}

const sendPatch = (sentId: string) => ({ "keywords/$draft": null, mailboxIds: { [sentId]: true } });

describe("post-send filing on Gmail", () => {
  it("appends to Sent and expunges the draft when MOVE is refused", async () => {
    const { account, emailId, sentId } = setup("gmail");
    const { client, calls } = fakeClient({ moveOk: false });
    await applyEmailUpdate(emailId, sendPatch(sentId), { account, client, store });
    expect(calls).toEqual([
      "select [Gmail]/Drafts",
      "flags -\\Draft 42",
      "move 42 [Gmail]/Sent Mail",
      "append [Gmail]/Sent Mail \\Seen",
      "delete 42",
    ]);
  });

  it("does not touch APPEND when MOVE works", async () => {
    const { account, emailId, sentId } = setup("gmail");
    const { client, calls } = fakeClient({ moveOk: true });
    await applyEmailUpdate(emailId, sendPatch(sentId), { account, client, store });
    expect(calls.some((c) => c.startsWith("append"))).toBe(false);
  });

  it("still reports a refused MOVE on other servers", async () => {
    const { account, emailId, sentId } = setup("generic");
    const { client, calls } = fakeClient({ moveOk: false });
    await expect(applyEmailUpdate(emailId, sendPatch(sentId), { account, client, store })).rejects.toThrow(
      /MOVE to "\[Gmail\]\/Sent Mail" failed/,
    );
    expect(calls.some((c) => c.startsWith("append"))).toBe(false);
  });
});
