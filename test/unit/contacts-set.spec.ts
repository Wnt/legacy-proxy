// End-to-end tests for the CardDAV write path (ContactCard/set and
// AddressBook/set) against an in-memory fake DAV server bolted onto
// globalThis.fetch. The fake speaks just enough PROPFIND / REPORT / PUT /
// DELETE / MKCOL / PROPPATCH to exercise the real client + handlers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressBookGet,
  addressBookSet,
  contactCardGet,
  contactCardSet,
  contactCardQuery,
  applyPatch,
  type ContactCtx,
} from "../../src/jmap/methods/contacts.js";
import type { AccountRow } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";
import { resetCardDavCaches } from "../../src/carddav/client.js";
import { FakeDav, HOME, PRINCIPAL, installFakeDav } from "../support/fake-dav.js";

// -- fixtures -----------------------------------------------------------------

const provider: ProviderConfig = {
  imap: { host: "imap.test", port: 993 },
  smtp: { host: "smtp.test", port: 465 },
  sieve: null,
  carddav: { host: "dav.test", port: 443, secure: true, basePath: "/" },
  auth: { mech: ["PLAIN"] },
};

const ctx: ContactCtx = {
  account: { id: 7, username: "u" } as AccountRow,
  provider,
  creds: { mech: "PLAIN", username: "u", password: "p" },
};

const ALICE = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "UID:alice-uid",
  "FN:Alice Example",
  "N:Example;Alice;;;",
  "EMAIL;TYPE=work:alice@example.test",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==",
  "X-CUSTOM-THING:keep me",
  "END:VCARD",
  "",
].join("\r\n");

let dav: FakeDav;

