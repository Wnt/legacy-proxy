// The pool hands out IMAP connections per (account, role). imapflow serialises
// commands on a socket, so the invariant that matters is that a connection is
// never lent to two callers at once -- and, just as important, that every exit
// path gives it back. A leaked lease wedges the account once the cap is hit.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const opened: FakeClient[] = [];

class FakeClient extends EventEmitter {
  usable = true;
  noopCalls = 0;
  loggedOut = false;
  noopShouldFail = false;

  async noop(): Promise<void> {
    this.noopCalls++;
    if (this.noopShouldFail) throw new Error("dead");
  }

  async logout(): Promise<void> {
    this.loggedOut = true;
    this.usable = false;
  }

  close(): void {
    this.usable = false;
  }
}

vi.mock("../../src/imap/client.js", () => ({
  openImap: vi.fn(async () => {
    const c = new FakeClient();
    opened.push(c);
    return c;
  }),
  withMailbox: vi.fn(),
}));

vi.mock("../../src/auth/credentials.js", () => ({
  openCredentials: vi.fn(async () => ({ mech: "PLAIN", username: "u", password: "p" })),
  sealCredentials: vi.fn(),
}));

vi.mock("../../src/auth/providers.js", () => ({
  resolveProvider: vi.fn(() => ({ imap: { host: "imap.test", port: 993 } })),
}));

const { ImapPool, PoolBusyError, viewEmailState } = await import("../../src/imap/pool.js");
const { openImap } = await import("../../src/imap/client.js");
import type { AccountRow, Store } from "../../src/state/store.js";
import type { AppConfig } from "../../src/util/config.js";

const account = { id: 1, slug: "test:u", kind: "test", vault: Buffer.alloc(0) } as AccountRow;
const cfg = { vaultKey: Buffer.alloc(32) } as AppConfig;
// Only the state counters the pool reads.
const states = new Map<string, number>();
const store = {
  getState: (_id: number, kind: string) => states.get(kind) ?? 0,
} as unknown as Store;
const bump = (kind: string) => states.set(kind, (states.get(kind) ?? 0) + 1);

function makePool() {
  return new ImapPool(cfg, store);
}

