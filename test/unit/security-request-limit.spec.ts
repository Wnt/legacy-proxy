// maxConcurrentRequests is advertised in the session; KeyedLimiter enforces
// it per account: excess requests wait, and only a backlog beyond the queue
// bound is refused (the server answers jmap:error:limit, clients back off).

import { describe, expect, it } from "vitest";
import { KeyedLimiter, LimitError } from "../../src/util/limiter.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("KeyedLimiter", () => {
  it("runs at most `limit` at once per key and queues the rest", async () => {
    const lim = new KeyedLimiter(2, 10);
    let running = 0;
    let peak = 0;
    const job = async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
    };
    await Promise.all(Array.from({ length: 8 }, () => lim.run("a", job)));
    expect(peak).toBe(2);
  });

  it("refuses beyond the queue bound and recovers afterwards", async () => {
    const lim = new KeyedLimiter(1, 2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = lim.run("a", () => gate);
    const queued = [lim.run("a", async () => 1), lim.run("a", async () => 2)];
    await expect(lim.run("a", async () => 3)).rejects.toBeInstanceOf(LimitError);
    // Other accounts are unaffected.
    await expect(lim.run("b", async () => "b")).resolves.toBe("b");
    release();
    await first;
    expect(await Promise.all(queued)).toEqual([1, 2]);
    await expect(lim.run("a", async () => 4)).resolves.toBe(4);
  });

  it("frees the slot when the job throws", async () => {
    const lim = new KeyedLimiter(1, 0);
    await expect(lim.run("a", async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(lim.run("a", async () => "ok")).resolves.toBe("ok");
  });
});
