// Both the CardDAV multiget fan-out and the account-wide Email/query folder
// scan depend on this returning results in input order while running several
// at once -- if it reordered, JMAP responses would silently reorder with it.

import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/util/concurrency.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("returns results in input order even when they finish out of order", async () => {
    const out = await mapWithConcurrency([30, 5, 20, 1], 4, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 5, 20, 1]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(2);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("actually overlaps rather than running serially", async () => {
    const started = new Date().getTime();
    await mapWithConcurrency([20, 20, 20, 20], 4, async (ms) => tick(ms));
    // Serial would be ~80ms; allow generous slack for a loaded CI box.
    expect(new Date().getTime() - started).toBeLessThan(70);
  });

  it("visits every item exactly once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 4, async (i) => {
      seen.push(i);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it("handles an empty input without spawning workers", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("starts no item after one failed, and rejects once the running ones settled", async () => {
    const started: number[] = [];
    let running = 0;
    let settledAtReject = -1;
    const p = mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
      started.push(i);
      running++;
      try {
        await tick(i === 0 ? 5 : 30);
        if (i === 0) throw new Error("over budget");
      } finally {
        running--;
      }
    });
    await expect(p.catch((e) => ((settledAtReject = running), Promise.reject(e)))).rejects.toThrow("over budget");
    expect(started).toEqual([0, 1, 2]);
    expect(settledAtReject).toBe(0);
  });

  it("propagates a rejection from one item", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
