// Per-account admission of JMAP requests (maxConcurrentRequests), in lanes.
//
// A single per-account queue let one kind of work starve every other: a
// full-text search runs for tens of seconds, and requests waiting for an IMAP
// connection behind it keep their slots, so once the slots were taken even a
// contact lookup or Core/echo -- which need no IMAP at all -- waited in line
// until the search finished. Each lane now has its own slots and queue:
//
//   - "search":   envelopes with a full-text Email/query (text/body terms),
//                 the long scans over every folder;
//   - "contacts": envelopes that need no IMAP connection at all (CardDAV
//                 contacts, Core/echo, Quota/get, PushSubscription);
//   - "mail":     everything else.
//
// The advertised maxConcurrentRequests applies per lane. That is more than a
// client sending at the advertised rate can use, so it changes nothing for a
// well-behaved client; it only stops one lane's backlog from blocking another.
import type { RequestEnvelope } from "./router.js";
import { KeyedLimiter } from "../util/limiter.js";

export type Lane = "search" | "contacts" | "mail";

// Methods served without an IMAP connection.
const NO_IMAP_METHODS = new Set([
  "Core/echo",
  "Quota/get",
  "AddressBook/get",
  "AddressBook/set",
  "AddressBook/changes",
  "ContactCard/get",
  "ContactCard/query",
  "ContactCard/set",
  "ContactCard/changes",
  "ContactCard/queryChanges",
  "PushSubscription/get",
  "PushSubscription/set",
]);

/** True when an Email/query filter (or any of its nested conditions) has a full-text term. */
function fullText(filter: unknown, depth = 0): boolean {
  if (!filter || typeof filter !== "object" || depth > 16) return false;
  const f = filter as Record<string, unknown>;
  if (Array.isArray(f["conditions"])) return f["conditions"].some((c) => fullText(c, depth + 1));
  const term = (k: string) => typeof f[k] === "string" && (f[k] as string).trim() !== "";
  return term("text") || term("body");
}

/** Which lane an envelope is admitted through. */
export function laneFor(env: RequestEnvelope): Lane {
  const calls = Array.isArray(env.methodCalls) ? env.methodCalls : [];
  let imap = false;
  for (const call of calls) {
    const name = Array.isArray(call) ? call[0] : undefined;
    const args = Array.isArray(call) ? call[1] : undefined;
    if (name === "Email/query" && fullText((args as { filter?: unknown } | undefined)?.filter)) return "search";
    if (typeof name !== "string" || !NO_IMAP_METHODS.has(name)) imap = true;
  }
  return imap || calls.length === 0 ? "mail" : "contacts";
}

export class RequestAdmission {
  private readonly limiter: KeyedLimiter;

  constructor(limit: number, maxQueued: number) {
    this.limiter = new KeyedLimiter(limit, maxQueued);
  }

  /** Run `fn` once the envelope's lane for `account` has a free slot (or throw LimitError). */
  run<T>(account: string, env: RequestEnvelope, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.limiter.run(`${account}|${laneFor(env)}`, fn, signal);
  }
}
