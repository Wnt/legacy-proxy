// The CardDAV client sends the mailbox password with every request, so every
// URL it requests must be on the configured server. These cases drive the
// real client against fetch mocks; no network is used.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardDavClient, resetCardDavCaches } from "../../src/carddav/client.js";

const creds = { mech: "PLAIN" as const, username: "u", password: "p" };

function client(basePath = "/dav/"): CardDavClient {
  return new CardDavClient({ host: "dav.test", port: 443, secure: true, basePath, creds });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let requests: Array<{ url: string; auth: string | null; method: string }>;

function serve(handler: Handler): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input instanceof URL ? input.href : input);
    requests.push({ url, auth: new Headers(init.headers).get("authorization"), method: init.method ?? "GET" });
    return handler(url, init);
  }));
}

const ms = (body: string): Response =>
  new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${body}</D:multistatus>`, { status: 207 });

beforeEach(() => {
  resetCardDavCaches();
  requests = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("CardDavClient.resolve", () => {
  const c = client();
  it("accepts paths and absolute URLs on the configured origin", () => {
    expect(c.resolve("/dav/u/").href).toBe("https://dav.test/dav/u/");
    expect(c.resolve("dav/u/").href).toBe("https://dav.test/dav/u/");
    expect(c.resolve("https://DAV.test:443/dav/u/").href).toBe("https://dav.test/dav/u/");
  });
  it.each([
    "https://evil.test/dav/u/",
    "//evil.test/dav/u/",
    "http://dav.test/dav/u/",
    "https://dav.test:8443/dav/u/",
    "https://u:p@dav.test/dav/u/",
    "https://dav.test/dav/u/?q",
    "https://dav.test/dav/u/#f",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://dav.test@evil.test/",
  ])("rejects %s", (href) => {
    expect(() => c.resolve(href)).toThrow(/not on the configured server/);
  });
});

describe("CardDavClient.isMember", () => {
  const c = client();
  const book = "/dav/u/Contacts/personal/";
  it.each([
    [`${book}a.vcf`, true],
    ["https://dav.test/dav/u/Contacts/personal/a.vcf", true],
    ["/dav/u%2Dx/../u/Contacts/personal/a.vcf", true], // dot segments resolved first
    ["/dav/u/Contacts/%70ersonal/a.vcf", true],         // percent-encoding variant
    [`${book}`, false],
    [`${book}sub/a.vcf`, false],
    [`${book}../other/a.vcf`, false],
    [`${book}%2e%2e/other/a.vcf`, false],
    [`${book}a%2Fb.vcf`, false],
    ["/dav/u/Contacts/personal-2/a.vcf", false],
    ["https://evil.test/dav/u/Contacts/personal/a.vcf", false],
  ])("%s -> %s", (href, ok) => {
    expect(c.isMember(book, href)).toBe(ok);
  });
});

describe("CardDAV redirects", () => {
  it("does not follow a discovery redirect to another host", async () => {
    serve((url) =>
      url === "https://dav.test/dav/"
        ? new Response(null, { status: 301, headers: { location: "https://evil.test/dav/" } })
        : new Response("unexpected", { status: 500 }),
    );
    await expect(client().listAddressBooks()).rejects.toThrow(/not on the configured server/);
    expect(requests.map((r) => r.url)).toEqual(["https://dav.test/dav/"]);
  });

  it("does not follow a request redirect to another host", async () => {
    serve((url) =>
      url.startsWith("https://dav.test/")
        ? new Response(null, { status: 307, headers: { location: "https://evil.test/x.vcf" } })
        : new Response(null, { status: 204 }),
    );
    await expect(client().deleteResource("/dav/u/personal/x.vcf")).rejects.toThrow(/not on the configured server/);
    expect(requests.every((r) => r.url.startsWith("https://dav.test/"))).toBe(true);
  });

  it("follows a redirect on the same server, keeping the method", async () => {
    serve((url) =>
      url === "https://dav.test/dav/u/personal/x.vcf"
        ? new Response(null, { status: 308, headers: { location: "/dav/u/personal/y.vcf" } })
        : new Response(null, { status: 204 }),
    );
    await client().deleteResource("/dav/u/personal/x.vcf");
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["DELETE", "https://dav.test/dav/u/personal/x.vcf"],
      ["DELETE", "https://dav.test/dav/u/personal/y.vcf"],
    ]);
  });

  it("never lets fetch follow redirects itself", async () => {
    const inits: RequestInit[] = [];
    serve((_url, init) => {
      inits.push(init);
      return new Response(null, { status: 204 });
    });
    await client().deleteResource("/dav/u/personal/x.vcf");
    expect(inits.map((i) => i.redirect)).toEqual(["manual"]);
  });
});

describe("server-supplied hrefs", () => {
  function server(opts: { principal?: string; home?: string; books?: string[]; cards?: string[] }): void {
    serve((url, init) => {
      const path = new URL(url).pathname;
      if (path === "/dav/") {
        return ms(`<D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype>
          <D:current-user-principal><D:href>${opts.principal ?? "/dav/u/"}</D:href></D:current-user-principal></D:prop></D:propstat></D:response>`);
      }
      if (path === "/dav/u/" && init.headers && new Headers(init.headers).get("depth") === "0") {
        return ms(`<D:response><D:href>/dav/u/</D:href><D:propstat><D:prop>
          <C:addressbook-home-set><D:href>${opts.home ?? "/dav/u/books/"}</D:href></C:addressbook-home-set></D:prop></D:propstat></D:response>`);
      }
      if (path === "/dav/u/books/") {
        return ms((opts.books ?? []).map((h) => `<D:response><D:href>${h}</D:href><D:propstat><D:prop>
          <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>B</D:displayname></D:prop></D:propstat></D:response>`).join(""));
      }
      if (path === "/dav/u/books/a/") {
        return ms((opts.cards ?? []).map((h) => `<D:response><D:href>${h}</D:href><D:propstat><D:prop>
          <D:resourcetype/><D:getetag>"1"</D:getetag></D:prop></D:propstat></D:response>`).join(""));
      }
      return new Response("no", { status: 404 });
    });
  }

  it("rejects a principal on another host", async () => {
    server({ principal: "https://evil.test/dav/u/" });
    await expect(client().listAddressBooks()).rejects.toThrow(/not on the configured server/);
    expect(requests.every((r) => r.url.startsWith("https://dav.test/"))).toBe(true);
  });

  it("rejects a home set on another host", async () => {
    server({ home: "https://evil.test/dav/u/books/" });
    await expect(client().listAddressBooks()).rejects.toThrow(/not on the configured server/);
    expect(requests.every((r) => r.url.startsWith("https://dav.test/"))).toBe(true);
  });

  it("drops address books outside the home set and cards outside their book", async () => {
    server({
      books: ["/dav/u/books/a/", "https://evil.test/dav/u/books/b/", "/dav/other/c/"],
      cards: ["/dav/u/books/a/1.vcf", "https://evil.test/2.vcf", "/dav/u/books/b/3.vcf"],
    });
    const c = client();
    const books = await c.listAddressBooks();
    expect(books.map((b) => b.href)).toEqual(["/dav/u/books/a/"]);
    expect((await c.listResources("/dav/u/books/a/")).map((r) => r.href)).toEqual(["/dav/u/books/a/1.vcf"]);
    expect(requests.every((r) => r.url.startsWith("https://dav.test/"))).toBe(true);
  });
});
