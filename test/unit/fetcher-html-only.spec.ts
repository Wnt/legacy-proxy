import net from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { decodePartTextChecked, fetchEmailsBatch } from "../../src/imap/fetcher.js";

// A minimal IMAP server for one single-part message with the given body.
function startServer(bodystructure: string, body: Buffer): Promise<net.Server> {
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
          if (line.includes("BODYSTRUCTURE")) {
            sock.write(
              `* 1 FETCH (UID 7 FLAGS () RFC822.SIZE 100 INTERNALDATE "05-Oct-2026 19:03:15 +0200"` +
                ` ENVELOPE (NIL "News" NIL NIL NIL NIL NIL NIL NIL NIL) BODYSTRUCTURE ${bodystructure}` +
                ` BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)] {2}\r\n\r\n)\r\n${tag} OK\r\n`,
            );
          } else {
            sock.write(`* 1 FETCH (UID 7 BODY[1] {${body.length}}\r\n`);
            sock.write(body);
            sock.write(`)\r\n${tag} OK\r\n`);
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

const account = { id: 1 } as never;
const mailbox = { id: 2, uidvalidity: 1 } as never;

let server: net.Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function fetchOne(bodystructure: string, body: Buffer, opts: Record<string, unknown>) {
  server = await startServer(bodystructure, body);
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: (server.address() as net.AddressInfo).port,
    secure: false,
    auth: { user: "u", pass: "p" },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    return (await fetchEmailsBatch(client, account, mailbox, [7], opts as never)).get(7)!;
  } finally {
    lock.release();
    await client.logout();
  }
}

describe("HTML-only message", () => {
  const html = Buffer.from("<html><body><p>Your invoice is ready</p></body></html>");
  const bs = `("text" "html" ("charset" "utf-8") NIL NIL "7bit" ${html.length} 1 NIL NIL NIL NIL)`;

  it("lists the HTML part in textBody and returns it for fetchTextBodyValues (RFC 8621 §4.1.4)", async () => {
    const email = await fetchOne(bs, html, { fetchTextBodyValues: true, wantsPreview: true });
    expect(email.textBody.map((p) => [p.partId, p.type])).toEqual([["1", "text/html"]]);
    expect(email.htmlBody.map((p) => [p.partId, p.type])).toEqual([["1", "text/html"]]);
    expect(email.bodyValues["1"]).toEqual({ value: html.toString(), isEncodingProblem: false, isTruncated: false });
    // the preview is taken from the HTML as HTML, not as markup text
    expect(email.preview).toBe("Your invoice is ready");
  });

  it("previews it as HTML without body values too", async () => {
    const email = await fetchOne(bs, html, { wantsPreview: true });
    expect(email.preview).toBe("Your invoice is ready");
  });
});

describe("isEncodingProblem", () => {
  it("is set for bytes that are not valid in the part's charset", async () => {
    const bad = Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x21]);
    const bs = `("text" "plain" ("charset" "utf-8") NIL NIL "8bit" ${bad.length} 1 NIL NIL NIL NIL)`;
    const email = await fetchOne(bs, bad, { fetchTextBodyValues: true });
    expect(email.bodyValues["1"]!.isEncodingProblem).toBe(true);
    expect(email.bodyValues["1"]!.value.startsWith("Hi")).toBe(true);
  });

  it("decodes valid text, unknown charsets and cut values as the RFC asks", () => {
    expect(decodePartTextChecked(Buffer.from("Hyvää päivää"), "utf-8", false)).toEqual({ value: "Hyvää päivää", problem: false });
    expect(decodePartTextChecked(Buffer.from([0xe4]), "iso-8859-1", false)).toEqual({ value: "ä", problem: false });
    expect(decodePartTextChecked(Buffer.from("abc"), "x-no-such-charset", false)).toEqual({ value: "abc", problem: true });
    // a value cut inside a multi-byte character is truncated, not an encoding problem
    const cut = Buffer.from("aä").subarray(0, 2);
    expect(decodePartTextChecked(cut, "utf-8", true)).toEqual({ value: "a", problem: false });
  });
});
