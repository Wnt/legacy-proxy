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
    if (!AT_RULE.test(rest) && !(SELECTOR.test(rest) && isSelector(rest.slice(0, rest.indexOf("{"))))) return rest;
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

// CSS properties, for telling a style rule left in the text ("p { margin: 0 }")
// from prose in braces ("at {time}", "{date: Monday}").
const CSS_PROPERTY =
  /^(?:(?:mso|-webkit|-moz|-ms|-o)-[a-z-]+|color|background(?:-[a-z]+)*|border(?:-[a-z]+)*|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|font(?:-[a-z]+)?|text-[a-z-]+|line-height|letter-spacing|word-(?:spacing|break|wrap)|white-space|(?:max-|min-)?(?:width|height)|display|visibility|opacity|overflow(?:-[xy])?|float|clear|position|top|right|bottom|left|z-index|vertical-align|list-style(?:-[a-z]+)?|outline(?:-[a-z]+)?|box-[a-z]+|cursor|content|table-layout|direction|transition(?:-[a-z]+)?|transform(?:-[a-z]+)?|animation(?:-[a-z]+)?|flex(?:-[a-z]+)?|justify-content|align-[a-z]+|gap|src|unicode-range|zoom|filter|fill|stroke|object-fit|aspect-ratio|interpolation-mode|-?[a-z]+-(?:size-adjust|text-size-adjust))$/i;
// Element names that, bare, can be a selector ("td p { … }").
const SELECTOR_ELEMENTS = new Set([
  "html", "body", "table", "tbody", "thead", "tr", "td", "th", "div", "span", "p", "a", "img", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "b", "i", "u", "strong", "em", "font", "center", "small", "sup", "sub",
  "blockquote", "pre", "code", "hr", "br", "button", "input", "u", "o:p", "*",
]);
const SELECTOR_TOKEN = /^(?:[a-z*][\w-]*|[.#][\w-]+|\[[^\]]*\])?(?:[.#][\w-]+|:{1,2}[\w-]+(?:\([^)]*\))?|\[[^\]]*\])*$/i;

// One whitespace-separated part of a selector: a combinator, or a compound
// selector; a bare word only when it is an element name.
function isSelectorToken(token: string): boolean {
  const t = token.replace(/,$/, "");
  if (t === "" || /^[>+~]$/.test(t)) return token !== "";
  if (!SELECTOR_TOKEN.test(t)) return false;
  return !/^[a-z][\w-]*$/i.test(t) || SELECTOR_ELEMENTS.has(t.toLowerCase());
}

// Every whitespace-separated token is a selector part ("td.x", ".a > p", "a:hover,").
function isSelector(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(isSelectorToken);
}

function isDeclarations(block: string): boolean {
  const items = block.split(";").map((d) => d.trim()).filter(Boolean);
  return items.length > 0 && items.every((d) => {
    const m = /^([-a-z]+)\s*:\s*\S/i.exec(d);
    return m !== null && CSS_PROPERTY.test(m[1]!);
  });
}

function startsWithDeclaration(block: string): boolean {
  const m = /^\s*([-a-z]+)\s*:/i.exec(block);
  return m !== null && CSS_PROPERTY.test(m[1]!);
}

function isRuleList(block: string): boolean {
  // The body of @media etc.: one or more `selector { declarations }`.
  const rules = block.match(/[^{}]+\{[^{}]*\}/g);
  if (!rules || rules.join("").replace(/\s+/g, "") !== block.replace(/\s+/g, "")) return false;
  return rules.every((r) => isDeclarations(r.slice(r.indexOf("{") + 1, -1)));
}

function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Removes CSS rules anywhere in a text: `selector { known-property: value }`
 * and `@media … { rules }`. A rule the text ends inside of is cut off with
 * the rest of the text.
 */
export function stripCssRules(text: string): string {
  let out = text;
  for (let from = 0, guard = 0; guard < 500; guard++) {
    const open = out.indexOf("{", from);
    if (open < 0) break;
    const close = matchBrace(out, open);
    const block = out.slice(open + 1, close < 0 ? undefined : close);
    // What precedes the brace: an at-rule prelude, or selector tokens.
    const before = out.slice(Math.max(0, open - 300), open);
    const at = /@(?:media|supports|font-face|page|keyframes|-webkit-keyframes|document)\b[^{}@]*$/i.exec(before);
    let start = -1;
    const isRule = close < 0 ? startsWithDeclaration(block) : isDeclarations(block);
    if (at) {
      const ok = close < 0 || (/^@(?:font-face|page)/i.test(at[0]) ? isDeclarations(block) : isRuleList(block));
      if (ok) start = open - (before.length - at.index);
    } else if (isRule) {
      const tokens = before.split(/(\s+)/);
      let taken = 0;
      let consumed = 0;
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i]!;
        if (t === "" || /^\s+$/.test(t)) {
          consumed += t.length;
          continue;
        }
        if (isSelectorToken(t)) {
          consumed += t.length;
          taken++;
          continue;
        }
        break;
      }
      if (taken > 0) start = open - consumed;
    }
    if (start < 0) {
      from = open + 1;
      continue;
    }
    if (close < 0) return out.slice(0, start);
    out = out.slice(0, start) + " " + out.slice(close + 1);
    from = start + 1;
  }
  return out;
}

// Markup in a text/plain part: a converter that left tags or entity
// references in. Only real element names count, so "<https://…>" and
// "<name@example.com>" stay.
const PLAIN_TAG =
  /<\/?(?:a|abbr|b|big|blockquote|br|center|code|div|em|font|h[1-6]|hr|i|img|li|o:p|ol|p|pre|small|span|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul)(?:\s[^<>]*)?\/?>/gi;
const ENTITY = /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi;

function decodeEntity(ref: string): string {
  let out = "";
  const p = new Parser({ ontext(t) { out += t; } }, { decodeEntities: true });
  p.write(ref);
  p.end();
  return out;
}

function stripPlainMarkup(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(PLAIN_TAG, (tag) => (/^<\/?(?:a|abbr|b|big|code|em|font|i|o:p|small|span|strong|sub|sup|u)\b/i.test(tag) ? "" : " "))
    .replace(ENTITY, decodeEntity);
}

/** Preview of a text/plain part (or a prefix of one). */
export function plainPreview(text: string): string {
  if (looksLikeHtml(text)) return htmlPreview(text);
  return cut(tidy(stripCssRules(stripLeadingCss(tidy(stripPlainMarkup(text))))));
}

/** Preview of a text/html part (or a prefix of one). */
export function htmlPreview(html: string): string {
  // A converter's leftover style sheet can sit in the body text as well.
  return cut(tidy(stripCssRules(stripLeadingCss(htmlToText(html)))));
}

export function buildPreview(text: string, isHtml: boolean): string {
  return isHtml ? htmlPreview(text) : plainPreview(text);
}
