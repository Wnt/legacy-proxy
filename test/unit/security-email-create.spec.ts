// Email/set create input is JSON; nodemailer's MimeNode gives objects in
// string places a meaning (file path, URL, pre-formatted header). The schema
// check must turn all of them away before MIME building, and still accept
// what Bulwark actually sends.

import { describe, expect, it } from "vitest";
import { buildRfc822 } from "../../src/mapping/buildMime.js";
import { InvalidEmailCreateError, validateEmailCreate } from "../../src/mapping/emailCreate.js";

const base = { mailboxIds: { m1: true }, keywords: { $draft: true, $seen: true } };

describe("validateEmailCreate", () => {
  it.each([
    ["body value as file source", { bodyValues: { "1": { value: { path: "/etc/passwd" } } }, textBody: [{ partId: "1" }] }],
    ["body value as URL source", { bodyValues: { "1": { value: { href: "http://169.254.169.254/" } } }, textBody: [{ partId: "1" }] }],
    ["body value as array", { bodyValues: { "1": { value: ["x"] } } }],
    ["prepared header object", { headers: [{ name: "X-A", value: { prepared: true, value: "a\r\nBcc: x@y" } }] }],
    ["header name with colon", { headers: [{ name: "X:A", value: "v" }] }],
    ["header name with CRLF", { headers: [{ name: "X-A\r\nBcc", value: "v" }] }],
    ["subject object", { subject: { prepared: true, value: "s\r\nBcc: x@y" } }],
    ["address email object", { to: [{ email: { prepared: true } }] }],
    ["address name object", { from: [{ name: { value: "x" }, email: "a@b" }] }],
    ["references object", { references: [{ value: "x" }] }],
    ["sentAt garbage", { sentAt: "yesterday-ish" }],
    ["sentAt not RFC 3339", { sentAt: "Tue, 1 Sep 2026 10:00:00 +0000" }],
    ["mailboxIds non-boolean", { mailboxIds: { m1: "yes" } }],
    ["keywords non-boolean", { keywords: { $seen: 1 } }],
    ["unknown property", { bodySource: { path: "/etc/passwd" } }],
    ["part type object", { bodyStructure: { type: { value: "text/plain" }, partId: "1" } }],
    ["nested part with bad name", { bodyStructure: { type: "multipart/mixed", subParts: [{ blobId: "b", name: { a: 1 } }] } }],
    ["attachment cid object", { attachments: [{ blobId: "b", cid: { prepared: true } }] }],
    ["header:asText object", { "header:X-A:asText": { prepared: true, value: "x" } }],
    ["header form unknown", { "header:X-A:asBlob": "x" }],
    ["deep structure", { bodyStructure: Array.from({ length: 40 }).reduce((p) => ({ type: "multipart/mixed", subParts: [p] }), { partId: "1" }) }],
  ])("rejects %s", (_name, extra) => {
    expect(() => validateEmailCreate({ ...base, ...(extra as object) })).toThrow(InvalidEmailCreateError);
  });

  it("accepts Bulwark's compose, read-receipt and iMIP shapes", () => {
    validateEmailCreate({
      ...base,
      from: [{ name: "Me", email: "me@x" }],
      to: [{ email: "a@x" }],
      cc: [{ name: null, email: "c@x" }],
      subject: "Hi",
      sentAt: "2026-10-15T10:00:00Z",
      receivedAt: "2026-10-15T10:00:00.123+03:00",
      messageId: ["m@x"],
      inReplyTo: ["p@x"],
      references: ["r@x", "p@x"],
      "header:Disposition-Notification-To:asText": "me@x",
      bodyValues: { text: { value: "t" }, html: { value: "<p>t</p>" } },
      textBody: [{ partId: "text", type: "text/plain" }],
      htmlBody: [{ partId: "html", type: "text/html" }],
      attachments: [{ blobId: "b1", type: "image/png", name: "a.png", disposition: "inline", cid: "c1" }],
    });
    validateEmailCreate({
      ...base,
      bodyStructure: {
        type: "multipart/mixed",
        subParts: [
          { partId: "text", type: "text/plain" },
          { partId: "cal", type: "text/calendar; method=REPLY; charset=UTF-8", disposition: "inline", name: "reply.ics" },
        ],
      },
      bodyValues: { text: { value: "x" }, cal: { value: "BEGIN:VCALENDAR" } },
    });
  });
});

describe("buildRfc822", () => {
  it("refuses object content even when the caller skipped validation", async () => {
    await expect(
      buildRfc822({ bodyStructure: { type: "text/plain", partId: "1" }, bodyValues: { "1": { value: { path: "/etc/hostname" } as never } } }, "x"),
    ).rejects.toThrow(InvalidEmailCreateError);
    await expect(
      buildRfc822({ subject: { prepared: true, value: "a\r\nBcc: x@y" } as never, textBody: [{ partId: "1" }], bodyValues: { "1": { value: "b" } } }, "x"),
    ).rejects.toThrow(InvalidEmailCreateError);
  });

  it("still builds an ordinary message", async () => {
    const raw = (await buildRfc822({
      from: [{ name: "Me", email: "me@x" }],
      subject: "Hi",
      textBody: [{ partId: "1" }],
      htmlBody: [{ partId: "2" }],
      bodyValues: { "1": { value: "plain" }, "2": { value: "<b>html</b>" } },
    }, "x")).toString();
    expect(raw).toContain("Subject: Hi");
    expect(raw).toContain("plain");
    expect(raw).toContain("<b>html</b>");
  });
});
