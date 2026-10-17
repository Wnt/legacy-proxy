// Text body parts, cached by blobId so a message opened again -- or opened
// after the prefetch warmed it -- needs no body FETCH. What is cached is the
// raw (transfer-encoded) bytes of a partial FETCH, so the decode path is the
// same as for bytes off the wire. See body_cache in state/store.ts.
import type { Store } from "../state/store.js";
import { log } from "../util/log.js";

// A part above this is not kept (body values are capped at a few MB anyway).
const BODY_CACHE_MAX_PART_BYTES = 1024 * 1024;
const BODY_CACHE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const BODY_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
// Prune once per this many writes rather than on every one.
const PRUNE_EVERY = 200;

export interface BodyCache {
  /** Bytes for a partial FETCH of up to `maxLength`, or null on a miss. */
  get(partBlobId: string, maxLength: number): Buffer | null;
  put(partBlobId: string, maxLength: number, raw: Buffer): void;
}

let writes = 0;

export function storeBodyCache(store: Store, accountId: number): BodyCache {
  return {
    get(id, maxLength) {
      try {
        const hit = store.getCachedBodyPart(id, accountId);
        if (!hit) return null;
        // Fewer bytes than were asked for is the whole part: good for any length.
        if (hit.body.length < hit.maxLen) return hit.body.length > maxLength ? hit.body.subarray(0, maxLength) : hit.body;
        // A cut prefix serves any request for no more than it holds.
        if (hit.maxLen >= maxLength) return hit.body.subarray(0, maxLength);
        return null;
      } catch (e) {
        log.warn({ err: (e as Error).message }, "body cache read failed");
        return null;
      }
    },
    put(id, maxLength, raw) {
      if (raw.length > BODY_CACHE_MAX_PART_BYTES) return;
      try {
        store.putCachedBodyPart({ id, accountId, maxLen: maxLength, body: Buffer.from(raw), ttlMs: BODY_CACHE_TTL_MS });
        if (++writes % PRUNE_EVERY === 0) store.pruneBodyCache(BODY_CACHE_MAX_TOTAL_BYTES);
      } catch (e) {
        log.warn({ err: (e as Error).message }, "body cache write failed");
      }
    },
  };
}