describe("security: contact resource boundaries", () => {
  // No network is used: the real handler and CardDavClient run against fetch mocks.
  function recordForeign(prefix: string): RequestInit[] {
    const original = globalThis.fetch;
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
      if (String(input instanceof URL ? input.href : input).startsWith(prefix)) {
        seen.push(init!);
        return new Response(null, { status: 204 });
      }
      return original(input, init);
    }));
    return seen;
  }

  it("rejects patch paths that mutate the process-wide object prototype", async () => {
    const book = dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const id = Buffer.from(`${book}\n${book}alice.vcf`).toString("base64url");
    const proto = Object.prototype as Record<string, unknown>;
    try {
      const result = await contactCardSet({ accountId: "7", update: {
        [id]: { "__proto__/auditContactMarker": "untrusted contact patch" },
      } }, ctx);
      expect(Object.hasOwn(proto, "auditContactMarker")).toBe(false);
      expect(result.notUpdated?.[id]?.type).toBe("invalidPatch");
    } finally {
      delete proto.auditContactMarker;
    }
  });

  it.each([
    "__proto__/x", "constructor/prototype/x", "name/__proto__/x", "emails/e1/constructor",
    "prototype", "emails~1x/__proto__",
  ])("rejects %s without touching the card or any prototype", async (path) => {
    const book = dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const id = Buffer.from(`${book}\n${book}alice.vcf`).toString("base64url");
    const before = dav.books.get(book)!.resources.get(`${book}alice.vcf`)!.data;
    const result = await contactCardSet({ accountId: "7", update: {
      [id]: { "name/full": "Changed", [path]: "polluted" },
    } }, ctx);
    expect(result.notUpdated?.[id]?.type).toBe("invalidPatch");
    expect(dav.books.get(book)!.resources.get(`${book}alice.vcf`)!.data).toBe(before);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "x")).toBe(false);
    expect(Object.hasOwn(Function.prototype, "x")).toBe(false);
  });

  it("does not send the mailbox password to a URL encoded in a contact id", async () => {
    const book = dav.addBook("personal", "Personal");
    const foreign = "https://collector.example.test/contact.vcf";
    const forgedId = Buffer.from(`${book}\n${foreign}`).toString("base64url");
    const foreignRequests = recordForeign("https://collector.example.test");

    const result = await contactCardSet({ accountId: "7", destroy: [forgedId] }, ctx);
    expect(foreignRequests.map((r) => new Headers(r.headers).get("authorization"))).toEqual([]);
    expect(result.notDestroyed?.[forgedId]?.type).toBe("notFound");
  });

  it("rejects forged ids on update and get without any request for them", async () => {
    const book = dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const other = dav.addBook("other", "Other", [["bob.vcf", ALICE.replace("alice-uid", "bob-uid")]]);
    const forged = [
      "https://collector.example.test/books/u/personal/x.vcf", // other host, member-shaped path
      "//collector.example.test/x.vcf",                           // scheme-relative
      "https://u:p@dav.test/books/u/personal/alice.vcf",         // userinfo
      "http://dav.test/books/u/personal/alice.vcf",              // other scheme
      `${book}../other/bob.vcf`,                                 // dot segments out of the book
      `${book}%2e%2e/other/bob.vcf`,                             // encoded dot segments
      `${book}sub/alice.vcf`,                                    // not a direct member
      `${book}a%2Fb.vcf`,                                        // encoded slash
      `${book}alice.vcf?x=1`,                                    // query
      `${other}bob.vcf`,                                         // member of another book
    ].map((href) => Buffer.from(`${book}\n${href}`).toString("base64url"));
    const foreignRequests = recordForeign("https://collector.example.test");
    const before = dav.calls.length;

    const upd = await contactCardSet({
      accountId: "7",
      update: Object.fromEntries(forged.map((id) => [id, { name: { full: "x" } }])),
    }, ctx);
    for (const id of forged) expect(upd.notUpdated?.[id]?.type).toBe("notFound");
    const got = await contactCardGet({ accountId: "7", ids: forged }, ctx);
    expect(got.list).toEqual([]);
    expect(got.notFound).toEqual(forged);
    const del = await contactCardSet({ accountId: "7", destroy: forged }, ctx);
    for (const id of forged) expect(del.notDestroyed?.[id]?.type).toBe("notFound");

    expect(foreignRequests).toEqual([]);
    // Nothing but listings reached the real server: no PUT, DELETE or REPORT.
    expect(dav.calls.slice(before).filter((c) => c.method !== "PROPFIND")).toEqual([]);
    expect(dav.books.get(other)!.resources.size).toBe(1);
  });

  it("still updates and deletes a real card whose id spells the href differently", async () => {
    const book = dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    // Same resource, absolute URL on the configured origin, as some servers report it.
    const id = Buffer.from(`${book}\nhttps://dav.test:443${book}alice.vcf`).toString("base64url");
    const del = await contactCardSet({ accountId: "7", destroy: [id] }, ctx);
    expect(del.destroyed).toEqual([id]);
    expect(dav.books.get(book)!.resources.size).toBe(0);
  });
});

