// Parse the raw header block of an RFC 5322 message and project values into
// the JMAP header forms (RFC 8621 §4.1.3): asRaw, asText, asAddresses,
// asGroupedAddresses, asMessageIds, asURLs, asDate.
//
// We parse ourselves rather than pull libmime as a direct dep: the surface we
// need is small, and the transitive libmime can be cleaned out from under us
// without notice. All parsing is forgiving — an undecodable encoded-word, an
// unparseable address, or a malformed date drops to the most useful fallback
// (the raw string, an empty array, etc.) rather than throwing.

export interface ParsedHeader {
  name: string;       // original casing as it appeared in the message
  rawValue: string;   // value AFTER folded-line unwrapping but before decoding
}

// Upper bounds on what a message's sender can make us parse. A header block
// is fetched and parsed on every listing, thread scan and push lookup, so its
// cost must not depend on how much a sender stuffs into it. Generous for real
// mail: a 1,000-message References chain is ~60 KB, and whole header blocks
// with long Received/ARC chains stay well under 100 KB.
export const MAX_HEADER_BLOCK_BYTES = 512 * 1024;
export const MAX_HEADER_FIELD_CHARS = 128 * 1024;
const MAX_MSG_ID_CHARS = 998; // RFC 5322 §2.1.1 line limit

export function parseHeaderBlock(block: string | Buffer): ParsedHeader[] {
  const text =
    typeof block === "string"
      ? block.slice(0, MAX_HEADER_BLOCK_BYTES)
      : block.subarray(0, MAX_HEADER_BLOCK_BYTES).toString("utf8");
  // RFC 5322 header lines end at LF with optional CR; continuation lines start
  // with whitespace. Unfold first, then split on header boundaries.
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ParsedHeader[] = [];
  let cur: ParsedHeader | null = null;
  for (const line of lines) {
    if (line === "") break; // empty line ends the header section
    if (/^[ \t]/.test(line)) {
      // continuation; a field past the cap keeps its (truncated) start
      if (cur && cur.rawValue.length < MAX_HEADER_FIELD_CHARS) {
        cur.rawValue = (cur.rawValue + " " + line.replace(/^[ \t]+/, "")).slice(0, MAX_HEADER_FIELD_CHARS);
      }
      continue;
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    if (cur) out.push(cur);
    cur = { name: m[1]!, rawValue: m[2]!.slice(0, MAX_HEADER_FIELD_CHARS) };
  }
  if (cur) out.push(cur);
  return out;
}

export function findHeaders(headers: ParsedHeader[], name: string): ParsedHeader[] {
  const lc = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === lc);
}

// Decode RFC 2047 encoded-words (`=?charset?B?...?=` / `=?charset?Q?...?=`).
// Whitespace BETWEEN consecutive encoded-words is preserved if textual but
// elided when it separates two encoded-words, per §6.2.
export function decodeWords(s: string): string {
  const ENCODED = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  // First pass: collapse whitespace between back-to-back encoded words.
  s = s.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return s.replace(ENCODED, (_m, charset: string, enc: string, text: string) => {
    try {
      let bytes: Buffer;
      if (enc.toUpperCase() === "B") {
        bytes = Buffer.from(text, "base64");
      } else {
        // Q: underscores → space, =XX → byte
        const replaced = text
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (_x, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          );
        bytes = Buffer.from(
          [...replaced].map((ch) => ch.charCodeAt(0)),
        );
      }
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      return _m;
    }
  });
}

export function asRaw(headers: ParsedHeader[], name: string): string | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  // RFC 8621 §4.1.3: "the value as it appears in the message" — last instance
  // wins, prefixed with a single space (the convention upstream tests follow).
  return " " + matches[matches.length - 1]!.rawValue;
}

// The Email `headers` property (RFC 8621 §4.1.3): every header field in
// message order, values in Raw form -- same convention as asRaw above.
export function headersToEmailHeaders(
  headers: ParsedHeader[],
): { name: string; value: string }[] {
  return headers.map((h) => ({ name: h.name, value: " " + h.rawValue }));
}

export function asText(headers: ParsedHeader[], name: string): string | null {
  const raw = asRaw(headers, name);
  if (raw == null) return null;
  return decodeWords(raw).replace(/\s+/g, " ").trim();
}

