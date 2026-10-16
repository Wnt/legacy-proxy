// Body values are fetched as partial parts sized from the requested limit and
// the part's transfer encoding, and an Email/get call has an overall byte
// budget. Mocked IMAP; counts the bytes a server would send.

import { describe, expect, it } from "vitest";
import { encodedCeiling, fetchEmailsBatch, MAX_BODY_FETCH_BYTES, MAX_BODY_VALUE_BYTES } from "../../src/imap/fetcher.js";

function server(parts: Record<string, { encoding: string; raw: Buffer }>, uids = [7]) {
  const wire = { bytes: 0 };
  const childNodes = Object.entries(parts).map(([part, p]) => ({
    part, type: "text/plain", encoding: p.encoding, size: p.raw.length,
  }));
  const client = {
    async *fetch(range: string, query: any) {
      const wanted = String(range).split(",").flatMap((r) => {
        const [a, b] = r.split(":").map(Number);
        return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i);
      });
      for (const uid of uids.filter((u) => wanted.includes(u))) {
        if (query.bodyStructure) {
          yield { uid, flags: new Set(), size: 1, internalDate: new Date(0), envelope: { subject: "s" },
            bodyStructure: childNodes.length === 1 ? childNodes[0] : { type: "multipart/mixed", childNodes } };
        } else if (query.headers || query.bodyParts?.[0]?.key === "HEADER") {
          yield { uid, headers: Buffer.from("Message-ID: <m@x>\r\n\r\n") };
        } else if (query.bodyParts) {
          const values = new Map<string, Buffer>();
          for (const bp of query.bodyParts) {
            expect(typeof bp).toBe("object");
            expect(bp.maxLength).toBeGreaterThan(0);
            const b = parts[bp.key]!.raw.subarray(bp.start ?? 0, (bp.start ?? 0) + bp.maxLength);
            wire.bytes += b.length;
            values.set(bp.key, b);
          }
          yield { uid, bodyParts: values };
        }
      }
    },
  };
  return { client: client as never, wire };
}

const get = (client: never, opts: object, uids = [7]) =>
  fetchEmailsBatch(client, { id: 1 } as never, { id: 2, uidvalidity: 1 } as never, uids,
    { fetchTextBodyValues: true, wantsPreview: false, ...opts });

describe("body values", () => {
  const text = "é".repeat(300_000); // 600 KB of UTF-8
  const encodings = {
    "7bit": Buffer.from(text),
    base64: Buffer.from(Buffer.from(text).toString("base64").replace(/.{76}/g, "$&\r\n")),
    "quoted-printable": Buffer.from(Buffer.from(text).toString("hex").replace(/(..)/g, "=$1").replace(/.{75}/g, "$&=\r\n")),
  };

  it.each(Object.entries(encodings))("%s: transfers about the requested limit, returns it, flags truncation", async (encoding, raw) => {
    const { client, wire } = server({ "1": { encoding, raw } });
    const v = (await get(client, { maxBodyValueBytes: 10_000 })).get(7)!.bodyValues["1"]!;
    expect(v.isTruncated).toBe(true);
    expect(Buffer.byteLength(v.value)).toBeGreaterThanOrEqual(9_990);
    expect(Buffer.byteLength(v.value)).toBeLessThanOrEqual(10_000);
    expect(wire.bytes).toBeLessThanOrEqual(encodedCeiling(10_000, encoding));
    expect(wire.bytes).toBeLessThan(raw.length / 10);
  });

  it.each(Object.entries(encodings))("%s: a part within the limit is complete and not truncated", async (encoding, raw) => {
    const { client } = server({ "1": { encoding, raw } });
    const v = (await get(client, { maxBodyValueBytes: 1_000_000 })).get(7)!.bodyValues["1"]!;
    expect(v.isTruncated).toBe(false);
    expect(v.value).toBe(text);
  });

  it("clamps a client's huge or unlimited (0) maxBodyValueBytes", async () => {
    const big = Buffer.alloc(MAX_BODY_VALUE_BYTES * 2, 97);
    for (const maxBodyValueBytes of [0, 1e12]) {
      const { client, wire } = server({ "1": { encoding: "7bit", raw: big } });
      const v = (await get(client, { maxBodyValueBytes })).get(7)!.bodyValues["1"]!;
      expect(v.isTruncated).toBe(true);
      expect(v.value.length).toBe(MAX_BODY_VALUE_BYTES);
      expect(wire.bytes).toBeLessThanOrEqual(MAX_BODY_VALUE_BYTES + 64);
    }
  });

  it("stops fetching once a call's byte budget is spent", async () => {
    const raw = Buffer.alloc(MAX_BODY_VALUE_BYTES, 97);
    const uids = Array.from({ length: 20 }, (_, i) => i + 1);
    const { client, wire } = server({ "1": { encoding: "7bit", raw } }, uids);
    const got = await get(client, { maxBodyValueBytes: MAX_BODY_VALUE_BYTES }, uids);
    expect(wire.bytes).toBeLessThanOrEqual(MAX_BODY_FETCH_BYTES);
    const values = uids.map((u) => got.get(u)!.bodyValues["1"]!);
    expect(values.filter((v) => v.value.length > 0).length).toBeGreaterThan(0);
    // The rest are answered, empty and marked truncated, not dropped.
    expect(values.every((v) => v.value.length > 0 || v.isTruncated)).toBe(true);
  });
});

