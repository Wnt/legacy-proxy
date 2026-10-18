import { ImapFlow } from "imapflow";
import type { Credentials } from "../auth/credentials.js";
import type { ProviderConfig } from "../util/config.js";
import { log } from "../util/log.js";
import { abortable } from "./abort.js";

export interface ImapConnOpts {
  provider: ProviderConfig;
  creds: Credentials;
}

// Above the largest message this proxy sends or stores (50 MB of attachments,
// base64-encoded).
const MAX_IMAP_LITERAL_BYTES = 128 * 1024 * 1024;

export async function openImap(opts: ImapConnOpts): Promise<ImapFlow> {
  const { provider, creds } = opts;
  let auth: { user: string; pass?: string; accessToken?: string };
  if (creds.mech === "XOAUTH2" && creds.accessToken) {
    auth = { user: creds.username, accessToken: creds.accessToken };
  } else if (creds.password) {
    auth = { user: creds.username, pass: creds.password };
  } else {
    throw new Error("openImap: no credentials supplied");
  }
  const client = new ImapFlow({
    host: provider.imap.host,
    port: provider.imap.port,
    secure: provider.imap.secure ?? true,
    auth,
    logger: imapflowLogger,
    // Backstops on what one server response may make imapflow buffer (its
    // defaults are 1 GiB per literal, 2 GiB per response), above anything a
    // legitimate fetch returns: header blocks use partial fetches, downloads
    // come in 64 KiB chunks, and a whole message is only read for submission.
    // Exceeding one closes the connection.
    maxLiteralSize: MAX_IMAP_LITERAL_BYTES,
    maxResponseSize: MAX_IMAP_LITERAL_BYTES + 32 * 1024 * 1024,
    maxLineLength: 16 * 1024 * 1024,
  });
  // imapflow reports a socket timeout or reset as an 'error' event, and an
  // EventEmitter with no listener throws it from a timer: an uncaught
  // exception with no frame of ours in it (#25). The pool and the IDLE worker
  // add listeners that act on the error; this one only keeps every client,
  // the short-lived auth probes included, from having none.
  client.on("error", (err: unknown) => {
    log.debug({ host: provider.imap.host, ...imapErrorDetails(err) }, "imap connection error");
  });
  await client.connect();
  log.debug({ host: provider.imap.host, mech: creds.mech }, "imap connected");
  return client;
}

// imapflow reports a failed MOVE or COPY only by returning false and logging
// the error. Keep its warnings so the server's NO text reaches our log; the
// rest of its logging stays off, as before.
const imapflowLogger = {
  debug: () => {},
  info: () => {},
  error: () => {},
  warn: (obj: { msg?: string; err?: unknown; cid?: string }) =>
    log.warn({ cid: obj?.cid, ...(obj?.err ? imapErrorDetails(obj.err) : {}) }, obj?.msg ?? "imap command failed"),
};

export async function withMailbox<T>(
  client: ImapFlow,
  path: string,
  fn: (lock: { release: () => void }) => Promise<T>,
  // The request's: a SELECT the server does not answer is cut off (abortable).
  signal?: AbortSignal,
): Promise<T> {
  const lock = await abortable(client, signal, () => client.getMailboxLock(path));
  try {
    return await fn({ release: () => lock.release() });
  } finally {
    lock.release();
  }
}

/**
 * UIDVALIDITY of the mailbox currently selected on `client`, or null when none
 * is. A UID only names a message together with this value: after a mailbox is
 * recreated or restored (new UIDVALIDITY) the same UID can be another message.
 */
export function selectedUidValidity(client: ImapFlow): number | null {
  const mb = client.mailbox && typeof client.mailbox === "object" ? client.mailbox : null;
  const v = (mb as { uidValidity?: number | bigint } | null)?.uidValidity;
  return v == null ? null : Number(v);
}

// The server's side of a failed IMAP command. imapflow puts the tagged NO/BAD
// text on the error object; without it the log only says "Command failed".
export function imapErrorDetails(e: unknown): Record<string, unknown> {
  const err = e as {
    message?: string;
    responseText?: string;
    responseStatus?: string;
    serverResponseCode?: string;
    code?: string;
  };
  return {
    err: err?.message ?? String(e),
    responseStatus: err?.responseStatus,
    responseText: err?.responseText,
    serverResponseCode: err?.serverResponseCode,
    code: err?.code,
  };
}
