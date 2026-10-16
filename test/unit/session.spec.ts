import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { signSession, verifySession, makeSession } from "../../src/auth/session.js";

const KEY = crypto.randomBytes(32);

describe("session token", () => {
  it("roundtrips", () => {
    const t = makeSession({ accountSlug: "gmail:bob@x.io", username: "bob@x.io" });
    const tok = signSession(KEY, t);
    const back = verifySession(KEY, tok);
    expect(back?.accountSlug).toBe("gmail:bob@x.io");
  });
  it("rejects tampered tokens", () => {
    const t = makeSession({ accountSlug: "x", username: "x" });
    const tok = signSession(KEY, t);
    const tampered = tok.slice(0, -2) + "ab";
    expect(verifySession(KEY, tampered)).toBeNull();
  });
  it("rejects expired tokens", () => {
    const tok = signSession(KEY, {
      accountSlug: "x",
      username: "x",
      iat: 1,
      exp: 2,
    });
    expect(verifySession(KEY, tok)).toBeNull();
  });
  it("rejects signed tokens with an implausible shape or lifetime", () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      { accountSlug: "", username: "u", iat: now, exp: now + 60 },
      { accountSlug: "s", username: 5, iat: now, exp: now + 60 },
      { accountSlug: "s", username: "u", iat: "1", exp: now + 60 },
      { accountSlug: "s", username: "u", iat: now, exp: now + 0.5 },
      { accountSlug: "s", username: "u", iat: now + 3600, exp: now + 7200 }, // issued in the future
      { accountSlug: "s", username: "u", iat: now, exp: now + 400 * 24 * 3600 }, // lifetime too long
      { accountSlug: "s", username: "u", iat: now, exp: now }, // exp == now
    ];
    for (const t of bad) expect(verifySession(KEY, signSession(KEY, t as never))).toBeNull();
    for (const body of ["null", "[]", '"x"']) {
      const b = Buffer.from(body).toString("base64url");
      const sig = crypto.createHmac("sha256", KEY).update(b).digest("base64url");
      expect(verifySession(KEY, `${b}.${sig}`)).toBeNull();
    }
    // The gateway's 300 s tokens still verify.
    const ok = { accountSlug: "gandi:u@x", username: "u@x", iat: now, exp: now + 300 };
    expect(verifySession(KEY, signSession(KEY, ok))).toEqual(ok);
  });
  it("rejects signed tokens whose expiry is missing or nonnumeric", () => {
    // Tests issuer-error hardening, not a signature bypass: the fixture is
    // deliberately signed with the trusted test key.
    for (const exp of [undefined, "not-a-timestamp"]) {
      const tok = signSession(KEY, {
        accountSlug: "gandi:user@example.test", username: "user@example.test",
        iat: 1, exp,
      } as never);
      expect(verifySession(KEY, tok)).toBeNull();
    }
  });
});