// Parse an RFC 5322 address list: `name <addr>`, `<addr>`, `addr`, group syntax
// `Group: addr1, addr2;`. Used for asAddresses and asGroupedAddresses.
export function parseAddressList(value: string): { groups: { name: string | null; addresses: { name: string | null; email: string }[] }[] } {
  const groups: { name: string | null; addresses: { name: string | null; email: string }[] }[] = [];
  let buf: { name: string | null; addresses: { name: string | null; email: string }[] } = {
    name: null,
    addresses: [],
  };
  // Tokenize: walk the string honoring quoted strings, comments, angle-brackets.
  let i = 0;
  let token = "";
  const finishAddress = () => {
    const t = token.trim();
    token = "";
    if (!t) return;
    // Match `Display Name <foo@bar>` or just `foo@bar`.
    const angle = splitAngleAddr(t);
    if (angle) {
      const name = angle.name.trim().replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
      buf.addresses.push({ name: name ? decodeWords(name) : null, email: angle.addr.trim() });
      return;
    }
    if (/@/.test(t)) buf.addresses.push({ name: null, email: t });
  };
  while (i < value.length) {
    const c = value[i]!;
    if (c === '"') {
      // quoted-string: read up to matching "
      token += c;
      i++;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\") { token += value[i]!; i++; }
        if (i < value.length) { token += value[i]!; i++; }
      }
      if (i < value.length) { token += value[i]!; i++; }
      continue;
    }
    if (c === "(") {
      // comment: skip to matching )
      let depth = 1;
      i++;
      while (i < value.length && depth > 0) {
        if (value[i] === "(") depth++;
        else if (value[i] === ")") depth--;
        if (depth > 0) i++;
      }
      i++;
      continue;
    }
    if (c === ":") {
      // group prefix: token so far is the group name
      const name = token.trim();
      if (buf.addresses.length || buf.name) groups.push(buf);
      buf = { name: name || null, addresses: [] };
      token = "";
      i++;
      continue;
    }
    if (c === ";") {
      finishAddress();
      groups.push(buf);
      buf = { name: null, addresses: [] };
      i++;
      continue;
    }
    if (c === ",") {
      finishAddress();
      i++;
      continue;
    }
    token += c;
    i++;
  }
  finishAddress();
  if (buf.addresses.length || buf.name) groups.push(buf);
  if (groups.length === 0) groups.push({ name: null, addresses: [] });
  return { groups };
}

export function asAddresses(headers: ParsedHeader[], name: string): { name: string | null; email: string }[] | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const out: { name: string | null; email: string }[] = [];
  for (const h of matches) {
    const decoded = decodeWords(h.rawValue);
    const parsed = parseAddressList(decoded);
    for (const g of parsed.groups) out.push(...g.addresses);
  }
  return out;
}

export function asGroupedAddresses(
  headers: ParsedHeader[],
  name: string,
): { name: string | null; addresses: { name: string | null; email: string }[] }[] | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const groups: { name: string | null; addresses: { name: string | null; email: string }[] }[] = [];
  for (const h of matches) {
    const decoded = decodeWords(h.rawValue);
    const parsed = parseAddressList(decoded);
    for (const g of parsed.groups) groups.push(g);
  }
  return groups;
}

// `<...>` items of a header value, in order: the text between each `<` and the
// next `>`, skipping empty pairs, and everything after an unclosed `<`. Same
// result as /<([^>]+)>/g, but one linear pass: that regex rescans the rest of
// the value from every `<` when no `>` follows, which a sender can turn into
// seconds of event-loop time with a header of nothing but `<`s.
export function bracketed(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const open = value.indexOf("<", i);
    if (open < 0) break;
    const close = value.indexOf(">", open + 1);
    if (close < 0) break;
    if (close === open + 1) {
      i = open + 1; // "<>": the regex needs one character, so it moves on
      continue;
    }
    out.push(value.slice(open + 1, close));
    i = close + 1;
  }
  return out;
}

