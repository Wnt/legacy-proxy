// Opening a message again (or after the prefetch warmed it) is served from
// the body cache: no body FETCH, the same bodyValues.
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { fetchEmailsBatch } from "../../src/imap/fetcher.js";
import { Store } from "../../src/state/store.js";
import { storeBodyCache } from "../../src/imap/bodycache.js";

const BODY = Buffer.from("Hello <b>world</b>, a body of some length.\r\n");

function startServer(log: string[]): Promise<net.Server> {
  const srv = net.createServer((sock) => {
    sock.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd = "", ...rest] = line.split(" ");
        const c = cmd.toUpperCase();
        if (c === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`);
        else if (c === "SELECT" || c === "EXAMINE")
          sock.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1] x\r\n* OK [UIDNEXT 8] x\r\n${tag} OK [READ-WRITE] x\r\n`);
        else if (c === "UID" && rest[0]?.toUpperCase() === "FETCH") {
          log.push(line.slice(line.indexOf("FETCH")));
          if (line.includes("BODYSTRUCTURE")) {
            sock.write(
              `* 1 FETCH (UID 7 FLAGS () RFC822.SIZE 100 INTERNALDATE "05-Oct-2026 19:03:15 +0200"` +
                ` ENVELOPE (NIL "News" NIL NIL NIL NIL NIL NIL NIL NIL) BODYSTRUCTURE ("text" "html" ("charset" "utf-8") NIL NIL "7bit" ${BODY.length} 1 NIL NIL NIL NIL))\r\n${tag} OK\r\n`,
            );
          } else if (line.includes("HEADER")) {
            sock.write(`* 1 FETCH (UID 7 BODY[HEADER] {2}\r\n\r\n)\r\n${tag} OK\r\n`);
          } else if (line.includes("BODY")) {
            sock.write(`* 1 FETCH (UID 7 BODY[1] {${BODY.length}}\r\n`);
            sock.write(BODY);
            sock.write(`)\r\n${tag} OK\r\n`);
          } else {
            sock.write(`* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n${tag} OK\r\n`);
          }
        } else if (c === "LOGOUT") {
          sock.write(`* BYE\r\n${tag} OK\r\n`);
          sock.end();
        } else sock.write(`${tag} OK\r\n`);
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

let server: net.Server | null = null;
let dir: string | null = null;
afterEach(() => {
  server?.close();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("body cache", () => {
  it("serves a second open's body values without a body FETCH", async () => {
    const log: string[] = [];
    server = await startServer(log);
    dir = mkdtempSync(path.join(tmpdir(), "bodycache-"));
    const store = new Store(dir);
    const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    store.db.prepare(`INSERT INTO mailbox(account_id, name, role, subscribed) VALUES(?, 'INBOX', 'inbox', 1)`).run(account.id);
    const mbox = { id: 1, uidvalidity: 1 } as never;
    const client = new ImapFlow({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port, secure: false, auth: { user: "u", pass: "p" }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    const opts = { fetchAllBodyValues: true, needsFullHeaders: true, maxBodyValueBytes: 256000 };
    try {
      const first = (await fetchEmailsBatch(client, account, mbox, [7], opts, store)).get(7)!;
      const bodyFetches = () => log.filter((l) => /BODY\.PEEK\[1\]/i.test(l)).length;
      expect(bodyFetches()).toBe(1);
      const second = (await fetchEmailsBatch(client, account, mbox, [7], opts, store)).get(7)!;
      expect(bodyFetches()).toBe(1);
      expect(second.bodyValues).toEqual(first.bodyValues);
      expect(Object.values(second.bodyValues)[0]!.value).toContain("Hello");
      expect(second.keywords).toEqual({ $seen: true }); // flags are still live
      // A smaller cap is served from the same bytes, cut and marked truncated.
      const small = (await fetchEmailsBatch(client, account, mbox, [7], { ...opts, maxBodyValueBytes: 5 }, store)).get(7)!;
      expect(bodyFetches()).toBe(1);
      expect(Object.values(small.bodyValues)[0]).toMatchObject({ value: "Hello", isTruncated: true });
    } finally {
      lock.release();
      await client.logout();
      store.db.close();
    }
  });

  it("a cut prefix does not answer a request for more", () => {
    dir = mkdtempSync(path.join(tmpdir(), "bodycache-"));
    const store = new Store(dir);
    const cache = storeBodyCache(store, 1);
    cache.put("Pid:1", 10, Buffer.from("0123456789"));
    expect(cache.get("Pid:1", 20)).toBeNull();
    expect(cache.get("Pid:1", 4)?.toString()).toBe("0123");
    cache.put("Pid:2", 100, Buffer.from("short"));
    expect(cache.get("Pid:2", 1000)?.toString()).toBe("short");
    store.db.close();
  });
});
