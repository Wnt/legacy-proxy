import { describe, expect, it } from "vitest";
import { selectBodies, structureToBodyParts } from "../../src/mapping/structure.js";

describe("body part selection (RFC 8621 §4.1.4)", () => {
  it("picks alternative parts and orders them", () => {
    const parsed = structureToBodyParts(
      {
        type: "multipart/alternative",
        part: "1",
        childNodes: [
          { type: "text/plain", part: "1.1", size: 10 },
          { type: "text/html", part: "1.2", size: 20 },
        ],
      } as never,
      (p) => (p ? `blob:${p}` : "blob:root"),
    );
    const sel = selectBodies(parsed);
    expect(sel.textBody.map((p) => p.partId)).toEqual(["1.1"]);
    expect(sel.htmlBody.map((p) => p.partId)).toEqual(["1.2"]);
    expect(sel.attachments).toEqual([]);
    expect(sel.hasAttachment).toBe(false);
  });

  it("treats non-text leaves as attachments", () => {
    const parsed = structureToBodyParts(
      {
        type: "multipart/mixed",
        part: "1",
        childNodes: [
          { type: "text/plain", part: "1.1", size: 10 },
          {
            type: "application/pdf",
            part: "1.2",
            size: 999,
            disposition: "attachment",
            dispositionParameters: { filename: "x.pdf" },
          },
        ],
      } as never,
      (p) => (p ? `blob:${p}` : "blob:root"),
    );
    const sel = selectBodies(parsed);
    expect(sel.attachments.length).toBe(1);
    expect(sel.attachments[0]!.name).toBe("x.pdf");
    expect(sel.hasAttachment).toBe(true);
  });

  const sel = (tree: unknown) => {
    const r = selectBodies(structureToBodyParts(tree as never, (p) => (p ? `blob:${p}` : "blob:root")));
    return {
      text: r.textBody.map((p) => `${p.partId}:${p.type}`),
      html: r.htmlBody.map((p) => `${p.partId}:${p.type}`),
      att: r.attachments.map((p) => p.partId),
    };
  };

  it("puts a single-part HTML message in textBody and htmlBody", () => {
    expect(sel({ type: "text/html", size: 10 })).toEqual({ text: ["1:text/html"], html: ["1:text/html"], att: [] });
  });

  it("puts a single-part plain-text message in textBody and htmlBody", () => {
    expect(sel({ type: "text/plain", size: 10 })).toEqual({ text: ["1:text/plain"], html: ["1:text/plain"], att: [] });
  });

  it("uses the HTML of an alternative that has no plain-text version for textBody too", () => {
    expect(sel({ type: "multipart/alternative", childNodes: [{ type: "text/html", part: "1", size: 10 }] })).toEqual({
      text: ["1:text/html"],
      html: ["1:text/html"],
      att: [],
    });
  });

  it("uses the HTML body of mixed{html, pdf} for textBody too", () => {
    expect(
      sel({
        type: "multipart/mixed",
        childNodes: [
          { type: "text/html", part: "1", size: 10 },
          { type: "application/pdf", part: "2", size: 99, disposition: "attachment" },
        ],
      }),
    ).toEqual({ text: ["1:text/html"], html: ["1:text/html"], att: ["2"] });
  });

  it("keeps the plain and HTML branches apart in alternative{plain, related{html, image}}", () => {
    expect(
      sel({
        type: "multipart/alternative",
        childNodes: [
          { type: "text/plain", part: "1", size: 10 },
          {
            type: "multipart/related",
            part: "2",
            childNodes: [
              { type: "text/html", part: "2.1", size: 10 },
              { type: "image/png", part: "2.2", size: 10 },
            ],
          },
        ],
      }),
    ).toEqual({ text: ["1:text/plain"], html: ["2.1:text/html"], att: ["2.2"] });
  });

  it("keeps mixed{related{alternative{plain, html}, image}} as before", () => {
    expect(
      sel({
        type: "multipart/mixed",
        childNodes: [
          {
            type: "multipart/related",
            part: "1",
            childNodes: [
              {
                type: "multipart/alternative",
                part: "1.1",
                childNodes: [
                  { type: "text/plain", part: "1.1.1", size: 10 },
                  { type: "text/html", part: "1.1.2", size: 10 },
                ],
              },
              { type: "image/png", part: "1.2", size: 10 },
            ],
          },
        ],
      }),
    ).toEqual({ text: ["1.1.1:text/plain"], html: ["1.1.2:text/html"], att: ["1.2"] });
  });

  it("does not let a calendar part stand in for the missing plain-text version", () => {
    expect(
      sel({
        type: "multipart/alternative",
        childNodes: [
          { type: "text/html", part: "1", size: 10 },
          { type: "text/calendar", part: "2", size: 10 },
        ],
      }),
    ).toEqual({ text: ["2:text/calendar", "1:text/html"], html: ["1:text/html", "2:text/calendar"], att: [] });
  });
});
