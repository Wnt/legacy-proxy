// A text/plain alternative that only points to the HTML version ("This
// newsletter is in HTML. Read it at <link>") is not the preview: the HTML
// alternative's text is. All senders, links and texts here are invented.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/state/store.js";
import { fetchEmailsBatch } from "../../src/imap/fetcher.js";
import { htmlPreview, plainPreview, textPartPreview } from "../../src/mapping/preview.js";
import {
  POINTER_FALLBACK_MAX_CHARS,
  hasPointerNotice,
  isHtmlPointer,
  pointerFallback,
  pointerWords,
} from "../../src/mapping/html-pointer.js";

const LONG_LINK = "https://news.examplepaja.test/v/" + "aGVsbG8td29ybGQtZXhhbXBsZXBhamEtdG9rZW4".repeat(4);

// Stubs as bulk mail tools write them, in common languages.
const STUB_EN =
  "-\n\nThis newsletter was sent to you in HTML format only. To read it, open:\n" + LONG_LINK + "\n\n" +
  "**************************\n\nAdd info@examplepaja.test to your contacts so our letters reach you.\n\n" +
  "Unsubscribe\nhttps://news.examplepaja.test/u/123\n\nOur shop\nhttps://examplepaja.test/\n";
const STUB_EN_LEAD =
  "Autumn birch logs and new axe handles are in the shop.\n\n" + STUB_EN;
const STUB_EN_CLIENT =
  "Your email program does not seem to support HTML messages.\n\nOpen this message in your web browser instead:\n" + LONG_LINK + "\n";
const STUB_EN_TROUBLE = "Having trouble reading this email? View it online: " + LONG_LINK;
const STUB_FI =
  "Tämä uutiskirje on lähetetty HTML-muodossa. Jos viesti ei näy oikein, avaa se selaimessa:\n" + LONG_LINK +
  "\n\nPeru tilaus: https://news.examplepaja.test/u/123\nExamplepaja Oy, Esimerkkikatu 1, 00100 Helsinki\n";
const STUB_FI_CLIENT = "Sähköpostiohjelmasi ei tue tätä viestiä. Lue uutiskirjeen verkkoversio: " + LONG_LINK;
const STUB_SV = "Om e-postmeddelandet inte visas korrekt, öppna det i din webbläsare: " + LONG_LINK;
const STUB_DE = "Falls diese E-Mail nicht korrekt angezeigt wird, öffnen Sie sie im Browser: " + LONG_LINK;

const HTML_BODY =
  "<!DOCTYPE html><html><head><style>td{padding:0}</style></head><body>" +
  "<div style=\"display:none\">Autumn sale: birch logs and axe handles</div>" +
  "<table><tr><td><h1>Examplepaja autumn news</h1><p>Our birch logs are dry and ready for the stove.</p>" +
  "<p><a href=\"" + LONG_LINK + "\">Shop now</a></p></td></tr></table></body></html>";

