// Translate IMAP BODYSTRUCTURE (as parsed by imapflow) into the RFC 8621
// EmailBodyPart shape, and pick textBody/htmlBody/attachments per §4.1.4.

export interface EmailBodyPart {
  partId: string | null;
  blobId: string | null;
  size: number;
  headers: { name: string; value: string }[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  // Content-Transfer-Encoding ("quoted-printable", "base64", "7bit", ...)
  // - kept on the part for decoders that fetch raw bytes via BODY[partId].
  encoding: string | null;
  subParts: EmailBodyPart[] | null;
}

interface ImapflowPart {
  part?: string;
  type?: string;
  parameters?: Record<string, string>;
  id?: string | null;
  description?: string | null;
  encoding?: string | null;
  size?: number;
  disposition?: string | null;
  dispositionParameters?: Record<string, string> | null;
  language?: string[] | null;
  location?: string | null;
  childNodes?: ImapflowPart[] | null;
}

function paramName(parameters: Record<string, string> | undefined, dispParams: Record<string, string> | null | undefined): string | null {
  if (dispParams?.filename) return dispParams.filename;
  if (parameters?.name) return parameters.name;
  return null;
}

export function structureToBodyParts(
  root: ImapflowPart,
  blobIdFor: (partId: string | null) => string | null,
): EmailBodyPart {
  function walk(p: ImapflowPart, fallbackPartId: string | null): EmailBodyPart {
    const isMulti = (p.type ?? "").toLowerCase().startsWith("multipart/");
    // imapflow omits `.part` for single-part messages; IMAP convention is "1".
    const partId = p.part ?? fallbackPartId ?? null;
    const children = p.childNodes
      ? p.childNodes.map((child, i) => walk(child, partId ? `${partId}.${i + 1}` : `${i + 1}`))
      : null;
    return {
      partId: isMulti ? null : partId,
      blobId: isMulti ? null : blobIdFor(partId),
      size: p.size ?? 0,
      headers: [],
      name: paramName(p.parameters, p.dispositionParameters ?? null),
      type: (p.type ?? "application/octet-stream").toLowerCase(),
      charset: p.parameters?.charset?.toLowerCase() ?? null,
      disposition: p.disposition ? p.disposition.toLowerCase() : null,
      cid: p.id ? p.id.replace(/^<|>$/g, "") : null,
      language: p.language && p.language.length ? p.language : null,
      location: p.location ?? null,
      encoding: p.encoding ? p.encoding.toLowerCase() : null,
      subParts: children,
    };
  }
  return walk(root, "1");
}

export interface SelectedBodies {
  textBody: EmailBodyPart[];
  htmlBody: EmailBodyPart[];
  attachments: EmailBodyPart[];
  hasAttachment: boolean;
}

// Implements the RFC 8621 §4.1.4 selection algorithm for text/plain and
// text/html: outside a multipart/alternative a text part is both the text and
// the HTML body; inside one, an alternative that has only an HTML (or only a
// plain-text) version uses it for both lists. So an HTML-only message has its
// HTML part in textBody too, as every RFC 8621 server returns it; clients that
// read textBody (summaries, previews, plugins) are never left without a body.
// Other leaves keep this proxy's simpler rule: non-text parts outside an
// alternative are attachments, other text/* parts are in both lists.
export function selectBodies(root: EmailBodyPart): SelectedBodies {
  const textBody: EmailBodyPart[] = [];
  const htmlBody: EmailBodyPart[] = [];
  const attachments: EmailBodyPart[] = [];

  function parse(
    parts: EmailBodyPart[],
    multipartType: string | null,
    inAlternative: boolean,
    text: EmailBodyPart[] | null,
    html: EmailBodyPart[] | null,
  ): void {
    const textLength = text ? text.length : -1;
    const htmlLength = html ? html.length : -1;
    for (const node of parts) {
      const ct = node.type;
      if (node.subParts !== null) {
        const sub = ct.replace(/^multipart\//, "");
        parse(node.subParts, sub, inAlternative || sub === "alternative", text, html);
        continue;
      }
      const isAttachment =
        node.disposition === "attachment" ||
        (multipartType !== "alternative" && !ct.startsWith("text/"));
      if (isAttachment) {
        attachments.push(node);
        continue;
      }
      if (ct !== "text/plain" && ct !== "text/html") {
        if (ct.startsWith("text/")) {
          text?.push(node);
          html?.push(node);
        }
        continue;
      }
      if (multipartType === "alternative") {
        if (ct === "text/plain") text?.push(node);
        else html?.push(node);
        continue;
      }
      if (inAlternative) {
        // e.g. alternative{text/plain, related{text/html, image}}: the HTML
        // branch belongs to htmlBody only, the plain branch to textBody only.
        if (ct === "text/plain") html = null;
        else text = null;
      }
      text?.push(node);
      html?.push(node);
    }
    if (multipartType === "alternative" && text && html) {
      // Parts this alternative added to one list only (other text/* parts go
      // to both and do not count as a version).
      const addedText = text.slice(textLength).filter((p) => !html!.slice(htmlLength).includes(p));
      const addedHtml = html.slice(htmlLength).filter((p) => !text!.slice(textLength).includes(p));
      if (addedText.length === 0 && addedHtml.length > 0) text.push(...addedHtml);
      if (addedHtml.length === 0 && addedText.length > 0) html.push(...addedText);
    }
  }

  if (root.subParts === null) {
    parse([root], null, false, textBody, htmlBody);
  } else {
    const sub = root.type.replace(/^multipart\//, "");
    parse(root.subParts, sub, sub === "alternative", textBody, htmlBody);
  }
  return {
    textBody,
    htmlBody,
    attachments,
    hasAttachment: attachments.length > 0,
  };
}
