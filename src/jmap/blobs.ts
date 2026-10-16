// Read a blob's bytes for building a message: uploads from SQLite, mail parts
// from the blob cache or else an IMAP fetch - the lookup the download route
// does, buffered instead of streamed.

import type { ImapFlow } from "imapflow";
import { Buffer } from "node:buffer";
import { selectedUidValidity, withMailbox } from "../imap/client.js";
import type { ImapPool } from "../imap/pool.js";
import { decodeBlobId, decodeEmailId } from "../mapping/ids.js";
import type { AccountRow, Store } from "../state/store.js";

// Above the 50 MB attachment and upload limits, with room for a whole message
// forwarded as a blob; larger mail could not be sent through this proxy anyway.
export const MAX_BLOB_READ_BYTES = 64 * 1024 * 1024;

export class BlobTooLargeError extends Error {
  constructor(readonly blobId: string) {
    super(`blob ${blobId} is too large for this message`);
  }
}

/**
 * A blob's bytes, or null if there is no such blob. Throws BlobTooLargeError
 * once it is known to exceed `maxBytes` (at most MAX_BLOB_READ_BYTES): from
 * the stored size for uploads and cached parts, before loading them, and while
 * streaming for parts read from IMAP.
 */
export async function readBlob(
  blobId: string,
  ctx: { account: AccountRow; store: Store; client: ImapFlow; pool?: ImapPool },
  maxBytes: number = MAX_BLOB_READ_BYTES,
): Promise<{ body: Buffer; ctype: string } | null> {
  const limit = Math.min(maxBytes, MAX_BLOB_READ_BYTES);
  if (blobId.startsWith("U")) {
    const size = ctx.store.getUploadSize(blobId, ctx.account.id);
    if (size === null) return null;
    if (size > limit) throw new BlobTooLargeError(blobId);
    return ctx.store.getUpload(blobId, ctx.account.id);
  }
  const cachedSize = ctx.store.getCachedBlobSize(blobId, ctx.account.id);
  if (cachedSize !== null && cachedSize > limit) throw new BlobTooLargeError(blobId);
  const cached = cachedSize === null ? null : ctx.store.getCachedBlob(blobId, ctx.account.id);
  if (cached) return { body: cached.body, ctype: cached.ctype ?? "application/octet-stream" };

  let part: { emailId: string; partId: string | null };
  let email: { accountIdx: number; mailboxIdx: number; uidvalidity: number; uid: number };
  try {
    part = decodeBlobId(blobId);
    email = decodeEmailId(part.emailId);
  } catch {
    return null;
  }
  if (email.accountIdx !== ctx.account.id) return null;
  const mbox = ctx.store
    .prep(`SELECT id,name FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(email.mailboxIdx, ctx.account.id) as { id: number; name: string } | undefined;
  if (!mbox) return null;

  const fetch = (client: ImapFlow) =>
    withMailbox(client, mbox.name, async () => {
      // A blob id from another UIDVALIDITY epoch names a message that is gone.
      if (selectedUidValidity(client) !== email.uidvalidity) return null;
      const dl = await client.download(`${email.uid}`, part.partId ?? undefined, { uid: true });
      // imapflow answers `{}` rather than null for an expunged message or part.
      if (!dl?.content) return null;
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of dl.content) {
          total += (chunk as Buffer).length;
          // Everything read here is held in memory (and then MIME-encoded
          // again), so cap it; mail this large cannot be sent anyway.
          if (total > limit) throw new BlobTooLargeError(blobId);
          chunks.push(chunk as Buffer);
        }
      } catch (e) {
        // A FETCH that broke off mid-literal leaves the connection
        // unparseable, so drop it rather than pool it.
        client.close();
        throw e;
      }
      return {
        body: Buffer.concat(chunks),
        ctype: part.partId ? dl.meta?.contentType ?? "application/octet-stream" : "message/rfc822",
      };
    });
  // Like the download route, fetch on the bulk connection so a large
  // forwarded attachment doesn't hold up the account's interactive calls.
  return ctx.pool ? ctx.pool.withConnection(ctx.account, "bulk", fetch) : fetch(ctx.client);
}
