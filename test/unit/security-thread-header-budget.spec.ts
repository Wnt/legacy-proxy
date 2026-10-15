import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { fetchEmailsBatch } from "../../src/imap/fetcher.js";

it("bounds CPU while indexing a modest malformed References header", async () => {
  // Small local fixture, not a large mailbox or a live IMAP connection.
  // Fold to ordinary-sized lines, as a sender can do with a long header.
  const references = Array.from({ length: 16 }, () => "<".repeat(750)).join("\r\n ");
  const client = {
    async *fetch() {
      yield {
        uid: 7, flags: new Set(), size: references.length,
        internalDate: new Date("2026-01-01T00:00:00Z"),
        envelope: { messageId: "<fallback@example.test>" },
        bodyStructure: { part: "1", type: "text/plain", encoding: "7bit", size: 0 },
        headers: Buffer.from(`References: ${references}\r\n\r\n`),
      };
    },
  };
  const start = performance.now();
  const emails = await fetchEmailsBatch(client as never, { id: 1 } as never,
    { id: 2, uidvalidity: 1 } as never, [7], { wantsPreview: false });
  expect(performance.now() - start).toBeLessThan(250);
  expect(emails.get(7)?.references).toBeNull();
}, 15000);