beforeEach(() => {
  // Each case gets a fresh server behind the same origin+user, so the client's
  // cross-instance discovery/book caches must be cleared with it.
  resetCardDavCaches();
  dav = new FakeDav();
  installFakeDav(dav);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CardDAV request caching", () => {
  it("discovers the principal and home set once across calls", async () => {
    dav.addBook("default", "Default", [["alice.vcf", ALICE]]);

    await addressBookGet({ accountId: "7", ids: null }, ctx);
    const discoveryPaths = (p: string) => p === "/" || p === PRINCIPAL;
    const firstPass = dav.calls.filter((c) => c.method === "PROPFIND" && discoveryPaths(c.path)).length;
    expect(firstPass).toBeGreaterThan(0);

    // A second contacts call on the same account must not re-walk discovery.
    await addressBookGet({ accountId: "7", ids: null }, ctx);
    const secondPass = dav.calls.filter((c) => c.method === "PROPFIND" && discoveryPaths(c.path)).length;
    expect(secondPass).toBe(firstPass);
  });

  it("serves unchanged vCards from cache instead of re-issuing REPORTs", async () => {
    dav.addBook("default", "Default", [["alice.vcf", ALICE]]);

    const first = await contactCardGet({ accountId: "7", ids: null }, ctx);
    expect(first.list).toHaveLength(1);
    const reportsAfterFirst = dav.calls.filter((c) => c.method === "REPORT").length;
    expect(reportsAfterFirst).toBeGreaterThan(0);

    // Same etags => the bodies we already hold are still current.
    const second = await contactCardGet({ accountId: "7", ids: null }, ctx);
    expect(second.list).toEqual(first.list);
    expect(dav.calls.filter((c) => c.method === "REPORT").length).toBe(reportsAfterFirst);
  });

  it("re-fetches a vCard once its etag moves", async () => {
    const href = dav.addBook("default", "Default", [["alice.vcf", ALICE]]);
    const { cardIds } = await ids();
    const reportsBefore = dav.calls.filter((c) => c.method === "REPORT").length;

    // Rewrite the card server-side, giving it a new etag, and drop the
    // listing cache the way a write through this proxy would.
    const book = dav.books.get(href)!;
    const res = book.resources.get(href + "alice.vcf")!;
    res.data = res.data.replace("Alice Example", "Alice Renamed");
    res.etag = dav.nextEtag();
    resetCardDavCaches();

    const after = await contactCardGet({ accountId: "7", ids: cardIds }, ctx);
    expect(dav.calls.filter((c) => c.method === "REPORT").length).toBeGreaterThan(reportsBefore);
    expect(JSON.stringify(after.list)).toContain("Alice Renamed");
  });

  it("re-lists address books after a write invalidates the cache", async () => {
    dav.addBook("default", "Default", [["alice.vcf", ALICE]]);
    const { bookId, cardIds } = await ids();
    const listsBefore = dav.calls.filter((c) => c.method === "PROPFIND" && c.path === HOME).length;

    // A read served from cache adds no PROPFIND on the home set...
    await addressBookGet({ accountId: "7", ids: null }, ctx);
    expect(dav.calls.filter((c) => c.method === "PROPFIND" && c.path === HOME).length).toBe(listsBefore);

    // ...but a destroy must, so the returned state reflects the new ctag.
    await contactCardSet({ accountId: "7", destroy: [cardIds[0]!] }, ctx);
    expect(dav.calls.filter((c) => c.method === "PROPFIND" && c.path === HOME).length).toBeGreaterThan(listsBefore);
    expect(bookId).toBeTruthy();
  });
});

describe("a write through the proxy is listed at once", () => {
  // Within the listing cache's lifetime (15 s), right after a listing.
  const fullNames = async () =>
    (await contactCardGet({ accountId: "7", ids: null }, ctx)).list.map((c) => (c as { name?: { full?: string } }).name?.full).sort();

  it("a card created, renamed and destroyed (Bulwark's trusted-sender add is a create)", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const { bookId } = await ids();
    expect(await fullNames()).toEqual(["Alice Example"]);

    const res = await contactCardSet({ accountId: "7", create: { b: {
      addressBookIds: { [bookId]: true }, name: { full: "Bob Builder" }, emails: { e: { address: "bob@example.test" } },
    } } }, ctx);
    const bob = res.created!["b"]!.id;
    expect((await contactCardQuery({ accountId: "7" }, ctx)).ids).toContain(bob);
    expect(await fullNames()).toEqual(["Alice Example", "Bob Builder"]);

    await contactCardSet({ accountId: "7", update: { [bob]: { name: { full: "Bob Renamed" } } } }, ctx);
    expect(await fullNames()).toEqual(["Alice Example", "Bob Renamed"]);

    await contactCardSet({ accountId: "7", destroy: [bob] }, ctx);
    expect((await contactCardQuery({ accountId: "7" }, ctx)).ids).not.toContain(bob);
    expect(await fullNames()).toEqual(["Alice Example"]);
  });

  it("a book destroyed and created again under the same name starts empty", async () => {
    const href = dav.addBook("trusted", "Trusted", [["alice.vcf", ALICE]]);
    expect(await fullNames()).toEqual(["Alice Example"]);
    const id = Buffer.from(href).toString("base64url");
    expect((await addressBookSet({ accountId: "7", destroy: [id], onDestroyRemoveContents: true }, ctx)).destroyed).toEqual([id]);
    expect(await fullNames()).toEqual([]);
    const made = await addressBookSet({ accountId: "7", create: { t: { name: "trusted" } } }, ctx);
    expect(Buffer.from(made.created!["t"]!.id, "base64url").toString()).toBe(href);
    expect(await fullNames()).toEqual([]);
  });
});