// `Display Name <addr>` -> { name, addr }, or null when the token doesn't end in
// a non-empty `<...>`. Equivalent to /^(.*)<([^>]+)>\s*$/ without its quadratic
// backtracking on a token full of `<`.
export function splitAngleAddr(t: string): { name: string; addr: string } | null {
  const close = t.lastIndexOf(">");
  if (close < 1 || t.slice(close + 1).trim() !== "") return null;
  // Greedy (.*): the last `<` that still leaves a non-empty address.
  const open = close >= 2 ? t.lastIndexOf("<", close - 2) : -1;
  if (open < 0) return null;
  if (t.lastIndexOf(">", close - 1) > open) return null;
  return { name: t.slice(0, open), addr: t.slice(open + 1, close) };
}

export function asMessageIds(headers: ParsedHeader[], name: string): string[] | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const ids: string[] = [];
  for (const h of matches) {
    for (const id of bracketed(h.rawValue)) {
      // Malformed: an unclosed `<` swallowed into the next id, or longer than
      // a header line may be. Skip it, so threading falls back to the next
      // reference or the message's own id.
      if (id.includes("<") || id.length > MAX_MSG_ID_CHARS) continue;
      ids.push(id);
    }
  }
  return ids.length ? ids : null;
}

export function asURLs(headers: ParsedHeader[], name: string): string[] | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const urls: string[] = [];
  for (const h of matches) for (const u of bracketed(h.rawValue)) urls.push(u.trim());
  return urls.length ? urls : null;
}

export function asDate(headers: ParsedHeader[], name: string): string | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1]!.rawValue;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Compute a stable JMAP threadId for a message from its headers, per the
// classic IMAP-threading heuristic (RFC 8621 §3 doesn't mandate a specific
// algorithm, so we follow the JWZ "References then In-Reply-To" approach):
//   1. The first Message-Id in References is the thread root (oldest ancestor).
//   2. If References is absent, fall back to In-Reply-To.
//   3. If both are absent, the message is its own root.
// We hash the chosen Message-Id so the threadId is opaque and URL-safe.
export function computeThreadIdFromHeaders(
  headers: ParsedHeader[],
  envelopeMessageId?: string | null,
): string | null {
  const refs = asMessageIds(headers, "References");
  if (refs && refs.length) return hashThreadId(refs[0]!);
  const irt = asMessageIds(headers, "In-Reply-To");
  if (irt && irt.length) return hashThreadId(irt[0]!);
  const own = asMessageIds(headers, "Message-ID");
  if (own && own.length) return hashThreadId(own[0]!);
  if (envelopeMessageId) return hashThreadId(envelopeMessageId);
  return null;
}

function hashThreadId(messageId: string): string {
  // Short base32-ish hash. Prefixed with "T" so a threadId is visually
  // distinguishable from an emailId in logs.
  const norm = messageId.replace(/^<|>$/g, "");
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < norm.length; i++) {
    const ch = norm.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = (BigInt(h1 >>> 0) << 32n) | BigInt(h2 >>> 0);
  // Encode as a short crockford-base32-ish string.
  const ALPH = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  let v = n;
  for (let i = 0; i < 13; i++) {
    out = ALPH[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return "T" + out;
}

// Project a JMAP `header:Name:asForm` (or `header:Name`, defaulting to asRaw)
// property string against a parsed header set. Returns the JMAP value the
// client should see in the Email response.
export function projectHeaderProp(
  headers: ParsedHeader[],
  prop: string,
):
  | string
  | string[]
  | { name: string | null; email: string }[]
  | { name: string | null; addresses: { name: string | null; email: string }[] }[]
  | null {
  // header:Name:asForm  → split on ':' but only the first two : are structural
  const m = /^header:([^:]+)(?::([^:]+))?$/.exec(prop);
  if (!m) return null;
  const name = m[1]!;
  const form = (m[2] ?? "asRaw").toLowerCase();
  switch (form) {
    case "asraw": return asRaw(headers, name);
    case "astext": return asText(headers, name);
    case "asaddresses": return asAddresses(headers, name);
    case "asgroupedaddresses": return asGroupedAddresses(headers, name);
    case "asmessageids": return asMessageIds(headers, name);
    case "asurls": return asURLs(headers, name);
    case "asdate": return asDate(headers, name);
    default: return null;
  }
}
