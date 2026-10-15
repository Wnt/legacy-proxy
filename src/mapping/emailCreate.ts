// Schema check for a JMAP Email/set create object (RFC 8621 §4.6) before any
// of it reaches blob lookups or MIME building. The request body is untrusted
// JSON, and the TypeScript types downstream are only a promise: nodemailer's
// MimeNode treats an object where a string belongs as an instruction - a body
// value `{ path }` is a local file to read, `{ href }` a URL to fetch, and a
// header value `{ prepared: true, value }` goes out unencoded. So every value
// buildRfc822 consumes must have its JMAP type here, or the create fails with
// invalidProperties.

export class InvalidEmailCreateError extends Error {
  constructor(message: string, readonly properties: string[]) {
    super(message);
  }
}

// RFC 8621 §4.1 Email properties. The server-set ones (id, blobId, threadId,
// size, hasAttachment, preview) are accepted and ignored, as before.
const EMAIL_PROPERTIES = new Set([
  "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt",
  "messageId", "inReplyTo", "references", "sender", "from", "to", "cc", "bcc",
  "replyTo", "subject", "sentAt", "hasAttachment", "preview", "bodyStructure",
  "bodyValues", "textBody", "htmlBody", "attachments", "headers",
]);

// Bounds on the bodyStructure tree; real messages are a few levels and parts.
const MAX_PART_DEPTH = 16;
const MAX_PARTS = 256;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(prop: string, why: string): never {
  throw new InvalidEmailCreateError(`${prop}: ${why}`, [prop]);
}

function optString(o: Obj, key: string, prop: string): void {
  const v = o[key];
  if (v !== undefined && v !== null && typeof v !== "string") fail(prop, `${key} must be a string`);
}

function optDate(o: Obj, key: string): void {
  optString(o, key, key);
  const v = o[key];
  if (typeof v === "string" && Number.isNaN(Date.parse(v))) fail(key, "must be a date");
}

function optStringList(o: Obj, key: string): void {
  const v = o[key];
  if (v === undefined || v === null) return;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(key, "must be a list of strings");
}

function optAddressList(o: Obj, key: string): void {
  const v = o[key];
  if (v === undefined || v === null) return;
  if (!Array.isArray(v)) fail(key, "must be a list of EmailAddress");
  for (const a of v) {
    if (!isObj(a)) fail(key, "must be a list of EmailAddress");
    if (typeof a.email !== "string") fail(key, "email must be a string");
    optString(a, "name", key);
  }
}

// EmailHeader[]: `{ name, value }` strings. The name must be a header field
// name (RFC 5322 §3.6.8: printable ASCII except colon).
function optHeaderList(v: unknown, prop: string): void {
  if (v === undefined || v === null) return;
  if (!Array.isArray(v)) fail(prop, "must be a list of EmailHeader");
  for (const h of v) {
    if (!isObj(h)) fail(prop, "must be a list of EmailHeader");
    if (typeof h.name !== "string" || !/^[!-9;-~]+$/.test(h.name)) fail(prop, "header name is invalid");
    if (typeof h.value !== "string") fail(prop, "header value must be a string");
  }
}