async function ids(): Promise<{ bookId: string; cardIds: string[] }> {
  const books = await addressBookGet({ accountId: "7", ids: null }, ctx);
  const q = await contactCardQuery({ accountId: "7" }, ctx);
  return { bookId: books.list[0]!.id, cardIds: q.ids };
}

// -- ContactCard/set ------------------------------------------------------------

describe("ContactCard/set", () => {
  it("creates a card with PUT + If-None-Match and returns a fetchable id", async () => {
    dav.addBook("personal", "Personal");
    const { bookId } = await ids();

    const res = await contactCardSet(
      {
        accountId: "7",
        create: {
          "new-contact": {
            "@type": "Card",
            uid: "urn:uuid:new-1",
            addressBookIds: { [bookId]: true },
            name: { components: [{ kind: "given", value: "Bob" }, { kind: "surname", value: "Builder" }] },
            emails: { e1: { address: "bob@example.test", contexts: { work: true } } },
            phones: { p1: { number: "+1 555 0100", features: { mobile: true } } },
          },
        },
      },
      ctx,
    );

    expect(res.notCreated).toBeNull();
    const created = res.created?.["new-contact"];
    expect(created?.id).toBeTruthy();
    expect(res.newState).not.toBe(res.oldState);

    const put = dav.calls.find((c) => c.method === "PUT");
    expect(put?.headers["if-none-match"]).toBe("*");
    expect(put?.headers["content-type"]).toMatch(/^text\/vcard/);
    expect(put?.body).toContain("UID:urn:uuid:new-1");
    expect(put?.body).toContain("FN:Bob Builder");
    expect(put?.body).toContain("N:Builder;Bob;;;");
    expect(put?.body).toContain("EMAIL;TYPE=work:bob@example.test");
    expect(put?.body).toContain("TEL;TYPE=cell:+1 555 0100");

    // The id round-trips through ContactCard/get (what webmail does next).
    const got = await contactCardGet({ accountId: "7", ids: [created!.id] }, ctx);
    expect(got.notFound).toEqual([]);
    expect(got.list[0]).toMatchObject({
      id: created!.id,
      uid: "urn:uuid:new-1",
      name: { full: "Bob Builder" },
      addressBookIds: { [bookId]: true },
    });
  });

  it("falls back to the first address book and mints a uid when none is given", async () => {
    dav.addBook("personal", "Personal");
    const res = await contactCardSet(
      { accountId: "7", create: { c: { name: { full: "No Book" } } } },
      ctx,
    );
    expect(res.created?.["c"]?.uid).toMatch(/^urn:uuid:/);
    const put = dav.calls.find((c) => c.method === "PUT");
    expect(put?.path.startsWith(`${HOME}personal/`)).toBe(true);
  });

  it("auto-creates a default book when the account has none (fresh Radicale)", async () => {
    const res = await contactCardSet(
      { accountId: "7", create: { c: { name: { full: "First Ever" } } } },
      ctx,
    );
    expect(res.notCreated).toBeNull();
    const mkcol = dav.calls.find((c) => c.method === "MKCOL");
    expect(mkcol?.path).toBe(`${HOME}contacts/`);
    expect(mkcol?.body).toContain("<D:displayname>Contacts</D:displayname>");
    const put = dav.calls.find((c) => c.method === "PUT");
    expect(put?.path.startsWith(`${HOME}contacts/`)).toBe(true);
    const books = await addressBookGet({ accountId: "7", ids: null }, ctx);
    expect(books.list.map((b) => b.name)).toEqual(["Contacts"]);
  });

  it("does not auto-create a book when an explicit (unknown) addressBookId is given", async () => {
    const res = await contactCardSet(
      { accountId: "7", create: { c: { name: { full: "Nowhere" }, addressBookIds: { bogus: true } } } },
      ctx,
    );
    expect(res.notCreated?.["c"]).toMatchObject({ type: "invalidProperties", properties: ["addressBookIds"] });
    expect(dav.calls.some((c) => c.method === "PUT" || c.method === "MKCOL")).toBe(false);
  });

  it("updates in place, preserving unmodelled properties and using If-Match", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const { cardIds } = await ids();
    const [aliceId] = cardIds;

    const res = await contactCardSet(
      {
        accountId: "7",
        update: {
          [aliceId!]: {
            id: aliceId, // echoed back unchanged — must be tolerated
            uid: "alice-uid",
            name: { full: "Alice Changed", components: [{ kind: "given", value: "Alice" }, { kind: "surname", value: "Changed" }] },
            "emails/e1/address": "alice+new@example.test",
            notes: { n1: { note: "line one\nline two" } },
          },
        },
      },
      ctx,
    );

    expect(res.notUpdated).toBeNull();
    expect(res.updated).toEqual({ [aliceId!]: null });

    const put = dav.calls.find((c) => c.method === "PUT")!;
    expect(put.headers["if-match"]).toBe('"e1"');
    expect(put.body).toContain("FN:Alice Changed");
    expect(put.body).toContain("EMAIL;TYPE=work:alice+new@example.test");
    expect(put.body).toContain("NOTE:line one\\nline two");
    // Properties we don't model survive the round trip.
    expect(put.body).toContain("PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==");
    expect(put.body).toContain("X-CUSTOM-THING:keep me");
    expect(put.body).toContain("UID:alice-uid");
    expect(put.body.match(/^FN:/gm)).toHaveLength(1);
  });

  it("removes a sub-property when patched with null", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const { cardIds } = await ids();
    const res = await contactCardSet({ accountId: "7", update: { [cardIds[0]!]: { "emails/e1": null } } }, ctx);
    expect(res.updated).toEqual({ [cardIds[0]!]: null });
    const put = dav.calls.find((c) => c.method === "PUT")!;
    expect(put.body).not.toContain("EMAIL");
  });

  it("refuses to move a card between books or change its uid", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const other = dav.addBook("other", "Other");
    const { cardIds } = await ids();
    const otherId = Buffer.from(other, "utf8").toString("base64url");
    const res = await contactCardSet(
      {
        accountId: "7",
        update: {
          [cardIds[0]!]: { addressBookIds: { [otherId]: true } },
        },
      },
      ctx,
    );
    expect(res.notUpdated?.[cardIds[0]!]).toMatchObject({ type: "invalidProperties", properties: ["addressBookIds"] });
    expect(dav.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("reports stateMismatch when the server-side ETag moved underneath us", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const { cardIds } = await ids();
    // Simulate another client editing between our read and our write.
    const originalHandle = dav.handle.bind(dav);
    dav.handle = (method, url, headers, body) => {
      if (method === "PUT") {
        const book = dav.books.get(`${HOME}personal/`)!;
        const r = book.resources.get(`${HOME}personal/alice.vcf`)!;
        r.etag = '"moved"';
      }
      return originalHandle(method, url, headers, body);
    };
    const res = await contactCardSet({ accountId: "7", update: { [cardIds[0]!]: { name: { full: "X" } } } }, ctx);
    expect(res.notUpdated?.[cardIds[0]!]?.type).toBe("stateMismatch");
  });

  it("destroys via DELETE and reports unknown ids as notFound", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const { cardIds } = await ids();
    const bogus = Buffer.from(`${HOME}personal/\n${HOME}personal/nope.vcf`).toString("base64url");
    const res = await contactCardSet({ accountId: "7", destroy: [cardIds[0]!, bogus, "garbage"] }, ctx);
    // A DELETE on a missing resource is idempotent success on the DAV side;
    // ids that don't decode to a known book are notFound.
    expect(res.destroyed).toEqual([cardIds[0]!, bogus]);
    expect(res.notDestroyed).toEqual({ garbage: { type: "notFound" } });
    expect(dav.books.get(`${HOME}personal/`)!.resources.size).toBe(0);
  });

  it("honours ifInState", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    await expect(
      contactCardSet({ accountId: "7", ifInState: "stale", destroy: [] }, ctx),
    ).rejects.toMatchObject({ type: "stateMismatch" });
  });

  it("rejects a foreign accountId", async () => {
    await expect(contactCardSet({ accountId: "8" }, ctx)).rejects.toMatchObject({ type: "accountNotFound" });
  });
});

