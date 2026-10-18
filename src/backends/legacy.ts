import { newRequestBudgets, type RequestBudgets } from "../imap/fetcher.js";
import type { ImapPool } from "../imap/pool.js";
import { prefetchEmails } from "../imap/prefetch.js";
import { decodeMailboxId } from "../mapping/ids.js";
import type { Store, AccountRow } from "../state/store.js";
import type { AppConfig } from "../util/config.js";
import type { PushDispatcher } from "../push/dispatcher.js";
import { JmapError, invalidArguments } from "../jmap/errors.js";
import {
  mailboxGet,
  mailboxQuery,
  mailboxQueryChanges,
  mailboxChanges,
  mailboxSet,
} from "../jmap/methods/mailbox.js";
import {
  emailGet,
  emailQuery,
  emailSet,
  emailChanges,
  emailQueryChanges,
  emailCopy,
  emailParse,
  emailImport,
  searchSnippetGet,
} from "../jmap/methods/email.js";
import { identityGet, identitySet, identityChanges } from "../jmap/methods/identity.js";
import {
  emailSubmissionChanges,
  emailSubmissionGet,
  emailSubmissionQuery,
  emailSubmissionSet,
} from "../jmap/methods/submission.js";
import { vacationGet, vacationSet, vacationChanges } from "../jmap/methods/vacation.js";
import {
  addressBookGet,
  addressBookSet,
  addressBookChanges,
  contactCardGet,
  contactCardQuery,
  contactCardSet,
  contactCardChanges,
  contactCardQueryChanges,
  contactsAvailable,
} from "../jmap/methods/contacts.js";
import { threadGet, threadChanges } from "../jmap/methods/threads.js";
import { pushSubscriptionGet, pushSubscriptionSet } from "../jmap/methods/push.js";
import { resolveProvider } from "../auth/providers.js";
import { openCredentials } from "../auth/credentials.js";
import type { MethodTable } from "../jmap/router.js";

export interface LegacyContext {
  cfg: AppConfig;
  pool: ImapPool;
  store: Store;
  account: AccountRow;
  dispatcher: PushDispatcher;
  /** Per HTTP request: set by makeLegacyMethods. */
  budgets?: RequestBudgets;
  /** Aborted when the HTTP client goes away. */
  signal?: AbortSignal;
}

type Handler = (args: Record<string, unknown>, ctx: LegacyContext) => Promise<unknown>;

