import crypto from "node:crypto";
import { b64uDecode, b64uEncode } from "../util/base64url.js";

export interface SessionToken {
  accountSlug: string;
  username: string;
  iat: number;
  exp: number;
}

export function signSession(key: Buffer, t: SessionToken): string {
  const body = b64uEncode(Buffer.from(JSON.stringify(t), "utf8"));
  const sig = b64uEncode(crypto.createHmac("sha256", key).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(key: Buffer, token: string): SessionToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = b64uEncode(crypto.createHmac("sha256", key).update(body).digest());
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64uDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  return validSession(parsed, Math.floor(Date.now() / 1000));
}

// The longest lifetime any issuer mints: /api/login's default below. The
// gateway's tokens live 300 s.
const MAX_LIFETIME_SEC = 7 * 24 * 60 * 60;
// Tolerated clock difference between the issuer and us.
const CLOCK_SKEW_SEC = 300;

// A correctly signed payload is still only trusted in shape: a token from a
// buggy issuer without a numeric `exp` would otherwise never expire, since
// `undefined < now` is false.
function validSession(v: unknown, now: number): SessionToken | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const t = v as Record<string, unknown>;
  if (typeof t.accountSlug !== "string" || t.accountSlug === "") return null;
  if (typeof t.username !== "string" || t.username === "") return null;
  if (!Number.isSafeInteger(t.iat) || !Number.isSafeInteger(t.exp)) return null;
  const iat = t.iat as number;
  const exp = t.exp as number;
  if (exp <= now || exp <= iat) return null;
  if (iat > now + CLOCK_SKEW_SEC || exp - iat > MAX_LIFETIME_SEC) return null;
  return { accountSlug: t.accountSlug, username: t.username, iat, exp };
}

export function makeSession(opts: { accountSlug: string; username: string; ttlSec?: number }): SessionToken {
  const now = Math.floor(Date.now() / 1000);
  return {
    accountSlug: opts.accountSlug,
    username: opts.username,
    iat: now,
    exp: now + Math.min(opts.ttlSec ?? MAX_LIFETIME_SEC, MAX_LIFETIME_SEC),
  };
}