describe("isHtmlPointer", () => {
  it.each([
    ["English, HTML only", STUB_EN],
    ["English, with a lead line", STUB_EN_LEAD],
    ["English, client without HTML", STUB_EN_CLIENT],
    ["English, trouble reading", STUB_EN_TROUBLE],
    ["Finnish, HTML-muodossa / selaimessa", STUB_FI],
    ["Finnish, ohjelma ei tue / verkkoversio", STUB_FI_CLIENT],
    ["Swedish", STUB_SV],
    ["German", STUB_DE],
  ])("%s", (_name, text) => {
    expect(isHtmlPointer(text)).toBe(true);
  });

  it("is not a real short message", () => {
    expect(isHtmlPointer("Hei! Nähdäänkö huomenna kahvilla klo 10? Terveisin Maija")).toBe(false);
    expect(isHtmlPointer("Kiitos tilauksestasi. Toimitamme paketin viikon sisällä.\nExamplepaja")).toBe(false);
    expect(isHtmlPointer("Thanks for your order. We ship it within a week.")).toBe(false);
  });

  it("is not a text alternative that carries the message after a view-online line", () => {
    const body = Array.from({ length: 30 }, (_, i) => `Item ${i}: dry birch logs, ready for the stove this winter.`).join("\n");
    const text = "View this email in your browser (" + LONG_LINK + ")\n\n" + body;
    expect(isHtmlPointer(text)).toBe(false);
  });

  it("never reads the notice from a link or an address", () => {
    expect(isHtmlPointer("Hei, katso https://examplepaja.test/view-in-browser/html-only.html")).toBe(false);
    expect(isHtmlPointer("Write to html-only@examplepaja.test")).toBe(false);
  });

  it("takes linear time on a long run of letters", () => {
    const blob = "QUJD".repeat(2048);
    const start = performance.now();
    expect(isHtmlPointer(blob)).toBe(false);
    expect(pointerWords(blob).length).toBe(blob.length);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("measures the words, not the links", () => {
    expect(pointerWords("-\nRead it online:\n" + LONG_LINK + "\n[>] " + LONG_LINK + "\n*****\n")).toBe("Read it online:");
  });
});

describe("pointerFallback", () => {
  it("is the notice's first sentence, without links", () => {
    expect(pointerFallback(STUB_EN)).toBe("This newsletter was sent to you in HTML format only.");
    expect(pointerFallback(STUB_FI)).toBe("Tämä uutiskirje on lähetetty HTML-muodossa.");
  });

  it("is the sender's lead line when there is one, but not a greeting or a label", () => {
    expect(pointerFallback(STUB_EN_LEAD)).toBe("Autumn birch logs and new axe handles are in the shop.");
    expect(pointerFallback("Hei,\n\n" + STUB_FI)).toBe("Hei, Tämä uutiskirje on lähetetty HTML-muodossa.");
    expect(pointerFallback("Order 1234\n\nSeems your mail program does not support HTML.\n" + LONG_LINK))
      .toBe("Order 1234 Seems your mail program does not support HTML.");
  });

  it("is short", () => {
    const long = "This newsletter, " + "with all of our autumn offers for the whole family and every stove, ".repeat(4) + "is in HTML only.";
    const f = pointerFallback(long);
    expect(f.length).toBeLessThanOrEqual(POINTER_FALLBACK_MAX_CHARS);
    expect(f.endsWith("…")).toBe(true);
    expect(f).not.toMatch(/https?:/);
  });
});

describe("textPartPreview", () => {
  it("takes the preview from the HTML alternative of a pointer stub", () => {
    expect(textPartPreview(STUB_EN, true)).toEqual({ preview: plainPreview(STUB_EN), useHtml: true, fallback: pointerFallback(STUB_EN) });
  });

  it("keeps the stub when there is no HTML alternative to take it from", () => {
    expect(textPartPreview(STUB_EN, false)).toEqual({ preview: plainPreview(STUB_EN), useHtml: false, fallback: plainPreview(STUB_EN) });
  });

  it("keeps a real text alternative", () => {
    expect(textPartPreview("Thanks for your order. We ship it within a week.", true).useHtml).toBe(false);
  });

  it("still falls back to the HTML for an empty text part, with no fallback text", () => {
    expect(textPartPreview("   ", true)).toEqual({ preview: "", useHtml: true, fallback: "" });
  });
});

// ---- Through fetchEmailsBatch ----

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pointer-"));
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

type Part = { body: string; type: string; encoding?: string };
function leaf(part: string, p: Part) {
  return { part, type: p.type, encoding: p.encoding ?? "7bit", size: encode(p).length, parameters: { charset: "utf-8" } };
}
function encode(p: Part): Buffer {
  return p.encoding === "base64" ? Buffer.from(Buffer.from(p.body).toString("base64").replace(/.{76}/g, "$&\r\n")) : Buffer.from(p.body);
}

// A mocked IMAP client serving one message (uid 7) with the given parts.
function server(bodyStructure: object, parts: Record<string, Part>, seen: string[] = []) {
  return {
    mailbox: { uidValidity: 1n, exists: 1, uidNext: 8, path: "INBOX" },
    getMailboxLock: async () => ({ release() {} }),
    async *fetch(_r: string, q: any) {
      if (q.headers || q.bodyParts?.[0]?.key === "HEADER") {
        yield { uid: 7, headers: Buffer.from("Subject: s\r\n\r\n") };
      } else if (q.bodyParts) {
        const map = new Map<string, Buffer>();
        for (const bp of q.bodyParts) {
          seen.push(bp.key);
          const p = parts[bp.key];
          if (p) map.set(bp.key, encode(p).subarray(0, bp.maxLength));
        }
        yield { uid: 7, bodyParts: map };
      } else if (q.flags && !q.envelope) yield { uid: 7, flags: new Set() };
      else yield { uid: 7, flags: new Set(), size: 100, internalDate: new Date(0), envelope: { subject: "s" }, bodyStructure };
    },
  } as never;
}

const STUB = { type: "text/plain", body: STUB_EN };
const HTML = { type: "text/html", body: HTML_BODY, encoding: "base64" };
const IMAGE_ONLY = { type: "text/html", body: "<html><body><a href=\"" + LONG_LINK + "\"><img src=\"cid:banner\" alt=\"\"></a></body></html>" };
const alternative = (html: Part) => ({ type: "multipart/alternative", childNodes: [leaf("1", STUB), leaf("2", html)] });

describe("fetchEmailsBatch preview of a pointer stub", () => {
  it("is the HTML alternative's text in a list (no body values)", async () => {
    const got = await fetchEmailsBatch(server(alternative(HTML), { "1": STUB, "2": HTML }), account, mailbox, [7], {}, store);
    expect(got.get(7)!.preview).toBe(htmlPreview(HTML_BODY));
    expect(got.get(7)!.preview).toBe("Autumn sale: birch logs and axe handles Examplepaja autumn news Our birch logs are dry and ready for the stove. Shop now");
  });

  it("is the same from body values in hand", async () => {
    const got = await fetchEmailsBatch(server(alternative(HTML), { "1": STUB, "2": HTML }), account, mailbox, [7],
      { fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 1_000_000 }, store);
    expect(got.get(7)!.preview).toBe(htmlPreview(HTML_BODY));
  });

  it("is the same with only the text body values in hand", async () => {
    const got = await fetchEmailsBatch(server(alternative(HTML), { "1": STUB, "2": HTML }), account, mailbox, [7],
      { fetchTextBodyValues: true, maxBodyValueBytes: 1_000_000 }, store);
    expect(got.get(7)!.preview).toBe(htmlPreview(HTML_BODY));
  });

  it("is the short notice when the HTML has no text", async () => {
    const got = await fetchEmailsBatch(server(alternative(IMAGE_ONLY), { "1": STUB, "2": IMAGE_ONLY }), account, mailbox, [7], {}, store);
    expect(got.get(7)!.preview).toBe("This newsletter was sent to you in HTML format only.");
    const again = await fetchEmailsBatch(server(alternative(IMAGE_ONLY), { "1": STUB, "2": IMAGE_ONLY }), account, mailbox, [7],
      { fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 1_000_000 });
    expect(again.get(7)!.preview).toBe("This newsletter was sent to you in HTML format only.");
  });

  it("stays the text when the HTML part is not its alternative", async () => {
    const mixed = { type: "multipart/mixed", childNodes: [leaf("1", STUB), leaf("2", HTML)] };
    const got = await fetchEmailsBatch(server(mixed, { "1": STUB, "2": HTML }), account, mailbox, [7], {}, store);
    expect(got.get(7)!.preview).toBe(plainPreview(STUB_EN));
  });

  it("reads only the text part of a real text alternative", async () => {
    const real = { type: "text/plain", body: "Thanks for your order. We ship it within a week." };
    const seen: string[] = [];
    const bs = { type: "multipart/alternative", childNodes: [leaf("1", real), leaf("2", HTML)] };
    const got = await fetchEmailsBatch(server(bs, { "1": real, "2": HTML }, seen), account, mailbox, [7], {}, store);
    expect(got.get(7)!.preview).toBe("Thanks for your order. We ship it within a week.");
    expect(seen).toEqual(["1"]);
  });
});

describe("cache upgrade to v6", () => {
  it("forgets only cached previews that hold a pointer notice, and moves that account's Email state", async () => {
    const row = (uid: number, preview: string) => ({ accountId: 1, mailboxId: 2, uidvalidity: 1, uid, threadId: `T${uid}`, internaldate: 5,
      threadInputs: JSON.stringify({ messageId: null, inReplyTo: null, references: null }),
      envelope: JSON.stringify({ subject: "s" }), bodystructure: JSON.stringify(alternative(HTML)), preview });
    store.upsertEmailCacheRows([row(7, plainPreview(STUB_EN)), row(8, "Thanks for your order. We ship it within a week.")]);
    const other = store.upsertAccount({ slug: "o", kind: "generic", host: "h", username: "o", vault: Buffer.from("v") });
    const before = store.getState(1, "email");
    const otherBefore = store.getState(other.id, "email");
    store.db.pragma("user_version = 5");
    store.db.close();
    store = new Store(dir);
    const previews = store.prep(`SELECT uid, preview FROM email_cache ORDER BY uid`).all();
    expect(previews).toEqual([{ uid: 7, preview: null }, { uid: 8, preview: "Thanks for your order. We ship it within a week." }]);
    expect(store.getState(1, "email")).toBeGreaterThan(before);
    expect(store.getState(other.id, "email")).toBe(otherBefore);
    expect(store.db.pragma("user_version", { simple: true })).toBe(6);
    // The next read computes the preview again, from the HTML, and caches it.
    const got = await fetchEmailsBatch(server(alternative(HTML), { "1": STUB, "2": HTML }), account, mailbox, [7, 8], {}, store);
    expect(got.get(7)!.preview).toBe(htmlPreview(HTML_BODY));
    expect((store.prep(`SELECT preview FROM email_cache WHERE uid = 7`).get() as { preview: string }).preview).toBe(htmlPreview(HTML_BODY));
  });

  it("a cached stub preview is recognised from its first 256 characters", () => {
    expect(hasPointerNotice(pointerWords(plainPreview(STUB_FI)))).toBe(true);
    expect(hasPointerNotice(pointerWords(plainPreview(STUB_EN_CLIENT)))).toBe(true);
  });
});
