// The JMAP `preview` of a message (RFC 8621 §4.1.4): up to 256 characters of
// plain text a client shows under the subject in a list. It is computed from a
// prefix of one body part, so everything here must cope with input cut short
// anywhere - inside a <style> element, a comment, a tag or a CSS rule.
import { Parser } from "htmlparser2";

export const PREVIEW_MAX_CHARS = 256;

// Elements whose content is never shown as text.
const SKIP_CONTENT = new Set([
  "head", "style", "script", "title", "template", "noscript", "svg", "math",
  "object", "iframe", "select", "textarea", "xml", "map",
]);

// What a <head> holds; any other element starts the body.
const HEAD_CONTENT = new Set([
  "base", "link", "meta", "style", "script", "title", "noscript", "template", "xml", "o:officedocumentsettings",
  "o:allowpng", "o:pixelsperinch",
]);

// Elements that run inline with their neighbours; every other tag separates
// words ("<td>A</td><td>B</td>" is "A B", not "AB").
const INLINE = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "del", "dfn", "em", "font", "i", "ins",
  "kbd", "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time",
  "tt", "u", "var", "wbr", "o:p",
]);

// Inline styles that make an element invisible. Bulk mail uses them for the
// preheader and for mobile-only duplicates of the content. (font-size:0 and
// mso-hide:all are not among them: layouts put font-size:0 on wrappers whose
// children set their own size, and mso-hide only hides from Outlook.)
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$))/i;
const ZERO_HEIGHT = /(?:^|;)\s*max-height\s*:\s*0(?:px)?\s*(?:!important\s*)?(?:;|$)/i;
const OVERFLOW_HIDDEN = /(?:^|;)\s*overflow\s*:\s*hidden/i;

function isHidden(attribs: Record<string, string>): boolean {
  if ("hidden" in attribs) return true;
  const style = attribs.style;
  if (!style) return false;
  return HIDDEN_STYLE.test(style) || (ZERO_HEIGHT.test(style) && OVERFLOW_HIDDEN.test(style));
}

// Invisible padding bulk senders put after the preheader (zero-width and other
// format characters, combining grapheme joiners, Hangul fillers, soft hyphens)
// to push the body out of the inbox preview. A zero-width joiner inside an
// emoji sequence is kept.
const FILLER = /[\p{Cf}͏ᅟᅠ឴឵ㅤﾠ]/gu;

function tidy(text: string): string {
  return text
    .replace(FILLER, (ch, offset: number, all: string) =>
      ch === "‍" && /\p{Extended_Pictographic}️?$/u.test(all.slice(Math.max(0, offset - 3), offset)) ? ch : "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function cut(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  let out = text.slice(0, PREVIEW_MAX_CHARS);
  // Never end on half of a surrogate pair.
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out.trimEnd();
}

/**
 * The visible text of an HTML body (or a prefix of one): no head, style,
 * script, comments or markup; entities decoded; whitespace collapsed.
 *
 * Hidden elements (display:none and the like) are dropped, with one exception:
 * hidden text that comes before any visible text is the sender's preheader -
 * the line written to be shown in the inbox, as every mail client shows it -
 * and is kept. Text inside an element the prefix ends in the middle of (an
 * unterminated <style>, say) is dropped with it.
 */
export function htmlToText(html: string, maxChars = PREVIEW_MAX_CHARS * 4): string {
  const parts: string[] = [];
  let length = 0;
  let sawVisible = false;
  let inHead = false;
  // One entry per open element: whether its content is suppressed.
  const stack: ("skip" | "hidden" | null)[] = [];
  let skipDepth = 0;
  let hiddenDepth = 0;
  let done = false;

  const sep = () => {
    if (parts.length > 0 && parts[parts.length - 1] !== " ") parts.push(" ");
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === "head") inHead = true;
        // As in a browser, the head ends at the first element that can't be
        // in it, <body> or not.
        else if (inHead && !HEAD_CONTENT.has(name)) inHead = false;
        let mark: "skip" | "hidden" | null = null;
        if (SKIP_CONTENT.has(name) && name !== "head") mark = "skip";
        else if (isHidden(attribs)) mark = "hidden";
        stack.push(mark);
        if (mark === "skip") skipDepth++;
        if (mark === "hidden") hiddenDepth++;
        if (!INLINE.has(name)) sep();
      },
      onclosetag(name) {
        if (name === "head") inHead = false;
        const mark = stack.pop();
        if (mark === "skip") skipDepth--;
        if (mark === "hidden") hiddenDepth--;
        if (!INLINE.has(name)) sep();
      },
      ontext(text) {
        if (done || inHead || skipDepth > 0) return;
        if (hiddenDepth > 0 && sawVisible) return;
        if (hiddenDepth === 0 && tidy(text) !== "") sawVisible = true;
        parts.push(text);
        length += text.replace(/\s+/g, " ").length;
        if (length > maxChars) {
          done = true;
          parser.pause();
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  // An unterminated element at the end of a prefix leaves its text with the
  // tokenizer; ending the parse would flush it as text, so it is not ended.
  return tidy(parts.join(""));
}

// A plain-text part that is really HTML: some senders label their HTML
// text/plain, or put the HTML source into the plain alternative.
const HTML_DOCUMENT_START = /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<meta\s|<style[\s>]|<body[\s>]|<table[\s>]|<div[\s>])/i;
const HTML_TAG = /<\/?(?:html|head|body|style|div|table|tr|td|p|br|span|font|center|img|a\s+href)\b[^>]*>/gi;

export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 4096);
  if (HTML_DOCUMENT_START.test(head)) return true;
  return (head.match(HTML_TAG)?.length ?? 0) >= 4;
}

