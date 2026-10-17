// Email `preview`: visible text only, never CSS or markup, from whichever part
// the message has, computed from a prefix that may end anywhere.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/state/store.js";
import { fetchEmailsBatch } from "../../src/imap/fetcher.js";
import { buildPreview, htmlPreview, plainPreview, stripLeadingCss } from "../../src/mapping/preview.js";

const NO_CSS = /[{}]|@media|!important|mso-|<\/?[a-z]|&[a-z]+;|&#/i;

const STYLE = "<style type=\"text/css\">\n" +
  Array.from({ length: 300 }, (_, i) => `.c${i} td { padding: 0 !important; color: #333; } @media only screen and (max-width:600px){ .m${i}{width:100%!important} }`).join("\n") +
  "\n</style>";

const NEWSLETTER =
  "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Newsletter title</title>" + STYLE +
  "<!--[if mso]><style>td{font-family:Arial}</style><![endif]--></head>" +
  "<body><style>.late{color:red}</style><table><tr><td>Hello &amp; welcome</td><td>to the autumn sale</td></tr></table>" +
  "<p>Prices from 10&nbsp;&euro; &ndash; caf&eacute; &auml;l&ouml; &#8217;ok&#x2019;</p></body></html>";

describe("htmlPreview", () => {
  it("drops head, title, style, comments and markup and decodes entities", () => {
    const p = htmlPreview(NEWSLETTER);
    expect(p).toBe("Hello & welcome to the autumn sale Prices from 10 € – café älö ’ok’");
    expect(p).not.toMatch(NO_CSS);
  });

  it("never shows CSS when the prefix ends inside a <style> element", () => {
    const html = "<html><head><style>a{color:red}</style></head><body><p>First words</p><style>.x{color:blue}\n.y{margin:0";
    expect(htmlPreview(html)).toBe("First words");
    // Cut inside a second head style sheet: nothing visible yet.
    expect(htmlPreview(NEWSLETTER.slice(0, 4096))).toBe("");
  });

  it("drops CSS that sits in the body as text", () => {
    expect(htmlPreview("<body><p>Hello</p><p>td.x { padding: 0 } table { border-collapse: collapse }</p><p>World</p>")).toBe("Hello World");
  });

  it("never shows markup when the prefix ends inside a tag or a comment", () => {
    expect(htmlPreview("<p>Visible text</p><a href=\"https://exa")).toBe("Visible text");
    expect(htmlPreview("<p>Visible text</p><!-- a comment that goes on {")).toBe("Visible text");
  });

  it("works without a <head> element and with a <head> that is never closed", () => {
    expect(htmlPreview("<style>p{margin:0}</style><div>Just a div</div>")).toBe("Just a div");
    expect(htmlPreview("<html><head><style>p{margin:0}</style><body><p>Body text</p>")).toBe("Body text");
  });

  it("keeps the preheader, drops its invisible padding and later hidden duplicates", () => {
    const html =
      "<html><head><style>.x{}</style></head><body>" +
      "<div style=\"display:none;max-height:0;overflow:hidden;mso-hide:all\">Your October statement is ready" +
      "&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;͏ ‌­⁠&#8203;".repeat(40) + "</div>" +
      "<table><tr><td>Dear customer,</td></tr></table>" +
      "<div class=\"mobile\" style=\"display: none !important\">Mobile-only copy</div>" +
      "<span style=\"opacity:0\">hidden span</span>" +
      "<p hidden>hidden attribute</p>" +
      "<p>See the details below.</p></body></html>";
    expect(htmlPreview(html)).toBe("Your October statement is ready Dear customer, See the details below.");
  });

  it("does not treat font-size:0 wrappers or mso-hide alone as hidden", () => {
    const html = "<td style=\"font-size:0\"><div style=\"display:inline-block\"><p style=\"font-size:14px\">Column text</p></div></td>" +
      "<div style=\"mso-hide:all\">Not for Outlook</div>";
    expect(htmlPreview(html)).toBe("Column text Not for Outlook");
  });

  it("separates words across block elements and keeps inline runs together", () => {
    expect(htmlPreview("<td>A</td><td>B</td><p>C<b>D</b><span>E</span><br>F</p>")).toBe("A B CDE F");
  });

  it("is at most 256 characters and never ends in half a surrogate pair", () => {
    const p = htmlPreview("<p>" + "a".repeat(255) + "😀 more</p>");
    expect(p.length).toBeLessThanOrEqual(256);
    expect(p).not.toMatch(/[\ud800-\udbff]$/);
    expect(htmlPreview("<p>" + "word ".repeat(400) + "</p>").length).toBeLessThanOrEqual(256);
  });

  it("keeps emoji joined by a zero-width joiner", () => {
    expect(htmlPreview("<p>Family \u{1F468}‍\u{1F469}‍\u{1F467} trip</p>")).toBe("Family \u{1F468}‍\u{1F469}‍\u{1F467} trip");
  });
});

