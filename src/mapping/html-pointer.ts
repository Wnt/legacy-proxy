// A plain-text alternative that only points to the HTML version.
//
// Many senders put a short notice into the text/plain part of a
// multipart/alternative instead of the text: "This newsletter is in HTML.
// Read it at <link>", "Your mail program cannot show HTML",
// "Jos viesti ei näy oikein, avaa se selaimessa". Taken as the preview, that
// notice (and the long link that follows it) is all a list shows of the
// message, while the HTML alternative holds the real text.
//
// No dependencies, so a read-only scan can reuse it as is.

// What such a notice says, in common languages. Each pattern
// is one statement about the message's format or where to read it; none is
// tied to a sender.
const NOTICE: RegExp[] = [
  // "HTML-only", "HTML version", "HTML formatted", "HTML-capable client", and
  // compounds in other languages: HTML-muodossa, HTML-versio, HTML:ää,
  // HTML-viesti, HTML-format, HTML-Version, HTML-fähig.
  /\bhtml(?:[-:]\p{L}+|\s+(?:only|version|format(?:ted)?|e-?mails?|messages?|newsletters?|capable|compatible|enabled|viewers?|readers?|clients?|content|mode)\b)/iu,
  // "sent in HTML", "as HTML", "does not support HTML", "can't display HTML"
  /\b(?:in|as|supports?|display|show|render|read|view)\s+html\b/i,
  // "view this email in your browser", "read it online", "open the following
  // link to view this email in a browser"
  /\b(?:view|read|see|open|display|show)(?:ing)?\b[^.!?\n]{0,40}?\b(?:online|(?:web\s?)?browser)\b/i,
  /\b(?:web|online|browser)[\s-]?version\b/i,
  // "If you can't see this email", "trouble viewing this message"
  /\b(?:can(?:no|['’])t|unable to|not able to|trouble|problems?|difficult(?:y|ies))\b[^.!?\n]{0,30}?\b(?:see|view|read|display)\w*\s+(?:this|the)\s+(?:e-?mail|message|newsletter|mail)\b/i,
  // "your email client does not support ...", "might not support HTML"
  /\b(?:e-?mail|mail)\s+(?:client|program|software|reader|app)\b[^.!?\n]{0,40}?\b(?:not|n['’]t)\s+(?:support|display|show)/i,
  // Finnish: "avaa selaimessa", "verkkoselaimessa", "verkkoversio",
  // "jos viesti ei näy oikein", "sähköpostiohjelmasi ei tue ..."
  /(?:^|[^\p{L}])(?:verkko)?selaime(?:ssa|ssasi|en|lla|llasi|esi)(?![\p{L}])/iu,
  /(?:^|[^\p{L}])(?:verkko|netti|web)-?versio\p{L}*/iu,
  /(?:^|[^\p{L}])ei\s+(?:näy|näytä|näky\p{L}*|aukea)\s+(?:oikein|kunnolla)/iu,
  /(?:^|[^\p{L}])sähköpostiohjelma\p{L}*[^.!?\n]{0,40}?(?:^|[^\p{L}])ei\s+(?:tue|näytä)(?![\p{L}])/iu,
  // Swedish, German, French, Spanish: the browser and the web version.
  /(?:^|[^\p{L}])(?:webbläsare\p{L}*|webbversion\p{L}*|navigateur|navegador|im\s+browser|webversion|onlineversion|version\s+(?:en\s+ligne|web)|versión\s+(?:web|en\s+línea))(?![\p{L}])/iu,
  /(?:^|[^\p{L}])(?:nicht\s+(?:richtig|korrekt)\s+angezeigt|(?:inte\s+visas|visas\s+inte)\s+(?:korrekt|rätt|ordentligt))(?![\p{L}])/iu,
];

// Longest a pointer stub is once links, addresses and separator lines are
// gone. Such notices, with an unsubscribe line and a postal footer, run to a
// few hundred characters; a text alternative that carries the message is
// longer. A false positive costs nothing in content: the HTML part is an
// alternative of the same message.
export const POINTER_MAX_CHARS = 800;
// Longest a fallback preview made from the notice is.
export const POINTER_FALLBACK_MAX_CHARS = 120;
const POINTER_LEAD_MIN_CHARS = 20;

// Links, <autolinks> and addresses. The address part is bounded (64 before
// the @, as RFC 5321 allows), so a long run of letters costs linear time.
const LINK = /\b(?:https?:\/\/|mailto:|www\.)[^\s<>()[\]"']+|<[^<>\s]+>|[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/gi;
// A line with no letters or digits (separators, "[>]", "-", "* * *").
const NO_WORDS = /^[^\p{L}\p{N}]*$/u;

/** The words of a text/plain part: links, addresses and separator lines removed, whitespace collapsed. */
export function pointerWords(text: string): string {
  return text
    .replace(LINK, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]\p{L}\p{N}]{0,3}\]/gu, " "))
    .filter((l) => !NO_WORDS.test(l))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasPointerNotice(text: string): boolean {
  return NOTICE.some((re) => re.test(text));
}

/**
 * Whether a text/plain part only points to the HTML version of the message:
 * it holds such a notice and little else. Callers use it only when the
 * message has a separate HTML alternative to take the preview from.
 */
export function isHtmlPointer(text: string): boolean {
  const words = pointerWords(text);
  return words.length <= POINTER_MAX_CHARS && hasPointerNotice(words);
}

/**
 * The preview of a pointer stub whose HTML alternative has no text (only
 * images, say), at most POINTER_FALLBACK_MAX_CHARS long and without links:
 * the sender's own words before the notice if there are any (a summary line,
 * say), else the notice's first sentence.
 */
export function pointerFallback(text: string): string {
  const sentences = pointerWords(text).split(/(?<=[.!?…])\s+/);
  const notice = sentences.findIndex(hasPointerNotice);
  const lead = notice > 0 ? sentences.slice(0, notice).join(" ") : "";
  // A greeting ("Hi,") is no lead.
  if (lead.length >= POINTER_LEAD_MIN_CHARS) return shorten(lead, POINTER_FALLBACK_MAX_CHARS);
  return shorten(sentences[Math.max(0, notice)] ?? "", POINTER_FALLBACK_MAX_CHARS);
}

function shorten(text: string, max: number): string {
  const out = text.replace(/[\s:;,–—-]+$/u, "");
  if (out.length <= max) return out;
  let cut = out.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  if (space > max / 2) cut = cut.slice(0, space);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.replace(/[\s.:;,–—-]+$/u, "")}…`;
}