function makeMethodTable(): Record<string, Handler> {
  return {
    "Core/echo": async (a) => a,
    // RFC 8620 §6.3: Blob/copy. The proxy doesn't (yet) cross account
    // boundaries — IMAP namespaces don't share — so we surface that limitation
    // as the spec-defined error. Same-account copies are also forbidden by
    // §6.3 and must return invalidArguments.
    "Blob/copy": async (a) => {
      const args = a as { fromAccountId?: string; accountId?: string };
      if (!args.fromAccountId || !args.accountId) {
        throw invalidArguments("fromAccountId and accountId are required");
      }
      if (args.fromAccountId === args.accountId) {
        throw invalidArguments("fromAccountId must differ from accountId");
      }
      throw new JmapError(
        "fromAccountNotFound",
        "cross-account Blob/copy is not supported by the IMAP backend",
      );
    },
    // Stubs for capabilities we don't advertise but the UI may probe anyway.
    // Returning an empty result is more graceful than `unknownMethod`, which
    // some clients treat as a fatal protocol error.
    "Quota/get": async (a) => ({
      accountId: (a as { accountId?: string }).accountId ?? "",
      state: "0",
      list: [],
      notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
    }),
    "AddressBook/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!contactsAvailable(provider)) {
        return {
          accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
          state: "0",
          list: [],
          notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
        };
      }
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return addressBookGet(a as never, { account: c.account, provider, creds, signal: c.signal });
    },
    "AddressBook/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return addressBookSet(a as never, { account: c.account, provider, creds, signal: c.signal });
    },
    "AddressBook/changes": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return addressBookChanges(a as never, { account: c.account, provider, creds, signal: c.signal });
    },
    "ContactCard/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!contactsAvailable(provider)) {
        return {
          accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
          state: "0",
          list: [],
          notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
        };
      }
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardGet(a as never, { account: c.account, provider, creds, signal: c.signal });
    },
    "ContactCard/query": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!contactsAvailable(provider)) {
        return {
          accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
          queryState: "0",
          canCalculateChanges: false,
          position: 0,
          total: 0,
          ids: [],
        };
      }
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardQuery(a as never, { account: c.account, provider, creds, signal: c.signal });
    },
    "ContactCard/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardSet(a as never, { account: c.account, provider, creds, signal: c.signal });
    },
    "ContactCard/changes": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardChanges(a as never, { account: c.account, provider, creds, signal: c.signal });
    },
    "ContactCard/queryChanges": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardQueryChanges(a as never, { account: c.account, provider, creds, signal: c.signal });
    },
    "Mailbox/get": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        mailboxGet(a as never, { account: c.account, client, store: c.store }),
      ),
    "Mailbox/query": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        mailboxQuery(a as never, { account: c.account, client, store: c.store }),
      ),
    "Mailbox/queryChanges": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        mailboxQueryChanges(a as never, { account: c.account, client, store: c.store }),
      ),
    "Mailbox/changes": async (a, c) =>
      mailboxChanges(a as never, { account: c.account, store: c.store }),
    "Mailbox/set": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        mailboxSet(a as never, { account: c.account, client, store: c.store }),
      ),
    // The read methods take the request's budgets and abort signal: an
    // abandoned request gives up its place in the connection queue and stops
    // its folder workers and FETCHes.
    "Email/query": async (a, c) => {
      const res = await c.pool.withConnection(c.account, "interactive", (client) =>
        emailQuery(a as never, { account: c.account, client, store: c.store, pool: c.pool, budgets: c.budgets }),
      c.signal);
      // The top of the INBOX list is what gets opened next: warm it.
      if (isInboxFirstPage(a, c.store, c.account.id)) prefetchEmails(c.pool, c.store, c.account, res.ids);
      return res;
    },
    "Email/get": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailGet(a as never, {
          account: c.account, client, store: c.store, pool: c.pool,
          maxObjectsInGet: c.cfg.limits.maxObjectsInGet,
          budgets: c.budgets,
        }),
      c.signal),
    // Mutations stop once the request is abandoned (emailSet), so it doesn't
    // start one either.
    "Email/set": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailSet(a as never, { account: c.account, client, store: c.store, pool: c.pool, budgets: c.budgets }),
      c.signal),
    "Email/changes": async (a, c) =>
      emailChanges(a as never, { account: c.account, store: c.store }),
    "Email/queryChanges": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailQueryChanges(a as never, { account: c.account, client, store: c.store, pool: c.pool, budgets: c.budgets }),
      c.signal),
    "Email/copy": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailCopy(a as never, { account: c.account, client, store: c.store }),
      ),
    "Email/import": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailImport(a as never, { account: c.account, client, store: c.store }),
      ),
    "Email/parse": async (a, c) =>
      emailParse(a as never, { account: c.account, store: c.store }),
    "SearchSnippet/get": async (a, c) =>
      searchSnippetGet(a as never, { account: c.account }),
    "Thread/get": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        threadGet(a as never, { account: c.account, client, store: c.store, pool: c.pool }),
      ),
    "Thread/changes": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        threadChanges(a as never, { account: c.account, client, store: c.store, pool: c.pool }),
      ),
    "PushSubscription/get": async (a, c) =>
      pushSubscriptionGet(a as never, { account: c.account, store: c.store, dispatcher: c.dispatcher }),
    "PushSubscription/set": async (a, c) =>
      pushSubscriptionSet(a as never, { account: c.account, store: c.store, dispatcher: c.dispatcher }),
    "EmailSubmission/get": async (a, c) =>
      emailSubmissionGet(a as never, { account: c.account, store: c.store }),
    "EmailSubmission/query": async (a, c) =>
      emailSubmissionQuery(a as never, { account: c.account, store: c.store }),
    "EmailSubmission/changes": async (a, c) =>
      emailSubmissionChanges(a as never, { account: c.account, store: c.store }),
    "EmailSubmission/set": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailSubmissionSet(a as never, {
          cfg: c.cfg,
          account: c.account,
          client,
          store: c.store,
        }),
      ),
    "Identity/get": async (a, c) =>
      identityGet(a as never, { account: c.account, store: c.store }),
    "Identity/set": async (a, c) =>
      identitySet(a as never, { account: c.account, store: c.store }),
    "Identity/changes": async (a, c) =>
      identityChanges(a as never, { account: c.account, store: c.store }),
    "VacationResponse/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return vacationGet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "VacationResponse/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return vacationSet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "VacationResponse/changes": async (a, c) =>
      vacationChanges(a as never, { account: c.account, store: c.store }),
  };
}

const TABLE = makeMethodTable();

/** Bind the legacy transports to the authenticated account for one request. */
// Called once per HTTP request, so the request's method calls share one set
// of budgets (Email/get, Email/query, Email/queryChanges).
export function makeLegacyMethods(ctx: LegacyContext): MethodTable {
  const budgets = ctx.budgets ?? newRequestBudgets();
  if (ctx.signal) budgets.signal = ctx.signal;
  const withBudgets = { ...ctx, budgets };
  return Object.fromEntries(
    Object.entries(TABLE).map(([name, handler]) => [name, (args: Record<string, unknown>) => handler(args, withBudgets)]),
  );
}

// An Email/query for the first page of the INBOX (filter `inMailbox`, alone
// or in a top-level AND).
function isInboxFirstPage(args: unknown, store: Store, accountId: number): boolean {
  const a = args as { filter?: Record<string, unknown>; position?: number; anchor?: unknown } | null;
  if (!a || (a.position ?? 0) !== 0 || a.anchor != null || !a.filter) return false;
  const f = a.filter;
  const conds = f.operator === "AND" && Array.isArray(f.conditions) ? (f.conditions as Record<string, unknown>[]) : [f];
  const mbox = conds.find((x) => typeof x?.inMailbox === "string")?.inMailbox as string | undefined;
  if (!mbox) return false;
  try {
    const idx = decodeMailboxId(mbox).mailboxIdx;
    const row = store.prep(`SELECT role FROM mailbox WHERE id = ? AND account_id = ?`).get(idx, accountId) as { role: string | null } | undefined;
    return row?.role === "inbox";
  } catch {
    return false;
  }
}