describe("plainPreview", () => {
  it("keeps angle-bracketed links and addresses, decodes entity references", () => {
    expect(plainPreview("Hi,\n\nsee <https://example.com> &amp; reply to <a@example.com>.\r\n")).toBe("Hi, see <https://example.com> & reply to <a@example.com>.");
    expect(plainPreview("It&#8217;s 5&nbsp;&euro; &lt;cheap&gt; AT&T Q&A")).toBe("It\u2019s 5 € <cheap> AT&T Q&A");
  });

  it("drops tags a converter left in a plain-text part", () => {
    expect(plainPreview("Click <a href=\"https://x\">here</a> or <span style=\"color:red\">now</span><br>Bye")).toBe("Click here or now Bye");
  });

  it("drops CSS rules after the first words, not prose in braces", () => {
    expect(plainPreview("View this email in your browser p { margin: 0; } .hdr td { padding:0 !important } Hello Jonni")).toBe("View this email in your browser Hello Jonni");
    expect(plainPreview("Intro text @media only screen and (max-width:600px) { .col { width:100% !important; } } Body")).toBe("Intro text Body");
    expect(plainPreview("Intro text .x { color: red; font-size: 1")).toBe("Intro text");
    expect(plainPreview("Join us {at 5pm} and bring {color: your own mug}")).toBe("Join us {at 5pm} and bring {color: your own mug}");
  });

  it("drops a style sheet a converter left at the start", () => {
    expect(plainPreview("/* reset */ body { margin: 0; }\n@media screen and (max-width: 600px) { .a { width: 100% } }\n\nHello there")).toBe("Hello there");
    expect(plainPreview("td{padding:0} .x{color:red}")).toBe("");
    expect(plainPreview(".btn { color: red; ")).toBe("");
  });

  it("recognises the selectors email style sheets use", () => {
    expect(plainPreview("#outlook a { padding:0; } .ReadMsgBody { width:100%; } a[x-apple-data-detectors] { color:inherit !important; } [data-ogsc] .dark, u + .body .x { color:#fff } *[x-apple-data-detectors] { color:inherit } td:hover, a::after { display:none } Text")).toBe("Text");
  });

  it("leaves prose with braces alone", () => {
    expect(plainPreview("Meeting at {time} tomorrow")).toBe("Meeting at {time} tomorrow");
    expect(stripLeadingCss("@media team, please read")).toBe("@media team, please read");
    expect(plainPreview("Reminder: your appointment {date: Monday}")).toBe("Reminder: your appointment {date: Monday}");
  });

  it("treats a text/plain part that holds an HTML document as HTML", () => {
    expect(plainPreview("<!DOCTYPE html><html><head><style>p{x:y}</style></head><body><p>Real text</p></body></html>")).toBe("Real text");
  });

  it("strips invisible padding", () => {
    expect(plainPreview("͏‌ Hello­​ world﻿")).toBe("Hello world");
  });

  it("buildPreview picks the converter by part type", () => {
    expect(buildPreview("<b>x</b>", true)).toBe("x");
    expect(buildPreview("a <https://x> c", false)).toBe("a <https://x> c");
  });
});

// ---- Through fetchEmailsBatch: part choice, fetch length, fallback, cache ----

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "preview-"));
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
  const enc = p.encoding ?? "7bit";
  return { part, type: p.type, encoding: enc, size: encode(p).length, parameters: { charset: "utf-8" } };
}
function encode(p: Part): Buffer {
  return p.encoding === "base64" ? Buffer.from(Buffer.from(p.body).toString("base64").replace(/.{76}/g, "$&\r\n")) : Buffer.from(p.body);
}

// A mocked IMAP client serving one message (uid 7) with the given parts.
function server(bodyStructure: object, parts: Record<string, Part>, seen: { key: string; maxLength: number }[] = []) {
  return {
    mailbox: { uidValidity: 1n, exists: 1, uidNext: 8, path: "INBOX" },
    getMailboxLock: async () => ({ release() {} }),
    async *fetch(_r: string, q: any) {
      if (q.headers || q.bodyParts?.[0]?.key === "HEADER") {
        yield { uid: 7, headers: Buffer.from("Subject: s\r\n\r\n") };
      } else if (q.bodyParts) {
        const map = new Map<string, Buffer>();
        for (const bp of q.bodyParts) {
          seen.push({ key: bp.key, maxLength: bp.maxLength });
          const p = parts[bp.key];
          if (p) map.set(bp.key, encode(p).subarray(0, bp.maxLength));
        }
        yield { uid: 7, bodyParts: map };
      } else if (q.flags && !q.envelope) yield { uid: 7, flags: new Set() };
      else yield { uid: 7, flags: new Set(), size: 100, internalDate: new Date(0), envelope: { subject: "s" }, bodyStructure };
    },
  } as never;
}

const PLAIN = { type: "text/plain", body: "Plain version of the mail" };
const HTML = { type: "text/html", body: NEWSLETTER, encoding: "base64" };