// -- AddressBook/set ------------------------------------------------------------

describe("AddressBook/set", () => {
  it("creates a collection with extended MKCOL and returns server-set props", async () => {
    dav.addBook("personal", "Personal");
    const res = await addressBookSet(
      { accountId: "7", create: { "new-book": { name: "Work Friends", description: "colleagues" } } },
      ctx,
    );
    expect(res.notCreated).toBeNull();
    const created = res.created?.["new-book"];
    expect(created?.id).toBe(Buffer.from(`${HOME}work-friends/`).toString("base64url"));
    expect(created).toMatchObject({ isDefault: false, myRights: { mayWrite: true, mayDelete: true } });

    const mkcol = dav.calls.find((c) => c.method === "MKCOL")!;
    expect(mkcol.path).toBe(`${HOME}work-friends/`);
    expect(mkcol.body).toContain("<C:addressbook/>");
    expect(mkcol.body).toContain("<D:displayname>Work Friends</D:displayname>");
    expect(mkcol.body).toContain("<C:addressbook-description>colleagues</C:addressbook-description>");

    const books = await addressBookGet({ accountId: "7", ids: null }, ctx);
    expect(books.list.map((b) => b.name)).toEqual(["Personal", "Work Friends"]);
  });

  it("falls back to a UUID slug for non-ASCII or colliding names", async () => {
    dav.addBook("personal", "Personal");
    const res = await addressBookSet(
      { accountId: "7", create: { a: { name: "Personal" }, b: { name: "Freunde – Zürich" } } },
      ctx,
    );
    expect(res.notCreated).toBeNull();
    const paths = dav.calls.filter((c) => c.method === "MKCOL").map((c) => c.path);
    expect(paths[0]).toMatch(new RegExp(`^${HOME}[0-9a-f-]{36}/$`));
    expect(paths[1]).toBe(`${HOME}freunde-z-rich/`);
  });

  it("renames via PROPPATCH and ignores client-only preferences", async () => {
    const href = dav.addBook("personal", "Personal");
    const id = Buffer.from(href).toString("base64url");
    const res = await addressBookSet(
      { accountId: "7", update: { [id]: { name: "Renamed", isDefault: true, color: "#f00" } } },
      ctx,
    );
    expect(res.updated).toEqual({ [id]: null });
    expect(dav.books.get(href)!.displayName).toBe("Renamed");
    const pp = dav.calls.find((c) => c.method === "PROPPATCH")!;
    expect(pp.body).toContain("<D:displayname>Renamed</D:displayname>");
  });

  it("rejects unsupported properties and empty names", async () => {
    const href = dav.addBook("personal", "Personal");
    const id = Buffer.from(href).toString("base64url");
    const res = await addressBookSet(
      {
        accountId: "7",
        create: { x: { name: "   " } },
        update: { [id]: { "shareWith/someone": { mayRead: true } } },
      },
      ctx,
    );
    expect(res.notCreated?.["x"]).toMatchObject({ type: "invalidProperties", properties: ["name"] });
    expect(res.notUpdated?.[id]).toMatchObject({ type: "invalidProperties", properties: ["shareWith/someone"] });
  });

  it("refuses to destroy a non-empty book unless onDestroyRemoveContents", async () => {
    const href = dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const id = Buffer.from(href).toString("base64url");

    const refused = await addressBookSet({ accountId: "7", destroy: [id] }, ctx);
    expect(refused.notDestroyed).toEqual({ [id]: { type: "addressBookHasContents" } });
    expect(dav.books.has(href)).toBe(true);

    const ok = await addressBookSet({ accountId: "7", destroy: [id], onDestroyRemoveContents: true }, ctx);
    expect(ok.destroyed).toEqual([id]);
    expect(dav.books.has(href)).toBe(false);
  });
});

