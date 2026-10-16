// A draft's MIME is built from blobs and body values held in memory; their
// total, counting every occurrence, is bounded before anything is loaded.

import { describe, expect, it, vi } from "vitest";
import { emailSet, MAX_COMPOSE_CONTENT_BYTES } from "../../src/jmap/methods/email.js";
import { encodeMailboxId } from "../../src/mapping/ids.js";

const MB = encodeMailboxId({ accountIdx: 1, mailboxIdx: 2 });
const MiB24 = 24 * 1024 * 1024;

function setup(sizes: Record<string, number>) {
  const loaded: string[] = [];
  const client = { append: vi.fn(async () => ({ uid: 7, uidValidity: 1n })) };
  const store = {
    getState: () => 1,
    prep: () => ({ get: () => ({ id: 2, name: "Drafts", uidvalidity: 1 }) }),
    recordChanges: vi.fn(), bumpState: vi.fn(),
    getUploadSize: (id: string) => sizes[id] ?? null,
    getUpload: (id: string) => {
      loaded.push(id);
      return { ctype: "application/octet-stream", body: Buffer.alloc(sizes[id]!, 1) };
    },
    getCachedBlobSize: () => null, getCachedBlob: () => null,
  };
  return { ctx: { account: { id: 1, host: "x" }, client, store } as never, client, loaded };
}

const draft = (attachments: object[], extra: object = {}) => ({
  mailboxIds: { [MB]: true },
  bodyValues: { "1": { value: "hi" } },
  textBody: [{ partId: "1" }],
  attachments,
  ...extra,
});

describe("compose content budget", () => {
  it("refuses several blobs that are each allowed but too large together, before building", async () => {
    const { ctx, client, loaded } = setup({ Ua: MiB24, Ub: MiB24, Uc: MiB24 });
    const res = await emailSet({ accountId: "1", create: { d: draft(["Ua", "Ub", "Uc"].map((blobId) => ({ blobId, type: "application/pdf" }))) } }, ctx);
    expect(res.notCreated?.d?.type).toBe("tooLarge");
    expect(client.append).not.toHaveBeenCalled();
    // The second already would not fit: refused from its stored size,
    // without loading it (nor the third).
    expect(loaded).toEqual(["Ua"]);
  });

  it("counts every reference to one blob", async () => {
    const { ctx, client, loaded } = setup({ Ua: MiB24 });
    const res = await emailSet({ accountId: "1", create: { d: draft([1, 2, 3].map(() => ({ blobId: "Ua", type: "application/pdf" }))) } }, ctx);
    expect(res.notCreated?.d?.type).toBe("tooLarge");
    expect(loaded).toEqual([]);
    expect(client.append).not.toHaveBeenCalled();
  });

  it("counts every use of a body value", async () => {
    const { ctx } = setup({});
    const big = "x".repeat(Math.ceil(MAX_COMPOSE_CONTENT_BYTES / 3));
    const res = await emailSet({ accountId: "1", create: { d: {
      mailboxIds: { [MB]: true },
      bodyValues: { "1": { value: big } },
      bodyStructure: { type: "multipart/mixed", subParts: [1, 2, 3, 4].map(() => ({ partId: "1", type: "text/plain" })) },
    } } }, ctx);
    expect(res.notCreated?.d?.type).toBe("tooLarge");
  });

  it("still sends an ordinary draft with an attachment", async () => {
    const { ctx, client } = setup({ Ua: 1024 });
    const res = await emailSet({ accountId: "1", create: { d: draft([{ blobId: "Ua", type: "application/pdf", name: "a.pdf" }]) } }, ctx);
    expect(res.created?.d).toBeTruthy();
    expect(client.append).toHaveBeenCalledOnce();
  });
});

describe("compose plan matches the MIME builder (review round 2)", () => {
  it("counts attachment occurrences whose partId also names a body value", async () => {
    const MiB = 1024 * 1024;
    const { ctx, client } = setup({ Ua: MiB });
    const attachments = Array.from({ length: 64 }, () => ({ blobId: "Ua", partId: "1", type: "application/pdf" }));
    const res = await emailSet({ accountId: "1", create: { d: draft(attachments, { bodyValues: { "1": { value: "hi" } } }) } }, ctx);
    expect(res.notCreated?.d?.type).toBe("tooLarge");
    expect(client.append).not.toHaveBeenCalled();
  });

  it("still loads a blob referenced only by such an attachment", async () => {
    const { ctx, client } = setup({ Ua: 1024 });
    const res = await emailSet({ accountId: "1", create: { d: draft([{ blobId: "Ua", partId: "1", type: "application/pdf" }]) } }, ctx);
    expect(res.created?.d).toBeTruthy();
    expect(client.append).toHaveBeenCalledOnce();
  });

  it("rejects children on a non-multipart part", async () => {
    const { ctx } = setup({});
    const res = await emailSet({ accountId: "1", create: { d: {
      mailboxIds: { [MB]: true },
      bodyValues: { "1": { value: "x" } },
      bodyStructure: { type: "multipart/mixed", subParts: [{ type: "text/plain", partId: "1", subParts: [{ partId: "1" }] }] },
    } } }, ctx);
    expect(res.notCreated?.d?.type).toBe("invalidProperties");
  });

  it("stops building once the encoded message passes its limit", async () => {
    const { buildRfc822, MessageTooLargeError } = await import("../../src/mapping/buildMime.js");
    await expect(buildRfc822({ textBody: [{ partId: "1" }], bodyValues: { "1": { value: "y".repeat(100_000) } } }, "x", () => null, false, 10_000))
      .rejects.toBeInstanceOf(MessageTooLargeError);
    const ok = await buildRfc822({ textBody: [{ partId: "1" }], bodyValues: { "1": { value: "small" } } }, "x");
    expect(ok.toString()).toContain("small");
  });
});

describe("encoded size preflight (review round 3)", () => {
  it("refuses text whose worst-case encoding is too large before any encoder runs", async () => {
    const MimeNode = (await import("nodemailer/lib/mime-node/index.js")).default;
    const entered = vi.spyOn(MimeNode.prototype, "createReadStream");
    const { ctx, client } = setup({});
    const value = "=a".repeat(200_000); // 400,000 bytes, ~3x in quoted-printable
    const res = await emailSet({ accountId: "1", create: { d: {
      mailboxIds: { [MB]: true },
      bodyValues: { "1": { value } },
      textBody: Array.from({ length: 124 }, () => ({ partId: "1" })),
    } } }, ctx);
    expect(res.notCreated?.d?.type).toBe("tooLarge");
    expect(client.append).not.toHaveBeenCalled();
    expect(entered).not.toHaveBeenCalled();
    entered.mockRestore();
  });

  it("encodes blobs as base64, the encoding the preflight assumes, even text/* ones", async () => {
    const { buildRfc822 } = await import("../../src/mapping/buildMime.js");
    const blob = Buffer.from("=a".repeat(50_000));
    const raw = (await buildRfc822({ textBody: [{ partId: "1" }], bodyValues: { "1": { value: "hi" } },
      attachments: [{ blobId: "B", type: "text/plain", name: "t.txt" }] }, "x", () => ({ body: blob, ctype: "text/plain" }))).toString();
    expect(raw).toMatch(/Content-Transfer-Encoding: base64/i);
    expect(raw).not.toMatch(/quoted-printable/i);
    expect(raw.length).toBeLessThan(blob.length * 1.5);
  });
});