// `header:Name[:asForm][:all]` (RFC 8621 §4.1.3). These are not written into
// the message, but their values must still have the form's type.
function checkHeaderProperty(key: string, v: unknown): void {
  const m = /^header:([!-9;-~]+)((?::[A-Za-z]+)*)$/.exec(key);
  if (!m) fail(key, "is not a valid header property");
  const mods = m[2]!.split(":").filter(Boolean).map((s) => s.toLowerCase());
  const all = mods[mods.length - 1] === "all";
  const form = (all ? mods.slice(0, -1) : mods)[0] ?? "asraw";
  if (mods.length > (all ? 2 : 1)) fail(key, "is not a valid header property");
  const one = (x: unknown): void => {
    if (x === null) return;
    switch (form) {
      case "asraw":
      case "astext":
      case "asdate":
        if (typeof x !== "string") fail(key, "must be a string");
        return;
      case "asmessageids":
      case "asurls":
        if (!Array.isArray(x) || !x.every((s) => typeof s === "string")) fail(key, "must be a list of strings");
        return;
      case "asaddresses":
        optAddressList({ [key]: x }, key);
        return;
      case "asgroupedaddresses":
        if (!Array.isArray(x)) fail(key, "must be a list of EmailAddressGroup");
        for (const g of x) {
          if (!isObj(g)) fail(key, "must be a list of EmailAddressGroup");
          optString(g, "name", key);
          optAddressList({ [key]: g.addresses ?? [] }, key);
        }
        return;
      default:
        fail(key, `unknown header form ${form}`);
    }
  };
  if (all) {
    if (!Array.isArray(v)) fail(key, "must be a list");
    v.forEach(one);
  } else one(v);
}

function checkPart(part: unknown, prop: string, depth: number, count: { n: number }): void {
  if (!isObj(part)) fail(prop, "must be an EmailBodyPart");
  if (++count.n > MAX_PARTS || depth > MAX_PART_DEPTH) fail(prop, "body structure is too complex");
  for (const key of ["partId", "blobId", "type", "name", "disposition", "cid", "charset", "location"]) {
    optString(part, key, prop);
  }
  if (part.size !== undefined && part.size !== null && typeof part.size !== "number") fail(prop, "size must be a number");
  optStringList({ [prop]: part.language }, prop);
  optHeaderList(part.headers, prop);
  if (part.subParts !== undefined && part.subParts !== null) {
    if (!Array.isArray(part.subParts)) fail(prop, "subParts must be a list");
    for (const child of part.subParts) checkPart(child, prop, depth + 1, count);
  }
}

function optPartList(o: Obj, key: string, count: { n: number }): void {
  const v = o[key];
  if (v === undefined || v === null) return;
  if (!Array.isArray(v)) fail(key, "must be a list of EmailBodyPart");
  for (const p of v) checkPart(p, key, 1, count);
}

/** Throws InvalidEmailCreateError unless `input` is a well-typed Email create. */
export function validateEmailCreate(input: unknown): void {
  if (!isObj(input)) throw new InvalidEmailCreateError("create entry must be an object", []);
  for (const [key, v] of Object.entries(input)) {
    if (key.startsWith("header:")) checkHeaderProperty(key, v);
    else if (!EMAIL_PROPERTIES.has(key)) fail(key, "unknown property");
  }

  for (const key of ["mailboxIds", "keywords"]) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (!isObj(v) || !Object.values(v).every((x) => typeof x === "boolean")) {
      fail(key, "must map ids to booleans");
    }
  }
  optDate(input, "receivedAt");
  optDate(input, "sentAt");
  optString(input, "subject", "subject");
  for (const key of ["messageId", "inReplyTo", "references"]) optStringList(input, key);
  for (const key of ["from", "sender", "to", "cc", "bcc", "replyTo"]) optAddressList(input, key);
  optHeaderList(input.headers, "headers");

  const bodyValues = input.bodyValues;
  if (bodyValues !== undefined && bodyValues !== null) {
    if (!isObj(bodyValues)) fail("bodyValues", "must be an object");
    for (const bv of Object.values(bodyValues)) {
      if (!isObj(bv) || typeof bv.value !== "string") fail("bodyValues", "value must be a string");
      for (const flag of ["isEncodingProblem", "isTruncated"]) {
        if (bv[flag] !== undefined && typeof bv[flag] !== "boolean") fail("bodyValues", `${flag} must be a boolean`);
      }
    }
  }

  const count = { n: 0 };
  if (input.bodyStructure !== undefined && input.bodyStructure !== null) {
    checkPart(input.bodyStructure, "bodyStructure", 1, count);
  }
  for (const key of ["textBody", "htmlBody", "attachments"]) optPartList(input, key, count);
}