describe("one body budget per request", () => {
  it("spans mailbox groups and Email/get calls that share RequestBudgets", async () => {
    const { emailGet } = await import("../../src/jmap/methods/email.js");
    const { encodeEmailId } = await import("../../src/mapping/ids.js");
    const { newRequestBudgets } = await import("../../src/imap/fetcher.js");
    const raw = Buffer.alloc(MAX_BODY_VALUE_BYTES, 97);
    let wire = 0;
    const client = {
      mailbox: { uidValidity: 1n, exists: 20 },
      getMailboxLock: async () => ({ release() {} }),
      async *fetch(range: string, query: any) {
        const uids = String(range).split(",").flatMap((r) => { const [a, b] = r.split(":").map(Number); return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i); });
        for (const uid of uids) {
          if (query.bodyStructure) yield { uid, flags: new Set(), size: raw.length, internalDate: new Date(0), envelope: { subject: "s" },
            bodyStructure: { part: "1", type: "text/plain", encoding: "7bit", size: raw.length } };
          else if (query.headers || query.bodyParts?.[0]?.key === "HEADER") yield { uid, headers: Buffer.from("Message-ID: <m@x>\r\n\r\n") };
          else if (query.bodyParts) {
            const b = raw.subarray(0, query.bodyParts[0].maxLength);
            wire += b.length;
            yield { uid, bodyParts: new Map([["1", b]]) };
          }
        }
      },
    };
    const store = {
      getState: () => 1,
      prep: () => ({ get: (id: number) => ({ id, name: `box${id}`, uidvalidity: 1 }) }),
      getEmailCacheRows: () => new Map(), getEmailCacheRowsLean: () => new Map(), upsertEmailCacheRows: () => {}, setEmailCachePreview: () => {},
    };
    const ids = (box: number) => Array.from({ length: 5 }, (_, i) => encodeEmailId({ accountIdx: 1, mailboxIdx: box, uidvalidity: 1, uid: i + 1 }));
    const budgets = newRequestBudgets();
    const ctx = { account: { id: 1 }, client, store, budgets } as never;
    const args = { accountId: "1", properties: ["id", "bodyValues"], fetchTextBodyValues: true, maxBodyValueBytes: MAX_BODY_VALUE_BYTES };
    // Two mailboxes in one call, then a second call of the same request.
    await emailGet({ ...args, ids: [...ids(2), ...ids(3)] }, ctx);
    await emailGet({ ...args, ids: [...ids(4), ...ids(5)] }, ctx);
    expect(wire).toBeLessThanOrEqual(MAX_BODY_FETCH_BYTES);
    expect(wire).toBeGreaterThan(0);
  });
});

describe("response budget (review round 2)", () => {
  function ctxWith(n: number, refsChars: number, budgets: object) {
    const refs = Array.from({ length: Math.ceil(refsChars / 20) }, (_, i) => `<r${i}@example.test>`).join(" ");
    const client = {
      mailbox: { uidValidity: 1n, exists: n },
      getMailboxLock: async () => ({ release() {} }),
      async *fetch(range: string, query: any) {
        const uids = String(range).split(",").flatMap((r) => { const [a, b] = r.split(":").map(Number); return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i); });
        for (const uid of uids) {
          if (query.bodyStructure) yield { uid, flags: new Set(), size: 100, internalDate: new Date(0),
            envelope: { subject: "s".repeat(100_000), from: [{ name: "n", address: "a@x" }] },
            bodyStructure: { part: "1", type: "text/plain", encoding: "7bit", size: 1 } };
          else if (query.headers) yield { uid, headers: Buffer.from(`References: ${refs}\r\n\r\n`) };
        }
      },
    };
    const store = { getState: () => 1, prep: () => ({ get: (id: number) => ({ id, name: "INBOX", uidvalidity: 1 }) }),
      getEmailCacheRows: () => new Map(), getEmailCacheRowsLean: () => new Map(), upsertEmailCacheRows: () => {} };
    return { account: { id: 1 }, client, store, budgets, maxObjectsInGet: 500 } as never;
  }

  it("charges ordinary properties and refuses once a request's responses are too large", async () => {
    const { emailGet } = await import("../../src/jmap/methods/email.js");
    const { encodeEmailId } = await import("../../src/mapping/ids.js");
    const { newRequestBudgets, MAX_RESPONSE_CHARS } = await import("../../src/imap/fetcher.js");
    const budgets = newRequestBudgets();
    const ids = Array.from({ length: 500 }, (_, i) => encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 1, uid: i + 1 }));
    let emitted = 0;
    let refused = false;
    for (let call = 0; call < 64 && !refused; call++) {
      try {
        const res = await emailGet({ accountId: "1", ids, properties: ["id", "references", "subject"] }, ctxWith(500, 16_000, budgets));
        emitted += JSON.stringify(res.list).length;
      } catch (e) {
        expect((e as { type: string }).type).toBe("requestTooLarge");
        refused = true;
      }
    }
    expect(refused).toBe(true);
    expect(emitted).toBeLessThanOrEqual(MAX_RESPONSE_CHARS * 1.1);
  });

  it("bounds a sender's ENVELOPE (subject) when loading it", async () => {
    const { emailGet } = await import("../../src/jmap/methods/email.js");
    const { encodeEmailId } = await import("../../src/mapping/ids.js");
    const { newRequestBudgets } = await import("../../src/imap/fetcher.js");
    const id = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 1, uid: 1 });
    const res = await emailGet({ accountId: "1", ids: [id], properties: ["id", "subject"] }, ctxWith(1, 100, newRequestBudgets()));
    expect((res.list[0]!.subject as string).length).toBe(16 * 1024);
  });
});
