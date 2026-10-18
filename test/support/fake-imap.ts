// A small in-memory IMAP4rev1 server for work-count tests: real sockets, so
// the real imapflow, ImapPool and JMAP method table run against it, and every
// command is logged. It speaks just what legacy-proxy's read paths use:
// LOGIN, ENABLE, LIST (RETURN STATUS, RFC 5819), STATUS, SELECT/EXAMINE with
// CONDSTORE (RFC 7162), UID SEARCH, UID FETCH (flags, envelope, structure,
// header and body sections, partials), UID STORE, NOOP, LOGOUT.
// Messages are single-part text/plain. Like a real server, a non-PEEK BODY[]
// fetch sets \Seen, and any flag change raises the folder's HIGHESTMODSEQ.
import net from "node:net";

export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  internalDate: Date;
  modseq: bigint;
  header: string; // CRLF-terminated header block, including the blank line
  body: string;
}

export interface FakeFolder {
  name: string;
  specialUse?: string;
  uidValidity: number;
  uidNext: number;
  modseq: bigint;
  msgs: FakeMessage[];
}

export interface CommandLog {
  conn: number;
  /** Upper-cased command, with UID folded in: "UID FETCH", "SELECT", ... */
  cmd: string;
  line: string;
  /** The folder selected on this connection when the command arrived. */
  folder: string | null;
}

export interface NewMessage {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  date?: Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  flags?: string[];
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const nstr = (s: string | undefined | null) => (s == null || s === "" ? "NIL" : q(s));

function imapDate(d: Date): string {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${m}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function addr(a: string | undefined): string {
  if (!a) return "NIL";
  const m = /^(?:"?([^"<]*)"?\s*)?<?([^<>@\s]+)@([^<>\s]+?)>?$/.exec(a.trim());
  if (!m) return "NIL";
  return `((${nstr(m[1]?.trim())} NIL ${q(m[2]!)} ${q(m[3]!)}))`;
}

function headerValue(header: string, name: string): string | undefined {
  const re = new RegExp(`^${name}:[ \\t]*(.*(?:\\r\\n[ \\t].*)*)`, "im");
  return re.exec(header)?.[1]?.replace(/\r\n[ \t]+/g, " ");
}

const has = (hay: string, needle: Tok | undefined) => hay.toLowerCase().includes(String(needle ?? "").toLowerCase());
const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function imapDay(t: Tok | undefined): number {
  const m = /^(\d{1,2})-([a-z]{3})-(\d{4})$/i.exec(String(t ?? ""));
  if (!m) throw new Error(`fake IMAP: bad SEARCH date ${String(t)}`);
  return Date.UTC(Number(m[3]), MONTHS.indexOf(m[2]!.toLowerCase()), Number(m[1]));
}

/** Parse an IMAP sequence/UID set against the folder's highest UID. */
function inSet(set: string, max: number): (n: number) => boolean {
  const ranges = set.split(",").map((r) => {
    const [a, b] = r.split(":");
    const lo = a === "*" ? max : Number(a);
    const hi = b === undefined ? lo : b === "*" ? max : Number(b);
    return [Math.min(lo, hi), Math.max(lo, hi)] as const;
  });
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

// Tokenise one command line: atoms (with [..] sections and <..> partials kept
// whole), quoted strings, parenthesised lists.
type Tok = string | Tok[];
function tokenize(s: string): Tok[] {
  let i = 0;
  const list = (): Tok[] => {
    const out: Tok[] = [];
    while (i < s.length) {
      const c = s[i]!;
      if (c === " ") { i++; continue; }
      if (c === ")") { i++; return out; }
      if (c === "(") { i++; out.push(list()); continue; }
      if (c === '"') {
        let v = "";
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\") i++;
          v += s[i++];
        }
        i++;
        out.push(v);
        continue;
      }
      let v = "";
      let depth = 0;
      while (i < s.length) {
        const ch = s[i]!;
        if (ch === "[") depth++;
        if (ch === "]") depth--;
        if (depth === 0 && (ch === " " || ch === ")" || ch === "(")) break;
        v += ch;
        i++;
      }
      out.push(v);
    }
    return out;
  };
  return list();
}

export class FakeImapServer {
  folders = new Map<string, FakeFolder>();
  log: CommandLog[] = [];
  connections = 0;
  /** Like Dovecot's mail_max_userip_connections: LOGIN beyond this many open sessions is refused. */
  maxConnections = Infinity;
  /** Holds a command this long before answering it (e.g. a slow full-text SEARCH). Commands on one connection stay in order. */
  commandDelayMs: ((line: string) => number) | null = null;
  /**
   * Holds a command until the promise returned for it settles; one that never
   * settles is a server that stopped answering. Commands on one connection
   * stay in order.
   */
  commandGate: ((line: string, conn: number) => Promise<unknown> | null) | null = null;
  /** Connections the client side closed (socket ended or destroyed), by number. */
  closedConns = new Set<number>();
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  port = 0;

