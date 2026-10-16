// Build an RFC 5322 / MIME message from a JMAP Email/set create payload.
// Used by Email/set create (drafts) which APPENDs the result via IMAP.
//
// We use nodemailer's MimeNode (already a transitive dep) to handle
// quoted-printable encoding, header folding, and message id generation.

import MimeNode from "nodemailer/lib/mime-node/index.js";
import { validateEmailCreate } from "./emailCreate.js";

// Every node is built with file and URL sources disabled. setContent() also
// accepts `{ path }` (read a local file) and `{ href }` (fetch a URL), and a
// node does not inherit these options from its parent, so set them on each.
function mimeNode(contentType: string, hostname: string): MimeNode {
  return new MimeNode(contentType, { hostname, disableFileAccess: true, disableUrlAccess: true });
}

// Content is only ever text or bytes; anything else is refused rather than
// handed to MimeNode, which would interpret it.
function setContent(node: MimeNode, content: unknown): void {
  if (typeof content !== "string" && !Buffer.isBuffer(content)) {
    throw new TypeError("MIME part content must be a string or Buffer");
  }
  node.setContent(content);
}

interface JmapAddress {
  name?: string | null;
  email?: string;
}

interface BodyPartRef {
  partId?: string;
}

interface BodyValue {
  value?: string;
}

// JMAP `bodyStructure` (RFC 8621 §4.1.4): a recursive tree describing the
// MIME hierarchy. Leaves carry either a partId (resolved through bodyValues)
// or a blobId (an upload, or a part of existing mail such as a forwarded
// attachment).
export interface BodyStructurePart {
  type?: string;
  partId?: string;
  blobId?: string;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
  charset?: string | null;
  subParts?: BodyStructurePart[];
}

export interface JmapEmailCreate {
  bodyStructure?: BodyStructurePart | null;
  from?: JmapAddress[] | null;
  sender?: JmapAddress[] | null;
  to?: JmapAddress[] | null;
  cc?: JmapAddress[] | null;
  bcc?: JmapAddress[] | null;
  replyTo?: JmapAddress[] | null;
  subject?: string | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  messageId?: string[] | null;
  sentAt?: string | null;
  textBody?: BodyPartRef[] | null;
  htmlBody?: BodyPartRef[] | null;
  // RFC 8621 §4.6: with textBody / htmlBody, attachments (inline images with
  // a cid, and files) are listed here instead of in a bodyStructure.
  attachments?: BodyStructurePart[] | null;
  bodyValues?: Record<string, BodyValue> | null;
  // Headers passed through verbatim (asRaw form). We don't attempt to
  // re-parse these; clients that send us structured forms should map them
  // before submission.
  headers?: { name: string; value: string }[] | null;
}