/** Let queued microtasks settle so parked acquires can make progress. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  opened.length = 0;
  states.clear();
});

describe("ImapPool", () => {
  it("security: reserves connection slots before concurrent opens await", async () => {
    const pool = makePool();
    try {
      await Promise.all(Array.from({ length: 12 }, () =>
        pool.withConnection(account, "interactive", async () => { await settle(); }),
      ));
      expect(opened.length).toBeLessThanOrEqual(3);
    } finally {
      await pool.closeAll();
    }
  });

  it("security: a failed open gives its slot back and wakes a waiter", async () => {
    const pool = makePool();
    try {
      vi.mocked(openImap).mockRejectedValueOnce(new Error("login failed"));
      const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
        pool.withConnection(account, "interactive", async () => { await settle(); }),
      ));
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
      expect(opened.length).toBeLessThanOrEqual(3);
    } finally {
      await pool.closeAll();
    }
  });

  it("security: refuses callers beyond the waiter bound instead of queueing them", async () => {
    const pool = makePool();
    const held = await Promise.all([1, 2, 3].map(() => pool.acquire(account, "interactive")));
    const parked = Array.from({ length: 64 }, () => pool.acquire(account, "interactive"));
    await settle();
    await expect(pool.acquire(account, "interactive")).rejects.toBeInstanceOf(PoolBusyError);
    const drained = Promise.all(parked.map((p) => p.then((l) => l.release())));
    for (const l of held) l.release();
    await drained;
    expect(opened.length).toBe(3);
    await pool.closeAll();
  });

  it("gives concurrent callers distinct connections", async () => {
    const pool = makePool();
    const a = await pool.acquire(account, "interactive");
    const b = await pool.acquire(account, "interactive");

    expect(a.client).not.toBe(b.client);
    expect(opened).toHaveLength(2);
  });

  it("reuses a released connection rather than dialing another", async () => {
    const pool = makePool();
    const a = await pool.acquire(account, "interactive");
    a.release();
    const b = await pool.acquire(account, "interactive");

    expect(b.client).toBe(a.client);
    expect(opened).toHaveLength(1);
  });

  it("caps connections per role and parks the overflow until one frees", async () => {
    const pool = makePool();
    const held = [
      await pool.acquire(account, "interactive"),
      await pool.acquire(account, "interactive"),
      await pool.acquire(account, "interactive"),
    ];
    expect(opened).toHaveLength(3);

    let fourth: { client: unknown; release: () => void } | null = null;
    const pending = pool.acquire(account, "interactive").then((l) => (fourth = l));

    await settle();
    expect(fourth).toBeNull();
    expect(opened).toHaveLength(3); // did not exceed the cap

    held[0]!.release();
    await pending;
    expect(fourth).not.toBeNull();
    expect(opened).toHaveLength(3);
  });

  it("keeps interactive and bulk pools separate", async () => {
    const pool = makePool();
    const i = await pool.acquire(account, "interactive");
    const b = await pool.acquire(account, "bulk");

    expect(i.client).not.toBe(b.client);
    expect(opened).toHaveLength(2);
  });

  it("returns the connection when the borrower throws", async () => {
    const pool = makePool();
    await expect(
      pool.withConnection(account, "interactive", async () => {
        throw new Error("handler blew up");
      }),
    ).rejects.toThrow("handler blew up");

    // If the lease had leaked, this would dial a second connection.
    await pool.withConnection(account, "interactive", async () => undefined);
    expect(opened).toHaveLength(1);
  });

  it("ignores a double release instead of freeing someone else's slot", async () => {
    const pool = makePool();
    const a = await pool.acquire(account, "interactive");
    a.release();
    a.release();

    const b = await pool.acquire(account, "interactive");
    const c = await pool.acquire(account, "interactive");
    expect(b.client).not.toBe(c.client);
    expect(opened).toHaveLength(2);
  });

  it("does not hand out a connection that died while idle", async () => {
    const pool = makePool();
    const a = await pool.acquire(account, "interactive");
    a.release();
    (a.client as unknown as FakeClient).usable = false;

    const b = await pool.acquire(account, "interactive");
    expect(b.client).not.toBe(a.client);
    expect(opened).toHaveLength(2);
  });

  it("adopts a probe connection instead of dialing a new one", async () => {
    const pool = makePool();
    const probe = new FakeClient();
    pool.adopt(account, probe as never);

    const lease = await pool.acquire(account, "interactive");
    expect(lease.client).toBe(probe as never);
    expect(opened).toHaveLength(0);
  });

  it("logs out an adopted probe once the role is at its cap", async () => {
    const pool = makePool();
    for (let i = 0; i < 3; i++) await pool.acquire(account, "interactive");

    const probe = new FakeClient();
    pool.adopt(account, probe as never);
    await settle();
    expect(probe.loggedOut).toBe(true);
  });

  it("drops a connection whose NOOP fails and dials a replacement", async () => {
    vi.useFakeTimers();
    try {
      const pool = makePool();
      const a = await pool.acquire(account, "interactive");
      a.release();
      (a.client as unknown as FakeClient).noopShouldFail = true;

      // Push past the NOOP freshness window so the next acquire probes it.
      vi.advanceTimersByTime(60_000);
      const b = await pool.acquire(account, "interactive");

      expect((a.client as unknown as FakeClient).noopCalls).toBe(1);
      expect(b.client).not.toBe(a.client);
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees a parked caller when a held connection closes", async () => {
    const pool = makePool();
    const held = [
      await pool.acquire(account, "interactive"),
      await pool.acquire(account, "interactive"),
      await pool.acquire(account, "interactive"),
    ];

    let got = false;
    const pending = pool.acquire(account, "interactive").then(() => (got = true));
    await settle();
    expect(got).toBe(false);

    // The socket dies underneath its borrower rather than being released.
    const dead = held[1]!.client as unknown as FakeClient;
    dead.usable = false;
    dead.emit("close");

    await pending;
    expect(got).toBe(true);
  });

  it("refreshes a recently used connection once the account state moved", async () => {
    // A server may tell a SELECTed session about new mail only on NOOP. Once
    // the IDLE worker (or another request) advanced the state, the next
    // borrower must not read through the older view.
    const pool = makePool();
    const a = await pool.acquire(account, "interactive");
    a.release();
    const fake = a.client as unknown as FakeClient;

    for (const kind of ["email", "mailbox"]) {
      bump(kind);
      const b = await pool.acquire(account, "interactive");
      expect(b.client).toBe(a.client);
      b.release();
    }
    expect(fake.noopCalls).toBe(2);
    expect(viewEmailState(a.client)).toBe(1);

    // Nothing moved since: no NOOP on a recently used connection.
    (await pool.acquire(account, "interactive")).release();
    expect(fake.noopCalls).toBe(2);
  });
});

describe("ImapPool wakeups", () => {
  it("security: a release between the cap check and parking is not lost", async () => {
    const pool = makePool();
    const held = await Promise.all([1, 2, 3].map(() => pool.acquire(account, "interactive")));
    const fourth = pool.acquire(account, "interactive");
    // Release everything before the pending acquisition gets to run again.
    for (const l of held) l.release();
    const got = await Promise.race([fourth, new Promise((r) => setTimeout(() => r("stuck"), 200))]);
    expect(got).not.toBe("stuck");
    (got as { release: () => void }).release();
    await pool.closeAll();
  });

  it("security: a release while another caller NOOPs is not lost", async () => {
    const pool = makePool();
    const held = await Promise.all([1, 2, 3].map(() => pool.acquire(account, "interactive")));
    held[0]!.release();
    bump("email"); // forces a NOOP on the next take of the idle connection
    const slow = opened[0]!;
    let finishNoop!: () => void;
    slow.noop = () => new Promise<void>((r) => (finishNoop = r));
    const a = pool.acquire(account, "interactive"); // takes [0], awaits its NOOP
    const b = pool.acquire(account, "interactive"); // at the cap: parks
    await settle();
    held[1]!.release(); // wakes b
    finishNoop();
    const la = await a;
    const lb = await Promise.race([b, new Promise((r) => setTimeout(() => r("stuck"), 200))]);
    expect(lb).not.toBe("stuck");
    la.release();
    (lb as { release: () => void }).release();
    held[2]!.release();
    await pool.closeAll();
  });
});
