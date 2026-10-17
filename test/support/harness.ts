// The JMAP request path as server.ts runs it (method table, real ImapPool,
// real imapflow, a real SQLite Store) against the fake IMAP server, for tests
// that count the IMAP work a request does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { Store, AccountRow } from "../../src/state/store.js";
import type { ImapPool } from "../../src/imap/pool.js";
import type { MethodCall } from "../../src/jmap/router.js";
import { sealCredentials } from "../../src/auth/credentials.js";
import type { AppConfig } from "../../src/util/config.js";
import { FakeImapServer } from "./fake-imap.js";

export const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

// Account ids key module-level caches (search, thread rows, prefetch); every
// harness gets ids no earlier harness in the same file used.
let accountSeq = 0;

export interface Harness {
  imap: FakeImapServer;
  store: Store;
  pool: ImapPool;
  cfg: AppConfig;
  account: AccountRow;
  accountId: string;
  dir: string;
  jmap(calls: MethodCall[]): Promise<MethodCall[]>;
  /** One method call; throws on a JMAP error response. */
  call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T>;
  mailboxIds(): Promise<Record<string, string>>;
  /** A process restart: fresh modules (empty in-memory caches), a new Store and pool on the same data dir. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

// The proxy's modules, loaded afresh by a restart so their in-memory caches
// start empty, as in a new process.
async function loadProxy() {
  const [{ Store }, { ImapPool }, { makeLegacyMethods }, { dispatch }] = await Promise.all([
    import("../../src/state/store.js"),
    import("../../src/imap/pool.js"),
    import("../../src/backends/legacy.js"),
    import("../../src/jmap/router.js"),
  ]);
  return { Store, ImapPool, makeLegacyMethods, dispatch };
}

export async function startHarness(imap: FakeImapServer): Promise<Harness> {
  const port = await imap.start();
  const dir = mkdtempSync(path.join(tmpdir(), "perf-"));
  const vaultKey = Buffer.alloc(32, 7);
  const cfg = {
    port: 0,
    publicUrl: "http://proxy.test",
    dataDir: dir,
    vaultKey,
    sessionHmacKey: Buffer.alloc(32, 9),
    defaultProvider: "fake",
    providers: {
      fake: {
        imap: { host: "127.0.0.1", port, secure: false },
        smtp: { host: "127.0.0.1", port: 1, secure: false },
        sieve: null,
        carddav: null,
        auth: { mech: ["PLAIN"] },
      },
    },
    limits: {
      maxConcurrentRequests: 4,
      maxObjectsInGet: 500,
      maxObjectsInSet: 500,
      maxSizeUpload: 50_000_000,
      maxSizeRequest: 10_000_000,
      maxCallsInRequest: 64,
    },
  } as AppConfig;
  let mods = await loadProxy();
  let store: Store = new mods.Store(dir);
  const vault = await sealCredentials(vaultKey, { mech: "PLAIN", username: "user@example.test", password: "pw" });
  const seq = ++accountSeq;
  for (let i = 1; i < seq; i++) store.upsertAccount({ slug: `pad${i}`, kind: "fake", host: "h", username: "pad", vault });
  const account = store.upsertAccount({ slug: `fake:user${seq}`, kind: "fake", host: "127.0.0.1", username: "user@example.test", vault });
  let pool: ImapPool = new mods.ImapPool(cfg, store);
  const h: Harness = {
    imap,
    get store() { return store; },
    get pool() { return pool; },
    cfg,
    account,
    accountId: String(account.id),
    dir,
    async jmap(calls) {
      const out = await mods.dispatch(
        { using: USING, methodCalls: calls },
        {
          methods: mods.makeLegacyMethods({ cfg, pool, store, account, dispatcher: {} as never }),
          maxCallsInRequest: 64,
          sessionState: "s",
        },
      );
      return out.methodResponses;
    },
    async call(name, args) {
      const [r] = await h.jmap([[name, { accountId: h.accountId, ...args }, "c"]]);
      if (r![0] === "error") throw new Error(`${name}: ${JSON.stringify(r![1])}`);
      return r![1] as never;
    },
    async mailboxIds() {
      const r = await h.call<{ list: { id: string; name: string }[] }>("Mailbox/get", { properties: ["id", "name", "role"] });
      return Object.fromEntries(r.list.map((m) => [m.name, m.id]));
    },
    async restart() {
      await pool.closeAll?.();
      store.db.close();
      vi.resetModules();
      mods = await loadProxy();
      store = new mods.Store(dir);
      pool = new mods.ImapPool(cfg, store);
    },
    async close() {
      await pool.closeAll?.();
      store.db.close();
      await imap.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  } as Harness;
  return h;
}