function jmapAddrToHeader(list: JmapAddress[] | null | undefined): string | null {
  if (!list || list.length === 0) return null;
  return list
    .filter((a) => a.email)
    .map((a) => {
      const name = a.name?.trim();
      const email = a.email!;
      if (!name) return email;
      // Quote names that contain RFC 5322 specials
      const escaped = /[",;:<>@()\[\]\\]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
      return `${escaped} <${email}>`;
    })
    .join(", ");
}

// Walk a bodyStructure tree into a nodemailer MimeNode. Multipart parts
// (type starting with "multipart/") get child nodes; leaves are filled from
// either bodyValues[partId] (text/* parts) or getBlob(blobId) (attachments).
function nodeFromBodyStructure(
  part: BodyStructurePart,
  bodyValues: Record<string, BodyValue> | null,
  getBlob: BlobLookup,
  hostname: string,
): MimeNode {
  const type = part.type ?? "text/plain";
  if (type.toLowerCase().startsWith("multipart/")) {
    const node = mimeNode(type, hostname);
    for (const child of part.subParts ?? []) {
      node.appendChild(nodeFromBodyStructure(child, bodyValues, getBlob, hostname));
    }
    return node;
  }
  // Leaf part: either text content via bodyValues, or a blob attachment.
  const headers: Record<string, string> = {};
  if (part.disposition || part.name) {
    const disp = part.disposition ?? "inline";
    const filename = part.name ? `; filename="${part.name.replace(/"/g, "")}"` : "";
    headers["Content-Disposition"] = `${disp}${filename}`;
  }
  if (part.cid) headers["Content-ID"] = `<${part.cid}>`;
  let contentType = type;
  if (type.toLowerCase().startsWith("text/")) {
    contentType = `${type}; charset=${part.charset ?? "utf-8"}`;
  }
  const node = mimeNode(contentType, hostname);
  for (const [k, v] of Object.entries(headers)) node.setHeader(k, v);

  if (part.partId && bodyValues?.[part.partId]?.value !== undefined) {
    setContent(node, bodyValues[part.partId]!.value);
  } else if (part.blobId) {
    const blob = getBlob(part.blobId);
    // An empty part would go out as a blank file or a broken inline image;
    // refuse the message instead.
    if (!blob) throw new MissingBlobError(part.blobId);
    // Always base64: it is the encoding the caller's size preflight assumes,
    // and nodemailer would otherwise pick quoted-printable for a text/* blob,
    // which can triple it.
    node.setHeader("Content-Transfer-Encoding", "base64");
    setContent(node, blob.body);
  }
  return node;
}

export class MissingBlobError extends Error {
  constructor(readonly blobId: string) {
    super(`blob ${blobId} not found`);
  }
}

function resolveBody(
  refs: BodyPartRef[] | null | undefined,
  values: Record<string, BodyValue> | null | undefined,
): string | null {
  if (!refs || refs.length === 0 || !values) return null;
  const chunks: string[] = [];
  for (const r of refs) {
    if (!r.partId) continue;
    const v = values[r.partId]?.value;
    if (typeof v === "string") chunks.push(v);
  }
  if (chunks.length === 0) return null;
  return chunks.join("\r\n");
}

// RFC 8621 §4.6: inline parts with a cid sit next to the HTML they are
// referenced from in a multipart/related; everything else, and inline parts
// without HTML to show them, goes into a multipart/mixed around that.
function wrapAttachments(
  body: MimeNode,
  attachments: BodyStructurePart[],
  hasHtml: boolean,
  getBlob: BlobLookup,
  hostname: string,
): MimeNode {
  const related = hasHtml ? attachments.filter((a) => a.cid && a.disposition === "inline") : [];
  const mixed = attachments.filter((a) => !related.includes(a));
  let root = body;
  for (const [type, parts] of [["multipart/related", related], ["multipart/mixed", mixed]] as const) {
    if (!parts.length) continue;
    const wrapper = mimeNode(type, hostname);
    wrapper.appendChild(root);
    for (const p of parts) {
      wrapper.appendChild(nodeFromBodyStructure({ ...p, disposition: p.disposition ?? "attachment" }, null, getBlob, hostname));
    }
    root = wrapper;
  }
  return root;
}

/**
 * What buildRfc822 will put into the message, counted the way it builds it:
 * how many times each blob is encoded, and the bytes of body text. It walks
 * the same decisions as nodeFromBodyStructure / resolveBody / wrapAttachments
 * (a multipart type recurses, a leaf takes its body value if it has one and
 * else its blob; attachments are built without body values), so callers can
 * bound a draft before loading anything. Keep the two in step.
 */
export function mimeContentPlan(create: JmapEmailCreate): { blobs: Map<string, number>; textBytes: number } {
  const blobs = new Map<string, number>();
  let textBytes = 0;
  const walk = (part: BodyStructurePart, values: Record<string, BodyValue> | null): void => {
    const type = part.type ?? "text/plain";
    if (type.toLowerCase().startsWith("multipart/")) {
      for (const child of part.subParts ?? []) walk(child, values);
      return;
    }
    const v = part.partId ? values?.[part.partId]?.value : undefined;
    if (v !== undefined) textBytes += typeof v === "string" ? Buffer.byteLength(v) : 0;
    else if (part.blobId) blobs.set(part.blobId, (blobs.get(part.blobId) ?? 0) + 1);
  };
  if (create.bodyStructure) {
    walk(create.bodyStructure, create.bodyValues ?? null);
  } else {
    for (const refs of [create.textBody, create.htmlBody]) {
      for (const r of refs ?? []) {
        const v = r.partId ? create.bodyValues?.[r.partId]?.value : undefined;
        if (typeof v === "string") textBytes += Buffer.byteLength(v) + 2;
      }
    }
    for (const a of create.attachments ?? []) walk(a, null);
  }
  return { blobs, textBytes };
}

// The most a built message may take: 50 MB of content, base64-encoded, plus
// headers and structure. Same as the submission limit.
export const MAX_MIME_BYTES = 80 * 1024 * 1024;

/** buildRfc822 stopped: the encoded message passed its byte limit. */
export class MessageTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`the message is larger than ${limit} bytes`);
  }
}