// A style sheet at the start of a plain-text part: some HTML-to-text
// converters copy the <style> element's content into the plain alternative.
const AT_RULE = /^@(?:media|font-face|import|supports|keyframes|-webkit-keyframes|charset|page|namespace)\b/;
const SELECTOR = /^[.#]?[a-z*](?:[\w\-.#,>~+*\s[\]="'()]|:(?!\s))*\{/i;
const DECLARATIONS = /^\s*(?:[-\w]+\s*:|[.#@a-z*][^{}]*\{|\})/i;

/**
 * Drops whole CSS rules (and CSS / HTML comments between them) from the
 * start of a text. A rule the text ends inside of means the text was only
 * CSS: the result is empty.
 */
export function stripLeadingCss(text: string): string {
  let rest = text.trimStart();
  for (let guard = 0; guard < 1000; guard++) {
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end < 0) return "";
      rest = rest.slice(end + 2).trimStart();
      continue;
    }
    if (rest.startsWith("<!--") || rest.startsWith("-->")) {
      rest = rest.slice(rest.startsWith("-->") ? 3 : 4).trimStart();
      continue;
    }
    if (!AT_RULE.test(rest) && !SELECTOR.test(rest)) return rest;
    const brace = rest.indexOf("{");
    const semicolon = rest.indexOf(";");
    if (/^@(?:import|charset|namespace)\b/.test(rest) && semicolon >= 0 && (brace < 0 || semicolon < brace)) {
      rest = rest.slice(semicolon + 1).trimStart();
      continue;
    }
    if (brace < 0) return rest; // "@media team, ..." is prose
    let depth = 0;
    let end = -1;
    for (let i = brace; i < rest.length; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const block = rest.slice(brace + 1, end < 0 ? undefined : end);
    // A rule's block holds declarations or further rules; a brace in prose
    // ("see you at {time}") holds neither and ends the strip.
    if (!rest.startsWith("@") && !DECLARATIONS.test(block)) return rest;
    if (end < 0) return "";
    rest = rest.slice(end + 1).trimStart();
  }
  return rest;
}

/** Preview of a text/plain part (or a prefix of one). */
export function plainPreview(text: string): string {
  if (looksLikeHtml(text)) return htmlPreview(text);
  return cut(tidy(stripLeadingCss(tidy(text))));
}

/** Preview of a text/html part (or a prefix of one). */
export function htmlPreview(html: string): string {
  // A converter's leftover style sheet can sit in the body text as well.
  return cut(tidy(stripLeadingCss(htmlToText(html))));
}

export function buildPreview(text: string, isHtml: boolean): string {
  return isHtml ? htmlPreview(text) : plainPreview(text);
}
