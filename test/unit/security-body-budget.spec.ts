import { expect, it } from "vitest";
import { fetchEmailsBatch } from "../../src/imap/fetcher.js";

it("bounds IMAP body transfer before buffering, not just the returned body value", async () => {
  const body = Buffer.alloc(1024 * 1024, 65);
  let transferred = 0;
  const client = {
    async *fetch(_range: string, query: any) {
      if (query.bodyStructure) {
        yield {
          uid: 7, flags: new Set(), size: body.length,
          internalDate: new Date("2026-01-01T00:00:00Z"),
          envelope: { subject: "Large text part" },
          bodyStructure: { part: "1", type: "text/plain", encoding: "7bit", size: body.length },
          headers: Buffer.from("Message-ID: <budget@example.test>\r\n\r\n"),
        };
      } else if (query.bodyParts?.[0]?.key === "HEADER") {
        // The bounded header fetch for a message this large (not a body part).
        yield { uid: 7, headers: Buffer.from("Message-ID: <budget@example.test>\r\n\r\n") };
      } else if (query.bodyParts) {
        const values = new Map<string, Buffer>();
        for (const part of query.bodyParts) {
          const key = typeof part === "string" ? part : part.key;
          const start = typeof part === "string" ? 0 : part.start ?? 0;
          const length = typeof part === "string" ? body.length : part.maxLength ?? body.length;
          const bytes = body.subarray(start, start + length);
          transferred += bytes.length;
          values.set(key, bytes);
        }
        yield { uid: 7, bodyParts: values };
      }
    },
  };
  const result = await fetchEmailsBatch(client as never, { id: 1 } as never,
    { id: 2, uidvalidity: 1 } as never, [7],
    { fetchTextBodyValues: true, wantsPreview: false, maxBodyValueBytes: 1024 });
  expect(result.get(7)?.bodyValues["1"]?.value).toHaveLength(1024);
  expect(result.get(7)?.bodyValues["1"]?.isTruncated).toBe(true);
  // Allow transfer-encoding overhead and a truncation sentinel; a 1 MiB
  // 7bit part must not be fully downloaded for a 1 KiB projection.
  expect(transferred).toBeLessThanOrEqual(8192);
});