export interface BlobLookup {
  // Returns the bytes for a blobId, or null if missing. The lookup is
  // synchronous for buildRfc822's MimeNode walk; callers load the referenced
  // blobs up front (some need an IMAP fetch) and answer from those.
  (blobId: string): { body: Buffer; ctype: string } | null;
}

export async function buildRfc822(
  create: JmapEmailCreate,
  hostname: string,
  getBlob: BlobLookup = () => null,
  keepBcc = false,
  maxBytes: number = MAX_MIME_BYTES,
): Promise<Buffer> {
  // Callers validate first to answer with invalidProperties; this is the
  // backstop for any caller that didn't.
  validateEmailCreate(create);
  // Choose a root structure based on the inputs we got. Prefer `bodyStructure`
  // (RFC 8621 §4.5.1 form 1) when present — it's the canonical source of
  // truth and drives multipart/alternative + attachments. Otherwise fall back
  // to the simpler textBody/htmlBody form.
  let root: MimeNode;
  if (create.bodyStructure) {
    root = nodeFromBodyStructure(create.bodyStructure, create.bodyValues ?? null, getBlob, hostname);
  } else {
    const text = resolveBody(create.textBody, create.bodyValues);
    const html = resolveBody(create.htmlBody, create.bodyValues);
    if (text && html) {
      root = mimeNode("multipart/alternative", hostname);
      setContent(root.appendChild(mimeNode("text/plain; charset=utf-8", hostname)), text);
      setContent(root.appendChild(mimeNode("text/html; charset=utf-8", hostname)), html);
    } else if (html) {
      root = mimeNode("text/html; charset=utf-8", hostname);
      setContent(root, html);
    } else {
      root = mimeNode("text/plain; charset=utf-8", hostname);
      setContent(root, text ?? "");
    }
    root = wrapAttachments(root, create.attachments ?? [], html !== null, getBlob, hostname);
  }

  root.keepBcc = keepBcc;

  const setIfPresent = (header: string, value: string | null): void => {
    if (value) root.setHeader(header, value);
  };
  setIfPresent("From", jmapAddrToHeader(create.from));
  setIfPresent("Sender", jmapAddrToHeader(create.sender));
  setIfPresent("To", jmapAddrToHeader(create.to));
  setIfPresent("Cc", jmapAddrToHeader(create.cc));
  setIfPresent("Bcc", jmapAddrToHeader(create.bcc));
  setIfPresent("Reply-To", jmapAddrToHeader(create.replyTo));
  if (create.subject) root.setHeader("Subject", create.subject);

  const date = create.sentAt ? new Date(create.sentAt) : new Date();
  root.setHeader("Date", date.toUTCString().replace(/GMT/, "+0000"));

  if (create.messageId && create.messageId[0]) {
    root.setHeader("Message-ID", `<${create.messageId[0]}>`);
  }
  if (create.inReplyTo && create.inReplyTo.length) {
    root.setHeader("In-Reply-To", create.inReplyTo.map((id) => `<${id}>`).join(" "));
  }
  if (create.references && create.references.length) {
    root.setHeader("References", create.references.map((id) => `<${id}>`).join(" "));
  }

  // Verbatim headers (e.g. List-* additions). Skip headers we already set
  // so the explicit JMAP fields win.
  const reserved = new Set([
    "from",
    "sender",
    "to",
    "cc",
    "bcc",
    "reply-to",
    "subject",
    "date",
    "message-id",
    "in-reply-to",
    "references",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
  ]);
  for (const h of create.headers ?? []) {
    if (!h?.name) continue;
    if (reserved.has(h.name.toLowerCase())) continue;
    root.setHeader(h.name, h.value ?? "");
  }

  // MimeNode drops Bcc from the output by default. Keep it: the stored draft
  // is what EmailSubmission/set derives the envelope from when the client
  // sends none, and without the header Bcc recipients were silently never
  // sent to. Submission strips it again before handing the message to SMTP.
  root.keepBcc = true;

  // Stream the build so an oversized message stops as soon as it passes the
  // limit, instead of being completed in memory and measured afterwards.
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = root.createReadStream();
  try {
    for await (const chunk of stream) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) throw new MessageTooLargeError(maxBytes);
      chunks.push(chunk as Buffer);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}