describe("fetchEmailsBatch preview", () => {
  it("multipart/alternative: prefers the text/plain part", async () => {
    const bs = { type: "multipart/alternative", childNodes: [leaf("1", PLAIN), leaf("2", HTML)] };
    const got = await fetchEmailsBatch(server(bs, { "1": PLAIN, "2": HTML }), account, mailbox, [7], {}, store);
    expect(got.get(7)!.preview).toBe("Plain version of the mail");
  });

  it("HTML-only: fetches enough of the part to get past a long <style> head", async () => {
    expect(Buffer.from(NEWSLETTER).length).toBeGreaterThan(30_000);
    const seen: { key: string; maxLength: number }[] = [];
    const bs = leaf("1", HTML);
    const got = await fetchEmailsBatch(server(bs, { "1": HTML }, seen), account, mailbox, [7], {}, store);
    expect(got.get(7)!.preview).toBe(htmlPreview(NEWSLETTER));
    expect(got.get(7)!.preview).not.toMatch(NO_CSS);
    expect(seen.find((s) => s.key === "1")!.maxLength).toBeGreaterThan(Buffer.from(NEWSLETTER).length);
  });

  it("multipart/alternative with only an HTML part, listed in textBody or not", async () => {
    const bs = { type: "multipart/alternative", childNodes: [leaf("1", HTML)] };
    const got = await fetchEmailsBatch(server(bs, { "1": HTML }), account, mailbox, [7], {}, store);
    expect(got.get(7)!.preview).toBe(htmlPreview(NEWSLETTER));
  });

  it("falls back to the HTML part when the plain part is only CSS", async () => {
    const cssOnly = { type: "text/plain", body: "td { padding: 0; } .x { color: red; }" };
    const bs = { type: "multipart/alternative", childNodes: [leaf("1", cssOnly), leaf("2", HTML)] };
    const got = await fetchEmailsBatch(server(bs, { "1": cssOnly, "2": HTML }), account, mailbox, [7], {}, store);
    expect(got.get(7)!.preview).toBe(htmlPreview(NEWSLETTER));
  });

  it("previews from body values in hand use the same rules", async () => {
    const bs = { type: "multipart/mixed", childNodes: [leaf("1", HTML), { part: "2", type: "application/pdf", encoding: "base64", size: 10, disposition: "attachment" }] };
    const got = await fetchEmailsBatch(server(bs, { "1": HTML }), account, mailbox, [7],
      { fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 1_000_000 }, store);
    expect(got.get(7)!.preview).toBe(htmlPreview(NEWSLETTER));
  });

  it("caches the preview and serves it from the cache", async () => {
    const bs = leaf("1", HTML);
    await fetchEmailsBatch(server(bs, { "1": HTML }), account, mailbox, [7], {}, store);
    const seen: { key: string; maxLength: number }[] = [];
    const again = await fetchEmailsBatch(server(bs, { "1": HTML }, seen), account, mailbox, [7], {}, store);
    expect(again.get(7)!.preview).toBe(htmlPreview(NEWSLETTER));
    expect(seen).toEqual([]);
  });
});

describe("cache upgrade to v4", () => {
  it("forgets cached previews, keeps the rest of the row, and moves the Email state", async () => {
    store.upsertEmailCacheRows([{ accountId: 1, mailboxId: 2, uidvalidity: 1, uid: 7, threadId: "T1", internaldate: 5,
      threadInputs: JSON.stringify({ messageId: null, inReplyTo: null, references: null }),
      envelope: JSON.stringify({ subject: "s" }), bodystructure: JSON.stringify(leaf("1", HTML)),
      preview: "td{color:red} .x{margin:0}" }]);
    const before = store.getState(1, "email");
    store.db.pragma("user_version = 3");
    store.db.close();
    store = new Store(dir);
    const row = store.prep(`SELECT preview, thread_id, envelope FROM email_cache WHERE uid = 7`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ preview: null, thread_id: "T1" });
    expect(row.envelope).toBeTruthy();
    expect(store.getState(1, "email")).toBeGreaterThan(before);
    expect(store.db.pragma("user_version", { simple: true })).toBe(4);
    // The next read computes the preview again and caches it.
    const got = await fetchEmailsBatch(server(leaf("1", HTML), { "1": HTML }), account, mailbox, [7], {}, store);
    expect(got.get(7)!.preview).toBe(htmlPreview(NEWSLETTER));
    expect((store.prep(`SELECT preview FROM email_cache WHERE uid = 7`).get() as { preview: string }).preview).toBe(htmlPreview(NEWSLETTER));
  });
});

describe("htmlPreview, malformed heads", () => {
  it("ends an unclosed <head> at the first body element, as a browser does", () => {
    expect(htmlPreview("<html><head><meta charset=utf-8><style>p{x:y}</style><title>T</title><div>Content</div>")).toBe("Content");
    expect(htmlPreview("<head><!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--><table><tr><td>Cell</td></tr></table>")).toBe("Cell");
  });
});
