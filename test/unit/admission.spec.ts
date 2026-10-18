// Contacts and other short requests stay fast while long full-text searches
// run for the same account.
//
// Contact lookups once took as long as a running search: every request of an
// account went through one queue of maxConcurrentRequests slots, a search
// holds its slot for its whole run, and mail requests waiting for an IMAP
// connection behind it held theirs. Once the slots were full, a contact
// lookup -- which needs no IMAP at all -- waited for the search to finish.
// Requests are now admitted in lanes (search, contacts, mail).
//
// Everything here is synthetic: invented names, addresses and texts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeImapServer } from "../support/fake-imap.js";
import { startHarness, USING, type Harness } from "../support/harness.js";
import { FakeDav, installFakeDav } from "../support/fake-dav.js";
import { RequestAdmission, laneFor } from "../../src/jmap/admission.js";
import { resetCardDavCaches } from "../../src/carddav/client.js";
import type { MethodCall } from "../../src/jmap/router.js";

const CONTACTS = "urn:ietf:params:jmap:contacts";

let h: Harness | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  await h?.close();
  h = null;
});

const card = (uid: string, name: string, email: string) =>
  ["BEGIN:VCARD", "VERSION:4.0", `UID:${uid}`, `FN:${name}`, `EMAIL:${email}`, "END:VCARD", ""].join("\r\n");

describe("request lanes", () => {
  it("puts full-text searches, IMAP-free calls and other mail calls in separate lanes", () => {
    const env = (calls: MethodCall[]) => ({ using: USING, methodCalls: calls });
    expect(laneFor(env([["Email/query", { filter: { text: "examplepaja" } }, "0"]]))).toBe("search");
    expect(laneFor(env([["Email/query", { filter: { operator: "AND", conditions: [{ inMailbox: "m" }, { body: "x" }] } }, "0"]]))).toBe("search");
    expect(laneFor(env([["Email/query", { filter: { inMailbox: "m" } }, "0"], ["Email/get", {}, "1"]]))).toBe("mail");
    expect(laneFor(env([["Email/query", { filter: { text: "  " } }, "0"]]))).toBe("mail");
    expect(laneFor(env([["ContactCard/query", { filter: { text: "ex" } }, "0"], ["ContactCard/get", {}, "1"]]))).toBe("contacts");
    expect(laneFor(env([["AddressBook/get", {}, "0"], ["Core/echo", {}, "1"]]))).toBe("contacts");
    // Anything that touches IMAP keeps an envelope out of the contacts lane.
    expect(laneFor(env([["AddressBook/get", {}, "0"], ["Mailbox/get", {}, "1"]]))).toBe("mail");
    expect(laneFor(env([]))).toBe("mail");
  });
});

describe("a contact lookup during long searches", () => {
  it("answers while searches and the mail requests queued behind them are still running", async () => {
    const imap = new FakeImapServer([{ name: "INBOX" }, { name: "Archive", specialUse: "\\Archive" }]);
    for (let i = 0; i < 30; i++) {
      imap.add("INBOX", { from: "News <news@letters.test>", subject: `Weekly ${i}`, date: new Date(Date.now() - i * 86_400_000) });
      imap.add("Archive", { from: "Examplepaja <info@examplepaja.test>", subject: `Order ${i}`, date: new Date(Date.now() - (400 + i) * 86_400_000) });
    }
    // A full-text SEARCH takes long, as on a server without a text index.
    imap.commandDelayMs = (line) => (/SEARCH[\s\S]*\b(TEXT|BODY)\b/i.test(line) ? 1500 : 0);
    h = await startHarness(imap);

    resetCardDavCaches();
    const dav = new FakeDav();
    dav.userPass = "user@example.test:pw";
    dav.addBook("personal", "Personal", [
      ["a.vcf", card("urn:uuid:00000000-0000-4000-8000-000000000001", "Erkki Esimerkki", "erkki@examplepaja.test")],
      ["b.vcf", card("urn:uuid:00000000-0000-4000-8000-000000000002", "Maija Malli", "maija@sample.test")],
    ]);
    installFakeDav(dav);
    h.cfg.providers["fake"]!.carddav = { host: "dav.test", port: 443, secure: true, basePath: "/" };

    // As server.ts admits requests: one RequestAdmission, maxConcurrentRequests per lane.
    const limit = h.cfg.limits.maxConcurrentRequests;
    const admission = new RequestAdmission(limit, limit * 4);
    const send = (calls: MethodCall[]) => {
      const env = { using: [...USING, CONTACTS], methodCalls: calls };
      return admission.run(h!.accountId, env, () => h!.jmap(calls));
    };

    // Search-as-you-type: several different full-text searches at once, more
    // than the account's slots. Mail requests pile up behind them, waiting for
    // IMAP connections the searches hold.
    let settled = 0;
    const background: Promise<unknown>[] = [];
    for (const term of ["exa", "exam", "examp", "exampl", "example", "examplep"]) {
      background.push(
        send([["Email/query", { accountId: h.accountId, filter: { text: term }, sort: [{ property: "receivedAt", isAscending: false }], limit: 20 }, "s"]])
          .finally(() => settled++),
      );
    }
    for (let i = 0; i < limit + 2; i++) {
      background.push(send([["Mailbox/get", { accountId: h.accountId, properties: ["id"] }, "m"]]).finally(() => settled++));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(settled).toBe(0);

    // The contact lookup Bulwark's search box makes.
    const t0 = Date.now();
    const out = await send([
      ["ContactCard/query", { accountId: h.accountId, filter: { text: "examplepaja" }, limit: 50 }, "0"],
      ["ContactCard/get", { accountId: h.accountId, "#ids": { resultOf: "0", name: "ContactCard/query", path: "/ids" } }, "1"],
    ]);
    const ms = Date.now() - t0;
    const echo0 = Date.now();
    await send([["Core/echo", { ping: 1 }, "e"]]);
    const echoMs = Date.now() - echo0;

    // Answered before any search (or the mail queued behind them) finished.
    expect(settled).toBe(0);
    expect(ms).toBeLessThan(1000);
    expect(echoMs).toBeLessThan(500);
    expect(out[0]![0]).toBe("ContactCard/query");
    const got = out[1]![1] as { list: Array<{ emails: Record<string, { address: string }> }> };
    expect(got.list.map((c) => Object.values(c.emails)[0]!.address)).toEqual(["erkki@examplepaja.test"]);

    const results = await Promise.allSettled(background);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  }, 60_000);
});
