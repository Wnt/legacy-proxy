// The header projections run on every listing, thread scan and push lookup,
// on header text any sender controls. Their cost must stay linear, and their
// results must match the regexes they replaced on well-formed input.

import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  asMessageIds,
  asURLs,
  bracketed,
  computeThreadIdFromHeaders,
  MAX_HEADER_BLOCK_BYTES,
  MAX_HEADER_FIELD_CHARS,
  parseAddressList,
  parseHeaderBlock,
  splitAngleAddr,
} from "../../src/imap/headers.js";

// The old regexes take ~1.5 s on 12 KB and grow quadratically (minutes at
// these sizes); the linear scanners take tens of ms. The budget leaves room
// for a loaded test machine.
const BUDGET_MS = 1000;

function legacyBracketed(v: string): string[] {
  const out: string[] = [];
  const re = /<([^>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v)) !== null) out.push(m[1]!);
  return out;
}

function legacyAngle(t: string): { name: string; addr: string } | null {
  const m = /^(.*)<([^>]+)>\s*$/.exec(t);
  return m ? { name: m[1]!, addr: m[2]! } : null;
}

// Deterministic strings over the characters that matter to both scanners.
function* samples(): Generator<string> {
  const alphabet = ["<", ">", "a", " ", "@", "\t"];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 4000; n++) {
    const len = Math.floor(rnd() * 14);
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    yield s;
  }
  yield* ["", "<>", "<<>>", "<a>", "a <b@c>", "<a<b>", "x<a<>", "<<>", "<a> ", "<a>b", "Name <a@b> \t"];
}

describe("linear header scanners", () => {
  it("bracketed() matches /<([^>]+)>/g", () => {
    for (const s of samples()) expect(bracketed(s), JSON.stringify(s)).toEqual(legacyBracketed(s));
  });

  it("splitAngleAddr() matches /^(.*)<([^>]+)>\\s*$/", () => {
    for (const s of samples()) expect(splitAngleAddr(s), JSON.stringify(s)).toEqual(legacyAngle(s));
  });

  // ~100 KB each, so three such fields plus Message-ID fit the block cap.
  const hostile = [
    "<".repeat(100_000),
    "<a".repeat(50_000),
    "<>".repeat(50_000),
    "a<".repeat(50_000),
  ];

  it.each(hostile.map((h, i) => [i, h] as const))("References/List-* case %i stays fast", (_i, value) => {
    const headers = parseHeaderBlock(
      `References: ${value}\r\nIn-Reply-To: ${value}\r\nList-Unsubscribe: ${value}\r\nMessage-ID: <own@x>\r\n\r\n`,
    );
    const t = performance.now();
    asMessageIds(headers, "References");
    asURLs(headers, "List-Unsubscribe");
    const tid = computeThreadIdFromHeaders(headers, null);
    expect(performance.now() - t).toBeLessThan(BUDGET_MS);
    expect(tid).toBe(computeThreadIdFromHeaders(parseHeaderBlock("Message-ID: <own@x>\r\n\r\n"), null));
  });

  it.each(hostile.map((h, i) => [i, h] as const))("address case %i stays fast", (_i, value) => {
    const t = performance.now();
    parseAddressList(value.slice(0, MAX_HEADER_FIELD_CHARS));
    parseAddressList(`Name ${value.slice(0, MAX_HEADER_FIELD_CHARS)}>`);
    expect(performance.now() - t).toBeLessThan(BUDGET_MS);
  });
});

describe("malformed threading data", () => {
  it("skips ids swallowed by an unclosed bracket and falls back", () => {
    const headers = parseHeaderBlock("References: <<<<root@x>\r\nMessage-ID: <own@x>\r\n\r\n");
    expect(asMessageIds(headers, "References")).toBeNull();
    expect(computeThreadIdFromHeaders(headers, null)).toBe(
      computeThreadIdFromHeaders(parseHeaderBlock("Message-ID: <own@x>\r\n\r\n"), null),
    );
  });

  it("keeps ordinary References", () => {
    const headers = parseHeaderBlock("References: <a@x>\r\n <b@x> <c@x>\r\n\r\n");
    expect(asMessageIds(headers, "References")).toEqual(["a@x", "b@x", "c@x"]);
  });
});

describe("header size bounds", () => {
  it("caps one unfolded field", () => {
    const folded = Array.from({ length: 8000 }, (_, i) => `<id${i}@example.test>`).join("\r\n ");
    expect(folded.length).toBeGreaterThan(MAX_HEADER_FIELD_CHARS);
    const [h] = parseHeaderBlock(`References: ${folded}\r\n\r\n`);
    expect(h!.rawValue.length).toBe(MAX_HEADER_FIELD_CHARS);
    // The start of the chain (the thread root) survives truncation.
    expect(asMessageIds([h!], "References")![0]).toBe("id0@example.test");
  });

  it("parses at most MAX_HEADER_BLOCK_BYTES of a header block", () => {
    const filler = `X-Filler: ${"a".repeat(900)}\r\n`.repeat(Math.ceil((MAX_HEADER_BLOCK_BYTES * 2) / 912));
    const parsed = parseHeaderBlock(Buffer.from(`${filler}Subject: late\r\n\r\n`));
    expect(parsed.some((h) => h.name === "Subject")).toBe(false);
    expect(parsed.reduce((n, h) => n + h.name.length + h.rawValue.length, 0)).toBeLessThanOrEqual(MAX_HEADER_BLOCK_BYTES);
  });
});