// -- servers that drop MKCOL properties (SOGo, Gandi) -------------------------

describe("AddressBook/set on a server that ignores the MKCOL body", () => {
  // SOGo answers 201 to an extended MKCOL but names the collection after its
  // URL leaf. A client that looks its book up by name (Bulwark's "Trusted
  // Senders") then never found it and created another one on every load.
  const findOrCreate = async (name: string): Promise<string> => {
    const books = await addressBookGet({ accountId: "7", ids: null }, ctx);
    const hit = books.list.find((b) => b.name === name);
    if (hit) return hit.id;
    const res = await addressBookSet({ accountId: "7", create: { b: { name } } }, ctx);
    expect(res.notCreated).toBeNull();
    return res.created!["b"]!.id;
  };

  it("sets the name with PROPPATCH, so a find-or-create client creates the book once", async () => {
    dav.sogoMkcol = true;
    dav.addBook("personal", "Personal Address Book");
    const first = await findOrCreate("Trusted Senders");
    for (let load = 0; load < 3; load++) expect(await findOrCreate("Trusted Senders")).toBe(first);

    expect(dav.calls.filter((c) => c.method === "MKCOL")).toHaveLength(1);
    expect(dav.books.get(Buffer.from(first, "base64url").toString())!.displayName).toBe("Trusted Senders");
    const books = await addressBookGet({ accountId: "7", ids: null }, ctx);
    expect(books.list.map((b) => b.name)).toEqual(["Personal Address Book", "Trusted Senders"]);
  });

  it("also names a colliding (UUID-slug) book and the description", async () => {
    dav.sogoMkcol = true;
    dav.addBook("trusted-senders", "trusted-senders");
    const res = await addressBookSet({ accountId: "7", create: { b: { name: "Trusted Senders", description: "allow list" } } }, ctx);
    const href = Buffer.from(res.created!["b"]!.id, "base64url").toString();
    expect(href).toMatch(new RegExp(`^${HOME}[0-9a-f-]{36}/$`));
    expect(dav.books.get(href)).toMatchObject({ displayName: "Trusted Senders", description: "allow list" });
  });

  it("does not PROPPATCH when the MKCOL body was honoured", async () => {
    await addressBookSet({ accountId: "7", create: { b: { name: "Work" } } }, ctx);
    expect(dav.calls.filter((c) => c.method === "PROPPATCH")).toHaveLength(0);
  });

  it("removes the new collection again when the name cannot be set at all", async () => {
    dav.sogoMkcol = true;
    const serve = dav.serve.bind(dav);
    dav.serve = async (method, url, headers, body, signal) =>
      method === "PROPPATCH" ? new Response("forbidden", { status: 403 }) : serve(method, url, headers, body, signal);
    const res = await addressBookSet({ accountId: "7", create: { b: { name: "Trusted Senders" } } }, ctx);
    expect(res.created).toBeNull();
    expect(res.notCreated?.["b"]).toBeDefined();
    expect([...dav.books.keys()]).toEqual([]);
  });
});