  constructor(folders: { name: string; specialUse?: string }[] = [{ name: "INBOX" }]) {
    for (const f of folders) this.addFolder(f.name, f.specialUse);
  }

  addFolder(name: string, specialUse?: string): FakeFolder {
    const f: FakeFolder = { name, specialUse, uidValidity: 1, uidNext: 1, modseq: 1n, msgs: [] };
    this.folders.set(name, f);
    return f;
  }

  add(folder: string, m: NewMessage = {}): FakeMessage {
    const f = this.folders.get(folder)!;
    const uid = f.uidNext++;
    f.modseq++;
    const date = m.date ?? new Date(Date.UTC(2026, 0, 1) + uid * 60_000);
    const lines = [
      `From: ${m.from ?? "Sender <sender@example.test>"}`,
      `To: ${m.to ?? "user@example.test"}`,
      `Subject: ${m.subject ?? `Message ${folder} ${uid}`}`,
      `Date: ${date.toUTCString()}`,
      `Message-ID: ${m.messageId ?? `<${folder.replace(/\W/g, "")}.${uid}@example.test>`}`,
      ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
      ...(m.references ? [`References: ${m.references}`] : []),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
    ];
    const msg: FakeMessage = {
      uid,
      flags: new Set(m.flags ?? []),
      internalDate: date,
      modseq: f.modseq,
      header: lines.join("\r\n") + "\r\n\r\n",
      body: (m.body ?? `Body of message ${uid} in ${folder}.`).replace(/\r?\n/g, "\r\n") + "\r\n",
    };
    f.msgs.push(msg);
    return msg;
  }

  /** Change flags as another client would (raises HIGHESTMODSEQ). */
  setFlags(folder: string, uid: number, op: "+" | "-", flags: string[]): void {
    const f = this.folders.get(folder)!;
    const m = f.msgs.find((x) => x.uid === uid)!;
    for (const fl of flags) (op === "+" ? m.flags.add(fl) : m.flags.delete(fl));
    m.modseq = ++f.modseq;
  }

  count(cmd: string, pred: (l: CommandLog) => boolean = () => true): number {
    return this.log.filter((l) => l.cmd === cmd && pred(l)).length;
  }

  reset(): void {
    this.log = [];
  }

