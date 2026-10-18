// An in-memory CardDAV server for tests, installed over globalThis.fetch. It
// speaks just enough PROPFIND / REPORT / PUT / DELETE / MKCOL / PROPPATCH to
// exercise the real CardDavClient and the contacts handlers.
//
// `sogoMkcol` mimics SOGo (Gandi's CardDAV): an extended MKCOL succeeds but its
// properties are ignored, and the new collection's displayname is its URL leaf.
// `delayMs` holds every response that long; `inflight` / `maxInflight` count
// requests being served at once.
import { vi } from "vitest";

interface Resource {
  data: string;
  etag: string;
}
interface Book {
  displayName: string;
  description: string | null;
  resources: Map<string, Resource>;
}

export const HOME = "/books/u/";
export const PRINCIPAL = "/principals/u/";

export class FakeDav {
  books = new Map<string, Book>();
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: string }> = [];
  /** SOGo: MKCOL ignores the properties in its body; the displayname is the URL leaf. */
  sogoMkcol = false;
  /** The Basic credentials the server accepts. */
  userPass = "u:p";
  /** Every response waits this long (after the request is logged). */
  delayMs = 0;
  inflight = 0;
  maxInflight = 0;
  private etagSeq = 0;

  addBook(slug: string, displayName: string, cards: Array<[string, string]> = []): string {
    const href = `${HOME}${slug}/`;
    const book: Book = { displayName, description: null, resources: new Map() };
    for (const [file, data] of cards) book.resources.set(href + file, { data, etag: this.nextEtag() });
    this.books.set(href, book);
    return href;
  }

  nextEtag(): string {
    return `"e${++this.etagSeq}"`;
  }

  async serve(method: string, url: string, headers: Record<string, string>, body: string, signal?: AbortSignal | null): Promise<Response> {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      const res = this.handle(method, url, headers, body);
      if (this.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, this.delayMs);
          signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
        });
      }
      return res;
    } finally {
      this.inflight--;
    }
  }

  handle(method: string, url: string, headers: Record<string, string>, body: string): Response {
    const path = decodeURIComponent(new URL(url).pathname);
    this.calls.push({ method, path, headers, body });
    if (headers["authorization"] !== "Basic " + Buffer.from(this.userPass).toString("base64")) {
      return new Response("nope", { status: 401 });
    }
    // Strict servers (Radicale) reject XML with a namespace-prefixed name
    // inside the local name — the client once emitted `<D:DAV:resourcetype/>`.
    if (/<[A-Za-z]+:[A-Za-z]+:/.test(body)) return new Response("malformed XML", { status: 400 });
    switch (method) {
      case "PROPFIND":
        return this.propfind(path, headers["depth"] ?? "0", body);
      case "REPORT":
        return this.report(path, body);
      case "PUT":
        return this.put(path, headers, body);
      case "DELETE":
        return this.delete(path, headers);
      case "MKCOL":
        return this.mkcol(path, body);
      case "PROPPATCH":
        return this.proppatch(path, body);
    }
    return new Response("method", { status: 405 });
  }

  private ms(responses: string): Response {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">${responses}</D:multistatus>`;
    return new Response(xml, { status: 207, headers: { "content-type": "application/xml" } });
  }

  private bookResponse(href: string, b: Book): string {
    const ctag = Array.from(b.resources.values()).map((r) => r.etag).join("");
    return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>
      <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
      <D:displayname>${esc(b.displayName)}</D:displayname>
      ${b.description ? `<C:addressbook-description>${esc(b.description)}</C:addressbook-description>` : ""}
      <CS:getctag>"${esc(ctag)}"</CS:getctag>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }

  private propfind(path: string, depth: string, body: string): Response {
    if (path === "/") {
      return this.ms(`<D:response><D:href>/</D:href><D:propstat><D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:current-user-principal><D:href>${PRINCIPAL}</D:href></D:current-user-principal>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    }
    if (path === PRINCIPAL) {
      return this.ms(`<D:response><D:href>${PRINCIPAL}</D:href><D:propstat><D:prop>
        <C:addressbook-home-set><D:href>${HOME}</D:href></C:addressbook-home-set>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    }
    if (path === HOME) {
      const self = `<D:response><D:href>${HOME}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      if (depth === "0") return this.ms(self);
      return this.ms(self + Array.from(this.books.entries()).map(([h, b]) => this.bookResponse(h, b)).join(""));
    }
    const book = this.books.get(path);
    if (book) {
      let out = this.bookResponse(path, book);
      if (depth === "1") {
        for (const [h, r] of book.resources) {
          out += `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:resourcetype/><D:getetag>${esc(r.etag)}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
        }
      }
      return this.ms(out);
    }
    void body;
    return new Response("not found", { status: 404 });
  }

  private report(path: string, body: string): Response {
    const book = this.books.get(path);
    if (!book) return new Response("not found", { status: 404 });
    const hrefs = Array.from(body.matchAll(/<D:href>([^<]+)<\/D:href>/g)).map((m) => m[1]!);
    let out = "";
    for (const h of hrefs) {
      const r = book.resources.get(h);
      if (!r) {
        out += `<D:response><D:href>${h}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
        continue;
      }
      out += `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:getetag>${esc(r.etag)}</D:getetag><C:address-data>${esc(r.data)}</C:address-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
    }
    return this.ms(out);
  }

  private bookFor(resourcePath: string): [string, Book] | null {
    for (const [h, b] of this.books) if (resourcePath.startsWith(h)) return [h, b];
    return null;
  }

  private put(path: string, headers: Record<string, string>, body: string): Response {
    const hit = this.bookFor(path);
    if (!hit) return new Response("no such collection", { status: 409 });
    const [, book] = hit;
    const existing = book.resources.get(path);
    if (headers["if-none-match"] === "*" && existing) return new Response("exists", { status: 412 });
    if (headers["if-match"] && (!existing || existing.etag !== headers["if-match"])) {
      return new Response("etag mismatch", { status: 412 });
    }
    if (!/^text\/vcard/.test(headers["content-type"] ?? "")) return new Response("type", { status: 415 });
    if (!/BEGIN:VCARD/.test(body) || !/\r\nUID:/.test(body)) return new Response("bad vcard", { status: 400 });
    const etag = this.nextEtag();
    book.resources.set(path, { data: body, etag });
    return new Response(null, { status: existing ? 204 : 201, headers: { etag } });
  }

  private delete(path: string, headers: Record<string, string>): Response {
    if (this.books.has(path)) {
      this.books.delete(path);
      return new Response(null, { status: 204 });
    }
    const hit = this.bookFor(path);
    if (!hit) return new Response("not found", { status: 404 });
    const [, book] = hit;
    const existing = book.resources.get(path);
    if (!existing) return new Response("not found", { status: 404 });
    if (headers["if-match"] && existing.etag !== headers["if-match"]) return new Response("etag", { status: 412 });
    book.resources.delete(path);
    return new Response(null, { status: 204 });
  }

  private mkcol(path: string, body: string): Response {
    if (this.books.has(path)) return new Response("exists", { status: 405 });
    if (!path.startsWith(HOME)) return new Response("conflict", { status: 409 });
    if (!/<C:addressbook\/>/.test(body)) return new Response("not an addressbook", { status: 403 });
    if (this.sogoMkcol) {
      const leaf = path.replace(/\/+$/, "").split("/").pop()!;
      this.books.set(path, { displayName: leaf, description: null, resources: new Map() });
      return new Response(null, { status: 201 });
    }
    const name = /<D:displayname>([^<]*)<\/D:displayname>/.exec(body)?.[1] ?? "";
    const desc = /<C:addressbook-description>([^<]*)<\/C:addressbook-description>/.exec(body)?.[1] ?? null;
    this.books.set(path, { displayName: unesc(name), description: desc ? unesc(desc) : null, resources: new Map() });
    return new Response(null, { status: 201 });
  }

  private proppatch(path: string, body: string): Response {
    const book = this.books.get(path);
    if (!book) return new Response("not found", { status: 404 });
    const name = /<D:displayname>([^<]*)<\/D:displayname>/.exec(body)?.[1];
    if (name !== undefined) book.displayName = unesc(name);
    const desc = /<C:addressbook-description>([^<]*)<\/C:addressbook-description>/.exec(body)?.[1];
    if (desc !== undefined) book.description = unesc(desc);
    if (/<D:remove>[\s\S]*addressbook-description/.test(body)) book.description = null;
    return this.ms(`<D:response><D:href>${path}</D:href><D:propstat><D:prop><D:displayname/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function unesc(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Route globalThis.fetch to `dav` (undo with vi.unstubAllGlobals()). */
export function installFakeDav(dav: FakeDav): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      if (init?.signal?.aborted) throw init.signal.reason ?? new Error("aborted");
      return dav.serve(init?.method ?? "GET", url, headers, typeof init?.body === "string" ? init.body : "", init?.signal);
    }),
  );
}