// -- ContactCard/query over many books ----------------------------------------

describe("ContactCard/query", () => {
  const vcard = (uid: string, fn: string, email: string) =>
    ["BEGIN:VCARD", "VERSION:4.0", `UID:${uid}`, `FN:${fn}`, `EMAIL:${email}`, "END:VCARD", ""].join("\r\n");

  it("lists the books' resources concurrently, not one PROPFIND after another", async () => {
    for (let i = 0; i < 12; i++) dav.addBook(`b${String(i).padStart(2, "0")}`, `Book ${i}`, [[`c${i}.vcf`, vcard(`u${i}`, `Name ${i}`, `n${i}@example.test`)]]);
    await addressBookGet({ accountId: "7", ids: null }, ctx);
    dav.delayMs = 20;
    dav.maxInflight = 0;
    const res = await contactCardQuery({ accountId: "7" }, ctx);
    expect(res.total).toBe(12);
    expect(dav.maxInflight).toBeGreaterThan(1);
    expect(dav.maxInflight).toBeLessThanOrEqual(4);
    // Book order is kept.
    expect(res.ids.map((id) => Buffer.from(id, "base64url").toString().split("\n")[0])).toEqual(
      [...dav.books.keys()],
    );
  });

  it("applies a text filter (name, email) instead of returning every card", async () => {
    dav.addBook("personal", "Personal", [
      ["a.vcf", vcard("ua", "Erkki Esimerkki", "erkki@examplepaja.test")],
      ["b.vcf", vcard("ub", "Maija Malli", "maija@sample.test")],
      ["c.vcf", vcard("uc", "Examplepaja Oy", "info@other.test")],
    ]);
    const byText = async (text: string) => {
      const q = await contactCardQuery({ accountId: "7", filter: { text } }, ctx);
      const g = await contactCardGet({ accountId: "7", ids: q.ids }, ctx);
      return g.list.map((c) => c.uid).sort();
    };
    expect(await byText("examplepaja")).toEqual(["ua", "uc"]);
    expect(await byText("MAIJA")).toEqual(["ub"]);
    expect(await byText("nobody")).toEqual([]);
    const email = await contactCardQuery({ accountId: "7", filter: { email: "sample.test" } }, ctx);
    expect(email.total).toBe(1);
  });

  it("rejects filters it cannot evaluate rather than ignoring them", async () => {
    dav.addBook("personal", "Personal");
    await expect(contactCardQuery({ accountId: "7", filter: { hasMember: "x" } }, ctx)).rejects.toMatchObject({ type: "unsupportedFilter" });
    await expect(
      contactCardQuery({ accountId: "7", filter: { operator: "OR", conditions: [] } }, ctx),
    ).rejects.toMatchObject({ type: "unsupportedFilter" });
  });

  it("stops reading from the CardDAV server once the request is aborted", async () => {
    for (let i = 0; i < 8; i++) dav.addBook(`b${i}`, `Book ${i}`);
    await addressBookGet({ accountId: "7", ids: null }, ctx);
    dav.delayMs = 50;
    const abort = new AbortController();
    const p = contactCardQuery({ accountId: "7" }, { ...ctx, signal: abort.signal });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    await expect(p).rejects.toBeDefined();
    const before = dav.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(dav.calls.length).toBe(before);
  });
});

// -- patch helper ---------------------------------------------------------------

describe("applyPatch", () => {
  it("does not follow inherited properties", () => {
    const o: Record<string, unknown> = {};
    applyPatch(o, { "toString/x": 1 });
    expect(Object.hasOwn(o, "toString")).toBe(true);
    expect((Object.prototype.toString as unknown as Record<string, unknown>).x).toBeUndefined();
  });

  it("sets nested paths, replaces top-level keys, and deletes on null", () => {
    const o: Record<string, unknown> = { emails: { e1: { address: "a@x" }, e2: { address: "b@x" } }, name: { full: "A" } };
    applyPatch(o, { "emails/e1/address": "z@x", "emails/e2": null, name: { full: "B" }, "notes/n1": { note: "hi" } });
    expect(o).toEqual({ emails: { e1: { address: "z@x" } }, name: { full: "B" }, notes: { n1: { note: "hi" } } });
  });

  it("rejects empty path segments", () => {
    expect(() => applyPatch({}, { "a//b": 1 })).toThrow(/bad path/);
  });
});
