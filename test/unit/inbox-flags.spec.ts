// The INBOX flags the IDLE worker vouches for (src/push/inbox-flags.ts): when
// a request may skip its flags FETCH, and when it must not.
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetInboxFlags, INBOX_FLAGS_MAX_AGE_MS, inboxFlagsChanged, inboxFlagsToken, inboxGap, inboxListed,
  inboxSyncDone, inboxSyncQueued, inboxUnwatched, knownInboxFlags, rememberInboxFlags,
} from "../../src/push/inbox-flags.js";

const A = 1, UV = 7;
beforeEach(() => {
  __resetInboxFlags();
  inboxListed(A, UV, [10, 11, 12]);
});
const remember = (uid: number, flags: string[], token = inboxFlagsToken(A)) => rememberInboxFlags(A, UV, new Map([[uid, flags]]), token);

describe("inbox flags", () => {
  it("answers what a request read while the worker watched, and what the worker heard since", () => {
    remember(10, []);
    expect(knownInboxFlags(A, UV, 10)).toEqual([]);
    inboxFlagsChanged(A, 10, ["\\Seen"]);
    expect(knownInboxFlags(A, UV, 10)).toEqual(["\\Seen"]);
  });

  it("drops a read that a heard change or a gap overtook", () => {
    const token = inboxFlagsToken(A);
    inboxFlagsChanged(A, 11, ["\\Flagged"]); // heard while the FETCH was out
    remember(10, [], token);
    expect(knownInboxFlags(A, UV, 10)).toBeNull();
    const t2 = inboxFlagsToken(A);
    inboxGap(A);
    remember(12, [], t2);
    expect(knownInboxFlags(A, UV, 12)).toBeNull();
  });

  it("knows nothing while a diff is outstanding, for an unlisted UID, another UIDVALIDITY, after a gap or when stale", () => {
    remember(10, []);
    inboxSyncQueued(A);
    expect(knownInboxFlags(A, UV, 10)).toBeNull();
    inboxSyncDone(A);
    expect(knownInboxFlags(A, UV, 10)).toEqual([]);
    remember(99, []);
    expect(knownInboxFlags(A, UV, 99)).toBeNull();
    expect(knownInboxFlags(A, UV + 1, 10)).toBeNull();
    expect(knownInboxFlags(A, UV, 10, Date.now() + INBOX_FLAGS_MAX_AGE_MS + 1)).toBeNull();
    inboxGap(A);
    expect(knownInboxFlags(A, UV, 10)).toBeNull();
  });

  it("knows nothing once the worker stopped watching, until it lists INBOX again", () => {
    remember(10, []);
    inboxUnwatched(A);
    expect(knownInboxFlags(A, UV, 10)).toBeNull();
    remember(10, []);
    expect(knownInboxFlags(A, UV, 10)).toBeNull();
    inboxListed(A, UV, [10]);
    remember(10, ["\\Seen"]);
    expect(knownInboxFlags(A, UV, 10)).toEqual(["\\Seen"]);
  });

  it("a new UIDVALIDITY forgets everything", () => {
    remember(10, []);
    inboxListed(A, UV + 1, [10]);
    expect(knownInboxFlags(A, UV + 1, 10)).toBeNull();
  });
});