  async start(): Promise<number> {
    this.server = net.createServer((sock) => this.session(sock));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private session(sock: net.Socket): void {
    const conn = ++this.connections;
    this.sockets.add(sock);
    sock.on("close", () => {
      this.sockets.delete(sock);
      this.closedConns.add(conn);
    });
    sock.on("error", () => {});
    let selected: FakeFolder | null = null;
    let buf = Buffer.alloc(0);
    let pending = "";
    let literal = 0;
    // Commands waiting behind a delayed one (see commandDelayMs).
    let queued: Promise<unknown> | null = null;
    const w = (s: string) => {
      if (!sock.destroyed) sock.write(s, "latin1");
    };
    w("* OK [CAPABILITY IMAP4rev1 LITERAL+ ENABLE CONDSTORE LIST-STATUS UIDPLUS] fake ready\r\n");

    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (literal > 0) {
          if (buf.length < literal) return;
          pending += buf.subarray(0, literal).toString("utf8");
          buf = buf.subarray(literal);
          literal = 0;
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.subarray(0, i).toString("utf8");
        buf = buf.subarray(i + 2);
        const lit = /\{(\d+)(\+?)\}$/.exec(line);
        if (lit) {
          pending += line.slice(0, lit.index) + "";
          literal = Number(lit[1]);
          if (!lit[2]) w("+ go ahead\r\n");
          // A literal's text is spliced in quoted, so the tokenizer sees a string.
          pending += "\u0000";
          continue;
        }
        const full = (pending + line).replace(/\u0000([^]*?)(?=\s|\)|$)/g, (_m, v: string) => q(v));
        pending = "";
        const run = () => {
          try {
            this.command(full, conn, w, () => selected, (f) => (selected = f), () => sock.end());
          } catch (e) {
            const tag = full.split(" ")[0];
            w(`${tag} BAD ${(e as Error).message}\r\n`);
          }
        };
        const delay = this.commandDelayMs?.(full) ?? 0;
        const gate = this.commandGate?.(full, conn) ?? null;
        if (delay > 0 || gate || queued) {
          const next: Promise<unknown> = (queued ?? Promise.resolve())
            .then(() => (delay > 0 ? new Promise((r) => setTimeout(r, delay)) : undefined))
            .then(() => gate?.catch(() => {}))
            .then(run);
          queued = next;
          void next.then(() => {
            if (queued === next) queued = null;
          });
        } else {
          run();
        }
      }
    });
  }

  private command(
    line: string,
    conn: number,
    w: (s: string) => void,
    sel: () => FakeFolder | null,
    setSel: (f: FakeFolder | null) => void,
    end: () => void,
  ): void {
    const toks = tokenize(line);
    const tag = toks[0] as string;
    let cmd = String(toks[1] ?? "").toUpperCase();
    let args = toks.slice(2);
    if (cmd === "UID") {
      cmd = `UID ${String(args[0]).toUpperCase()}`;
      args = args.slice(1);
    }
    this.log.push({ conn, cmd, line: cmd === "LOGIN" ? `${tag} LOGIN ***` : line, folder: sel()?.name ?? null });
    const ok = (s = "done") => w(`${tag} OK ${s}\r\n`);

    switch (cmd) {
      case "CAPABILITY":
        w("* CAPABILITY IMAP4rev1 LITERAL+ ENABLE CONDSTORE LIST-STATUS UIDPLUS\r\n");
        return ok();
      case "LOGIN":
        if (this.sockets.size > this.maxConnections) {
          return w(`${tag} NO [LIMIT] Maximum number of connections from user+IP exceeded\r\n`);
        }
        return ok("[CAPABILITY IMAP4rev1 LITERAL+ ENABLE CONDSTORE LIST-STATUS UIDPLUS] logged in");
      case "ENABLE":
        w(`* ENABLED ${args.filter((a) => String(a).toUpperCase() === "CONDSTORE").join(" ")}\r\n`);
        return ok();
      case "ID":
        w("* ID NIL\r\n");
        return ok();
      case "NOOP":
      case "CHECK":
        return ok();
      case "LOGOUT":
        w("* BYE bye\r\n");
        ok();
        return end();
      case "CLOSE":
      case "UNSELECT":
        setSel(null);
        return ok();
      case "LIST":
      case "LSUB":
        return this.list(cmd, args, w, ok);
      case "STATUS": {
        const f = this.folders.get(String(args[0]));
        if (!f) return w(`${tag} NO no such folder\r\n`);
        w(`* STATUS ${q(f.name)} (${this.statusItems(f, args[1] as Tok[])})\r\n`);
        return ok();
      }
      case "SELECT":
      case "EXAMINE": {
        const f = this.folders.get(String(args[0]));
        if (!f) return w(`${tag} NO no such folder\r\n`);
        setSel(f);
        w(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n`);
        w(`* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] ok\r\n`);
        w(`* ${f.msgs.length} EXISTS\r\n* 0 RECENT\r\n`);
        w(`* OK [UIDVALIDITY ${f.uidValidity}] ok\r\n* OK [UIDNEXT ${f.uidNext}] ok\r\n* OK [HIGHESTMODSEQ ${f.modseq}] ok\r\n`);
        return ok(cmd === "SELECT" ? "[READ-WRITE] selected" : "[READ-ONLY] examined");
      }
      case "UID SEARCH":
      case "SEARCH": {
        const f = sel();
        if (!f) return w(`${tag} BAD no folder selected\r\n`);
        const crit = args[0] && String(args[0]).toUpperCase() === "CHARSET" ? args.slice(2) : args;
        const hits = f.msgs.filter((m, i) => this.matches(m, i + 1, f, crit));
        w(`* SEARCH${hits.map((m) => " " + (cmd === "UID SEARCH" ? m.uid : f.msgs.indexOf(m) + 1)).join("")}\r\n`);
        return ok();
      }
      case "UID FETCH":
      case "FETCH": {
        const f = sel();
        if (!f) return w(`${tag} BAD no folder selected\r\n`);
        const byUid = cmd === "UID FETCH";
        const max = byUid ? (f.msgs.at(-1)?.uid ?? 0) : f.msgs.length;
        const want = inSet(String(args[0]), max);
        const items = (Array.isArray(args[1]) ? args[1] : [args[1]]).map(String);
        let any = false;
        f.msgs.forEach((m, i) => {
          if (!want(byUid ? m.uid : i + 1)) return;
          any = true;
          w(this.fetchResponse(f, m, i + 1, items, byUid));
        });
        // `n:*` matches the last message even when n is beyond it (RFC 3501).
        if (!any && byUid && /:\*$/.test(String(args[0])) && f.msgs.length) {
          w(this.fetchResponse(f, f.msgs.at(-1)!, f.msgs.length, items, byUid));
        }
        return ok();
      }
      case "UID STORE":
      case "STORE": {
        const f = sel();
        if (!f) return w(`${tag} BAD no folder selected\r\n`);
        const byUid = cmd === "UID STORE";
        let i = 1;
        if (Array.isArray(args[i])) i++; // (UNCHANGEDSINCE n)
        const op = String(args[i]).toUpperCase();
        const flags = (Array.isArray(args[i + 1]) ? args[i + 1] : [args[i + 1]]) as string[];
        const want = inSet(String(args[0]), byUid ? (f.msgs.at(-1)?.uid ?? 0) : f.msgs.length);
        f.msgs.forEach((m, idx) => {
          if (!want(byUid ? m.uid : idx + 1)) return;
          if (op.startsWith("FLAGS")) m.flags = new Set();
          for (const fl of flags) (op.startsWith("-") ? m.flags.delete(fl) : m.flags.add(fl));
          m.modseq = ++f.modseq;
          if (!op.endsWith(".SILENT")) w(`* ${idx + 1} FETCH (UID ${m.uid} FLAGS (${[...m.flags].join(" ")}) MODSEQ (${m.modseq}))\r\n`);
        });
        return ok();
      }
      default:
        throw new Error(`fake IMAP: unsupported command ${cmd}`);
    }
  }

  private statusItems(f: FakeFolder, items: Tok[] | undefined): string {
    const out: string[] = [];
    for (const it of (items ?? []).map((x) => String(x).toUpperCase())) {
      if (it === "MESSAGES") out.push(`MESSAGES ${f.msgs.length}`);
      else if (it === "UIDNEXT") out.push(`UIDNEXT ${f.uidNext}`);
      else if (it === "UIDVALIDITY") out.push(`UIDVALIDITY ${f.uidValidity}`);
      else if (it === "UNSEEN") out.push(`UNSEEN ${f.msgs.filter((m) => !m.flags.has("\\Seen")).length}`);
      else if (it === "HIGHESTMODSEQ") out.push(`HIGHESTMODSEQ ${f.modseq}`);
      else if (it === "RECENT") out.push(`RECENT 0`);
    }
    return out.join(" ");
  }

  private list(cmd: string, args: Tok[], w: (s: string) => void, ok: () => void): void {
    let i = 0;
    if (Array.isArray(args[0])) i++; // selection options
    const pattern = String(args[i + 1] ?? "");
    const ret = args.slice(i + 2);
    const retList = ret.length && String(ret[0]).toUpperCase() === "RETURN" ? (ret[1] as Tok[]) : [];
    let statusItems: Tok[] | null = null;
    for (let k = 0; k < retList.length; k++) {
      if (String(retList[k]).toUpperCase() === "STATUS") statusItems = retList[k + 1] as Tok[];
    }
    if (pattern === "") {
      w(`* ${cmd} (\\Noselect) "/" ""\r\n`);
      return ok();
    }
    for (const f of this.folders.values()) {
      const attrs = [f.specialUse, f.msgs.length ? "\\HasNoChildren" : "\\HasNoChildren"].filter(Boolean).join(" ");
      w(`* ${cmd} (${attrs}) "/" ${q(f.name)}\r\n`);
      if (cmd === "LIST" && statusItems) w(`* STATUS ${q(f.name)} (${this.statusItems(f, statusItems)})\r\n`);
    }
    ok();
  }

  private matches(m: FakeMessage, seq: number, f: FakeFolder, crit: Tok[]): boolean {
    let i = 0;
    const one = (): boolean => {
      const t = crit[i++];
      if (Array.isArray(t)) {
        const save = { crit, i };
        const r = t.length === 0 || this.matches(m, seq, f, t);
        crit = save.crit;
        i = save.i;
        return r;
      }
      const k = String(t).toUpperCase();
      const flag = (fl: string) => m.flags.has(fl);
      switch (k) {
        case "ALL": return true;
        case "SEEN": return flag("\\Seen");
        case "UNSEEN": return !flag("\\Seen");
        case "FLAGGED": return flag("\\Flagged");
        case "UNFLAGGED": return !flag("\\Flagged");
        case "ANSWERED": return flag("\\Answered");
        case "UNANSWERED": return !flag("\\Answered");
        case "DELETED": return flag("\\Deleted");
        case "UNDELETED": return !flag("\\Deleted");
        case "DRAFT": return flag("\\Draft");
        case "UNDRAFT": return !flag("\\Draft");
        case "KEYWORD": return flag(String(crit[i++]));
        case "UNKEYWORD": return !flag(String(crit[i++]));
        case "UID": return inSet(String(crit[i++]), f.msgs.at(-1)?.uid ?? 0)(m.uid);
        case "NOT": return !one();
        case "OR": { const a = one(); const b = one(); return a || b; }
        case "MODSEQ": return m.modseq > BigInt(String(crit[i++]));
        // Like Dovecot without a full-text index: case-insensitive substring
        // matches; dates by the internal date's day (UTC here).
        case "TEXT": return has(m.header + m.body, crit[i++]);
        case "BODY": return has(m.body, crit[i++]);
        case "FROM": case "TO": case "CC": case "BCC": case "SUBJECT":
          return has(headerValue(m.header, k === "SUBJECT" ? "Subject" : k[0] + k.slice(1).toLowerCase()) ?? "", crit[i++]);
        case "SINCE": return dayStart(m.internalDate) >= imapDay(crit[i++]);
        case "BEFORE": return dayStart(m.internalDate) < imapDay(crit[i++]);
        default:
          if (/^[\d:*,]+$/.test(k)) return inSet(k, f.msgs.length)(seq);
          throw new Error(`fake IMAP: unsupported SEARCH key ${k}`);
      }
    };
    while (i < crit.length) if (!one()) return false;
    return true;
  }

  private fetchResponse(f: FakeFolder, m: FakeMessage, seq: number, rawItems: string[], byUid: boolean): string {
    const items = rawItems.flatMap((it) => {
      const u = it.toUpperCase();
      if (u === "FAST") return ["FLAGS", "INTERNALDATE", "RFC822.SIZE"];
      if (u === "ALL") return ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"];
      if (u === "FULL") return ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODY"];
      return [it];
    });
    const size = Buffer.byteLength(m.header + m.body);
    const parts: string[] = [];
    const tail: string[] = [];
    let setSeen = false;
    if (byUid && !items.some((x) => x.toUpperCase() === "UID")) parts.push(`UID ${m.uid}`);
    for (const it of items) {
      const u = it.toUpperCase();
      if (u === "UID") parts.push(`UID ${m.uid}`);
      else if (u === "FLAGS") tail.push("FLAGS");
      else if (u === "INTERNALDATE") parts.push(`INTERNALDATE "${imapDate(m.internalDate)}"`);
      else if (u === "RFC822.SIZE") parts.push(`RFC822.SIZE ${size}`);
      else if (u === "MODSEQ") parts.push(`MODSEQ (${m.modseq})`);
      else if (u === "ENVELOPE") {
        const h = (n: string) => headerValue(m.header, n);
        parts.push(
          `ENVELOPE (${nstr(h("Date"))} ${nstr(h("Subject"))} ${addr(h("From"))} ${addr(h("From"))} ${addr(h("From"))}` +
            ` ${addr(h("To"))} NIL NIL ${nstr(h("In-Reply-To"))} ${nstr(h("Message-ID"))})`,
        );
      } else if (u === "BODYSTRUCTURE" || u === "BODY") {
        const lines = m.body.split("\r\n").length - 1;
        parts.push(`${u} ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" ${Buffer.byteLength(m.body)} ${lines}${u === "BODYSTRUCTURE" ? " NIL NIL NIL NIL" : ""})`);
      } else if (u.startsWith("BODY[") || u.startsWith("BODY.PEEK[") || u === "RFC822" || u === "RFC822.HEADER" || u === "RFC822.TEXT") {
        const peek = u.startsWith("BODY.PEEK[") || u === "RFC822.HEADER";
        if (!peek && u !== "RFC822.HEADER") setSeen = true;
        const sm = /\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?/.exec(it);
        let section = sm ? sm[1]! : u === "RFC822.HEADER" ? "HEADER" : u === "RFC822.TEXT" ? "TEXT" : "";
        const start = sm?.[2] ? Number(sm[2]) : 0;
        const len = sm?.[3] ? Number(sm[3]) : undefined;
        let data: string;
        const S = section.toUpperCase();
        if (S === "") data = m.header + m.body;
        else if (S === "HEADER" || S === "0") data = m.header;
        else if (S.startsWith("HEADER.FIELDS")) {
          const not = S.startsWith("HEADER.FIELDS.NOT");
          const names = new Set((/\(([^)]*)\)/.exec(section)?.[1] ?? "").split(/\s+/).filter(Boolean).map((x) => x.toLowerCase()));
          const hl = m.header.replace(/\r\n\r\n$/, "").split(/\r\n(?![ \t])/);
          data = hl.filter((l) => names.has(l.slice(0, l.indexOf(":")).toLowerCase()) !== not).map((l) => l + "\r\n").join("") + "\r\n";
        } else if (S === "TEXT" || S === "1") data = m.body;
        else if (S === "1.MIME") data = "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n";
        else data = "";
        const bytes = Buffer.from(data, "utf8");
        const cut = bytes.subarray(start, len === undefined ? undefined : start + len);
        const key = u === "RFC822" || u === "RFC822.HEADER" || u === "RFC822.TEXT" ? u : `BODY[${section}]${sm?.[2] ? `<${start}>` : ""}`;
        parts.push(`${key} {${cut.length}}\r\n${cut.toString("latin1")}`);
      } else {
        throw new Error(`fake IMAP: unsupported FETCH item ${it}`);
      }
    }
    if (setSeen && !m.flags.has("\\Seen")) {
      m.flags.add("\\Seen");
      m.modseq = ++f.modseq;
    }
    if (tail.length) parts.push(`FLAGS (${[...m.flags].join(" ")})`);
    return `* ${seq} FETCH (${parts.join(" ")})\r\n`;
  }
}
