import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { emailParse } from "../../src/jmap/methods/email.js";

it("parses a modest malformed address header within a bounded CPU budget", async () => {
  // Bounded fixture for GHSA-v53p-9fqp-m79j. No transport or large allocation.
  const body = Buffer.from(`From: ${"[x]".repeat(5000)}\r\nSubject: test\r\n\r\nbody`);
  const warm = Buffer.from("From: Someone <a@example.test>\r\nSubject: warm-up\r\n\r\nbody");
  const store = { getUpload: (id: string) => ({ body: id === "Uwarm" ? warm : body, ctype: "message/rfc822" }) };
  // Warm the dynamic module import and the parser's first-run code paths
  // separately from the measured parser work: one ordinary parse.
  await emailParse({ accountId: "1", blobIds: ["Uwarm"] }, { account: { id: 1 }, store } as never);
  const start = performance.now();
  await emailParse({ accountId: "1", blobIds: ["Ufixture"] }, { account: { id: 1 }, store } as never);
  expect(performance.now() - start).toBeLessThan(250);
}, 15000);
