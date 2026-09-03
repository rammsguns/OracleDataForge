import express from "express";
import compression from "compression";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import oracledb from "oracledb";

oracledb.fetchAsString = [oracledb.CLOB];

// node-oracledb exposes Lob at runtime, while the matching DefinitelyTyped
// release models it only as an interface.
const OraLob = (oracledb as unknown as {
  Lob: abstract new (...args: never[]) => oracledb.Lob;
}).Lob;

const PORT = Number(process.env.PORT ?? 3001);
const MAX_ROWS = 1000;
const HOST = process.env.HOST || "127.0.0.1";
const IS_LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
const AUTH_TOKEN = process.env.DATAFORGE_AUTH_TOKEN ?? "";
/** Fine-grained token with Contents: Read and write permission for the configured repository. Never sent to the browser. */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const CREDENTIALS_KEY = (() => {
  const encoded = process.env.DATAFORGE_ENCRYPTION_KEY;
  if (!encoded) return null;
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("DATAFORGE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
})();

/**
 * The names this server answers to, checked against every request's `Host` header.
 *
 * Loopback and the configured `HOST` are always in. Reaching the server by a DNS name —
 * behind a reverse proxy, or through an internal hostname — needs that name listed here,
 * comma-separated. An entry may carry a port to pin it; without one, any port matches, so
 * a TLS terminator on 443 and the Vite dev proxy both work unconfigured.
 */
const ALLOWED_HOSTS = new Set(
  ["localhost", "127.0.0.1", "::1", "[::1]", HOST.toLowerCase()]
    .concat(HOST.includes(":") ? [`[${HOST.toLowerCase()}]`] : [])
    .concat((process.env.DATAFORGE_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()))
    .filter(Boolean)
);

if (!IS_LOOPBACK && !AUTH_TOKEN) throw new Error("DATAFORGE_AUTH_TOKEN is required when HOST is not loopback.");
if (!IS_LOOPBACK && !CREDENTIALS_KEY) throw new Error("DATAFORGE_ENCRYPTION_KEY is required when HOST is not loopback.");

interface ConnConfig {
  name: string;
  engine: "oracle";
  host: string;
  port: number;
  user: string;
  password: string;
  database: string; // Oracle service name
  readOnly: boolean; // when true, only read statements are allowed through this connection
}

interface LiveConnection extends ConnConfig {
  id: string;
  oraPool?: oracledb.Pool;
  /** Cached answer to "is the connected schema Oracle-maintained (SYS, SYSTEM, XDB…)?".
   *  It cannot change for a given user, and PUT replaces the entry, so caching is safe. */
  oracleMaintained?: boolean;
}

interface QueryOutcome {
  columns: string[];
  rows: (string | number | null)[][];
  rowsReturned: number;
  truncated?: boolean;
}

// Connection registry, persisted with AES-256-GCM when DATAFORGE_ENCRYPTION_KEY is set.
const registry = new Map<string, LiveConnection>();
let seq = 1;

const DATA_DIR = path.resolve(import.meta.dirname, "../data");
const DATA_FILE = path.join(DATA_DIR, "connections.json");

type StoredConnection = ConnConfig & { id: string };
type EncryptedRegistry = { version: 2; iv: string; tag: string; data: string };

function decryptRegistry(raw: EncryptedRegistry): StoredConnection[] {
  if (!CREDENTIALS_KEY) throw new Error("DATAFORGE_ENCRYPTION_KEY is required to read saved connections.");
  const decipher = createDecipheriv("aes-256-gcm", CREDENTIALS_KEY, Buffer.from(raw.iv, "base64"));
  decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.data, "base64")), decipher.final()]).toString("utf8")) as StoredConnection[];
}

function encryptRegistry(arr: StoredConnection[]): EncryptedRegistry {
  if (!CREDENTIALS_KEY) throw new Error("DATAFORGE_ENCRYPTION_KEY is required to persist connections.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", CREDENTIALS_KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(arr)), cipher.final()]);
  return { version: 2, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function loadRegistry() {
  try {
    const stored = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as StoredConnection[] | EncryptedRegistry;
    if (Array.isArray(stored) && !IS_LOOPBACK) throw new Error("Plaintext connection storage is not allowed for LAN access. Configure DATAFORGE_ENCRYPTION_KEY and migrate the file.");
    const arr = Array.isArray(stored) ? stored : decryptRegistry(stored);
    for (const c of arr) if (c.engine === "oracle") registry.set(c.id, { ...c });
    seq = arr.reduce((m, c) => Math.max(m, Number(c.id.replace(/\D/g, "")) || 0), 0) + 1;
    if (arr.length) console.log(`Restored ${arr.length} saved connection(s) from ${DATA_FILE}`);
  } catch {
    /* no saved file yet */
  }
}

/** set once the plaintext warning has been printed, so a busy session says it one time */
let warnedPlaintext = false;

/**
 * DATAFORGE_ENCRYPTION_KEY is optional on loopback, so the default local install writes
 * real passwords to disk in clear text. That is a deliberate convenience, but a silent
 * one: nothing in the UI or the log says it is happening. Say it out loud instead —
 * `data/` frequently sits inside a synced folder (OneDrive, Dropbox, iCloud) or a backup
 * set, which copies those credentials off the machine.
 */
function warnIfPlaintextCredentials() {
  if (CREDENTIALS_KEY || warnedPlaintext) return;
  warnedPlaintext = true;
  console.warn(
    `WARNING  Connection passwords are stored unencrypted in ${DATA_FILE}\n` +
      `         Set DATAFORGE_ENCRYPTION_KEY to encrypt them with AES-256-GCM, then save each\n` +
      `         connection once to rewrite the file. Generate a key with:\n` +
      `           openssl rand -base64 32\n` +
      `         Until then, keep data/ out of synced folders and backups.`
  );
}

function saveRegistry() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const arr = [...registry.values()].map(({ oraPool, ...cfg }) => cfg);
    if (arr.length) warnIfPlaintextCredentials();
    fs.writeFileSync(DATA_FILE, CREDENTIALS_KEY ? JSON.stringify(encryptRegistry(arr), null, 2) : JSON.stringify(arr, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error("Could not persist connections:", e);
  }
}

loadRegistry();

/* ---------------- Workspace users: real server-side role enforcement ----------------
 * `accessRole` used to be a client-side dropdown backed by localStorage — cosmetic only,
 * trivially bypassed by anyone editing localStorage or calling the API directly. This
 * replaces it with named accounts the server actually authenticates.
 *
 * As long as no account exists (the out-of-the-box state), the app behaves exactly as
 * before: no login prompt, full access, role "Administrator". Creating the first account
 * (via POST /api/users, open to everyone until one exists) switches the whole server over
 * to requiring HTTP Basic auth with a real username/password on every request.
 */
type Role = "Administrator" | "Developer" | "Analyst" | "Viewer";
const ROLES: Role[] = ["Administrator", "Developer", "Analyst", "Viewer"];
const FULL_ACCESS_ROLES: Role[] = ["Administrator", "Developer"];

interface StoredUser {
  id: string;
  name: string;
  email: string; // lowercase; doubles as the HTTP Basic auth username
  role: Role;
  status: "Active" | "Suspended";
  mfa: boolean; // stored, not enforced — see docs/security.md
  salt: string; // base64
  hash: string; // base64 scrypt hash
  createdAt: string;
}
type PublicUser = Omit<StoredUser, "salt" | "hash">;
const toPublicUser = ({ salt: _salt, hash: _hash, ...rest }: StoredUser): PublicUser => rest;

const USERS_FILE = path.join(DATA_DIR, "users.json");
const users = new Map<string, StoredUser>(); // keyed by lowercase email

/** scrypt needs no extra dependency and (unlike a plain hash) is deliberately slow to brute-force. */
function hashPassword(password: string, salt: Buffer = randomBytes(16)) {
  return { salt: salt.toString("base64"), hash: scryptSync(password, salt, 64).toString("base64") };
}
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * Deliberately expensive, so it must not run on the event loop. HTTP Basic replays the
 * credential on *every* request — each API call and each static asset — and the derivation
 * runs for a wrong password just as long as for a right one. Synchronously that blocked the
 * process for tens of milliseconds at a time and handed anyone who knew one account email a
 * denial of service; on the thread pool a burst no longer stalls unrelated requests.
 */
async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const candidate = await scryptAsync(password, Buffer.from(salt, "base64"), 64);
  const stored = Buffer.from(hash, "base64");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/**
 * Verified credentials, keyed by a SHA-256 of the raw `Authorization` header, so a page load
 * costs one derivation instead of one per request. Only successful verifications are stored,
 * which bounds the map by the number of real accounts; `AUTH_CACHE_MAX` guards the rest.
 *
 * Entries are cheap to throw away, and `saveUsers` throws all of them away: a password
 * change, a suspension or a deletion takes effect on the very next request rather than
 * whenever the TTL happens to lapse.
 */
const AUTH_CACHE_TTL_MS = 5 * 60_000;
const AUTH_CACHE_MAX = 500;
/** `email: null` marks the break-glass token, which has no stored account. */
const authCache = new Map<string, { email: string | null; expires: number }>();
function rememberAuth(key: string, email: string | null) {
  if (authCache.size >= AUTH_CACHE_MAX) authCache.clear();
  authCache.set(key, { email, expires: Date.now() + AUTH_CACHE_TTL_MS });
}

/**
 * Per-address failure counter. The cache above only helps credentials that are *correct*;
 * guesses still reach scrypt, and there is no lockout anywhere else. Ten failures inside a
 * minute buy a minute of 429s from that address, during which no derivation runs at all —
 * which is the point, since the cost is the attack.
 */
const AUTH_FAILURE_LIMIT = 10;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_COOLDOWN_MS = 60_000;
const AUTH_FAILURE_MAX_TRACKED = 1000;
const authFailures = new Map<string, { count: number; since: number; until: number }>();
function authCooldownRemaining(ip: string): number {
  return Math.max(0, (authFailures.get(ip)?.until ?? 0) - Date.now());
}
function recordAuthFailure(ip: string) {
  const now = Date.now();
  if (authFailures.size >= AUTH_FAILURE_MAX_TRACKED && !authFailures.has(ip)) {
    for (const [addr, e] of authFailures) {
      if (e.until <= now && now - e.since > AUTH_FAILURE_WINDOW_MS) authFailures.delete(addr);
    }
    // The sweep above only catches entries that have already expired. With enough distinct
    // addresses still active inside their window, that leaves nothing to reclaim and the map
    // would grow without bound — so once it's still full, evict the oldest tracked addresses
    // until it isn't. `Map` preserves insertion order, so the first key is the oldest.
    while (authFailures.size >= AUTH_FAILURE_MAX_TRACKED) {
      const oldest = authFailures.keys().next().value;
      if (oldest === undefined) break;
      authFailures.delete(oldest);
    }
  }
  const entry = authFailures.get(ip);
  if (!entry || now - entry.since > AUTH_FAILURE_WINDOW_MS) {
    authFailures.set(ip, { count: 1, since: now, until: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= AUTH_FAILURE_LIMIT) {
    entry.until = now + AUTH_COOLDOWN_MS;
    entry.count = 0;
    entry.since = now;
  }
}

function loadUsers() {
  try {
    const arr = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) as StoredUser[];
    for (const u of arr) users.set(u.email.toLowerCase(), u);
  } catch {
    /* no accounts yet — the server stays wide open, as documented above */
  }
}
function saveUsers() {
  authCache.clear(); // a changed, suspended or deleted account must not ride a cached verification
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify([...users.values()], null, 2), { mode: 0o600 });
  } catch (e) {
    console.error("Could not persist users:", e);
  }
}
loadUsers();

/**
 * True once changing (or removing, via `statusOverride: "Suspended"`) `targetId` would
 * leave zero active Administrators — the guard against a self-inflicted lockout.
 */
function wouldOrphanAdministrators(targetId: string, roleOverride?: Role, statusOverride?: "Active" | "Suspended"): boolean {
  const stillActiveAdmin = [...users.values()].some((u) => {
    const role = u.id === targetId ? roleOverride ?? u.role : u.role;
    const status = u.id === targetId ? statusOverride ?? u.status : u.status;
    return role === "Administrator" && status === "Active";
  });
  return !stillActiveAdmin;
}

/**
 * Closes every pooled session held for a connection without forgetting the
 * connection itself. Returns true when something was actually open — the caller
 * uses it to tell "disconnected" from "already disconnected".
 */
async function closePools(c: LiveConnection): Promise<boolean> {
  let wasOpen = false;
  if (c.oraPool) {
    wasOpen = true;
    try {
      await c.oraPool.close(0);
    } catch { /* already closed */ }
    c.oraPool = undefined;
  }
  return wasOpen;
}

function pickConfig(body: any): ConnConfig {
  return {
    name: String(body?.name ?? "").slice(0, 120),
    engine: "oracle",
    host: String(body?.host ?? ""),
    port: Number(body?.port ?? 0),
    user: String(body?.user ?? ""),
    password: String(body?.password ?? ""),
    database: String(body?.database ?? ""),
    // read-only unless the caller explicitly opts out — a connection created without
    // saying anything about writes is treated as the safest thing it could be
    readOnly: body?.readOnly !== false,
  };
}

/** closing character of an Oracle q-quote delimiter: q'[…]' and friends are mirrored, everything else is itself */
const Q_QUOTE_CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/**
 * Comments and string literals blanked. Quoted identifiers survive so the target can still be named.
 *
 * This is a single left-to-right scan, not a chain of `replace()` calls, and that
 * matters for correctness: whichever construct opens *first* in the text has to win.
 * Replacing comments before literals let `… ename = '--' FOR UPDATE` lose everything
 * after the quoted `--` (so it classified as a read); replacing literals first breaks
 * the mirror case, an apostrophe inside a comment swallowing the rest of the statement.
 * Only a single pass gets both right, and it also lets `"it's"` stay an identifier and
 * Oracle's `q'[…]'` literals be recognised as literals.
 */
function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // q'[ … ]' / q'{ … }' / q'! … !' — an alternative-quoting literal, blanked like any other
    if ((ch === "q" || ch === "Q") && next === "'" && i + 2 < sql.length) {
      const open = sql[i + 2];
      const close = Q_QUOTE_CLOSE[open] ?? open;
      let j = i + 3;
      while (j < sql.length && !(sql[j] === close && sql[j + 1] === "'")) j++;
      i = j < sql.length ? j + 2 : sql.length;
      out += "''";
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; } // '' is an escaped quote, not the end
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    // quoted identifiers are copied verbatim: they name the target, and their contents
    // must not be able to open a comment or a literal
    if (ch === '"' || ch === "`") {
      const end = sql.indexOf(ch, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Read-only guard: strips comments/string literals, then requires the statement
 * to start with a read verb AND contain no write/DDL verbs anywhere (this also
 * catches Oracle `WITH … DELETE` and `SELECT … FOR UPDATE`).
 */
function isReadStatement(sql: string): boolean {
  const stripped = stripSqlNoise(sql).replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, "``");
  if (!/^\s*(select|with|show|desc|describe|explain)\b/i.test(stripped)) return false;
  // Oracle 12c+ lets a WITH clause carry a whole PL/SQL routine, which can do anything
  // an autonomous transaction can — the statement still starts with WITH and needs none
  // of the blacklisted verbs to write. Treat it as a write, always.
  if (/^\s*with\b[\s\S]*\b(function|procedure)\b/i.test(stripped)) return false;
  return !/\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|rename|flashback|purge|call|execute|lock)\b/i.test(stripped);
}

/**
 * Analyst's server-side ceiling: the exact single-table preview the Data Browser itself
 * generates (see `previewSql` in src/components/DataBrowser.tsx) — not just any SELECT.
 * The server can't tell "typed in the worksheet" from "generated by the preview panel"
 * any other way, since both arrive as the same SQL text.
 */
function isDataBrowserPreviewSql(sql: string): boolean {
  return /^\s*SELECT\s+\*\s+FROM\s+"[^"]+"\s+FETCH\s+FIRST\s+1000\s+ROWS\s+ONLY\s*;?\s*$/i.test(sql);
}

/** Returns an error message when `role` isn't allowed to run `sql` at all, else null.
 *  Administrator/Developer are unrestricted here (the write guard below still applies). */
function roleQueryDenial(role: Role, sql: string): string | null {
  if (FULL_ACCESS_ROLES.includes(role)) return null;
  if (role === "Analyst") {
    return isDataBrowserPreviewSql(sql)
      ? null
      : "Analyst access is limited to browsing table data.";
  }
  // Viewer
  return isReadStatement(sql) ? null : "Viewer access is read-only — only SELECT statements can run.";
}

/* ---------------- Write guard: read-only by default ----------------
 * Nothing that changes the database runs unless the request explicitly
 * acknowledges it (`confirm: true`). The server classifies the operation and
 * hands the UI the wording for its dialog, so the browser never decides on its
 * own what counts as dangerous — one classifier, no client/server drift.
 */

type GuardLevel = "read" | "write" | "destructive";

interface StatementClass {
  level: GuardLevel;
  verb: string;
  /** object the statement acts on, best-effort ("" when it can't be named) */
  target: string;
}

/** What the UI needs to render a confirmation dialog for a pending operation. */
interface GuardConfirmation extends StatementClass {
  title: string;
  body: string;
  confirmLabel: string;
  /** true = red/danger styling: irreversible or data-destroying */
  danger: boolean;
}

/** object keyword that may sit between the verb and the name (DROP **TABLE** FOO) */
const OBJ_KIND =
  "(?:table|index|view|materialized\\s+view|sequence|procedure|function|package(?:\\s+body)?|trigger|type(?:\\s+body)?|synonym|database\\s+link|user|role|tablespace|database|schema|constraint|column)";
// the name is optional throughout: `SELECT … FOR UPDATE` has a verb and no target, and a
// verb we can't attach a name to still has to be classified rather than fall through
const DESTRUCTIVE_RE = new RegExp(
  `\\b(drop|truncate|delete|alter|grant|revoke|rename|flashback|purge)\\b(?:\\s+(?:from\\s+|${OBJ_KIND}\\s+)?(?:if\\s+exists\\s+)?([A-Za-z_"][A-Za-z0-9_$#."]*)?)?`,
  "i"
);
const WRITE_RE = new RegExp(
  `\\b(insert|update|merge|create|call|exec(?:ute)?|lock|comment|analyze|begin|declare)\\b(?:\\s+(?:into\\s+|on\\s+|or\\s+replace\\s+)?(?:${OBJ_KIND}\\s+)?(?:if\\s+not\\s+exists\\s+)?([A-Za-z_"][A-Za-z0-9_$#."]*)?)?`,
  "i"
);

/**
 * Classify one statement. Anything that isn't provably a read is a write, and
 * anything unrecognised stays a write — the default has to be "ask", never "run".
 */
function classifyStatement(sql: string): StatementClass {
  if (isReadStatement(sql)) return { level: "read", verb: "SELECT", target: "" };
  const stripped = stripSqlNoise(sql);
  const name = (raw: string | undefined) => (raw ?? "").replace(/"/g, "").toUpperCase();
  const d = stripped.match(DESTRUCTIVE_RE);
  if (d) {
    const verb = d[1].toUpperCase();
    // GRANT SELECT ON T TO U — the first identifier is a privilege, not an object
    const target = verb === "GRANT" || verb === "REVOKE" ? "privileges" : name(d[2]);
    return { level: "destructive", verb, target };
  }
  const w = stripped.match(WRITE_RE);
  if (w) return { level: "write", verb: w[1].toUpperCase(), target: name(w[2]) };
  return { level: "write", verb: "STATEMENT", target: "" };
}

/** Human wording for the confirmation dialog of a SQL statement. */
function describeStatement(cls: StatementClass, connName: string): GuardConfirmation {
  const on = cls.target ? ` on ${cls.target}` : "";
  const irreversible = cls.verb === "DROP" || cls.verb === "TRUNCATE" || cls.verb === "PURGE";
  const body =
    irreversible
      ? `${cls.verb}${on} permanently removes objects or data from "${connName}" and cannot be rolled back.`
    : cls.verb === "DELETE"
      ? `DELETE${on} removes rows from the live database "${connName}".`
    : cls.verb === "ALTER" || cls.verb === "RENAME"
      ? `${cls.verb}${on} changes the structure of a live object in "${connName}". Dependent objects may become invalid.`
    : cls.verb === "GRANT" || cls.verb === "REVOKE"
      ? `${cls.verb} changes privileges on "${connName}".`
    : /^CREATE/.test(cls.verb)
      ? `CREATE${on} writes to the schema of "${connName}" and replaces the object if it already exists.`
      : `${cls.verb}${on} modifies data in the live database "${connName}".`;
  return {
    ...cls,
    title: `Confirm ${cls.verb}${cls.target ? ` on ${cls.target}` : ""}`,
    body,
    confirmLabel: `Run ${cls.verb}`,
    danger: cls.level === "destructive",
  };
}

/** Worst level across a DDL batch, so one DROP in a script makes the whole batch destructive. */
function classifyBatch(statements: string[]): StatementClass {
  let worst: StatementClass = { level: "read", verb: "STATEMENT", target: "" };
  for (const s of statements) {
    const c = classifyStatement(s);
    if (c.level === "destructive") return c;
    if (c.level === "write" && worst.level === "read") worst = c;
  }
  return worst;
}

/** The caller has explicitly acknowledged this specific operation. */
function acknowledged(req: express.Request): boolean {
  return req.body?.confirm === true;
}

/** Confirmation for an operation that isn't raw SQL (import, compile, maintenance, …). */
function describeOperation(o: {
  level: Exclude<GuardLevel, "read">;
  verb: string;
  target: string;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}): GuardConfirmation {
  return { ...o, danger: o.danger ?? o.level === "destructive" };
}

/** 409 + everything the UI needs to ask the user. Management-endpoint style. */
function confirmRequired(res: express.Response, confirmation: GuardConfirmation) {
  return res.status(409).json({
    error: `${confirmation.title} — this operation changes the database and needs confirmation.`,
    code: "CONFIRM_REQUIRED",
    confirmation,
  });
}

function validate(cfg: ConnConfig): string | null {
  if (cfg.engine !== "oracle") return "Only Oracle Database connections are supported";
  if (!cfg.host) return "Host is required";
  if (cfg.engine === "oracle" && !cfg.database) return "Service name is required for Oracle (e.g. FREEPDB1)";
  if (!Number.isFinite(cfg.port) || cfg.port < 1 || cfg.port > 65535) return "Invalid port";
  return null;
}

function errMsg(e: unknown): string {
  const err = e as { sqlMessage?: string; message?: string; code?: string; errors?: { code?: string; message?: string }[] };
  if (err.sqlMessage) return err.sqlMessage;
  // Node AggregateError (e.g. ECONNREFUSED on localhost -> ::1 + 127.0.0.1) has an empty message
  if (err.errors?.length) {
    const parts = [...new Set(err.errors.map((x) => x.code ?? x.message ?? ""))].filter(Boolean);
    if (parts.length) return parts.join(" / ");
  }
  return err.message || err.code || "Connection failed";
}

/**
 * True only when this process is actually inside a container. NODE_ENV is not a proxy for
 * that — the supported production install (`npm run build && npm start`) sets NODE_ENV
 * to production on the host, where a "you are in Docker" hint is simply wrong.
 */
const IN_CONTAINER = fs.existsSync("/.dockerenv");

/** Adds a container-networking hint when a connection to localhost is refused from inside one. */
function withNetworkHint(msg: string, host: string): string {
  const refused = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|NJS-5\d\d|Connection failed/i.test(msg);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(host.toLowerCase());
  if (IN_CONTAINER && refused && isLocal) {
    return `${msg} — this app runs inside a container, where "localhost" is the container itself. Use host.docker.internal to reach a database on your machine, or the container name if it runs in a container too.`;
  }
  return msg;
}

/**
 * Oracle 23ai/26ai appends a documentation link to most errors:
 *   ORA-00942: table or view "X"."Y" does not exist
 *   Help: https://docs.oracle.com/error-help/db/ora-00942/
 * Left in the message it renders as a wall of text with a bare URL in the middle. Split
 * it off so the UI can show it as what it is — a link, one click, out of the way.
 */
function splitHelpUrl(msg: string): { message: string; helpUrl?: string } {
  const m = msg.match(/\s*\bHelp:\s*(https?:\/\/\S+?)\/?\s*$/i);
  if (!m) return { message: msg };
  return { message: msg.slice(0, m.index).trimEnd(), helpUrl: m[1] };
}

function mapVal(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    // node-oracledb builds the Date from the Oracle value's own components in the process's
    // local zone, so toISOString() re-reads it as UTC and shifts every value by the local
    // offset — a DATE stored as 09:15 came back as 15:15 on a UTC-6 machine. An Oracle DATE
    // carries no time zone to convert into, so the local components go back out unchanged.
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  if (Buffer.isBuffer(v)) return `0x${v.toString("hex").slice(0, 64)}`;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "string") return v;
  // node-oracledb streams BLOB (and CLOB when not fetchAsString) as a Lob object that
  // back-references its connection — JSON.stringify would hit that circular structure and
  // throw, killing the whole query. Show a typed placeholder instead of the bytes.
  if (v instanceof OraLob) return `[${v.type === oracledb.BLOB ? "BLOB" : "CLOB"}]`;
  // Oracle 23ai VECTOR columns arrive as a typed array (Float32Array for the usual
  // FLOAT32 format, Float64Array / Int8Array / Uint8Array for the others). Plain
  // JSON.stringify turns those into an object keyed by index — {"0":1.41,"1":0.6,…} —
  // which is not the value the user asked for and is far larger than the array form.
  // Buffers are already handled above, so they don't reach this branch.
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const nums = Array.from(v as unknown as ArrayLike<number>);
    // a float32 round-trips exactly at 9 significant digits; printing it at float64
    // precision (1.4140859842300415) adds ~40% to the payload and no information
    const out = v instanceof Float32Array ? nums.map((n) => Number(n.toPrecision(9))) : nums;
    return JSON.stringify(out);
  }
  // last resort: never let one unserializable/circular cell crash the result set
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ---------------- Oracle driver (node-oracledb Thin mode — no client install needed) ---------------- */

const oraConnectString = (c: ConnConfig) => `${c.host}:${c.port}/${c.database}`;

/** SYS can only connect AS SYSDBA (ORA-28009) — apply the privilege automatically, like SQL Developer does. */
const isSysUser = (user: string) => user.trim().toLowerCase() === "sys";

async function getOraPool(c: LiveConnection): Promise<oracledb.Pool> {
  if (!c.oraPool) {
    c.oraPool = await oracledb.createPool({
      user: c.user, password: c.password, connectString: oraConnectString(c),
      poolMin: 0, poolMax: 4, connectTimeout: 8,
    });
  }
  return c.oraPool;
}

/** SYS sessions bypass the pool: each query gets a standalone SYSDBA connection. */
async function getOraConn(c: LiveConnection): Promise<oracledb.Connection> {
  if (isSysUser(c.user)) {
    return oracledb.getConnection({
      user: c.user, password: c.password, connectString: oraConnectString(c),
      privilege: oracledb.SYSDBA, connectTimeout: 8,
    });
  }
  const pool = await getOraPool(c);
  return pool.getConnection();
}

async function oraTest(cfg: ConnConfig): Promise<string> {
  const conn = await oracledb.getConnection({
    user: cfg.user, password: cfg.password, connectString: oraConnectString(cfg), connectTimeout: 8,
    ...(isSysUser(cfg.user) ? { privilege: oracledb.SYSDBA } : {}),
  });
  await conn.execute("SELECT 1 FROM dual");
  const v = conn.oracleServerVersionString;
  await conn.close();
  return `Oracle Database ${v}${isSysUser(cfg.user) ? " (as SYSDBA)" : ""}`;
}

/**
 * Tree groups read in bulk from USER_OBJECTS, each with the `object_type` it lists.
 * `bodyType` is a second type that shares the parent's name: a package whose **body**
 * fails to compile is what SQL Developer marks invalid, so both types condemn the entry.
 */
const ORA_OBJ_GROUPS: { label: string; kind: string; type: string; bodyType?: string }[] = [
  { label: "Indexes", kind: "index", type: "INDEX" },
  { label: "Packages", kind: "package", type: "PACKAGE", bodyType: "PACKAGE BODY" },
  { label: "Procedures", kind: "procedure", type: "PROCEDURE" },
  { label: "Functions", kind: "function", type: "FUNCTION" },
  { label: "Operators", kind: "operator", type: "OPERATOR" },
  { label: "Queues", kind: "queue", type: "QUEUE" },
  { label: "Triggers", kind: "trigger", type: "TRIGGER" },
  { label: "Types", kind: "type", type: "TYPE", bodyType: "TYPE BODY" },
  { label: "Sequences", kind: "sequence", type: "SEQUENCE" },
  { label: "Materialized Views", kind: "view", type: "MATERIALIZED VIEW" },
  { label: "Synonyms", kind: "synonym", type: "SYNONYM" },
  { label: "Scheduler", kind: "job", type: "JOB" },
];

/** Object types read in bulk from USER_OBJECTS. */
const ORA_OBJ_TYPES = ORA_OBJ_GROUPS.map((g) => g.type);

/**
 * Objects the dictionary reports as broken, for the tree's red icons.
 *
 * `status = 'INVALID'` and not `<> 'VALID'` on purpose: USER_OBJECTS also answers `'N/A'`
 * (partitioned indexes, some scheduler objects), and painting those red would be a false
 * alarm on a perfectly healthy schema. An index that really is broken says so in
 * USER_INDEXES/USER_IND_PARTITIONS instead, which is where the second query looks.
 */
const ORA_INVALID_OBJECTS = `SELECT object_type, object_name FROM user_objects
   WHERE status = 'INVALID' AND object_name NOT LIKE 'BIN$%'`;
const ORA_UNUSABLE_INDEXES = `SELECT index_name FROM user_indexes WHERE status = 'UNUSABLE'
   UNION SELECT index_name FROM user_ind_partitions WHERE status = 'UNUSABLE'`;

/** Index internals promoted to their own group (see ORA_SYSGEN_TABLE) — needed by both readers. */
const ORA_SYSGEN_TABLES_SQL = `SELECT table_name FROM user_tables
   WHERE (table_name LIKE 'DR$%' OR table_name LIKE 'DR#%' OR table_name LIKE 'RUPD$%')
   ORDER BY table_name`;
const ORA_OTHER_USERS_SQL = "SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username";

/**
 * Categories with their own dictionary view. Each is fetched independently and
 * tolerates failure (missing feature/privilege in a given edition → empty list).
 */
const ORA_DEDICATED: { label: string; kind: string; sql: string }[] = [
  { label: "Queues Tables", kind: "table", sql: "SELECT queue_table FROM user_queue_tables ORDER BY 1" },
  { label: "Materialized View Logs", kind: "table", sql: "SELECT log_table FROM user_mview_logs ORDER BY 1" },
  {
    label: "Public Synonyms", kind: "synonym",
    // only synonyms pointing at user-created schemas — the full list is thousands of Oracle-owned entries
    sql: `SELECT synonym_name FROM all_synonyms WHERE owner = 'PUBLIC'
          AND table_owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N')
          ORDER BY 1 FETCH FIRST 500 ROWS ONLY`,
  },
  { label: "Database Links", kind: "dblink", sql: "SELECT db_link FROM user_db_links ORDER BY 1" },
  { label: "Public Database Links", kind: "publicdblink", sql: "SELECT db_link FROM all_db_links WHERE owner = 'PUBLIC' ORDER BY 1" },
  { label: "Directories", kind: "directory", sql: "SELECT directory_name FROM all_directories ORDER BY 1" },
  { label: "Editions", kind: "edition", sql: "SELECT edition_name FROM all_editions ORDER BY 1" },
  { label: "XML Schemas", kind: "xmlschema", sql: "SELECT schema_url FROM user_xml_schemas ORDER BY 1" },
  { label: "Analytic Views", kind: "analyticview", sql: "SELECT analytic_view_name FROM user_analytic_views ORDER BY 1" },
  { label: "Property Graph", kind: "graph", sql: "SELECT graph_name FROM user_property_graphs ORDER BY 1" },
  { label: "RDF Semantic Graph", kind: "graph", sql: "SELECT model_name FROM mdsys.sem_model$ ORDER BY 1" },
  { label: "Recycle Bin", kind: "recycle", sql: "SELECT DISTINCT original_name FROM user_recyclebin ORDER BY 1" },
];

/**
 * `user_tables` rows that are an implementation detail of something else, not a table
 * the user modelled. A single Oracle Text CONTEXT index adds ten `DR$<index>$B/$C/$G/…`
 * tables: in one real 37-table schema they were 20 of the entities and 90 of the 201
 * columns, which is enough to bury the business tables in a diagram
 * prompt. Materialized views and mview logs own a table of the same name too, and both
 * already have their own node in the tree — listing them under *Tables* is a duplicate.
 *
 * `$` and `#` are not LIKE metacharacters, so these patterns need no ESCAPE clause.
 */
const oraSysgenLike = (col = "table_name") =>
  `(${col} LIKE 'DR$%' OR ${col} LIKE 'DR#%' OR ${col} LIKE 'MLOG$%' OR ${col} LIKE 'RUPD$%')`;

const ORA_SYSGEN_TABLE = `(${oraSysgenLike()} OR table_name IN (SELECT mview_name FROM user_mviews))`;

/** Same, plus dropped tables still sitting in the recycle bin. */
const ORA_NOISE_TABLE = `(table_name LIKE 'BIN$%' OR ${ORA_SYSGEN_TABLE})`;

async function oraSchema(c: LiveConnection) {
  const conn = await getOraConn(c);
  const tryList = async (sql: string): Promise<string[]> => {
    try {
      const r = await conn.execute<[unknown]>(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
      return (r.rows ?? []).map((x) => String(x[0]));
    } catch {
      return []; // feature not installed / no privilege — category stays visible but empty
    }
  };
  try {
    const tables = await conn.execute<[string, number | null]>(
      `SELECT table_name, num_rows FROM user_tables WHERE NOT ${ORA_NOISE_TABLE} ORDER BY table_name`,
      [], { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    // nothing disappears: the index/mview internals get their own group instead of
    // sitting between the business tables (mview and mview-log tables already have one)
    const sysgen = await tryList(ORA_SYSGEN_TABLES_SQL);
    const views = await conn.execute<[string]>(
      "SELECT view_name FROM user_views ORDER BY view_name",
      [], { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    const objs = await conn.execute<[string, string]>(
      `SELECT object_type, object_name FROM user_objects
       WHERE object_type IN (${ORA_OBJ_TYPES.map((t) => `'${t}'`).join(",")})
         AND object_name NOT LIKE 'BIN$%'
       ORDER BY object_name`,
      [], { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    const objRows = objs.rows ?? [];
    const byType = (t: string) => objRows.filter((r) => r[0] === t).map((r) => r[1]);

    // Validity for the whole schema in one pass: even a 19k-object dictionary schema has a
    // handful of INVALID rows, so this is far cheaper than a status column on every group.
    // A failure leaves `invalidByType` null and every group *untracked* — an uncoloured tree
    // is honest, an all-green one would be a lie.
    let invalidByType: Record<string, string[]> | null = null;
    try {
      const inv = await conn.execute<[string, string]>(ORA_INVALID_OBJECTS, [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
      });
      const m: Record<string, string[]> = {};
      for (const [type, name] of inv.rows ?? []) (m[type] ||= []).push(name);
      invalidByType = m;
    } catch {
      invalidByType = null;
    }
    const unusableIdx = invalidByType ? await tryList(ORA_UNUSABLE_INDEXES) : [];
    const invalidFor = (g: (typeof ORA_OBJ_GROUPS)[number]): string[] | undefined => {
      if (!invalidByType) return undefined;
      const names = [...(invalidByType[g.type] ?? []), ...(g.bodyType ? invalidByType[g.bodyType] ?? [] : [])];
      if (g.type === "INDEX") names.push(...unusableIdx);
      return [...new Set(names)];
    };
    /** an object-type group, with the names the dictionary says are broken */
    const og = (label: string) => {
      const g = ORA_OBJ_GROUPS.find((x) => x.label === label)!;
      return { label: g.label, kind: g.kind, items: byType(g.type), invalid: invalidFor(g) };
    };

    // The dedicated-type queries are independent, so a second pooled connection runs half
    // of them while `conn` runs the other half — cutting this section's latency roughly
    // in half instead of the previous fully serial loop. Each half still runs its own
    // queries one at a time: a single node-oracledb connection cannot execute concurrently.
    const dedicated: Record<string, string[]> = {};
    {
      const conn2 = await getOraConn(c);
      const tryList2 = async (sql: string): Promise<string[]> => {
        try {
          const r = await conn2.execute<[unknown]>(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
          return (r.rows ?? []).map((x) => String(x[0]));
        } catch {
          return [];
        }
      };
      try {
        const mid = Math.ceil(ORA_DEDICATED.length / 2);
        const runHalf = async (items: typeof ORA_DEDICATED, list: typeof tryList) => {
          const out: [string, string[]][] = [];
          for (const d of items) out.push([d.label, await list(d.sql)]);
          return out;
        };
        const [first, second] = await Promise.all([
          runHalf(ORA_DEDICATED.slice(0, mid), tryList),
          runHalf(ORA_DEDICATED.slice(mid), tryList2),
        ]);
        for (const [label, items] of [...first, ...second]) dedicated[label] = items;
      } finally {
        await conn2.close();
      }
    }
    const users = await tryList(ORA_OTHER_USERS_SQL);

    const dGroup = (label: string) => {
      const d = ORA_DEDICATED.find((x) => x.label === label)!;
      return { label: d.label, kind: d.kind, items: dedicated[label] };
    };

    // ordered to mirror SQL Developer's connection tree
    const extras = [
      og("Indexes"),
      og("Packages"),
      og("Procedures"),
      og("Functions"),
      og("Operators"),
      og("Queues"),
      dGroup("Queues Tables"),
      og("Triggers"),
      og("Types"),
      og("Sequences"),
      og("Materialized Views"),
      dGroup("Materialized View Logs"),
      og("Synonyms"),
      dGroup("Public Synonyms"),
      dGroup("Database Links"),
      dGroup("Public Database Links"),
      dGroup("Directories"),
      dGroup("Editions"),
      dGroup("XML Schemas"),
      dGroup("Analytic Views"),
      og("Scheduler"),
      dGroup("Property Graph"),
      dGroup("RDF Semantic Graph"),
      { label: "System-Generated Tables", kind: "table", items: sysgen, invalid: invalidByType ? [] : undefined },
      dGroup("Recycle Bin"),
      { label: "Other Users", kind: "user", items: users },
    ];
    return {
      schemaName: c.user.toUpperCase(),
      tables: (tables.rows ?? []).map((r) => ({ name: r[0], rowCount: Number(r[1] ?? 0) })),
      views: (views.rows ?? []).map((r) => r[0]),
      // a table is never INVALID in the dictionary, so an empty list is the truthful answer:
      // it tells the tree "validity is known here" and every table renders as healthy
      invalidTables: invalidByType ? [] : undefined,
      invalidViews: invalidByType ? invalidByType["VIEW"] ?? [] : undefined,
      extras,
    };
  } finally {
    await conn.close();
  }
}

interface SchemaGroupResult {
  label: string;
  kind: string;
  items: string[];
  invalid?: string[];
  rowCounts?: Record<string, number>;
}

/**
 * Re-read a single Oracle group (the tree's per-type Refresh). Same queries `oraSchema` runs,
 * narrowed to one type, so a refreshed group is indistinguishable from a full reload.
 *
 * `label` arrives from the query string and is only ever *matched* against the constants
 * above — nothing from the request is interpolated into SQL. An unknown label returns null,
 * which the route turns into a 400 rather than an empty group that looks like a dropped type.
 */
async function oraGroup(c: LiveConnection, label: string): Promise<SchemaGroupResult | null> {
  const conn = await getOraConn(c);
  const list = async (sql: string, tolerant = false): Promise<string[]> => {
    try {
      const r = await conn.execute<[unknown]>(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
      return (r.rows ?? []).map((x) => String(x[0]));
    } catch (e) {
      if (tolerant) return []; // feature not installed / no privilege, as in oraSchema
      throw e;
    }
  };
  try {
    if (label === "Tables" || label === "System-Generated Tables") {
      const sysgen = label !== "Tables";
      const r = await conn.execute<[string, number | null]>(
        sysgen
          ? ORA_SYSGEN_TABLES_SQL
          : `SELECT table_name, num_rows FROM user_tables WHERE NOT ${ORA_NOISE_TABLE} ORDER BY table_name`,
        [], { outFormat: oracledb.OUT_FORMAT_ARRAY }
      );
      const rows = r.rows ?? [];
      return {
        label, kind: "table", items: rows.map((x) => x[0]), invalid: [],
        ...(sysgen ? {} : { rowCounts: Object.fromEntries(rows.map((x) => [x[0], Number(x[1] ?? 0)])) }),
      };
    }
    if (label === "Views") {
      return {
        label, kind: "view",
        items: await list("SELECT view_name FROM user_views ORDER BY view_name"),
        invalid: await list(`SELECT object_name FROM user_objects
                             WHERE object_type = 'VIEW' AND status = 'INVALID' AND object_name NOT LIKE 'BIN$%'`),
      };
    }
    const g = ORA_OBJ_GROUPS.find((x) => x.label === label);
    if (g) {
      const types = g.bodyType ? [g.type, g.bodyType] : [g.type];
      const r = await conn.execute<[string, string, string]>(
        `SELECT object_type, object_name, status FROM user_objects
         WHERE object_type IN (${types.map((t) => `'${t}'`).join(",")})
           AND object_name NOT LIKE 'BIN$%'
         ORDER BY object_name`,
        [], { outFormat: oracledb.OUT_FORMAT_ARRAY }
      );
      const rows = r.rows ?? [];
      const invalid = new Set(rows.filter((x) => x[2] === "INVALID").map((x) => x[1]));
      if (g.type === "INDEX") for (const n of await list(ORA_UNUSABLE_INDEXES, true)) invalid.add(n);
      return {
        label, kind: g.kind,
        items: rows.filter((x) => x[0] === g.type).map((x) => x[1]),
        invalid: [...invalid],
      };
    }
    const d = ORA_DEDICATED.find((x) => x.label === label);
    if (d) return { label, kind: d.kind, items: await list(d.sql, true) };
    if (label === "Other Users") return { label, kind: "user", items: await list(ORA_OTHER_USERS_SQL, true) };
    return null;
  } finally {
    await conn.close();
  }
}

/* ---------------- Oracle DBA Performance Advisor ---------------- */

type Row = Record<string, string | number | null>;
type Severity = "good" | "warning" | "serious" | "critical";

/** Run an Oracle query returning named columns, tolerating privilege/feature errors (→ []). */
async function oraRows(conn: oracledb.Connection, sql: string, binds: Record<string, unknown> = {}): Promise<Row[]> {
  try {
    const r = await conn.execute(sql, binds as oracledb.BindParameters, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows as Record<string, unknown>[] ?? []).map((row) => {
      const o: Row = {};
      for (const k in row) o[k] = mapVal(row[k]);
      return o;
    });
  } catch {
    return [];
  }
}

const numOf = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

export interface PerfReport {
  engine: "oracle";
  scope: string;
  tiles: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "err" }[];
  series?: { label: string; unit: string; points: { t: string; v: number }[] };
  slowQueries: { sql: string; avgMs: number; execs: number; totalS: number }[];
  sessions: { id: string; user: string; program: string; status: string; event: string; seconds: number }[];
  storage: { name: string; usedMb: number; totalMb: number | null }[];
  activity: { at: string; text: string; kind: "ok" | "info" | "err" }[];
  note?: string;
}

async function oraPerf(c: LiveConnection): Promise<PerfReport> {
  const conn = await getOraConn(c);
  try {
    const activeSess = numOf(
      (await oraRows(conn, `SELECT COUNT(*) AS "n" FROM v$session WHERE status='ACTIVE' AND type='USER'`))[0]?.n
    );
    const totalSess = numOf((await oraRows(conn, `SELECT COUNT(*) AS "n" FROM v$session`))[0]?.n);
    const stor = (
      await oraRows(
        conn,
        `SELECT ROUND(df.total/1073741824, 2) AS "totalGb",
                ROUND((df.total - NVL(fs.free,0))/1073741824, 2) AS "usedGb"
         FROM (SELECT SUM(bytes) total FROM dba_data_files) df,
              (SELECT SUM(bytes) free FROM dba_free_space) fs`
      )
    )[0];
    const errs = numOf(
      (await oraRows(conn, `SELECT COUNT(*) AS "n" FROM v$diag_alert_ext WHERE message_type = 2 AND originating_timestamp > SYSTIMESTAMP - 1`))[0]?.n
    );

    // real per-minute history (last ~hour). In a PDB, v$sysmetric_history is empty
    // (metrics roll up to CDB root), so prefer the container-scoped view.
    let series: PerfReport["series"] | undefined;
    outer: for (const view of ["v$con_sysmetric_history", "v$sysmetric_history"]) {
      for (const metric of ["Executions Per Sec", "User Calls Per Sec", "Average Active Sessions"]) {
        const pts = await oraRows(
          conn,
          `SELECT TO_CHAR(begin_time,'HH24:MI') AS "t", ROUND(value,2) AS "v"
           FROM ${view} WHERE metric_name = '${metric}'
           ORDER BY begin_time`
        );
        if (pts.length) {
          series = { label: metric, unit: "/sec", points: pts.map((p) => ({ t: String(p.t), v: numOf(p.v) })) };
          break outer;
        }
      }
    }

    const slow = await oraRows(
      conn,
      `SELECT SUBSTR(REPLACE(REPLACE(sql_text,CHR(10),' '),CHR(13),' '),1,120) AS "sql",
              ROUND(elapsed_time/GREATEST(executions,1)/1000,2) AS "avgMs",
              executions AS "execs", ROUND(elapsed_time/1e6,2) AS "totalS"
       FROM v$sqlstats WHERE executions > 0
       ORDER BY elapsed_time DESC FETCH FIRST 8 ROWS ONLY`
    );

    const sess = await oraRows(
      conn,
      `SELECT sid AS "id", NVL(username,'(background)') AS "user",
              NVL(program,'—') AS "program", status AS "status",
              NVL(event,'—') AS "event", NVL(last_call_et,0) AS "seconds"
       FROM v$session WHERE type='USER'
       ORDER BY DECODE(status,'ACTIVE',0,1), last_call_et DESC FETCH FIRST 10 ROWS ONLY`
    );

    const ts = await oraRows(
      conn,
      `SELECT tablespace_name AS "name",
              ROUND(used_space*8192/1048576,1) AS "usedMb",
              ROUND(tablespace_size*8192/1048576,1) AS "totalMb", ROUND(used_percent,1) AS "pct"
       FROM dba_tablespace_usage_metrics ORDER BY used_percent DESC`
    );

    const acts = await oraRows(
      conn,
      `SELECT TO_CHAR(last_active_time,'HH24:MI:SS') AS "at", sql_id AS "sqlId",
              SUBSTR(REPLACE(sql_text,CHR(10),' '),1,70) AS "txt"
       FROM v$sqlstats WHERE last_active_time IS NOT NULL
       ORDER BY last_active_time DESC FETCH FIRST 8 ROWS ONLY`
    );

    return {
      engine: "oracle",
      scope: `${c.database} · ${c.user.toUpperCase()}`,
      tiles: [
        { label: "Active sessions", value: String(activeSess), sub: `${totalSess} total`, tone: activeSess > 20 ? "warn" : undefined },
        { label: "Storage used", value: stor ? `${numOf(stor.usedGb).toLocaleString()} GB` : "—", sub: stor ? `of ${numOf(stor.totalGb).toLocaleString()} GB allocated` : undefined },
        { label: "Tablespaces", value: String(ts.length), sub: ts[0] ? `top ${ts[0].name} at ${ts[0].pct}%` : undefined, tone: ts.some((t) => numOf(t.pct) > 85) ? "warn" : undefined },
        { label: "Alerts (24h)", value: String(errs), sub: errs ? "check the alert log" : "none", tone: errs > 0 ? "err" : "ok" },
      ],
      series,
      slowQueries: slow.map((r) => ({ sql: String(r.sql), avgMs: numOf(r.avgMs), execs: numOf(r.execs), totalS: numOf(r.totalS) })),
      sessions: sess.map((r) => ({ id: String(r.id), user: String(r.user), program: String(r.program), status: String(r.status), event: String(r.event), seconds: numOf(r.seconds) })),
      storage: ts.map((r) => ({ name: String(r.name), usedMb: numOf(r.usedMb), totalMb: numOf(r.totalMb) })),
      activity: acts.map((r) => ({ at: String(r.at), text: `${r.sqlId}: ${r.txt}`, kind: "info" as const })),
    };
  } finally {
    await conn.close();
  }
}

async function oraDba(c: LiveConnection) {
  const conn = await getOraConn(c);
  const q = async (sql: string): Promise<Row[]> => {
    try {
      const r = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return (r.rows as Record<string, unknown>[] ?? []).map((row) => {
        const o: Row = {};
        for (const k in row) o[k] = mapVal(row[k]);
        return o;
      });
    } catch {
      return []; // view not accessible with current privileges
    }
  };
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

  try {
    const instance =
      (
        await q(
          `SELECT i.instance_name AS "name", i.version_full AS "version", i.status AS "status",
                  TO_CHAR(i.startup_time,'YYYY-MM-DD HH24:MI') AS "startup", i.host_name AS "host",
                  d.name AS "dbName", d.open_mode AS "openMode"
           FROM v$instance i CROSS JOIN v$database d`
        )
      )[0] ?? null;

    // v$sysmetric is often empty on a freshly-started instance, so compute ratios
    // from the always-populated cumulative counters instead (values are since startup).
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const sysstat = await q(
      `SELECT name AS "n", value AS "v" FROM v$sysstat WHERE name IN
        ('physical reads cache','db block gets from cache','consistent gets from cache',
         'parse count (total)','parse count (hard)','execute count','user commits')`
    );
    const stat = (n: string) => num(sysstat.find((r) => r.n === n)?.v);
    const logical = stat("db block gets from cache") + stat("consistent gets from cache");
    const bufferHit = logical > 0 ? (1 - stat("physical reads cache") / logical) * 100 : 100;
    const totalParse = stat("parse count (total)");
    const softParse = totalParse > 0 ? (1 - stat("parse count (hard)") / totalParse) * 100 : 100;

    const libRows = await q(`SELECT SUM(pins) AS "pins", SUM(pinhits) AS "hits" FROM v$librarycache`);
    const libHit = num(libRows[0]?.pins) > 0 ? (num(libRows[0]?.hits) / num(libRows[0]?.pins)) * 100 : 100;

    const osRows = await q(`SELECT stat_name AS "n", value AS "v" FROM v$osstat WHERE stat_name IN ('BUSY_TIME','IDLE_TIME')`);
    const busy = num(osRows.find((r) => r.n === "BUSY_TIME")?.v);
    const idle = num(osRows.find((r) => r.n === "IDLE_TIME")?.v);
    const cpuPct = busy + idle > 0 ? (busy / (busy + idle)) * 100 : 0;

    const metrics = [
      { name: "Buffer Cache Hit Ratio", value: round1(bufferHit), unit: "%" },
      { name: "Library Cache Hit Ratio", value: round1(libHit), unit: "%" },
      { name: "Soft Parse Ratio", value: round1(softParse), unit: "%" },
      { name: "Host CPU Utilization (%)", value: round1(cpuPct), unit: "%" },
      { name: "Executions", value: stat("execute count"), unit: "since startup" },
      { name: "User Commits", value: stat("user commits"), unit: "since startup" },
    ];

    const waitEvents = await q(
      `SELECT event AS "event", total_waits AS "waits",
              ROUND(time_waited_micro/1e6, 2) AS "timeS",
              ROUND(average_wait*10, 2) AS "avgMs", wait_class AS "waitClass"
       FROM v$system_event WHERE wait_class <> 'Idle'
       ORDER BY time_waited_micro DESC FETCH FIRST 10 ROWS ONLY`
    );

    const topSql = await q(
      `SELECT sql_id AS "sqlId", ROUND(elapsed_time/1e6, 2) AS "elapsedS", executions AS "executions",
              ROUND(elapsed_time/GREATEST(executions,1)/1000, 2) AS "perExecMs",
              SUBSTR(REPLACE(REPLACE(sql_text, CHR(10), ' '), CHR(13), ' '), 1, 140) AS "sqlText"
       FROM v$sqlstats WHERE executions > 0
       ORDER BY elapsed_time DESC FETCH FIRST 10 ROWS ONLY`
    );

    const tablespaces = await q(
      `SELECT tablespace_name AS "name",
              ROUND(used_space*8192/1024/1024, 1) AS "usedMb",
              ROUND(tablespace_size*8192/1024/1024, 1) AS "totalMb",
              ROUND(used_percent, 1) AS "pct"
       FROM dba_tablespace_usage_metrics ORDER BY used_percent DESC`
    );

    const sessRows = await q(`SELECT status AS "status", COUNT(*) AS "cnt" FROM v$session GROUP BY status`);
    const active = num(sessRows.find((r) => r.status === "ACTIVE")?.cnt);
    const inactive = num(sessRows.find((r) => r.status === "INACTIVE")?.cnt);
    const sessUsers = await q(
      `SELECT username AS "user", COUNT(*) AS "cnt" FROM v$session
       WHERE username IS NOT NULL GROUP BY username ORDER BY COUNT(*) DESC FETCH FIRST 6 ROWS ONLY`
    );

    const sga = await q(
      `SELECT name AS "name", ROUND(bytes/1024/1024, 1) AS "mb" FROM v$sgainfo
       WHERE name IN ('Fixed SGA Size','Redo Buffers','Buffer Cache Size','Shared Pool Size',
                      'Large Pool Size','Java Pool Size','Maximum SGA Size') ORDER BY bytes DESC`
    );
    const pga = await q(
      `SELECT name AS "name", ROUND(value/1024/1024, 1) AS "mb" FROM v$pgastat
       WHERE name IN ('total PGA allocated','total PGA inuse','aggregate PGA target parameter','maximum PGA allocated')`
    );

    // --- synthesize advisor findings from thresholds ---
    const advice: { severity: Severity; title: string; detail: string }[] = [];
    const metric = (name: string) => metrics.find((m) => m.name === name);
    const bchr = num(metric("Buffer Cache Hit Ratio")?.value);
    if (metric("Buffer Cache Hit Ratio") && bchr < 90)
      advice.push({ severity: bchr < 80 ? "serious" : "warning", title: "Low buffer cache hit ratio", detail: `Buffer cache hit ratio is ${bchr.toFixed(1)}% (target ≥ 90%). Consider increasing DB_CACHE_SIZE or reviewing full-table-scan-heavy SQL.` });
    const lchr = num(metric("Library Cache Hit Ratio")?.value);
    if (metric("Library Cache Hit Ratio") && lchr < 95)
      advice.push({ severity: "warning", title: "Library cache misses", detail: `Library cache hit ratio is ${lchr.toFixed(1)}% (target ≥ 95%). Often caused by non-shareable SQL — use bind variables instead of literals.` });
    const cpu = num(metric("Host CPU Utilization (%)")?.value);
    if (metric("Host CPU Utilization (%)") && cpu > 85)
      advice.push({ severity: cpu > 95 ? "critical" : "serious", title: "High host CPU utilization", detail: `Host CPU is at ${cpu.toFixed(0)}%. Review the top SQL by elapsed time below for CPU-bound statements.` });
    for (const t of tablespaces) {
      const pct = num(t.pct);
      if (pct > 90) advice.push({ severity: "critical", title: `Tablespace ${t.name} almost full`, detail: `${t.name} is ${pct.toFixed(1)}% used. Add a datafile or enable AUTOEXTEND to avoid ORA-01653.` });
      else if (pct > 80) advice.push({ severity: "serious", title: `Tablespace ${t.name} filling up`, detail: `${t.name} is ${pct.toFixed(1)}% used. Plan to extend it soon.` });
    }
    const topWait = waitEvents[0];
    if (topWait && ["Concurrency", "Contention", "Cluster"].includes(String(topWait.waitClass)))
      advice.push({ severity: "serious", title: `Contention: ${topWait.event}`, detail: `The top wait event is "${topWait.event}" (${topWait.waitClass}), ${num(topWait.timeS).toFixed(0)}s total. Investigate blocking sessions and hot blocks.` });
    if (advice.length === 0 && instance)
      advice.push({ severity: "good", title: "No performance issues detected", detail: "Cache ratios, CPU, tablespace headroom and wait profile are all within healthy thresholds." });

    return {
      available: !!instance,
      privilegeHint: instance
        ? undefined
        : "The dynamic performance views (V$…) are not visible with this user. Connect as SYS/SYSTEM or grant SELECT_CATALOG_ROLE to see DBA metrics.",
      instance,
      metrics,
      waitEvents,
      topSql,
      tablespaces,
      sessions: { active, inactive, total: active + inactive, users: sessUsers },
      sga,
      pga,
      advice,
    };
  } finally {
    await conn.close();
  }
}

/* ---------------- Object dependency explorer ---------------- */

interface DepItem {
  owner?: string;
  name: string;
  type: string;
  /** how the dependency was detected, e.g. "FK ORDERS_CUST_FK" or "text match" */
  via?: string;
  status?: string;
}

interface DepsReport {
  engine: "oracle";
  object: { name: string; type: string; status?: string } | null;
  /** what the object itself depends on (direct) */
  uses: DepItem[];
  /** what directly depends on the object */
  usedBy: DepItem[];
  /** transitive impact: everything that could break, with level + path */
  impact: (DepItem & { level: number; path: string })[];
  note?: string;
}

const fmtPath = (raw: string) => raw.split("~>").map((s) => s.trim()).filter(Boolean).join(" → ");

/** Oracle: real dependency data from the data dictionary (user_/all_dependencies + FK constraints). */
async function oraDeps(c: LiveConnection, name: string): Promise<DepsReport> {
  const conn = await getOraConn(c);
  const n = name.toUpperCase();
  try {
    const obj = (
      await oraRows(
        conn,
        `SELECT object_name AS "name", object_type AS "type", status AS "status"
         FROM user_objects WHERE object_name = :n AND object_type <> 'PACKAGE BODY'
         ORDER BY object_type FETCH FIRST 1 ROWS ONLY`,
        { n }
      )
    )[0];

    const uses = await oraRows(
      conn,
      `SELECT DISTINCT referenced_owner AS "owner", referenced_name AS "name", referenced_type AS "type"
       FROM user_dependencies
       WHERE name = :n AND referenced_name <> :n
       ORDER BY 3, 2`,
      { n }
    );

    const usedBy = await oraRows(
      conn,
      `SELECT DISTINCT d.owner AS "owner", d.name AS "name", d.type AS "type",
              (SELECT MIN(o.status) FROM all_objects o
                WHERE o.owner = d.owner AND o.object_name = d.name AND o.object_type = d.type) AS "status"
       FROM all_dependencies d
       WHERE d.referenced_name = :n AND d.referenced_owner = USER AND d.name <> :n
       ORDER BY 3, 2`,
      { n }
    );

    // FK children: tables whose foreign keys point at this table (not tracked in *_dependencies)
    const fkChildren = await oraRows(
      conn,
      `SELECT a.owner AS "owner", a.table_name AS "name", a.constraint_name AS "via"
       FROM all_constraints a
       JOIN all_constraints r ON a.r_owner = r.owner AND a.r_constraint_name = r.constraint_name
       WHERE a.constraint_type = 'R' AND r.table_name = :n AND r.owner = USER
       ORDER BY 2`,
      { n }
    );

    // FK parents: tables this table's own foreign keys point at
    const fkParents = await oraRows(
      conn,
      `SELECT r.owner AS "owner", r.table_name AS "name", a.constraint_name AS "via"
       FROM all_constraints a
       JOIN all_constraints r ON a.r_owner = r.owner AND a.r_constraint_name = r.constraint_name
       WHERE a.constraint_type = 'R' AND a.table_name = :n AND a.owner = USER
       ORDER BY 2`,
      { n }
    );

    // transitive impact tree (who breaks if this object changes), cycle-safe
    const impactRows = await oraRows(
      conn,
      `SELECT d.owner AS "owner", d.name AS "name", d.type AS "type", LEVEL AS "lvl",
              LTRIM(SYS_CONNECT_BY_PATH(d.name, '~>'), '~>') AS "path",
              (SELECT MIN(o.status) FROM all_objects o
                WHERE o.owner = d.owner AND o.object_name = d.name AND o.object_type = d.type) AS "status"
       FROM all_dependencies d
       START WITH d.referenced_name = :n AND d.referenced_owner = USER
       CONNECT BY NOCYCLE PRIOR d.name = d.referenced_name
                      AND PRIOR d.owner = d.referenced_owner
                      AND PRIOR d.type = d.referenced_type
       ORDER BY LEVEL, d.owner, d.name
       FETCH FIRST 500 ROWS ONLY`,
      { n }
    );

    const impact: DepsReport["impact"] = [];
    const seen = new Set<string>();
    for (const r of impactRows) {
      const key = `${r.owner}.${r.name}.${r.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      impact.push({
        owner: String(r.owner), name: String(r.name), type: String(r.type),
        status: r.status ? String(r.status) : undefined,
        level: numOf(r.lvl),
        path: fmtPath(`${n}~>${r.path}`),
      });
    }
    // FK children are impact too (a column/constraint change hits them), at level 1
    for (const r of fkChildren) {
      const key = `${r.owner}.${r.name}.TABLE`;
      if (seen.has(key)) continue;
      seen.add(key);
      impact.push({
        owner: String(r.owner), name: String(r.name), type: "TABLE", via: `FK ${r.via}`,
        level: 1, path: `${n} → ${r.name}`,
      });
    }

    return {
      engine: "oracle",
      object: obj
        ? { name: String(obj.name), type: String(obj.type), status: obj.status ? String(obj.status) : undefined }
        : null,
      uses: [
        ...uses.map((r) => ({ owner: String(r.owner), name: String(r.name), type: String(r.type) })),
        ...fkParents.map((r) => ({ owner: String(r.owner), name: String(r.name), type: "TABLE", via: `FK ${r.via}` })),
      ],
      usedBy: [
        ...usedBy.map((r) => ({
          owner: String(r.owner), name: String(r.name), type: String(r.type),
          status: r.status ? String(r.status) : undefined,
        })),
        ...fkChildren.map((r) => ({ owner: String(r.owner), name: String(r.name), type: "TABLE", via: `FK ${r.via}` })),
      ],
      impact,
      note: obj
        ? undefined
        : `No object named ${n} in schema ${c.user.toUpperCase()} — results below only cover dependencies visible to this user.`,
    };
  } finally {
    await conn.close();
  }
}

/* ---------------- Code versioning ----------------
 * Every successful CREATE [OR REPLACE] PROCEDURE / FUNCTION / PACKAGE [BODY] /
 * TRIGGER automatically snapshots the object's source into data/versions/ and
 * appends an entry to data/changelog.json. DROPs are logged too. Only code
 * objects are versioned — tables/data are out of scope by design. */

const VERSIONS_DIR = path.join(DATA_DIR, "versions");
const CHANGELOG_FILE = path.join(DATA_DIR, "changelog.json");
const MAX_CHANGELOG = 1000;

interface CodeVersion {
  version: number;
  at: string; // ISO timestamp
  action: "CREATE" | "REPLACE";
  hash: string; // sha1 of the trimmed source — used to skip no-op recompiles
  source: string;
}

interface VersionFile {
  engine: string;
  connKey: string;
  name: string;
  type: string;
  versions: CodeVersion[];
}

interface ChangeLogEntry {
  at: string;
  connId: string;
  connName: string;
  connKey: string;
  engine: string;
  name: string;
  type: string;
  action: "CREATE" | "REPLACE" | "DROP";
  version: number | null; // null for DROP
}

/** What /query reports back when a statement touched a versioned code object. */
export interface VersionedInfo {
  action: "CREATE" | "REPLACE" | "DROP" | "UNCHANGED";
  type: string;
  name: string;
  version: number | null;
}

/** Stable identity for "the same database" across connection re-creates (ids are not stable). */
const connKey = (c: ConnConfig) =>
  [c.engine, c.host, c.port, c.database || "-", c.user]
    .join("_")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .toLowerCase();

/**
 * `name` and `key` were already scrubbed of path separators; `type` was only
 * whitespace-collapsed, and it reaches here straight from a query string
 * (`/versions/object?type=`). `path.join` resolves `..`, so that was enough to read
 * any `*__*.json` outside data/versions/. Every segment is scrubbed now — the write
 * path can only produce fixed type names anyway, so nothing legitimate changes.
 */
const versionFilePath = (key: string, type: string, name: string) =>
  path.join(
    VERSIONS_DIR,
    `${key}__${type.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "_")}__${name.replace(/[^A-Za-z0-9_$#.-]/g, "_")}.json`
  );

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function appendChangeLog(entry: ChangeLogEntry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const log = readJsonFile<ChangeLogEntry[]>(CHANGELOG_FILE, []);
    log.push(entry);
    fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(log.slice(-MAX_CHANGELOG), null, 2));
  } catch (e) {
    console.error("Could not persist changelog entry:", e);
  }
}

interface CodeChange {
  action: "CREATE" | "DROP";
  type: string; // PROCEDURE | FUNCTION | PACKAGE | PACKAGE BODY | TRIGGER
  name: string;
}

/** Detect a CREATE/DROP of a code object. Returns null for everything else. */
function detectCodeChange(engine: string, sql: string): CodeChange | null {
  const clean = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const kinds = engine === "oracle" ? "procedure|function|package\\s+body|package|trigger" : "procedure|function|trigger";
  const create = new RegExp(
    `^\\s*create\\s+(?:or\\s+replace\\s+)?(?:editionable\\s+|noneditionable\\s+)?(?:definer\\s*=\\s*\\S+\\s+)?(${kinds})\\s+(?:if\\s+not\\s+exists\\s+)?([\`"]?[\\w$#]+[\`"]?(?:\\.[\`"]?[\\w$#]+[\`"]?)?)`,
    "i"
  );
  const drop = new RegExp(`^\\s*drop\\s+(${kinds})\\s+(?:if\\s+exists\\s+)?([\`"]?[\\w$#]+[\`"]?(?:\\.[\`"]?[\\w$#]+[\`"]?)?)`, "i");
  const m = clean.match(create) ?? clean.match(drop);
  if (!m) return null;
  const action: CodeChange["action"] = /^\s*create/i.test(clean) ? "CREATE" : "DROP";
  const type = m[1].toUpperCase().replace(/\s+/g, " ");
  const parts = m[2].split(".");
  let name = parts[parts.length - 1].replace(/[`"]/g, "");
  if (engine === "oracle" && !/"/.test(m[2])) name = name.toUpperCase();
  return { action, type, name };
}

/** Canonical source as stored by Oracle (user_source keeps line breaks per line). */
async function fetchOraSource(c: LiveConnection, type: string, name: string): Promise<string | null> {
  const conn = await getOraConn(c);
  try {
    const rows = await oraRows(
      conn,
      `SELECT text FROM user_source WHERE name = :n AND type = :t ORDER BY line`,
      { n: name, t: type }
    );
    if (!rows.length) return null;
    return rows.map((r) => String(r.TEXT ?? "")).join("");
  } finally {
    await conn.close();
  }
}

/** Canonical source via SHOW CREATE (name is identifier-safe: regex-restricted + backtick-stripped). */
/** Called after every successful /query. Never throws into the caller's path. */
async function captureCodeVersion(c: LiveConnection, sql: string): Promise<VersionedInfo | null> {
  const change = detectCodeChange(c.engine, sql);
  if (!change) return null;
  const key = connKey(c);
  const now = new Date().toISOString();

  if (change.action === "DROP") {
    appendChangeLog({
      at: now, connId: c.id, connName: c.name, connKey: key, engine: c.engine,
      name: change.name, type: change.type, action: "DROP", version: null,
    });
    return { action: "DROP", type: change.type, name: change.name, version: null };
  }

  let source: string | null = null;
  try {
    source = await fetchOraSource(c, change.type, change.name);
  } catch {
    source = null;
  }
  if (!source) source = sql; // dictionary unavailable → keep the executed statement itself

  const hash = createHash("sha1").update(source.trim()).digest("hex");
  const file = versionFilePath(key, change.type, change.name);
  const vf = readJsonFile<VersionFile>(file, {
    engine: c.engine, connKey: key, name: change.name, type: change.type, versions: [],
  });
  const last = vf.versions[vf.versions.length - 1];
  if (last && last.hash === hash) {
    // re-running the identical source is not a new version and is not logged
    return { action: "UNCHANGED", type: change.type, name: change.name, version: last.version };
  }

  const action: CodeVersion["action"] = vf.versions.length ? "REPLACE" : "CREATE";
  const version = (last?.version ?? 0) + 1;
  vf.versions.push({ version, at: now, action, hash, source });
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(vf, null, 2));
  appendChangeLog({
    at: now, connId: c.id, connName: c.name, connKey: key, engine: c.engine,
    name: change.name, type: change.type, action, version,
  });
  return { action, type: change.type, name: change.name, version };
}

/** All versioned objects for a connection (summaries — sources stay on disk). */
function listVersionedObjects(c: LiveConnection) {
  const key = connKey(c);
  let files: string[] = [];
  try {
    files = fs.readdirSync(VERSIONS_DIR).filter((f) => f.startsWith(`${key}__`) && f.endsWith(".json"));
  } catch {
    /* no versions dir yet */
  }
  const objects = files
    .map((f) => readJsonFile<VersionFile | null>(path.join(VERSIONS_DIR, f), null))
    .filter((v): v is VersionFile => !!v && v.versions.length > 0)
    .map((v) => {
      const last = v.versions[v.versions.length - 1];
      return {
        name: v.name,
        type: v.type,
        versionCount: v.versions.length,
        latestVersion: last.version,
        latestAt: last.at,
        latestAction: last.action,
      };
    })
    .sort((a, b) => (a.latestAt < b.latestAt ? 1 : -1));
  return { connKey: key, objects };
}

/* ---------------- Object source (real DDL for the Object Editor) ---------------- */

interface ObjectSource {
  name: string;
  type: string | null;
  source: string | null;
  /** true when the object belongs to an Oracle-maintained schema (SYS, SYSTEM, XDB…).
   *  The editor shows these read-only: recompiling a dictionary object such as
   *  SYS.STANDARD can leave the instance unusable, and nothing else in the tree
   *  distinguishes one from a user object. */
  systemObject?: boolean;
  /** PACKAGE/TYPE only: the BODY as its own runnable CREATE OR REPLACE (null when no body exists) */
  bodySource?: string | null;
  error?: string;
}

const ORA_CODE_TYPES = new Set(["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE"]);

/** Fallback for instances where all_users.oracle_maintained can't be read. Not exhaustive —
 *  the dictionary flag is the real answer; this only has to catch the schemas a person
 *  actually connects as by accident. */
const ORA_SYSTEM_SCHEMAS = new Set([
  "SYS", "SYSTEM", "XDB", "CTXSYS", "MDSYS", "ORDSYS", "ORDDATA", "ORDPLUGINS", "OLAPSYS",
  "WMSYS", "LBACSYS", "DVSYS", "DVF", "AUDSYS", "APPQOSSYS", "GSMADMIN_INTERNAL", "OUTLN",
  "DBSNMP", "OJVMSYS", "GGSYS", "ANONYMOUS", "SYSBACKUP", "SYSDG", "SYSKM", "SYSRAC", "DIP",
]);

/** True when the connected schema is Oracle-maintained. Cached on the connection: one
 *  dictionary read per connection, not one per object opened. */
async function oraUserIsSystem(c: LiveConnection, conn: oracledb.Connection): Promise<boolean> {
  if (c.oracleMaintained !== undefined) return c.oracleMaintained;
  if (ORA_SYSTEM_SCHEMAS.has(c.user.toUpperCase())) {
    c.oracleMaintained = true;
    return true;
  }
  // oraRows swallows errors and returns [] — an unreadable/absent column then means
  // "not a system schema", which is the permissive answer, so the name check runs first.
  const rows = await oraRows(conn, `SELECT oracle_maintained FROM all_users WHERE username = USER`);
  c.oracleMaintained = rows.length > 0 && String(rows[0].ORACLE_MAINTAINED) === "Y";
  return c.oracleMaintained;
}

/** DBMS_METADATA names the object types differently from user_objects for a few kinds. */
const ORA_DDL_TYPE: Record<string, string> = {
  "DATABASE LINK": "DB_LINK",
  JOB: "PROCOBJ",
  PROGRAM: "PROCOBJ",
  SCHEDULE: "PROCOBJ",
  "JOB CLASS": "PROCOBJ",
  QUEUE: "AQ_QUEUE",
  "JAVA CLASS": "JAVA_CLASS",
  "JAVA SOURCE": "JAVA_SOURCE",
};
const ddlTypeOf = (type: string) => ORA_DDL_TYPE[type] ?? type.replace(/\s+/g, "_");

/** Rebuild CREATE SEQUENCE from user_sequences (DBMS_METADATA won't emit identity
 *  ISEQ$$_… sequences). Returns null when the sequence isn't in this schema. */
async function oraSequenceDdl(conn: oracledb.Connection, name: string): Promise<string | null> {
  // TO_CHAR everything numeric: MIN/MAX_VALUE are NUMBER(28) and would come back as
  // JS floats in exponent form ("1e+28"), losing the exact integer.
  const rows = await oraRows(
    conn,
    `SELECT TO_CHAR(min_value) min_value, TO_CHAR(max_value) max_value,
            TO_CHAR(increment_by) increment_by, TO_CHAR(cache_size) cache_size,
            cycle_flag, order_flag, TO_CHAR(last_number) last_number
     FROM user_sequences WHERE sequence_name = :n`,
    { n: name }
  );
  if (!rows.length) return null;
  const r = rows[0];
  const cache = Number(r.CACHE_SIZE);
  // identity sequences carry a system name — quote it so the statement parses
  const parts = [
    `CREATE SEQUENCE ${/^[A-Z][A-Z0-9_$#]*$/.test(name) ? name : `"${name}"`}`,
    `  START WITH ${r.LAST_NUMBER}`,
    `  INCREMENT BY ${r.INCREMENT_BY}`,
    `  MINVALUE ${r.MIN_VALUE}`,
    `  MAXVALUE ${r.MAX_VALUE}`,
    cache > 0 ? `  CACHE ${cache}` : `  NOCACHE`,
    String(r.CYCLE_FLAG) === "Y" ? `  CYCLE` : `  NOCYCLE`,
    String(r.ORDER_FLAG) === "Y" ? `  ORDER` : `  NOORDER`,
  ];
  let ddl = parts.join("\n") + ";";

  // if it backs an identity column, that's the real source of truth — point at it
  const idc = await oraRows(
    conn,
    `SELECT table_name, column_name FROM user_tab_identity_cols WHERE sequence_name = :n`,
    { n: name }
  );
  if (idc.length) {
    ddl =
      `-- System-generated sequence backing identity column ${idc[0].TABLE_NAME}.${idc[0].COLUMN_NAME}.\n` +
      `-- It is managed by that column's GENERATED AS IDENTITY clause — this DDL is reconstructed, not from DBMS_METADATA.\n\n` +
      ddl;
  }
  return ddl;
}

async function oraObjectSource(c: LiveConnection, rawName: string, wantType?: string): Promise<ObjectSource> {
  // Oracle identifiers are case-sensitive when they were created quoted. Uppercasing
  // blindly made a lowercase object resolve to a *different* same-named uppercase one
  // (e.g. the synonym "product_catalog_dv" returned the view PRODUCT_CATALOG_DV), so
  // the exact spelling is tried first and the uppercase form is only a fallback.
  const upper = rawName.toUpperCase();
  // empty rather than null: node-oracledb can't infer a bind type for a bare null, and an
  // empty string simply never matches an object_type, so the tie-break degrades to a no-op
  const wt = wantType ? wantType.toUpperCase() : "";
  const conn = await getOraConn(c);
  try {
    const obj = await oraRows(
      conn,
      // exact-case match wins, then the caller's expected type, then the specific type
      // over TABLE (a materialized view also has a TABLE row for its container)
      // NB: bind names avoid Oracle keywords — ":raw" is a datatype and fails to parse
      `SELECT object_name, object_type FROM user_objects
       WHERE object_name IN (:nexact, :nupper) AND object_type NOT IN ('PACKAGE BODY','TYPE BODY')
       ORDER BY CASE WHEN object_name = :nexact THEN 0 ELSE 1 END,
                CASE WHEN object_type = :wtype THEN 0 ELSE 1 END,
                CASE WHEN object_type = 'TABLE' THEN 1 ELSE 0 END
       FETCH FIRST 1 ROWS ONLY`,
      { nexact: rawName, nupper: upper, wtype: wt }
    );
    // everything below the resolution step works on the name as the dictionary spells it
    const name = obj.length ? String(obj[0].OBJECT_NAME) : upper;
    const systemObject = await oraUserIsSystem(c, conn);
    // every exit below returns the object as-found; systemObject is stamped on once
    // at the end so a new branch can't forget it
    const resolve = async (): Promise<ObjectSource> => {
    if (!obj.length) {
      // dropped objects live in the recycle bin under a BIN$ name, so the tree's
      // original_name finds nothing above — report what can still be known about it
      const bin = await oraRows(
        conn,
        `SELECT object_name, original_name, type, droptime, can_undrop, can_purge, space
         FROM user_recyclebin WHERE original_name = :n ORDER BY droptime DESC FETCH FIRST 1 ROWS ONLY`,
        { n: name }
      );
      if (bin.length) {
        const r = bin[0];
        const orig = String(r.ORIGINAL_NAME);
        return {
          name,
          type: `RECYCLEBIN ${String(r.TYPE)}`,
          source: [
            `-- ${r.TYPE} ${orig} is in the recycle bin — it was dropped, so it has no live DDL.`,
            `-- Recycle bin name : ${r.OBJECT_NAME}`,
            `-- Dropped          : ${r.DROPTIME}`,
            `-- Can undrop       : ${r.CAN_UNDROP}   ·   can purge: ${r.CAN_PURGE}   ·   blocks: ${r.SPACE}`,
            ``,
            `-- Restore it:`,
            `FLASHBACK TABLE "${orig}" TO BEFORE DROP;`,
            ``,
            `-- Or remove it permanently:`,
            `-- PURGE TABLE "${orig}";`,
          ].join("\n"),
        };
      }
      // the tree also lists things that aren't objects of this schema (Other Users,
      // objects owned by someone else): say so instead of "not found"
      const usr = await oraRows(conn, `SELECT username, user_id, created FROM all_users WHERE username = :n`, { n: name });
      if (usr.length) {
        const r = usr[0];
        return {
          name,
          type: "USER",
          source: [
            `-- USER ${r.USERNAME}`,
            `-- User id : ${r.USER_ID}`,
            `-- Created : ${r.CREATED}`,
            ``,
            `-- This connection is ${c.user.toUpperCase()}, so this user's DDL (privileges, quotas,`,
            `-- tablespaces) lives in DBA views it can't read. Connect as a DBA to see it.`,
          ].join("\n"),
        };
      }
      const other = await oraRows(
        conn,
        `SELECT owner, object_type FROM all_objects WHERE object_name = :n AND owner <> USER
         ORDER BY owner FETCH FIRST 1 ROWS ONLY`,
        { n: name }
      );
      if (other.length) {
        return {
          name,
          type: String(other[0].OBJECT_TYPE),
          source: null,
          error: `${name} is a ${other[0].OBJECT_TYPE} owned by ${other[0].OWNER}, not by ${c.user.toUpperCase()} — its DDL isn't readable from this connection.`,
        };
      }
      return { name, type: null, source: null, error: `${name} was not found in your schema.` };
    }
    const type = String(obj[0].OBJECT_TYPE);

    if (ORA_CODE_TYPES.has(type)) {
      const spec = await oraRows(conn, `SELECT text FROM user_source WHERE name = :n AND type = :t ORDER BY line`, { n: name, t: type });
      const source = `CREATE OR REPLACE ${spec.map((r) => String(r.TEXT ?? "")).join("")}`;
      const bodyType = type === "PACKAGE" ? "PACKAGE BODY" : type === "TYPE" ? "TYPE BODY" : null;
      if (bodyType) {
        // spec and body come back as separate runnable statements so the UI can
        // show/edit/compile them independently (SQL Developer-style SPEC/BODY views)
        const body = await oraRows(conn, `SELECT text FROM user_source WHERE name = :n AND type = :t ORDER BY line`, { n: name, t: bodyType });
        const bodySource = body.length ? `CREATE OR REPLACE ${body.map((r) => String(r.TEXT ?? "")).join("")}` : null;
        return { name, type, source, bodySource };
      }
      return { name, type, source };
    }

    if (type === "VIEW") {
      const v = await oraRows(conn, `SELECT text FROM user_views WHERE view_name = :n`, { n: name });
      if (v.length && v[0].TEXT != null) return { name, type, source: `CREATE OR REPLACE VIEW ${name} AS\n${String(v[0].TEXT)}` };
    }

    // tables, sequences, indexes, synonyms, db links, jobs, … — canonical DDL from the dictionary
    const meta = await oraRows(conn, `SELECT dbms_metadata.get_ddl(:t, :n) AS ddl FROM dual`, { t: ddlTypeOf(type), n: name });
    if (meta.length && meta[0].DDL != null) return { name, type, source: String(meta[0].DDL).trim() };

    // DBMS_METADATA refuses identity-column sequences (ISEQ$$_…) — rebuild the
    // CREATE SEQUENCE from user_sequences and note the column it backs.
    if (type === "SEQUENCE") {
      const built = await oraSequenceDdl(conn, name);
      if (built) return { name, type, source: built };
    }
    return { name, type, source: null, error: `Could not read the DDL of ${type} ${name} (dbms_metadata).` };
    };
    return { ...(await resolve()), systemObject };
  } finally {
    await conn.close();
  }
}

/* ---------------- Table designer (Oracle) ---------------- */

interface TableColumnMeta {
  name: string;
  /** canonical full type, e.g. VARCHAR2(50), NUMBER(10,2), DATE */
  dataType: string;
  baseType: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  dataDefault: string | null;
  comment: string | null;
  pk: boolean;
  position: number;
}

interface TableIndexMeta {
  name: string;
  columns: string[]; // includes " DESC" suffix on descending columns
  unique: boolean;
  type: string; // NORMAL | BITMAP | FUNCTION-BASED NORMAL | …
  status: string; // VALID | UNUSABLE | N/A
  tablespace: string | null;
  /** backs a PK/UNIQUE constraint — must be dropped via the constraint, not directly */
  constraintBacked: boolean;
}

interface TableConstraintMeta {
  name: string;
  type: "P" | "U" | "R" | "C";
  typeLabel: string; // PRIMARY KEY | UNIQUE | FOREIGN KEY | CHECK
  columns: string[];
  status: string; // ENABLED | DISABLED
  validated: string; // VALIDATED | NOT VALIDATED
  refTable: string | null; // FK only
  refColumns: string[]; // FK only
  searchCondition: string | null; // CHECK only (best-effort — LONG)
}

interface TableMeta {
  name: string;
  engine: "oracle";
  exists: boolean;
  columns: TableColumnMeta[];
  primaryKey: { name: string; columns: string[] } | null;
  tableComment: string | null;
  indexes: TableIndexMeta[];
  constraints: TableConstraintMeta[];
  error?: string;
}

/** Build the display type string from the dictionary's separate size columns. */
function composeOraType(baseType: string, length: number | null, precision: number | null, scale: number | null): string {
  const t = baseType.toUpperCase();
  if (["VARCHAR2", "CHAR", "NVARCHAR2", "NCHAR", "RAW"].includes(t)) return length ? `${t}(${length})` : t;
  if (t === "NUMBER") {
    if (precision == null) return "NUMBER";
    return scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
  }
  if (t === "FLOAT") return precision ? `FLOAT(${precision})` : "FLOAT";
  return t; // DATE, CLOB, BLOB, TIMESTAMP, …
}

async function oraTableMeta(c: LiveConnection, rawName: string): Promise<TableMeta> {
  const name = rawName.toUpperCase().replace(/[^A-Z0-9_$#]/g, "");
  const conn = await getOraConn(c);
  try {
    const hit = await oraRows(conn, `SELECT table_name FROM user_tables WHERE table_name = :n`, { n: name });
    if (!hit.length) {
      return { name, engine: "oracle", exists: false, columns: [], primaryKey: null, tableComment: null, indexes: [], constraints: [], error: `Table ${name} was not found in your schema.` };
    }
    const cols = await oraRows(
      conn,
      `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, column_id
       FROM user_tab_columns WHERE table_name = :n ORDER BY column_id`,
      { n: name }
    );
    // DATA_DEFAULT is a LONG column — fetched separately so a LONG hiccup can't drop the whole column list.
    const defs = await oraRows(conn, `SELECT column_name, data_default FROM user_tab_columns WHERE table_name = :n`, { n: name });
    const defMap = new Map(defs.map((d) => [String(d.COLUMN_NAME), d.DATA_DEFAULT == null ? null : String(d.DATA_DEFAULT).trim()]));

    const comm = await oraRows(conn, `SELECT column_name, comments FROM user_col_comments WHERE table_name = :n`, { n: name });
    const comMap = new Map(comm.map((r) => [String(r.COLUMN_NAME), r.COMMENTS == null ? null : String(r.COMMENTS)]));

    const pkRows = await oraRows(
      conn,
      `SELECT uc.constraint_name, cc.column_name
       FROM user_constraints uc JOIN user_cons_columns cc ON cc.constraint_name = uc.constraint_name
       WHERE uc.table_name = :n AND uc.constraint_type = 'P' ORDER BY cc.position`,
      { n: name }
    );
    const pkSet = new Set(pkRows.map((r) => String(r.COLUMN_NAME)));
    const primaryKey = pkRows.length ? { name: String(pkRows[0].CONSTRAINT_NAME), columns: pkRows.map((r) => String(r.COLUMN_NAME)) } : null;

    const tabCom = await oraRows(conn, `SELECT comments FROM user_tab_comments WHERE table_name = :n`, { n: name });

    const columns: TableColumnMeta[] = cols.map((r) => {
      const baseType = String(r.DATA_TYPE);
      const length = r.DATA_LENGTH == null ? null : Number(r.DATA_LENGTH);
      const precision = r.DATA_PRECISION == null ? null : Number(r.DATA_PRECISION);
      const scale = r.DATA_SCALE == null ? null : Number(r.DATA_SCALE);
      const cname = String(r.COLUMN_NAME);
      const charLen = ["VARCHAR2", "CHAR", "NVARCHAR2", "NCHAR", "RAW"].includes(baseType) ? length : null;
      return {
        name: cname,
        baseType,
        length: charLen,
        precision,
        scale,
        dataType: composeOraType(baseType, charLen, precision, scale),
        nullable: String(r.NULLABLE) === "Y",
        dataDefault: defMap.get(cname) ?? null,
        comment: comMap.get(cname) ?? null,
        pk: pkSet.has(cname),
        position: Number(r.COLUMN_ID) || 0,
      };
    });

    // ---- indexes ----
    const idxRows = await oraRows(
      conn,
      `SELECT index_name, uniqueness, index_type, status, tablespace_name
       FROM user_indexes WHERE table_name = :n ORDER BY index_name`,
      { n: name }
    );
    const idxColRows = await oraRows(
      conn,
      `SELECT index_name, column_name, column_position, descend
       FROM user_ind_columns WHERE table_name = :n ORDER BY index_name, column_position`,
      { n: name }
    );
    const idxCols = new Map<string, string[]>();
    for (const r of idxColRows) {
      const k = String(r.INDEX_NAME);
      const col = String(r.COLUMN_NAME) + (String(r.DESCEND) === "DESC" ? " DESC" : "");
      (idxCols.get(k) ?? idxCols.set(k, []).get(k)!).push(col);
    }

    // ---- constraints ----
    const conRows = await oraRows(
      conn,
      `SELECT constraint_name, constraint_type, status, validated, r_constraint_name, index_name
       FROM user_constraints WHERE table_name = :n AND constraint_type IN ('P','U','R','C')
       ORDER BY constraint_type, constraint_name`,
      { n: name }
    );
    const conColRows = await oraRows(
      conn,
      `SELECT constraint_name, column_name, position FROM user_cons_columns WHERE table_name = :n ORDER BY constraint_name, position`,
      { n: name }
    );
    const conCols = new Map<string, string[]>();
    for (const r of conColRows) {
      const k = String(r.CONSTRAINT_NAME);
      (conCols.get(k) ?? conCols.set(k, []).get(k)!).push(String(r.COLUMN_NAME));
    }
    // FK → referenced table + columns
    const fkRefRows = await oraRows(
      conn,
      `SELECT rc.constraint_name AS fk, rk.table_name AS reftab, rk.column_name AS refcol
       FROM user_constraints rc
       JOIN user_cons_columns rk ON rk.constraint_name = rc.r_constraint_name
       WHERE rc.table_name = :n AND rc.constraint_type = 'R'
       ORDER BY rc.constraint_name, rk.position`,
      { n: name }
    );
    const fkRefTable = new Map<string, string>();
    const fkRefCols = new Map<string, string[]>();
    for (const r of fkRefRows) {
      const k = String(r.FK);
      fkRefTable.set(k, String(r.REFTAB));
      (fkRefCols.get(k) ?? fkRefCols.set(k, []).get(k)!).push(String(r.REFCOL));
    }
    // CHECK search conditions (LONG → separate tolerant fetch)
    const chkRows = await oraRows(conn, `SELECT constraint_name, search_condition FROM user_constraints WHERE table_name = :n AND constraint_type = 'C'`, { n: name });
    const chkCond = new Map(chkRows.map((r) => [String(r.CONSTRAINT_NAME), r.SEARCH_CONDITION == null ? null : String(r.SEARCH_CONDITION).trim()]));

    const constraintIndexNames = new Set(conRows.map((r) => (r.INDEX_NAME == null ? "" : String(r.INDEX_NAME))).filter(Boolean));

    const indexes: TableIndexMeta[] = idxRows.map((r) => ({
      name: String(r.INDEX_NAME),
      columns: idxCols.get(String(r.INDEX_NAME)) ?? [],
      unique: String(r.UNIQUENESS) === "UNIQUE",
      type: String(r.INDEX_TYPE ?? "NORMAL"),
      status: String(r.STATUS ?? "N/A"),
      tablespace: r.TABLESPACE_NAME == null ? null : String(r.TABLESPACE_NAME),
      constraintBacked: constraintIndexNames.has(String(r.INDEX_NAME)),
    }));

    const CTYPE: Record<string, string> = { P: "PRIMARY KEY", U: "UNIQUE", R: "FOREIGN KEY", C: "CHECK" };
    const constraints: TableConstraintMeta[] = conRows
      .map((r) => {
        const cname = String(r.CONSTRAINT_NAME);
        const type = String(r.CONSTRAINT_TYPE) as "P" | "U" | "R" | "C";
        return {
          name: cname,
          type,
          typeLabel: CTYPE[type] ?? type,
          columns: conCols.get(cname) ?? [],
          status: String(r.STATUS ?? ""),
          validated: String(r.VALIDATED ?? ""),
          refTable: type === "R" ? fkRefTable.get(cname) ?? null : null,
          refColumns: type === "R" ? fkRefCols.get(cname) ?? [] : [],
          searchCondition: type === "C" ? chkCond.get(cname) ?? null : null,
        };
      })
      // hide system NOT NULL checks — those are managed as column nullability in the Columns tab
      .filter((c) => !(c.type === "C" && c.searchCondition != null && /^"?\w+"?\s+IS\s+NOT\s+NULL$/i.test(c.searchCondition)));

    return {
      name,
      engine: "oracle",
      exists: true,
      columns,
      primaryKey,
      tableComment: tabCom.length && tabCom[0].COMMENTS != null ? String(tabCom[0].COMMENTS) : null,
      indexes,
      constraints,
    };
  } finally {
    await conn.close();
  }
}

/** Statements the Table Designer is allowed to run — CREATE TABLE (new-table designer), column/PK/comment DDL (ALTER TABLE also covers constraint add/drop/enable/disable) plus index DDL. */
const TABLE_DDL_ALLOWED = /^\s*(CREATE\s+TABLE|ALTER\s+TABLE|COMMENT\s+ON\s+(COLUMN|TABLE)|CREATE\s+(UNIQUE\s+|BITMAP\s+)?INDEX|DROP\s+INDEX|ALTER\s+INDEX)\b/i;

interface ApplyStmtResult { sql: string; ok: boolean; error?: string; line?: number; }
interface ApplyResult { results: ApplyStmtResult[]; failed: boolean; applied: number; }

/** Run designer-generated DDL sequentially on one connection, stopping at the first failure. */
async function oraApplyTableDdl(c: LiveConnection, statements: string[]): Promise<ApplyResult> {
  const conn = await getOraConn(c);
  const results: ApplyStmtResult[] = [];
  try {
    for (const raw of statements) {
      const sql = raw.trim().replace(/;\s*$/, "");
      if (!sql) continue;
      try {
        await conn.execute(sql, [], { autoCommit: true });
        results.push({ sql, ok: true });
      } catch (e) {
        results.push({ sql, ok: false, error: withNetworkHint(errMsg(e), c.host), line: oraErrorLine(e, sql) });
        break; // Oracle DDL auto-commits each statement — stop so we don't push past a failure
      }
    }
  } finally {
    await conn.close();
  }
  return { results, failed: results.some((r) => !r.ok), applied: results.filter((r) => r.ok).length };
}

/* ---------------- Table statistics (Oracle, DBMS_STATS) ---------------- */

interface TableStats {
  table: { numRows: number | null; blocks: number | null; avgRowLen: number | null; lastAnalyzed: string | null; stale: boolean; locked: boolean } | null;
  columns: { name: string; numDistinct: number | null; numNulls: number | null; histogram: string; lastAnalyzed: string | null }[];
  indexes: { name: string; numRows: number | null; distinctKeys: number | null; leafBlocks: number | null; clusteringFactor: number | null; lastAnalyzed: string | null; stale: boolean }[];
}

const isoOrNull = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

async function oraTableStats(c: LiveConnection, rawName: string): Promise<TableStats> {
  const name = rawName.toUpperCase().replace(/[^A-Z0-9_$#]/g, "");
  const conn = await getOraConn(c);
  try {
    const t = await oraRows(
      conn,
      `SELECT num_rows, blocks, avg_row_len, last_analyzed, stale_stats, stattype_locked
       FROM user_tab_statistics WHERE table_name = :n AND object_type = 'TABLE'`,
      { n: name }
    );
    const table = t.length
      ? {
          numRows: t[0].NUM_ROWS == null ? null : Number(t[0].NUM_ROWS),
          blocks: t[0].BLOCKS == null ? null : Number(t[0].BLOCKS),
          avgRowLen: t[0].AVG_ROW_LEN == null ? null : Number(t[0].AVG_ROW_LEN),
          lastAnalyzed: isoOrNull(t[0].LAST_ANALYZED),
          stale: String(t[0].STALE_STATS ?? "") === "YES",
          locked: t[0].STATTYPE_LOCKED != null,
        }
      : null;

    const cols = await oraRows(
      conn,
      `SELECT column_name, num_distinct, num_nulls, histogram, last_analyzed
       FROM user_tab_col_statistics WHERE table_name = :n ORDER BY column_name`,
      { n: name }
    );
    const columns = cols.map((r) => ({
      name: String(r.COLUMN_NAME),
      numDistinct: r.NUM_DISTINCT == null ? null : Number(r.NUM_DISTINCT),
      numNulls: r.NUM_NULLS == null ? null : Number(r.NUM_NULLS),
      histogram: String(r.HISTOGRAM ?? "NONE"),
      lastAnalyzed: isoOrNull(r.LAST_ANALYZED),
    }));

    const idx = await oraRows(
      conn,
      `SELECT index_name, num_rows, distinct_keys, leaf_blocks, clustering_factor, last_analyzed, stale_stats
       FROM user_ind_statistics WHERE table_name = :n ORDER BY index_name`,
      { n: name }
    );
    const indexes = idx.map((r) => ({
      name: String(r.INDEX_NAME),
      numRows: r.NUM_ROWS == null ? null : Number(r.NUM_ROWS),
      distinctKeys: r.DISTINCT_KEYS == null ? null : Number(r.DISTINCT_KEYS),
      leafBlocks: r.LEAF_BLOCKS == null ? null : Number(r.LEAF_BLOCKS),
      clusteringFactor: r.CLUSTERING_FACTOR == null ? null : Number(r.CLUSTERING_FACTOR),
      lastAnalyzed: isoOrNull(r.LAST_ANALYZED),
      stale: String(r.STALE_STATS ?? "") === "YES",
    }));

    return { table, columns, indexes };
  } finally {
    await conn.close();
  }
}

type StatsAction = "gather" | "delete" | "lock" | "unlock";

/** Run a DBMS_STATS action against one table (bind-safe). */
async function oraTableStatsAction(c: LiveConnection, rawName: string, action: StatsAction): Promise<void> {
  const name = rawName.toUpperCase().replace(/[^A-Z0-9_$#]/g, "");
  const plsql: Record<StatsAction, string> = {
    gather: `BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => USER, tabname => :n, cascade => TRUE); END;`,
    delete: `BEGIN DBMS_STATS.DELETE_TABLE_STATS(ownname => USER, tabname => :n); END;`,
    lock: `BEGIN DBMS_STATS.LOCK_TABLE_STATS(ownname => USER, tabname => :n); END;`,
    unlock: `BEGIN DBMS_STATS.UNLOCK_TABLE_STATS(ownname => USER, tabname => :n); END;`,
  };
  const conn = await getOraConn(c);
  try {
    await conn.execute(plsql[action], { n: name }, { autoCommit: true });
  } finally {
    await conn.close();
  }
}

/** Sanitize an Oracle identifier for safe inlining into DDL (uppercased, only legal chars). */
const oraIdent = (s: string): string => String(s).toUpperCase().replace(/[^A-Z0-9_$#]/g, "");

interface TableStorage {
  table: {
    tablespace: string | null;
    sizeBytes: number | null;
    blocks: number | null;
    extents: number | null;
    pctFree: number | null;
    iniTrans: number | null;
    logging: boolean | null;
    compression: string | null; // 'ENABLED' | 'DISABLED'
    compressFor: string | null; // e.g. 'ADVANCED', 'BASIC'
    partitioned: boolean;
    numRows: number | null;
    avgRowLen: number | null;
  } | null;
  indexes: { name: string; tablespace: string | null; sizeBytes: number | null; status: string; compression: string | null }[];
  tablespaces: { name: string; blockSize: number | null; status: string; contents: string | null }[];
}

async function oraTableStorage(c: LiveConnection, rawName: string): Promise<TableStorage> {
  const name = oraIdent(rawName);
  const conn = await getOraConn(c);
  try {
    const t = await oraRows(
      conn,
      `SELECT tablespace_name, pct_free, ini_trans, logging, compression, compress_for,
              num_rows, blocks, avg_row_len, partitioned
       FROM user_tables WHERE table_name = :n`,
      { n: name }
    );
    const seg = await oraRows(
      conn,
      `SELECT SUM(bytes) AS bytes, SUM(blocks) AS blocks, SUM(extents) AS extents
       FROM user_segments WHERE segment_name = :n AND segment_type IN ('TABLE', 'TABLE PARTITION')`,
      { n: name }
    );
    const table = t.length
      ? {
          tablespace: t[0].TABLESPACE_NAME == null ? null : String(t[0].TABLESPACE_NAME),
          sizeBytes: seg.length && seg[0].BYTES != null ? Number(seg[0].BYTES) : null,
          blocks: seg.length && seg[0].BLOCKS != null ? Number(seg[0].BLOCKS) : null,
          extents: seg.length && seg[0].EXTENTS != null ? Number(seg[0].EXTENTS) : null,
          pctFree: t[0].PCT_FREE == null ? null : Number(t[0].PCT_FREE),
          iniTrans: t[0].INI_TRANS == null ? null : Number(t[0].INI_TRANS),
          logging: t[0].LOGGING == null ? null : String(t[0].LOGGING) === "YES",
          compression: t[0].COMPRESSION == null ? null : String(t[0].COMPRESSION),
          compressFor: t[0].COMPRESS_FOR == null ? null : String(t[0].COMPRESS_FOR),
          partitioned: String(t[0].PARTITIONED ?? "NO") === "YES",
          numRows: t[0].NUM_ROWS == null ? null : Number(t[0].NUM_ROWS),
          avgRowLen: t[0].AVG_ROW_LEN == null ? null : Number(t[0].AVG_ROW_LEN),
        }
      : null;

    const idx = await oraRows(
      conn,
      `SELECT i.index_name, i.tablespace_name, i.status, i.compression,
              (SELECT SUM(s.bytes) FROM user_segments s WHERE s.segment_name = i.index_name) AS bytes
       FROM user_indexes i WHERE i.table_name = :n ORDER BY i.index_name`,
      { n: name }
    );
    const indexes = idx.map((r) => ({
      name: String(r.INDEX_NAME),
      tablespace: r.TABLESPACE_NAME == null ? null : String(r.TABLESPACE_NAME),
      sizeBytes: r.BYTES == null ? null : Number(r.BYTES),
      status: String(r.STATUS ?? ""),
      compression: r.COMPRESSION == null ? null : String(r.COMPRESSION),
    }));

    const ts = await oraRows(
      conn,
      `SELECT tablespace_name, block_size, status, contents FROM user_tablespaces ORDER BY tablespace_name`
    );
    const tablespaces = ts.map((r) => ({
      name: String(r.TABLESPACE_NAME),
      blockSize: r.BLOCK_SIZE == null ? null : Number(r.BLOCK_SIZE),
      status: String(r.STATUS ?? ""),
      contents: r.CONTENTS == null ? null : String(r.CONTENTS),
    }));

    return { table, indexes, tablespaces };
  } finally {
    await conn.close();
  }
}

type StorageAction = "move" | "shrink" | "logging" | "rebuildIndexes" | "rebuildIndex";
type StorageCompression = "KEEP" | "NONE" | "BASIC" | "ADVANCED";
interface StorageParams {
  tablespace?: string;
  compression?: StorageCompression;
  on?: boolean;
  index?: string;
}

/** Build + run a storage/tablespace maintenance action (Oracle DDL, one statement at a time, stop on first error). */
async function oraTableStorageAction(
  c: LiveConnection,
  rawName: string,
  action: StorageAction,
  params: StorageParams
): Promise<{ statements: string[]; note?: string }> {
  const name = oraIdent(rawName);
  const conn = await getOraConn(c);
  try {
    const stmts: string[] = [];
    let note: string | undefined;
    switch (action) {
      case "move": {
        let sql = `ALTER TABLE ${name} MOVE`;
        if (params.tablespace) sql += ` TABLESPACE ${oraIdent(params.tablespace)}`;
        if (params.compression === "NONE") sql += ` NOCOMPRESS`;
        else if (params.compression === "BASIC") sql += ` ROW STORE COMPRESS BASIC`;
        else if (params.compression === "ADVANCED") sql += ` ROW STORE COMPRESS ADVANCED`;
        stmts.push(sql);
        note = "A MOVE can leave this table's indexes UNUSABLE — use “Rebuild all indexes” below afterwards.";
        break;
      }
      case "shrink":
        stmts.push(`ALTER TABLE ${name} ENABLE ROW MOVEMENT`);
        stmts.push(`ALTER TABLE ${name} SHRINK SPACE`);
        break;
      case "logging":
        stmts.push(`ALTER TABLE ${name} ${params.on ? "LOGGING" : "NOLOGGING"}`);
        break;
      case "rebuildIndexes": {
        const rows = await oraRows(conn, `SELECT index_name FROM user_indexes WHERE table_name = :n ORDER BY index_name`, { n: name });
        for (const r of rows) stmts.push(`ALTER INDEX ${oraIdent(String(r.INDEX_NAME))} REBUILD`);
        if (!stmts.length) note = "No indexes to rebuild on this table.";
        break;
      }
      case "rebuildIndex": {
        if (!params.index) throw new Error("Missing index name for rebuild.");
        // The confirmation the user approved named *this table*. `index` arrives in the
        // request body, so without this check the call could rebuild any index in the
        // schema while the dialog said something else. oraIdent makes injection
        // impossible; it does not make the target honest.
        const idx = oraIdent(params.index);
        const owned = await oraRows(conn, `SELECT index_name FROM user_indexes WHERE table_name = :n AND index_name = :i`, { n: name, i: idx });
        if (!owned.length) throw new Error(`Index ${idx} does not belong to ${name}.`);
        let sql = `ALTER INDEX ${idx} REBUILD`;
        if (params.tablespace) sql += ` TABLESPACE ${oraIdent(params.tablespace)}`;
        stmts.push(sql);
        break;
      }
    }
    for (const sql of stmts) await conn.execute(sql, [], { autoCommit: true });
    return { statements: stmts, note };
  } finally {
    await conn.close();
  }
}

/* ---------------- Optimization advisor ---------------- */

const fmtBytesSrv = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};

type AdvisorSeverity = "high" | "medium" | "low" | "info";
type AdvisorCategory = "primaryKey" | "indexes" | "statistics" | "compression" | "partitioning" | "chainedRows" | "systemObject";
/** One-click remediation: routed to an existing endpoint by kind (ddl→apply, stats→gather, storage→move). */
interface AdvisorFix {
  kind: "ddl" | "stats" | "storage";
  statements?: string[]; // kind === "ddl" (runs through the table/apply allow-list)
  action?: "gather" | "move";
  compression?: StorageCompression; // kind === "storage"
  label: string;
}
interface AdvisorFinding {
  id: string;
  category: AdvisorCategory;
  severity: AdvisorSeverity;
  title: string;
  detail: string;
  benefit: string;
  fix?: AdvisorFix;
}
interface TableAdvisor {
  table: string;
  exists: boolean;
  findings: AdvisorFinding[];
  summary: { high: number; medium: number; low: number; info: number };
  analyzedAt: string;
}

const COMPRESSION_MIN_BYTES = 1024 * 1024; // only suggest compression above ~1 MB of allocated segment
const PARTITION_MIN_ROWS = 2_000_000; // only flag partitioning above ~2M rows

/** Table names Oracle generates for something else (see ORA_SYSGEN_TABLE for the SQL form). */
const SYSGEN_NAME_RE = /^(DR[$#]|MLOG\$|RUPD\$)/;

/** Is this table an implementation detail — text-index internals or an mview container? */
async function oraTableIsSystemGenerated(conn: oracledb.Connection, name: string): Promise<boolean> {
  if (SYSGEN_NAME_RE.test(name)) return true;
  return (await oraRows(conn, `SELECT 1 AS x FROM user_mviews WHERE mview_name = :n`, { n: name })).length > 0;
}

/** Read-only analysis of one table's schema/stats/storage → prioritized findings with one-click fixes. */
async function oraTableAdvisor(c: LiveConnection, rawName: string): Promise<TableAdvisor> {
  const name = oraIdent(rawName);
  const analyzedAt = new Date().toISOString();
  const conn = await getOraConn(c);
  try {
    const trows = await oraRows(
      conn,
      `SELECT num_rows, blocks, avg_row_len, chain_cnt, compression, compress_for,
              partitioned, last_analyzed, pct_free
       FROM user_tables WHERE table_name = :n`,
      { n: name }
    );
    if (!trows.length) {
      return { table: name, exists: false, findings: [], summary: { high: 0, medium: 0, low: 0, info: 0 }, analyzedAt };
    }
    // Oracle owns the shape of these: a DR$…$I text-index table has no primary key
    // because Oracle Text did not give it one, and "add a PK" is not advice anyone
    // should act on. Say what the object is and stop, rather than emit findings whose
    // only honest resolution is "ignore this".
    if (await oraTableIsSystemGenerated(conn, name)) {
      const isText = SYSGEN_NAME_RE.test(name);
      return {
        table: name, exists: true, analyzedAt,
        summary: { high: 0, medium: 0, low: 0, info: 1 },
        findings: [{
          id: "system-generated", category: "systemObject", severity: "info",
          title: "Oracle-managed object — not analysed",
          detail: isText
            ? `${name} is generated and maintained by Oracle (an Oracle Text index or materialized-view log stores its data here). Its structure follows the index, not your data model.`
            : `${name} is the container table of a materialized view. Its structure comes from the view's query.`,
          benefit: isText
            ? "Tune the index or the log through the object that owns it; changing this table directly can break it."
            : "Change the materialized view's definition instead — the container follows it.",
        }],
      };
    }
    const t = trows[0];
    const numRows = t.NUM_ROWS == null ? null : Number(t.NUM_ROWS);
    const chainCnt = t.CHAIN_CNT == null ? null : Number(t.CHAIN_CNT);
    const compression = String(t.COMPRESSION ?? "");
    const partitioned = String(t.PARTITIONED ?? "NO") === "YES";
    const lastAnalyzed = t.LAST_ANALYZED;

    const segRows = await oraRows(
      conn,
      `SELECT SUM(bytes) AS bytes FROM user_segments WHERE segment_name = :n AND segment_type IN ('TABLE','TABLE PARTITION')`,
      { n: name }
    );
    const segBytes = segRows.length && segRows[0].BYTES != null ? Number(segRows[0].BYTES) : null;

    const statRows = await oraRows(
      conn,
      `SELECT stale_stats FROM user_tab_statistics WHERE table_name = :n AND object_type = 'TABLE'`,
      { n: name }
    );
    const stale = statRows.length ? String(statRows[0].STALE_STATS ?? "") === "YES" : false;
    const hasStats = lastAnalyzed != null || numRows != null;

    const pkRows = await oraRows(conn, `SELECT constraint_name FROM user_constraints WHERE table_name = :n AND constraint_type = 'P'`, { n: name });
    const hasPk = pkRows.length > 0;

    const idxRows = await oraRows(conn, `SELECT index_name, uniqueness FROM user_indexes WHERE table_name = :n`, { n: name });
    const idxColRows = await oraRows(
      conn,
      `SELECT index_name, column_name, column_position FROM user_ind_columns WHERE table_name = :n ORDER BY index_name, column_position`,
      { n: name }
    );
    const idxCols = new Map<string, string[]>();
    for (const r of idxColRows) {
      const k = String(r.INDEX_NAME);
      (idxCols.get(k) ?? idxCols.set(k, []).get(k)!).push(String(r.COLUMN_NAME));
    }
    const uniqueOf = new Map(idxRows.map((r) => [String(r.INDEX_NAME), String(r.UNIQUENESS) === "UNIQUE"]));

    const cbRows = await oraRows(conn, `SELECT index_name FROM user_constraints WHERE table_name = :n AND index_name IS NOT NULL`, { n: name });
    const constraintBacked = new Set(cbRows.map((r) => String(r.INDEX_NAME)));

    const fkRows = await oraRows(conn, `SELECT constraint_name FROM user_constraints WHERE table_name = :n AND constraint_type = 'R'`, { n: name });
    const fkNames = new Set(fkRows.map((r) => String(r.CONSTRAINT_NAME)));
    const fkColRows = await oraRows(
      conn,
      `SELECT constraint_name, column_name, position FROM user_cons_columns WHERE table_name = :n ORDER BY constraint_name, position`,
      { n: name }
    );
    const fkCols = new Map<string, string[]>();
    for (const r of fkColRows) {
      const k = String(r.CONSTRAINT_NAME);
      if (!fkNames.has(k)) continue;
      (fkCols.get(k) ?? fkCols.set(k, []).get(k)!).push(String(r.COLUMN_NAME));
    }

    const allIdxColLists = [...idxCols.values()];
    const fkCovered = (cols: string[]) => allIdxColLists.some((ic) => cols.every((col, i) => ic[i] === col));

    const findings: AdvisorFinding[] = [];

    // 1. Missing primary key (no safe auto-fix — columns are a human choice)
    if (!hasPk) {
      findings.push({
        id: "missing-pk",
        category: "primaryKey",
        severity: "high",
        title: "No primary key",
        detail: `${name} has no primary key, so rows can't be uniquely identified and the optimizer loses a guaranteed-unique access path.`,
        benefit: "Add a primary key (Design tab) so rows are uniquely addressable and plans improve.",
      });
    }

    // 2. Missing / stale optimizer statistics
    if (!hasStats) {
      findings.push({
        id: "no-stats",
        category: "statistics",
        severity: "high",
        title: "No optimizer statistics",
        detail: `${name} has never had statistics gathered — the optimizer falls back to dynamic sampling and row counts are unknown.`,
        benefit: "Gather statistics so the optimizer can estimate cardinality and pick good plans.",
        fix: { kind: "stats", action: "gather", label: "Gather statistics" },
      });
    } else if (stale) {
      findings.push({
        id: "stale-stats",
        category: "statistics",
        severity: "medium",
        title: "Statistics are stale",
        detail: `${name} changed significantly since statistics were last gathered${lastAnalyzed ? ` (${isoOrNull(lastAnalyzed)})` : ""}.`,
        benefit: "Re-gather statistics to keep cardinality estimates accurate.",
        fix: { kind: "stats", action: "gather", label: "Gather statistics" },
      });
    }

    // 3. Foreign keys with no leading index
    for (const [cname, cols] of fkCols) {
      if (!cols.length || fkCovered(cols)) continue;
      const ixName = oraIdent(`${name}_${cols.join("_")}_FK_IX`).slice(0, 30);
      findings.push({
        id: `fk-no-index:${cname}`,
        category: "indexes",
        severity: "medium",
        title: `Unindexed foreign key ${cname}`,
        detail: `FK ${cname} (${cols.join(", ")}) has no leading index — unindexed FKs can cause table-level lock contention on parent DML and slow joins.`,
        benefit: "Create a covering index to avoid lock escalation and speed up joins.",
        fix: { kind: "ddl", statements: [`CREATE INDEX ${ixName} ON ${name} (${cols.map(oraIdent).join(", ")})`], label: "Create index" },
      });
    }

    // 4. Redundant indexes (non-unique, non-constraint index that is a strict leading prefix of another)
    for (const [ixName, cols] of idxCols) {
      if (!cols.length || uniqueOf.get(ixName) || constraintBacked.has(ixName)) continue;
      const wider = [...idxCols.entries()].find(
        ([other, ocols]) => other !== ixName && ocols.length > cols.length && cols.every((col, i) => ocols[i] === col)
      );
      if (wider) {
        findings.push({
          id: `redundant-index:${ixName}`,
          category: "indexes",
          severity: "low",
          title: `Redundant index ${ixName}`,
          detail: `${ixName} (${cols.join(", ")}) is a leading prefix of ${wider[0]} (${wider[1].join(", ")}) — the wider index already covers it.`,
          benefit: "Drop the redundant index to cut storage and per-DML maintenance cost.",
          fix: { kind: "ddl", statements: [`DROP INDEX ${oraIdent(ixName)}`], label: "Drop index" },
        });
      }
    }

    // 5. Chained / migrated rows (chain_cnt is only populated by ANALYZE, so this fires rarely)
    if (chainCnt != null && chainCnt > 0 && !partitioned) {
      findings.push({
        id: "chained-rows",
        category: "chainedRows",
        severity: "medium",
        title: "Chained or migrated rows",
        detail: `${name} reports ${chainCnt.toLocaleString("en")} chained/migrated row(s); each one costs an extra block read on access.`,
        benefit: "Reorganize the table (ALTER TABLE MOVE) to eliminate row chaining.",
        fix: { kind: "storage", action: "move", compression: "KEEP", label: "Reorganize (MOVE)" },
      });
    }

    // 6. Compression opportunity (uncompressed, non-trivial segment)
    if (compression && compression !== "ENABLED" && !partitioned && segBytes != null && segBytes >= COMPRESSION_MIN_BYTES) {
      findings.push({
        id: "no-compression",
        category: "compression",
        severity: "low",
        title: "Table is not compressed",
        detail: `${name} is ${fmtBytesSrv(segBytes)} and uncompressed — advanced row compression typically shrinks tables 2–4×.`,
        benefit: "Enable advanced compression to save storage and reduce I/O (offline MOVE; rebuild indexes after).",
        fix: { kind: "storage", action: "move", compression: "ADVANCED", label: "Compress (MOVE ADVANCED)" },
      });
    }

    // 7. Large unpartitioned table (no auto-fix — partition key/strategy is a design decision)
    if (!partitioned && numRows != null && numRows >= PARTITION_MIN_ROWS) {
      findings.push({
        id: "partition-candidate",
        category: "partitioning",
        severity: "info",
        title: "Large unpartitioned table",
        detail: `${name} has ~${numRows.toLocaleString("en")} rows and is not partitioned.`,
        benefit: "Consider range/list/hash partitioning for partition pruning and easier maintenance.",
      });
    }

    const order: AdvisorSeverity[] = ["high", "medium", "low", "info"];
    findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
    const summary = { high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) summary[f.severity]++;

    return { table: name, exists: true, findings, summary, analyzedAt };
  } finally {
    await conn.close();
  }
}

/* ---------------- One-click maintenance ---------------- */

type MaintenanceAction = "gatherStats" | "rebuildIndexes" | "reorg" | "shrink" | "analyze" | "validateConstraints";

/** Run a single one-click maintenance operation, reusing the stats/storage helpers where they overlap. */
async function oraTableMaintenance(
  c: LiveConnection,
  rawName: string,
  action: MaintenanceAction
): Promise<{ statements: string[]; note?: string }> {
  const name = oraIdent(rawName);
  switch (action) {
    case "gatherStats":
      await oraTableStatsAction(c, name, "gather");
      return { statements: [`DBMS_STATS.GATHER_TABLE_STATS(USER, '${name}', cascade => TRUE)`], note: "Optimizer statistics refreshed." };
    case "rebuildIndexes":
      return oraTableStorageAction(c, name, "rebuildIndexes", {});
    case "reorg":
      return oraTableStorageAction(c, name, "move", { compression: "KEEP" });
    case "shrink":
      return oraTableStorageAction(c, name, "shrink", {});
    case "analyze": {
      const conn = await getOraConn(c);
      try {
        const sql = `ANALYZE TABLE ${name} VALIDATE STRUCTURE CASCADE`;
        await conn.execute(sql, [], { autoCommit: true });
        return { statements: [sql], note: "No structural corruption found in the table or its indexes." };
      } finally {
        await conn.close();
      }
    }
    case "validateConstraints": {
      const conn = await getOraConn(c);
      try {
        const rows = await oraRows(
          conn,
          `SELECT constraint_name FROM user_constraints WHERE table_name = :n AND status = 'ENABLED' AND validated = 'NOT VALIDATED' ORDER BY constraint_name`,
          { n: name }
        );
        if (!rows.length) return { statements: [], note: "All enabled constraints are already validated." };
        const stmts = rows.map((r) => `ALTER TABLE ${name} ENABLE VALIDATE CONSTRAINT ${oraIdent(String(r.CONSTRAINT_NAME))}`);
        for (const sql of stmts) await conn.execute(sql, [], { autoCommit: true });
        return { statements: stmts, note: `${stmts.length} constraint(s) validated.` };
      } finally {
        await conn.close();
      }
    }
  }
}

function oraPrepare(sql: string): string {
  const isPlsql =
    /^\s*(begin|declare)\b/i.test(sql) ||
    /^\s*create(\s+or\s+replace)?(\s+editionable|\s+noneditionable)?\s+(procedure|function|package|trigger|type)\b/i.test(sql);
  if (isPlsql) return sql;
  return sql.replace(/;\s*$/, "");
}

async function oraQuery(c: LiveConnection, sql: string): Promise<QueryOutcome> {
  const conn = await getOraConn(c);
  try {
    const result = await conn.execute(oraPrepare(sql), [], {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      maxRows: MAX_ROWS + 1,
      autoCommit: true,
    });
    if (result.rows) {
      return {
        columns: (result.metaData ?? []).map((m) => m.name),
        rows: (result.rows as unknown[][]).slice(0, MAX_ROWS).map((r) => r.map(mapVal)),
        rowsReturned: result.rows.length > MAX_ROWS ? MAX_ROWS : result.rows.length,
        truncated: result.rows.length > MAX_ROWS,
      };
    }
    const affected = result.rowsAffected ?? 0;
    return {
      columns: ["RESULT"],
      rows: [[`${affected} row(s) affected`]],
      rowsReturned: affected,
    };
  } finally {
    await conn.close();
  }
}

/** Scheduler keeps textual job output in a CLOB and its error/output streams in BLOBs.
 * Fetch the BLOBs as Buffers here so they can be rendered instead of the generic query
 * endpoint's deliberately-safe `[BLOB]` placeholder. */
async function oraJobRunOutput(c: LiveConnection, logId: number) {
  const conn = await getOraConn(c);
  try {
    const result = await conn.execute<Record<string, unknown>>(
      `SELECT DBMS_LOB.SUBSTR(output, 32767, 1) AS output,
              DBMS_LOB.SUBSTR(binary_errors, 32767, 1) AS binary_errors,
              DBMS_LOB.SUBSTR(binary_output, 32767, 1) AS binary_output
         FROM user_scheduler_job_run_details
        WHERE log_id = :logId`,
      { logId },
      {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchInfo: {
          BINARY_ERRORS: { type: oracledb.BUFFER },
          BINARY_OUTPUT: { type: oracledb.BUFFER },
        },
      }
    );
    const row = result.rows?.[0];
    if (!row) return null;
    const content = (value: unknown) =>
      value == null ? null : Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    return {
      output: content(row.OUTPUT),
      binaryErrors: content(row.BINARY_ERRORS),
      binaryOutput: content(row.BINARY_OUTPUT),
    };
  } finally {
    await conn.close();
  }
}

/** Compute a 1-based error line from Oracle's character offset into the statement. */
function oraErrorLine(e: unknown, sql: string): number {
  const off = (e as { offset?: number }).offset;
  if (typeof off !== "number" || off <= 0) return 1;
  return sql.slice(0, off).split("\n").length;
}

/* ---------------- Explain Plan ---------------- */

export interface ExplainNode {
  op: string;
  object?: string;
  cost: number;
  rows: number;
  bytes: string;
  note?: string;
  children?: ExplainNode[];
}

export interface ExplainResult {
  engine: "oracle";
  plan: ExplainNode | null;
  totalCost: number;
  note?: string;
  error?: { message: string; code: string; line: number; helpUrl?: string } | null;
}

/** Format a raw byte count into a compact human string ("12 MB"); "" for empty/zero. */
function fmtBytes(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!n || n <= 0 || !isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${u[i]}`;
}

const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Oracle: EXPLAIN PLAN FOR <sql> → parse plan_table into a cost tree. */
async function oraExplain(c: LiveConnection, sql: string): Promise<ExplainResult> {
  const stmt = sql.replace(/;\s*$/, "").trim();
  const sid = `DF${Date.now().toString().slice(-12)}`;
  const conn = await getOraConn(c);
  try {
    try {
      await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${sid}' FOR ${stmt}`);
    } catch (e) {
      const err = e as { errorNum?: number };
      return {
        engine: "oracle", plan: null, totalCost: 0,
        error: {
          ...splitHelpUrl(withNetworkHint(errMsg(e), c.host)),
          code: err.errorNum ? `ORA-${String(err.errorNum).padStart(5, "0")}` : "SQL-ERROR",
          line: oraErrorLine(e, stmt),
        },
      };
    }
    const rows = await oraRows(
      conn,
      `SELECT id, parent_id, operation, options, object_name,
              cost, cardinality, bytes, access_predicates, filter_predicates
         FROM plan_table WHERE statement_id = :sid ORDER BY id`,
      { sid }
    );
    try {
      await conn.execute(`DELETE FROM plan_table WHERE statement_id = :sid`, { sid });
      await conn.commit();
    } catch { /* cleanup is best-effort — plan_table is a scratch GTT */ }

    if (!rows.length) return { engine: "oracle", plan: null, totalCost: 0, note: "Oracle returned no plan rows for this statement." };

    type Tmp = ExplainNode & { _parent: number | null };
    const map = new Map<number, Tmp>();
    for (const r of rows) {
      const id = Number(r.ID);
      const op = [String(r.OPERATION ?? "").trim(), String(r.OPTIONS ?? "").trim()].filter(Boolean).join(" ");
      const pred = [r.ACCESS_PREDICATES, r.FILTER_PREDICATES].map((p) => (p ? String(p) : "")).filter(Boolean).join(" · ");
      map.set(id, {
        _parent: r.PARENT_ID === null || r.PARENT_ID === undefined ? null : Number(r.PARENT_ID),
        op: op || "SELECT STATEMENT",
        object: r.OBJECT_NAME ? String(r.OBJECT_NAME) : undefined,
        cost: Number(r.COST) || 0,
        rows: Number(r.CARDINALITY) || 0,
        bytes: fmtBytes(r.BYTES),
        note: pred ? clip(pred) : undefined,
        children: [],
      });
    }
    let root: Tmp | null = null;
    for (const node of map.values()) {
      const parent = node._parent !== null ? map.get(node._parent) : undefined;
      if (parent) parent.children!.push(node);
      else if (!root) root = node;
    }
    const clean = (n: Tmp): ExplainNode => ({
      op: n.op, object: n.object, cost: n.cost, rows: n.rows, bytes: n.bytes, note: n.note,
      children: n.children && n.children.length ? (n.children as Tmp[]).map(clean) : undefined,
    });
    const plan = root ? clean(root) : null;
    return { engine: "oracle", plan, totalCost: plan?.cost ?? 0 };
  } finally {
    await conn.close();
  }
}

const myNum = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };

const MY_ACCESS: Record<string, string> = {
  ALL: "FULL TABLE SCAN",
  index: "FULL INDEX SCAN",
  range: "INDEX RANGE SCAN",
  ref: "INDEX LOOKUP (ref)",
  eq_ref: "UNIQUE INDEX LOOKUP",
  ref_or_null: "INDEX LOOKUP (ref/null)",
  const: "CONST ROW",
  system: "SYSTEM (single row)",
  fulltext: "FULLTEXT SEARCH",
  index_merge: "INDEX MERGE",
  unique_subquery: "UNIQUE SUBQUERY",
  index_subquery: "INDEX SUBQUERY",
};
const MY_WRAP: Record<string, string> = {
  ordering_operation: "ORDER BY",
  grouping_operation: "GROUP BY",
  duplicates_removal: "DISTINCT",
  buffer_result: "BUFFER RESULT",
  windowing: "WINDOW",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/* ---------------- CSV/JSON import ---------------- */

export interface ImportResult {
  ok: boolean;
  created: boolean;
  inserted: number;
  table: string;
  error?: string;
}

interface ImportBody {
  table: string;
  createNew: boolean;
  columns: string[];              // target column names, order matches each row's values
  types?: string[];               // required when createNew: DDL type per column (validated below)
  rows: (string | number | null)[][];
}

const IMPORT_MAX_ROWS = 50000;

/** Keep only identifier-safe characters; Oracle folds unquoted names to upper case. */
const identOra = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_$#]/g, "").slice(0, 128);

/** Whitelist the client-supplied column type so it can never smuggle DDL. */
function safeOraType(t: string): string {
  return /^(NUMBER(\(\d+(,\d+)?\))?|VARCHAR2\(\d+\)|CHAR\(\d+\)|CLOB|DATE|TIMESTAMP)$/i.test(t.trim()) ? t.trim().toUpperCase() : "VARCHAR2(4000)";
}
/**
 * Validate an import payload, naming what is wrong. The shape is easy to get subtly
 * wrong from a script — `columns: [{name, type}]` instead of `columns: string[]` +
 * `types: string[]` used to reach Oracle as ten identical `OBJECTOBJECT` identifiers
 * and come back as `ORA-00957: duplicate column name`, which tells the caller nothing.
 * Every rejection here is a 400 that says what was expected.
 */
function readImportBody(body: unknown): { body: ImportBody } | { error: string } {
  const b = body as Partial<ImportBody> | undefined;
  if (!b || typeof b !== "object") return { error: "Invalid import payload — expected a JSON object." };
  if (typeof b.table !== "string" || !b.table.trim()) return { error: "Invalid import payload — `table` must be a non-empty string." };
  if (!Array.isArray(b.columns) || !b.columns.length) return { error: "Invalid import payload — `columns` must be a non-empty array of column names." };

  const bad = b.columns.findIndex((c) => typeof c !== "string" || !c.trim());
  if (bad >= 0) {
    const got = b.columns[bad];
    return {
      error: `Invalid import payload — \`columns[${bad}]\` is ${typeof got === "object" ? "an object" : `a ${typeof got}`}, expected a column name. `
        + "Send `columns: string[]` with a parallel `types: string[]` (only needed when `createNew` is true), not objects.",
    };
  }
  const columns = (b.columns as string[]).map((c) => c.trim());
  const seen = new Map<string, number>();
  for (let i = 0; i < columns.length; i++) {
    const key = columns[i].toUpperCase();
    const first = seen.get(key);
    if (first !== undefined) return { error: `Invalid import payload — \`columns[${i}]\` ("${columns[i]}") repeats \`columns[${first}]\`; column names must be unique.` };
    seen.set(key, i);
  }

  if (!Array.isArray(b.rows)) return { error: "Invalid import payload — `rows` must be an array of value arrays." };
  const notArray = b.rows.findIndex((r) => !Array.isArray(r));
  if (notArray >= 0) return { error: `Invalid import payload — \`rows[${notArray}]\` is not an array; each row is an array of values in \`columns\` order.` };
  const wrongLen = (b.rows as unknown[][]).findIndex((r) => r.length !== columns.length);
  if (wrongLen >= 0) {
    return { error: `Invalid import payload — \`rows[${wrongLen}]\` has ${(b.rows as unknown[][])[wrongLen].length} value(s) but there are ${columns.length} column(s).` };
  }

  const types = Array.isArray(b.types) ? b.types.map(String) : undefined;
  // types only matter for CREATE TABLE; a mismatched list there would silently
  // shift every column's type by one, so it is a rejection, not a fallback
  if (b.createNew && (!types || types.length !== columns.length)) {
    return { error: `Invalid import payload — \`createNew\` needs \`types\` with one entry per column (${columns.length} expected${types ? `, got ${types.length}` : ""}).` };
  }

  return { body: { table: b.table, createNew: !!b.createNew, columns, types, rows: b.rows as (string | number | null)[][] } };
}

async function oraImport(c: LiveConnection, body: ImportBody): Promise<ImportResult> {
  const table = identOra(body.table);
  const cols = body.columns.map(identOra);
  const conn = await getOraConn(c);
  try {
    let created = false;
    if (body.createNew) {
      const defs = cols.map((col, i) => `"${col}" ${safeOraType(body.types?.[i] ?? "VARCHAR2(4000)")}`).join(", ");
      await conn.execute(`CREATE TABLE "${table}" (${defs})`, [], { autoCommit: true });
      created = true;
    }
    const colList = cols.map((col) => `"${col}"`).join(", ");
    const binds = cols.map((_, i) => `:${i + 1}`).join(", ");
    const sql = `INSERT INTO "${table}" (${colList}) VALUES (${binds})`;
    // bind everything as strings (CSV is text anyway) with per-column maxSize so executeMany
    // has stable bind types even when the first row of a column is null
    const data = body.rows.map((r) => cols.map((_, ci) => { const v = r[ci]; return v == null || v === "" ? null : String(v); }));
    const bindDefs = cols.map((_, ci) => {
      let max = 1;
      for (const r of data) { const v = r[ci]; if (v != null && v.length > max) max = v.length; }
      return { type: oracledb.STRING, maxSize: Math.min(4000, max) };
    });
    const res = await conn.executeMany(sql, data, { autoCommit: true, bindDefs });
    return { ok: true, created, inserted: res.rowsAffected ?? data.length, table };
  } finally {
    await conn.close();
  }
}

/* ---------------- Row editor: insert / update / delete single rows (Oracle) ---------------- */

interface RowEditColumn {
  name: string;
  /** display type, e.g. VARCHAR2(50) */
  dataType: string;
  baseType: string;
  nullable: boolean;
  pk: boolean;
  /** false = the grid shows the value but refuses to write it back; `reason` says why */
  editable: boolean;
  reason?: string;
  /** characters the column accepts, for the input's maxLength (character types only) */
  maxLength?: number;
}

interface TableRowsResult {
  table: string;
  columns: RowEditColumn[];
  rows: (string | number | null)[][];
  /** parallel to `rows` — the ROWID each one is written back through */
  rowIds: string[];
  truncated: boolean;
  /** false when no row here can be written at all (a view, or every column unsupported) */
  writable: boolean;
  reason?: string;
}

type RowAction = "insert" | "update" | "delete";

interface RowChangeBody {
  table: string;
  action: RowAction;
  /** update/delete: which row. Ignored for insert. */
  rowId?: string;
  /** insert/update: column name → new value. Only the columns being written. */
  values?: Record<string, string | number | null>;
  /** update/delete: the row as the grid last read it, so a reused ROWID matches nothing. */
  original?: Record<string, string | number | null>;
}

interface RowChangeResult {
  ok: boolean;
  action: RowAction;
  table: string;
  /** the statement that ran, binds left as placeholders — there to be shown, not re-parsed */
  sql: string;
  /** ROWID of the inserted/updated row (null after a delete) */
  rowId: string | null;
  /** the row re-read from the database, so defaults and triggers are visible immediately */
  row: (string | number | null)[] | null;
}

/**
 * Types a single-line text box can round-trip without losing anything. Everything else is
 * shown read-only on purpose: `mapVal` renders LOBs as `[BLOB]`, RAW as a truncated hex
 * prefix and VECTOR as JSON, so writing the *rendered* text back would quietly replace the
 * value with its own preview. Time-zone timestamps are excluded for the same reason — the
 * grid shows them normalised to UTC, and saving that back would move the stored offset.
 */
function rowEditReason(baseType: string, virtual: boolean, identity: string | null): string | null {
  if (virtual) return "virtual column — Oracle computes it from the other columns.";
  if (identity === "ALWAYS") return "identity column generated always — Oracle assigns the value.";
  const t = baseType.toUpperCase();
  if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|NUMBER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE|DATE)$/.test(t)) return null;
  if (/^TIMESTAMP\(\d+\)$/.test(t)) return null;
  if (/TIME ZONE/.test(t)) return `${t} carries a time zone that the grid renders in UTC — editing it here would move the stored value.`;
  if (/^(CLOB|NCLOB|BLOB|BFILE|LONG|LONG RAW)$/.test(t)) return `${t} is shown as a placeholder rather than its contents.`;
  if (t === "RAW") return "RAW is shown as a truncated hex preview, not the full bytes.";
  return `${t} values cannot be edited from the data grid.`;
}

/** Normalise a typed-in date to the one format the TO_DATE/TO_TIMESTAMP calls below use. */
function normalizeStamp(raw: string | number): { value: string } | { error: string } {
  const m = String(raw).trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?Z?$/);
  if (!m) return { error: `expected a date as YYYY-MM-DD or YYYY-MM-DD HH24:MI:SS, got "${String(raw).slice(0, 40)}"` };
  return { value: `${m[1]} ${m[2] ?? "00"}:${m[3] ?? "00"}:${m[4] ?? "00"}` };
}

/**
 * How one column's value reaches Oracle. Every value is a bind — the only text this builds
 * from the request is the placeholder name, so a value can never become SQL.
 */
function rowValueBind(
  baseType: string,
  raw: string | number | null
): { sql: (ph: string) => string; value: string | number | null } | { error: string } {
  const t = baseType.toUpperCase();
  // Oracle stores '' as NULL anyway, so an emptied box means NULL — there is no third state.
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return { sql: (ph) => ph, value: null };
  if (/^(NUMBER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE)$/.test(t)) {
    const text = String(raw).trim();
    if (!Number.isFinite(typeof raw === "number" ? raw : Number(text))) {
      return { error: `"${String(raw).slice(0, 40)}" is not a valid ${t}` };
    }
    // Number() is only the validity check. Binding the parsed double would round a NUMBER(38)
    // past the ~15 significant digits a double holds — 12345678901234567890 would commit
    // silently as 12345678901234567000 — so the digits reach Oracle as text, as the
    // importer's do, and Oracle converts them at full precision.
    return { sql: (ph) => ph, value: text };
  }
  if (t === "DATE" || /^TIMESTAMP\(\d+\)$/.test(t)) {
    const s = normalizeStamp(raw);
    if ("error" in s) return { error: s.error };
    const fn = t === "DATE" ? "TO_DATE" : "TO_TIMESTAMP";
    return { sql: (ph) => `${fn}(${ph}, 'YYYY-MM-DD HH24:MI:SS')`, value: s.value };
  }
  return { sql: (ph) => ph, value: String(raw) };
}

/** Double-quote an identifier that came from the data dictionary, not from the request. */
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Extra WHERE predicates pinning a change to the row the grid actually read. A ROWID on its
 * own is not an identity: Oracle hands a deleted row's ROWID to the next insert that lands in
 * that block, so a stale grid could delete or overwrite a row it never showed. Comparing the
 * values it displayed makes that case match nothing, which surfaces as the "row is gone"
 * message instead — and catches a concurrent edit of the same row on the way.
 *
 * Only editable columns take part; `mapVal` renders the rest as placeholders that would never
 * compare equal. Dates go through the same mask `mapVal` prints them with, so a fractional
 * second the grid never showed cannot make an untouched row look changed, and NUMBER is
 * compared in double space, where node-oracledb has already put the value the grid holds.
 */
function rowMatchWhere(
  columns: RowEditColumn[],
  original: Record<string, string | number | null> | undefined
): { sql: string; binds: Record<string, unknown> } {
  const byName = new Map(columns.map((col) => [col.name.toUpperCase(), col]));
  const parts: string[] = [];
  const binds: Record<string, unknown> = {};
  let i = 0;
  for (const [rawName, was] of Object.entries(original ?? {})) {
    const col = byName.get(rawName.trim().toUpperCase());
    if (!col?.editable) continue;
    const ident = quoteIdent(col.name);
    // Oracle stores '' as NULL, so both spellings of "empty" mean the same predicate
    if (was === null || (typeof was === "string" && was === "")) {
      parts.push(`${ident} IS NULL`);
      continue;
    }
    const key = `w${i++}`;
    binds[key] = String(was);
    const t = col.baseType.toUpperCase();
    if (t === "DATE" || /^TIMESTAMP\(\d+\)$/.test(t)) parts.push(`TO_CHAR(${ident}, 'YYYY-MM-DD HH24:MI:SS') = :${key}`);
    else if (/^(NUMBER|FLOAT)$/.test(t)) parts.push(`TO_BINARY_DOUBLE(${ident}) = TO_BINARY_DOUBLE(:${key})`);
    else parts.push(`${ident} = :${key}`);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

/**
 * Resolve a name to the exact dictionary spelling of a **table** in this schema. Views are
 * deliberately not resolved: a view's ROWID is the base table's only in the simplest
 * key-preserving cases, so writing rows back through one is not dependable.
 */
async function oraResolveTable(conn: oracledb.Connection, name: string): Promise<string | null> {
  const rows = await oraRows(conn, `SELECT table_name FROM user_tables WHERE table_name = :n OR table_name = UPPER(:n)`, { n: name });
  // exact spelling wins, so a real lowercase "orders" is never answered with "ORDERS"
  const exact = rows.find((r) => String(r.TABLE_NAME) === name);
  return exact ? String(exact.TABLE_NAME) : rows.length ? String(rows[0].TABLE_NAME) : null;
}

/** The columns `SELECT *` returns, in that order, each marked editable or not. */
async function oraRowColumns(conn: oracledb.Connection, table: string): Promise<RowEditColumn[]> {
  // user_tab_cols (not user_tab_columns) is what carries VIRTUAL_COLUMN and HIDDEN_COLUMN;
  // hidden columns are excluded because SELECT * does not return them either.
  const cols = await oraRows(
    conn,
    `SELECT column_name, data_type, data_length, char_length, data_precision, data_scale, nullable, virtual_column
       FROM user_tab_cols WHERE table_name = :n AND hidden_column = 'NO' ORDER BY column_id`,
    { n: table }
  );
  // separate query: user_tab_identity_cols is empty on a table with no identity column, and
  // oraRows turns any failure into [] — a join would take the whole column list down with it
  const idents = await oraRows(conn, `SELECT column_name, generation_type FROM user_tab_identity_cols WHERE table_name = :n`, { n: table });
  const identMap = new Map(idents.map((r) => [String(r.COLUMN_NAME), String(r.GENERATION_TYPE ?? "").toUpperCase()]));
  const pkRows = await oraRows(
    conn,
    `SELECT cc.column_name
       FROM user_constraints uc JOIN user_cons_columns cc ON cc.constraint_name = uc.constraint_name
      WHERE uc.table_name = :n AND uc.constraint_type = 'P'`,
    { n: table }
  );
  const pkSet = new Set(pkRows.map((r) => String(r.COLUMN_NAME)));

  return cols.map((r) => {
    const name = String(r.COLUMN_NAME);
    const baseType = String(r.DATA_TYPE);
    const charLen = r.CHAR_LENGTH == null ? null : Number(r.CHAR_LENGTH) || null;
    const precision = r.DATA_PRECISION == null ? null : Number(r.DATA_PRECISION);
    const scale = r.DATA_SCALE == null ? null : Number(r.DATA_SCALE);
    const reason = rowEditReason(baseType, String(r.VIRTUAL_COLUMN) === "YES", identMap.get(name) ?? null);
    return {
      name,
      baseType,
      dataType: composeOraType(baseType, charLen, precision, scale),
      nullable: String(r.NULLABLE) === "Y",
      pk: pkSet.has(name),
      editable: reason === null,
      ...(reason ? { reason } : {}),
      ...(charLen && /^(VARCHAR2|NVARCHAR2|CHAR|NCHAR)$/.test(baseType.toUpperCase()) ? { maxLength: charLen } : {}),
    };
  });
}

/** Read a page of rows together with the ROWID that identifies each one. */
async function oraTableRows(c: LiveConnection, name: string, limit: number): Promise<TableRowsResult> {
  const lim = Math.min(MAX_ROWS, Math.max(1, limit));
  const conn = await getOraConn(c);
  try {
    const table = await oraResolveTable(conn, name);
    if (!table) {
      return {
        table: name, columns: [], rows: [], rowIds: [], truncated: false, writable: false,
        reason: `${name} is not a table in this schema. Rows are edited through a table's ROWID, which a view does not dependably have.`,
      };
    }
    const columns = await oraRowColumns(conn, table);
    if (!columns.length) {
      return { table, columns: [], rows: [], rowIds: [], truncated: false, writable: false, reason: `Could not read the columns of ${table}.` };
    }
    const list = columns.map((col) => `t.${quoteIdent(col.name)}`).join(", ");
    // lim is clamped above, so inlining it is safe — FETCH FIRST will not take a bind here
    const r = await conn.execute<unknown[]>(
      `SELECT t.ROWID, ${list} FROM ${quoteIdent(table)} t FETCH FIRST ${lim + 1} ROWS ONLY`,
      [],
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    const all = (r.rows ?? []) as unknown[][];
    const page = all.slice(0, lim);
    const editable = columns.filter((col) => col.editable).length;
    return {
      table,
      columns,
      rows: page.map((row) => row.slice(1).map(mapVal)),
      rowIds: page.map((row) => String(row[0])),
      truncated: all.length > lim,
      writable: editable > 0,
      ...(editable ? {} : { reason: `No column of ${table} holds a type the data grid can write back.` }),
    };
  } finally {
    await conn.close();
  }
}

/** Apply one row change. Identifiers come from the dictionary, values are always binds. */
async function oraRowChange(c: LiveConnection, body: RowChangeBody): Promise<RowChangeResult | { error: string }> {
  const conn = await getOraConn(c);
  try {
    const table = await oraResolveTable(conn, body.table);
    if (!table) return { error: `${body.table} is not a table in this schema — rows can only be edited on tables.` };
    const columns = await oraRowColumns(conn, table);
    const byName = new Map(columns.map((col) => [col.name.toUpperCase(), col]));
    const gone = "That row is not there any more — it was deleted, moved or changed by someone else since this grid was loaded. Refresh to see the current rows.";
    const match = rowMatchWhere(columns, body.original);

    if (body.action === "delete") {
      if (!body.rowId) return { error: "The row to delete could not be identified. Refresh the grid and try again." };
      const sql = `DELETE FROM ${quoteIdent(table)} WHERE ROWID = :rid${match.sql}`;
      const r = await conn.execute(sql, { ...match.binds, rid: body.rowId }, { autoCommit: true });
      if (!r.rowsAffected) return { error: gone };
      return { ok: true, action: "delete", table, sql, rowId: null, row: null };
    }

    const entries = Object.entries(body.values ?? {});
    if (!entries.length) {
      return { error: body.action === "update" ? "Nothing changed — no column was given a new value." : "A new row needs at least one column value." };
    }
    const assignments: string[] = [];
    const insertCols: string[] = [];
    const insertVals: string[] = [];
    const binds: Record<string, unknown> = {};
    for (const [i, [rawName, rawValue]] of entries.entries()) {
      const col = byName.get(rawName.trim().toUpperCase());
      if (!col) return { error: `${table} has no column named ${rawName}.` };
      if (!col.editable) return { error: `${col.name} cannot be edited here — ${col.reason}` };
      const bound = rowValueBind(col.baseType, rawValue);
      if ("error" in bound) return { error: `${col.name}: ${bound.error}.` };
      const key = `v${i}`;
      binds[key] = bound.value;
      assignments.push(`${quoteIdent(col.name)} = ${bound.sql(`:${key}`)}`);
      insertCols.push(quoteIdent(col.name));
      insertVals.push(bound.sql(`:${key}`));
    }

    let sql: string;
    let rowId: string;
    if (body.action === "update") {
      if (!body.rowId) return { error: "The row to update could not be identified. Refresh the grid and try again." };
      // RETURNING, not body.rowId: an update that moves the row — a partition key on a table
      // with ENABLE ROW MOVEMENT — leaves it at a new ROWID, and re-reading the old one would
      // find nothing and hand the grid back its stale values under a "saved" toast.
      sql = `UPDATE ${quoteIdent(table)} SET ${assignments.join(", ")} WHERE ROWID = :rid${match.sql} RETURNING ROWID INTO :df_rowid`;
      const r = await conn.execute(
        sql,
        { ...binds, ...match.binds, rid: body.rowId, df_rowid: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 64 } },
        { autoCommit: true }
      );
      if (!r.rowsAffected) return { error: gone };
      rowId = String((r.outBinds as { df_rowid: string[] }).df_rowid[0]);
    } else {
      // RETURNING hands back the new ROWID, so the grid can keep editing the row it just made
      sql = `INSERT INTO ${quoteIdent(table)} (${insertCols.join(", ")}) VALUES (${insertVals.join(", ")}) RETURNING ROWID INTO :df_rowid`;
      const r = await conn.execute(
        sql,
        { ...binds, df_rowid: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 64 } },
        { autoCommit: true }
      );
      rowId = String((r.outBinds as { df_rowid: string[] }).df_rowid[0]);
    }

    // re-read: defaults, identity values and row triggers only show up after the write
    const list = columns.map((col) => `t.${quoteIdent(col.name)}`).join(", ");
    const back = await conn.execute<unknown[]>(
      `SELECT ${list} FROM ${quoteIdent(table)} t WHERE t.ROWID = :rid`,
      { rid: rowId },
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    const row = back.rows?.[0] ? back.rows[0].map(mapVal) : null;
    return { ok: true, action: body.action, table, sql, rowId, row };
  } finally {
    await conn.close();
  }
}

/* ---------------- ER diagram (live FKs) ---------------- */

export interface ErdColumn { name: string; type: string; pk: boolean; fk: boolean; nullable: boolean; }
export interface ErdTable { name: string; rowCount: number | null; columns: ErdColumn[]; }
export interface ErdRelationship { name: string; fromTable: string; fromColumns: string[]; toTable: string; toColumns: string[]; }
export interface ErdResult {
  engine: "oracle";
  schema: string;
  tables: ErdTable[];
  relationships: ErdRelationship[];
  truncated: boolean;
  /** Oracle: index/mview internals left out of the model (see ORA_SYSGEN_TABLE). Reported, not silent. */
  hiddenSystem: number;
}

/** Cap entities so the diagram stays legible; huge schemas mark truncated. */
const ERD_MAX_TABLES = 60;

/**
 * Named binds for an `IN` list of table names — `{ clause: ":t0, :t1, …" }`.
 * Only ever called with the ≤60 tables the diagram keeps, so it stays far below
 * Oracle's 1000-expression limit. `NULL` for an empty list keeps the SQL valid
 * (and matches nothing) instead of producing `IN ()`.
 */
function oraNameList(names: string[], prefix = "t"): { clause: string; binds: Record<string, string> } {
  const binds: Record<string, string> = {};
  const parts = names.map((n, i) => {
    binds[`${prefix}${i}`] = n;
    return `:${prefix}${i}`;
  });
  return { clause: parts.length ? parts.join(", ") : "NULL", binds };
}

async function oraErd(c: LiveConnection): Promise<ErdResult> {
  const conn = await getOraConn(c);
  try {
    const hiddenCount = `SELECT COUNT(*) AS n FROM user_tables WHERE ${ORA_SYSGEN_TABLE}`;
    const tabRows = await oraRows(
      conn,
      // One row past the cap: its presence is how we detect truncation without dragging
      // every table of a 2000-table schema across the wire. Three details earn their keep
      // on a dictionary schema, where each touch of `user_mviews` costs ~250 ms:
      //  - the count of what we hid rides along as a scalar subquery (Oracle evaluates it
      //    once and caches it), so honesty about the omission costs no extra round trip;
      //  - NO_UNNEST keeps the optimizer from merging the anti-join into the main query,
      //    which otherwise defeats the ORDER BY + FETCH FIRST top-N plan (1,050 ms → 515);
      //  - the cheap LIKE patterns are tested first, so most rows never reach the anti-join.
      `SELECT t.table_name, t.num_rows,
              (SELECT COUNT(*) FROM user_tables x WHERE ${oraSysgenLike("x.table_name")})
                + (SELECT COUNT(*) FROM user_mviews) AS hidden
       FROM user_tables t
       WHERE NOT (t.table_name LIKE 'BIN$%' OR ${oraSysgenLike("t.table_name")})
         AND NOT EXISTS (SELECT /*+ NO_UNNEST */ 1 FROM user_mviews m WHERE m.mview_name = t.table_name)
       ORDER BY t.table_name FETCH FIRST ${ERD_MAX_TABLES + 1} ROWS ONLY`
    );
    // no rows means the scalar subquery came back with them — count separately rather
    // than claim nothing was hidden (a schema of nothing but DR$ tables would lie)
    const hiddenSystem = tabRows.length
      ? Number(tabRows[0].HIDDEN)
      : Number((await oraRows(conn, hiddenCount))[0]?.N ?? 0);
    const truncated = tabRows.length > ERD_MAX_TABLES;
    const kept = tabRows.slice(0, ERD_MAX_TABLES);
    const keep = new Set(kept.map((r) => String(r.TABLE_NAME)));
    if (!kept.length) {
      return { engine: "oracle", schema: c.user.toUpperCase(), tables: [], relationships: [], truncated, hiddenSystem };
    }
    // every follow-up query filters to the kept tables in SQL. Doing it in JS
    // meant reading the whole dictionary — on SYS that is ~133k column rows to
    // draw 60 boxes.
    const { clause: tabs, binds } = oraNameList([...keep]);

    const colRows = await oraRows(
      conn,
      `SELECT table_name, column_name, data_type, data_length, data_precision, data_scale, nullable, column_id
       FROM user_tab_columns WHERE table_name IN (${tabs}) ORDER BY table_name, column_id`,
      binds
    );
    const pkRows = await oraRows(
      conn,
      `SELECT uc.table_name, cc.column_name
       FROM user_constraints uc JOIN user_cons_columns cc ON cc.constraint_name = uc.constraint_name
       WHERE uc.constraint_type = 'P' AND uc.table_name IN (${tabs})`,
      binds
    );
    const fkRows = await oraRows(
      conn,
      `SELECT rc.constraint_name AS fk, rc.table_name AS from_tab, cc.column_name AS from_col,
              rk.table_name AS to_tab, rk.column_name AS to_col, cc.position AS pos
       FROM user_constraints rc
       JOIN user_cons_columns cc ON cc.constraint_name = rc.constraint_name
       JOIN user_cons_columns rk ON rk.constraint_name = rc.r_constraint_name AND rk.position = cc.position
       WHERE rc.constraint_type = 'R' AND rc.table_name IN (${tabs})
       ORDER BY rc.constraint_name, cc.position`,
      binds
    );

    const pkSet = new Set(pkRows.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));
    // a column is "fk" if it appears as the local side of any FK
    const fkColSet = new Set(fkRows.map((r) => `${r.FROM_TAB}.${r.FROM_COL}`));

    const colsByTable = new Map<string, ErdColumn[]>();
    for (const r of colRows) {
      const t = String(r.TABLE_NAME);
      const key = `${t}.${r.COLUMN_NAME}`;
      const length = r.DATA_LENGTH == null ? null : Number(r.DATA_LENGTH);
      const precision = r.DATA_PRECISION == null ? null : Number(r.DATA_PRECISION);
      const scale = r.DATA_SCALE == null ? null : Number(r.DATA_SCALE);
      const baseType = String(r.DATA_TYPE);
      const charLen = ["VARCHAR2", "CHAR", "NVARCHAR2", "NCHAR", "RAW"].includes(baseType) ? length : null;
      (colsByTable.get(t) ?? colsByTable.set(t, []).get(t)!).push({
        name: String(r.COLUMN_NAME),
        type: composeOraType(baseType, charLen, precision, scale),
        pk: pkSet.has(key),
        fk: fkColSet.has(key),
        nullable: String(r.NULLABLE) === "Y",
      });
    }

    const tables: ErdTable[] = kept.map((r) => ({
      name: String(r.TABLE_NAME),
      rowCount: r.NUM_ROWS == null ? null : Number(r.NUM_ROWS),
      columns: colsByTable.get(String(r.TABLE_NAME)) ?? [],
    }));

    // group FK column pairs per constraint; only keep edges whose both ends are visible
    const relMap = new Map<string, ErdRelationship>();
    for (const r of fkRows) {
      const from = String(r.FROM_TAB);
      const to = String(r.TO_TAB);
      if (!keep.has(from) || !keep.has(to)) continue;
      const name = String(r.FK);
      const rel = relMap.get(name) ?? { name, fromTable: from, toTable: to, fromColumns: [], toColumns: [] };
      rel.fromColumns.push(String(r.FROM_COL));
      rel.toColumns.push(String(r.TO_COL));
      relMap.set(name, rel);
    }

    return { engine: "oracle", schema: c.user.toUpperCase(), tables, relationships: [...relMap.values()], truncated, hiddenSystem };
  } finally {
    await conn.close();
  }
}

/* ---------------- HTTP API ---------------- */

const app = express();

/**
 * `req.ip` reads the raw socket address unless Express is told otherwise — behind the
 * TLS-terminating reverse proxy this app expects for anything beyond loopback (see
 * docs/deployment.md), that address is the proxy's own. Every client sharing that proxy
 * would then share one cooldown bucket in the auth throttle below: a single attacker, or
 * one user mistyping their password, could 429 everyone else behind it. Trusting
 * `X-Forwarded-For` unconditionally is its own hole — an untrusted client could forge the
 * header and pin its failures on someone else's address — so this stays off unless
 * `DATAFORGE_TRUST_PROXY` says how far to trust it (hop count, or a proxy/CIDR list; see
 * https://expressjs.com/en/guide/behind-proxies.html for the accepted values).
 */
const TRUST_PROXY = process.env.DATAFORGE_TRUST_PROXY ?? "";
if (TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

/**
 * Host guard — the first thing every request meets.
 *
 * The same-origin guard further down compares `Origin` against `Host`, and a browser fills
 * both in from the URL the page was loaded from, so they always agree with each other. That
 * makes the check self-satisfying under DNS rebinding: a page served from
 * `attacker.example:3001`, whose DNS record is flipped to 127.0.0.1 once it has loaded, sends
 * `Origin: http://attacker.example:3001` and `Host: attacker.example:3001`, matches itself,
 * and reaches the API. On the default install — no token, no accounts — that is the whole
 * API: the connection list, arbitrary SQL, and `POST /api/users` to plant an Administrator.
 *
 * Pinning the names this server answers to closes it. The attacker controls DNS, not which
 * names appear in this allowlist. Literal IP addresses are accepted unconditionally because
 * rebinding needs a *name* to re-point — a browser resolves nothing for `192.168.1.5` — so a
 * LAN install reached by address keeps working with no extra configuration.
 *
 * It runs ahead of the auth middleware so it also covers the unauthenticated bootstrap
 * state, which is exactly where the damage would be greatest.
 */
// Each octet 0-255, not just 1-3 digits: an out-of-range host like "999.999.999.999" is not
// a real IP literal and must not be waved through as one.
const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const IPV4_LITERAL = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;

/**
 * Strips a trailing `:<port>`, keeping a bracketed IPv6 literal intact — `null` for anything
 * that isn't a well-formed authority. A bracketed host must end at its `]`, followed by
 * nothing or exactly `:<port>`; trailing junk like `[::1]attacker.com` used to be truncated
 * at the first `]` and silently accepted as `[::1]`, letting a Host this guard never actually
 * validated ride through on another literal's name.
 */
function stripPort(host: string): string | null {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return null; // unterminated bracket
    const rest = host.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return null;
    return host.slice(0, end + 1);
  }
  return host.split(":")[0];
}
function isAllowedHost(header: string | undefined): boolean {
  if (!header) return false; // HTTP/1.1 requires Host; a request without one names nothing
  const host = header.toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  const bare = stripPort(host);
  if (!bare) return false;
  return ALLOWED_HOSTS.has(bare) || IPV4_LITERAL.test(bare) || IPV6_LITERAL.test(bare);
}
app.use((req, res, next) => {
  if (isAllowedHost(req.headers.host)) return next();
  return res.status(403).json({
    error: "This server does not answer to that host name. Add it to DATAFORGE_ALLOWED_HOSTS if it is legitimate.",
  });
});

/**
 * gzip the responses that are worth it. The built SPA is a single ~950 kB bundle that the
 * backend serves itself in production, and result payloads are JSON — both compress by
 * roughly 4-5x, which is the difference between a snappy first load and a visible one over
 * anything slower than loopback.
 *
 * Registered first so it also covers the static SPA mounted at the end of this file.
 * The default 1 kB threshold is left alone: below that, the gzip header costs more than
 * the saving.
 */
app.use(compression());

/**
 * HTTP Basic auth protects every API and UI route on a LAN deployment, and now also
 * establishes *who* is asking, for role enforcement. Two credentials are accepted:
 *
 * - `dataforge` / DATAFORGE_AUTH_TOKEN — the original break-glass credential. Always
 *   Administrator, independent of the accounts below, so a forgotten password can never
 *   lock the workspace out entirely as long as this is configured.
 * - a workspace account's email / password, checked against `users`.
 *
 * With no token and no accounts configured, the server stays exactly as open as before:
 * no prompt, full access, role "Administrator" for everyone. Browser requests retain the
 * header for same-origin API calls, so no application credential is stored in JS.
 *
 * Because Basic replays that credential on every request, a verified result is cached for a
 * few minutes (`authCache`) and the derivation itself runs off the event loop; repeated
 * failures from one address meet a cooldown before reaching scrypt at all. See
 * `verifyPassword` for why that matters.
 */
app.use((req, res, next) => {
  if (!AUTH_TOKEN && users.size === 0) {
    res.locals.role = "Administrator" as Role;
    return next();
  }
  const header = req.headers.authorization ?? "";
  const encoded = header.match(/^Basic\s+(.+)$/i)?.[1];
  const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
  const sep = decoded.indexOf(":");
  const username = sep >= 0 ? decoded.slice(0, sep) : "";
  const password = sep >= 0 ? decoded.slice(sep + 1) : "";

  const admitToken = () => {
    res.locals.role = "Administrator" as Role;
    res.locals.userName = "dataforge (break-glass token)";
    next();
  };
  const admitUser = (user: StoredUser) => {
    res.locals.role = user.role;
    res.locals.userEmail = user.email;
    res.locals.userName = user.name;
    next();
  };
  const challenge = () => {
    res.setHeader("WWW-Authenticate", 'Basic realm="Oracle DataForge", charset="UTF-8"');
    res.status(401).json({ error: "Authentication required." });
  };

  // A request carrying no credential is the *first half* of the Basic handshake, not a
  // guess: the browser asks once with nothing, gets the challenge, and retries with the
  // password. A page load opens several of those at once, so counting them would let an
  // ordinary first visit trip the cooldown before anyone could type anything. Only a
  // credential that was presented and rejected counts against the limit.
  if (!encoded) return challenge();

  // A credential verified earlier skips the derivation, but never the status check: an
  // account suspended between requests stops here even if its entry is still warm.
  const cacheKey = encoded ? createHash("sha256").update(header).digest("base64") : "";
  if (cacheKey) {
    const hit = authCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      if (hit.email === null) return admitToken();
      const cached = users.get(hit.email);
      if (cached && cached.status === "Active") return admitUser(cached);
    }
    if (hit) authCache.delete(cacheKey);
  }

  const cooldown = authCooldownRemaining(req.ip ?? "");
  if (cooldown > 0) {
    res.setHeader("Retry-After", String(Math.ceil(cooldown / 1000)));
    return res.status(429).json({ error: "Too many failed sign-in attempts. Try again shortly." });
  }

  if (AUTH_TOKEN && username === "dataforge") {
    // Compared as UTF-8 bytes rather than JavaScript string length: timingSafeEqual throws
    // on a length mismatch, so a multi-byte token used to surface as a 500, not a 401.
    const supplied = Buffer.from(password, "utf8");
    const expected = Buffer.from(AUTH_TOKEN, "utf8");
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      rememberAuth(cacheKey, null);
      return admitToken();
    }
  }

  const user = users.get(username.toLowerCase());
  if (!user || user.status !== "Active") {
    recordAuthFailure(req.ip ?? "");
    return challenge();
  }
  const { salt, hash } = user;
  verifyPassword(password, salt, hash).then((ok) => {
    if (!ok) {
      recordAuthFailure(req.ip ?? "");
      return challenge();
    }
    // scrypt just spent real wall-clock time off the event loop. Re-fetch rather than
    // trust the closed-over `user`: the account may have been suspended, or its password
    // rotated, while the derivation was in flight, and admission must reflect that, not
    // the credentials that were current when the request arrived.
    const current = users.get(username.toLowerCase());
    if (!current || current.status !== "Active" || current.salt !== salt || current.hash !== hash) {
      return challenge();
    }
    rememberAuth(cacheKey, current.email);
    admitUser(current);
  }, next); // a rejected derivation reaches the error handler instead of hanging the request
});

/** Administrator/Developer only — everything that changes Oracle data, DDL, the connection
 *  registry, or writes to GitHub. Analyst and Viewer are read tiers, enforced per-endpoint. */
function requireFullAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (FULL_ACCESS_ROLES.includes(res.locals.role as Role)) return next();
  return res.status(403).json({ error: "Your role does not have access to this feature." });
}

/** Only an Administrator manages workspace accounts — a stricter bar than the general
 *  read/write split, since this endpoint can grant or revoke everyone else's access. */
function requireAdministrator(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (res.locals.role === "Administrator") return next();
  return res.status(403).json({ error: "Only an Administrator can manage workspace users." });
}

/**
 * Same-origin guard — the API has no authentication, so the browser's origin is the
 * only thing standing between it and any web page the user happens to have open.
 * `cors()` (wildcard `Access-Control-Allow-Origin: *`) actively removed that barrier:
 * any site could read `GET /api/connections` and POST arbitrary SQL to `/query`
 * cross-origin, because there are no cookies for the browser's credential rules to
 * withhold. Requests carrying an `Origin` that is not this server or the dev frontend
 * are now refused.
 *
 * Same-origin requests (the container's own SPA, curl, Invoke-RestMethod) send no
 * `Origin` at all and are unaffected; reaching :8080 from another machine on the LAN
 * still works, because that page's origin *is* this server.
 */
const DEV_ORIGINS = new Set(
  [5173, 4173].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`])
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = DEV_ORIGINS.has(origin) || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
    if (!allowed) {
      return res.status(403).json({ error: "Cross-origin requests are not allowed by this server." });
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: "16mb" })); // generous headroom for CSV/JSON imports

app.get("/api/health", (_req, res) => res.json({ ok: true, connections: registry.size }));

/** Tells the browser who it's actually authenticated as, so the UI reflects the role the
 *  server will enforce instead of a client-chosen guess. */
app.get("/api/session", (_req, res) => {
  res.json({
    role: res.locals.role as Role,
    email: (res.locals.userEmail as string | undefined) ?? null,
    name: (res.locals.userName as string | undefined) ?? null,
    accountsConfigured: users.size > 0,
  });
});

/**
 * Change the signed-in account's own password. Deliberately not Administrator-gated: it only
 * ever touches the account the request authenticated as, and the current password has to be
 * presented again, so a session someone walked away from cannot be used to lock its owner out.
 *
 * Basic auth has no server-side session to re-issue, so the browser goes on sending the old
 * credential and every later request 401s — the caller is told to sign in again, and the UI
 * says so rather than leaving the app looking broken.
 */
app.post("/api/session/password", async (req, res) => {
  const email = res.locals.userEmail as string | undefined;
  const user = email ? users.get(email) : undefined;
  if (!user) {
    return res.status(400).json({
      error: users.size === 0
        ? "This workspace has no accounts yet, so there is no password to change. Create one in Administration first."
        : "You are signed in with the break-glass token, which has no stored account. Sign in as a workspace account to change its password.",
    });
  }
  const current = String(req.body?.currentPassword ?? "");
  const next = String(req.body?.newPassword ?? "");
  const { salt, hash } = user;
  if (!(await verifyPassword(current, salt, hash))) return res.status(400).json({ error: "That is not your current password." });
  if (next.length < 8) return res.status(400).json({ error: "The new password must be at least 8 characters." });
  if (next === current) return res.status(400).json({ error: "The new password is the same as the current one." });
  // scrypt just spent real wall-clock time off the event loop. Re-fetch rather than trust
  // the closed-over `user`: it could have been suspended, or its password already changed
  // by someone else, while the derivation was in flight.
  const target = email ? users.get(email) : undefined;
  if (!target || target.status !== "Active" || target.salt !== salt || target.hash !== hash) {
    return res.status(409).json({ error: "Your account changed while this request was in flight. Sign in again and retry." });
  }
  Object.assign(target, hashPassword(next));
  saveUsers();
  res.json({ ok: true, reauthenticate: true });
});

type CreateUserBody = { name?: unknown; email?: unknown; role?: unknown; mfa?: unknown; password?: unknown };
type UpdateUserBody = CreateUserBody & { status?: unknown };

function validateUserFields(body: CreateUserBody): string | null {
  if (!String(body.name ?? "").trim()) return "Enter a name.";
  if (!/^\S+@\S+\.\S+$/.test(String(body.email ?? ""))) return "Enter a valid email address.";
  if (!ROLES.includes(body.role as Role)) return "Choose a valid role.";
  return null;
}

/** Administrator-only account management. Open to everyone until the first account
 *  exists (see the auth middleware above) — that first call is how a fresh install
 *  bootstraps its own Administrator without a chicken-and-egg login problem. */
app.get("/api/users", requireAdministrator, (_req, res) => {
  res.json({ users: [...users.values()].map(toPublicUser) });
});

app.post("/api/users", requireAdministrator, (req, res) => {
  const body = req.body as CreateUserBody;
  const bad = validateUserFields(body);
  if (bad) return res.status(400).json({ error: bad });
  const email = String(body.email).trim().toLowerCase();
  if (users.has(email)) return res.status(409).json({ error: "A user with that email already exists." });
  const password = String(body.password ?? "");
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const user: StoredUser = {
    id: `user${Date.now()}`, name: String(body.name).trim(), email, role: body.role as Role,
    status: "Active", mfa: !!body.mfa, ...hashPassword(password), createdAt: new Date().toISOString(),
  };
  users.set(email, user);
  saveUsers();
  res.json({ user: toPublicUser(user) });
});

app.put("/api/users/:id", requireAdministrator, (req, res) => {
  const existing = [...users.values()].find((u) => u.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "Unknown user." });
  const body = req.body as UpdateUserBody;
  const bad = validateUserFields(body);
  if (bad) return res.status(400).json({ error: bad });
  const email = String(body.email).trim().toLowerCase();
  const other = users.get(email);
  if (other && other.id !== existing.id) return res.status(409).json({ error: "A user with that email already exists." });
  const role = body.role as Role;
  const status = body.status === "Suspended" ? "Suspended" : "Active";
  if (wouldOrphanAdministrators(existing.id, role, status)) {
    return res.status(400).json({ error: "This would leave the workspace with no active Administrator." });
  }
  const updated: StoredUser = {
    ...existing, name: String(body.name).trim(), email, role, status, mfa: !!body.mfa,
    ...(String(body.password ?? "").length >= 8 ? hashPassword(String(body.password)) : {}),
  };
  if (email !== existing.email) users.delete(existing.email);
  users.set(email, updated);
  saveUsers();
  res.json({ user: toPublicUser(updated) });
});

app.post("/api/users/:id/status", requireAdministrator, (req, res) => {
  const existing = [...users.values()].find((u) => u.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "Unknown user." });
  const status = req.body?.status === "Suspended" ? "Suspended" : "Active";
  if (wouldOrphanAdministrators(existing.id, undefined, status)) {
    return res.status(400).json({ error: "This would leave the workspace with no active Administrator." });
  }
  existing.status = status;
  saveUsers();
  res.json({ user: toPublicUser(existing) });
});

app.delete("/api/users/:id", requireAdministrator, (req, res) => {
  const existing = [...users.values()].find((u) => u.id === req.params.id);
  if (!existing) return res.json({ ok: true });
  if (wouldOrphanAdministrators(existing.id, undefined, "Suspended")) {
    return res.status(400).json({ error: "This would leave the workspace with no active Administrator." });
  }
  users.delete(existing.email);
  saveUsers();
  res.json({ ok: true });
});

type GitHubSyncRequest = { repositoryUrl?: unknown; branch?: unknown; directory?: unknown; object?: unknown; type?: unknown; source?: unknown };

/** Accept only a normal github.com owner/repository URL; the caller never chooses an API host. */
function parseGitHubRepository(value: unknown): { owner: string; repo: string } | null {
  const raw = String(value ?? "").trim().replace(/\.git$/i, "");
  const match = raw.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function gitHubSourcePath(directory: string, object: string, type: string) {
  const safeDir = directory.replace(/^\/+|\/+$/g, "").split("/").filter((p) => /^[A-Za-z0-9_.-]+$/.test(p)).join("/");
  const safeName = object.toLowerCase().replace(/[^a-z0-9_$#]/gi, "_");
  const normalized = type.toUpperCase().replace(/\s+BODY$/, " BODY");
  const ext = normalized === "PACKAGE" ? "pks" : normalized === "PACKAGE BODY" ? "pkb" : normalized === "PROCEDURE" ? "prc" : normalized === "FUNCTION" ? "fnc" : normalized === "TRIGGER" ? "trg" : "sql";
  return `${safeDir ? `${safeDir}/` : ""}${safeName}.${ext}`;
}

app.post("/api/github/sync", requireFullAccess, async (req, res) => {
  if (!GITHUB_TOKEN) return res.status(503).json({ error: "GitHub sync is not configured on this server. Set GITHUB_TOKEN and restart Dataforge." });
  const body = req.body as GitHubSyncRequest;
  const repo = parseGitHubRepository(body.repositoryUrl);
  const object = String(body.object ?? "").trim();
  const type = String(body.type ?? "").trim();
  const branch = String(body.branch ?? "main").trim();
  const directory = String(body.directory ?? "database/plsql").trim();
  const source = String(body.source ?? "");
  if (!repo || !object || !type || !branch || !source) return res.status(400).json({ error: "Repository URL, branch, object, type, and source are required." });
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || source.length > 4 * 1024 * 1024) return res.status(400).json({ error: "The branch or source content is invalid." });
  const filePath = gitHubSourcePath(directory, object, type);
  const apiPath = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Oracle-DataForge" };
  try {
    const existing = await fetch(`${apiPath}?ref=${encodeURIComponent(branch)}`, { headers });
    let sha: string | undefined;
    if (existing.ok) sha = (await existing.json() as { sha?: string }).sha;
    else if (existing.status !== 404) return res.status(existing.status).json({ error: `GitHub could not read ${filePath}: ${await existing.text()}` });
    const message = `Dataforge: compile ${type.toUpperCase()} ${object.toUpperCase()}`;
    const saved = await fetch(apiPath, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ message, content: Buffer.from(source.endsWith("\n") ? source : `${source}\n`, "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) }) });
    if (!saved.ok) return res.status(saved.status).json({ error: `GitHub could not write ${filePath}: ${await saved.text()}` });
    const result = await saved.json() as { commit?: { sha?: string; html_url?: string } };
    return res.json({ ok: true, path: filePath, commit: result.commit?.sha ?? null, url: result.commit?.html_url ?? null });
  } catch (e) {
    return res.status(502).json({ error: `GitHub sync failed: ${errMsg(e)}` });
  }
});

async function runTest(cfg: ConnConfig) {
  const bad = validate(cfg);
  if (bad) return { ok: false, error: bad };
  const started = Date.now();
  try {
    const version = await oraTest(cfg);
    return { ok: true, version, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: withNetworkHint(errMsg(e), cfg.host) };
  }
}

/**
 * Saved connections, metadata only. The browser used to be the sole owner of this
 * list (localStorage), so opening the app from another browser or machine showed
 * "No connections yet" while the backend still held them — with their passwords and
 * no way to reach them. This lets the frontend rehydrate from the registry.
 * The password is destructured away rather than omitted by hand, so a new field
 * added to ConnConfig cannot silently start leaking through here.
 */
app.get("/api/connections", (_req, res) => {
  const connections = [...registry.values()].map((c) => {
    const { password: _pw, oraPool: _op, oracleMaintained: _om, ...safe } = c;
    return safe;
  });
  res.json({ connections });
});

app.post("/api/connections/test", async (req, res) => {
  res.json(await runTest(pickConfig(req.body)));
});

/**
 * A stored password may only ever be replayed to the endpoint it was stored for.
 *
 * Both `/:id/test` and `PUT /:id` accept an empty password to mean "keep the saved
 * one" — a real convenience, but combined with a caller-supplied host it turned the
 * app into a credential-harvesting oracle: point a saved connection at a rogue
 * server, and the backend dials out and authenticates with the real password
 * (Oracle hands over an O5LOGON exchange that can be attacked offline). Reusing the secret therefore
 * requires the whole endpoint identity to match what it was saved against.
 */
const SAME_ENDPOINT_ERROR =
  "The server, port, user or engine changed — re-enter the password for the new destination.";
const sameEndpoint = (a: ConnConfig, b: ConnConfig) =>
  a.engine === b.engine &&
  a.host === b.host &&
  Number(a.port) === Number(b.port) &&
  a.user === b.user &&
  (a.database ?? "") === (b.database ?? "");

/** Test against an existing connection — an empty password means "use the stored one". */
app.post("/api/connections/:id/test", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.json({ ok: false, error: "Unknown connection (backend may have restarted — recreate it)" });
  const cfg = pickConfig(req.body);
  if (!cfg.password) {
    if (!sameEndpoint(cfg, c)) return res.json({ ok: false, error: SAME_ENDPOINT_ERROR });
    cfg.password = c.password;
  }
  res.json(await runTest(cfg));
});

app.post("/api/connections", requireFullAccess, (req, res) => {
  const cfg = pickConfig(req.body);
  const bad = validate(cfg);
  if (bad) return res.status(400).json({ error: bad });
  const id = `live${seq++}`;
  registry.set(id, { ...cfg, id });
  saveRegistry();
  res.json({ id });
});

/** Update a saved connection — an empty password keeps the stored one. Pools are recycled. */
app.put("/api/connections/:id", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const cfg = pickConfig(req.body);
  if (!cfg.password) {
    if (!sameEndpoint(cfg, c)) return res.status(400).json({ error: SAME_ENDPOINT_ERROR });
    cfg.password = c.password;
  }
  const bad = validate(cfg);
  if (bad) return res.status(400).json({ error: bad });
  await closePools(c);
  registry.set(c.id, { ...cfg, id: c.id });
  saveRegistry();
  res.json({ ok: true });
});

app.delete("/api/connections/:id", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (c) {
    await closePools(c);
    registry.delete(c.id);
    saveRegistry();
  }
  res.json({ ok: true });
});

/**
 * Disconnect: drop the pooled sessions but keep the saved connection. The next
 * query re-opens a pool lazily, so this is also the way out of a pool left
 * stale by a database or network restart.
 */
app.post("/api/connections/:id/disconnect", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const wasOpen = await closePools(c);
  res.json({ ok: true, wasOpen });
});

/** Reconnect: close whatever is open, then prove a fresh session can be established. */
app.post("/api/connections/:id/reconnect", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  await closePools(c);
  const started = Date.now();
  try {
    const version = await oraTest(c);
    res.json({ ok: true, version, ms: Date.now() - started });
  } catch (e) {
    res.json({ ok: false, error: withNetworkHint(errMsg(e), c.host) });
  }
});

app.get("/api/connections/:id/schema", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  try {
    res.json(await oraSchema(c));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** One group of the tree, re-read on its own (the per-type Refresh in the Explorer). */
app.get("/api/connections/:id/schema/group", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const label = String(req.query.label ?? "").trim();
  if (!label) return res.status(400).json({ error: "Missing group label (?label=...)" });
  try {
    const group = await oraGroup(c, label);
    if (!group) return res.status(400).json({ error: `"${label}" is not a schema group on this connection.` });
    res.json(group);
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

app.get("/api/connections/:id/dba", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The DBA Performance Advisor is Oracle-only." });
  try {
    res.json(await oraDba(c));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

app.get("/api/connections/:id/perf", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  try {
    res.json(await oraPerf(c));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

app.get("/api/connections/:id/deps", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const name = String(req.query.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Missing object name (?name=...)" });
  try {
    res.json(await oraDeps(c, name));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** ER diagram model from the Oracle catalog: tables, columns, PK/FK flags, FK edges. */
app.get("/api/connections/:id/erd", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  try {
    res.json(await oraErd(c));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Real Oracle execution plan for a statement: body { sql }. */
app.post("/api/connections/:id/explain", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const sql = String(req.body?.sql ?? "").trim();
  if (!sql) {
    return res.json({ engine: c.engine, plan: null, totalCost: 0, error: { message: "Nothing to explain — the worksheet is empty.", code: "DF-0001", line: 1 } });
  }
  const denial = roleQueryDenial(res.locals.role as Role, sql);
  if (denial) {
    return res.json({ engine: c.engine, plan: null, totalCost: 0, error: { message: denial, code: "ROLE-DENIED", line: 1 } });
  }
  // Explaining is a read, but producing the plan is not: Oracle writes rows into
  // plan_table and deletes them again. A read-only connection must not do that, and
  // it must certainly not run the parser over a statement it would refuse to execute.
  if (c.readOnly && !isReadStatement(sql)) {
    return res.json({
      engine: c.engine,
      plan: null,
      totalCost: 0,
      error: { message: "READ-ONLY connection: only read statements can be explained here.", code: "DF-0002", line: 1 },
    });
  }
  try {
    res.json(await oraExplain(c, sql));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Import parsed CSV/JSON rows into a live Oracle table: body ImportBody. */
app.post("/api/connections/:id/import", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.readOnly) return res.status(400).json({ error: "This connection is read-only — importing data is blocked. Edit the connection to disable read-only mode." });
  const parsed = readImportBody(req.body);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });
  const body = parsed.body;
  if (body.rows.length > IMPORT_MAX_ROWS) return res.status(400).json({ error: `Too many rows — the import limit is ${IMPORT_MAX_ROWS.toLocaleString()}.` });
  if (body.rows.length === 0) return res.status(400).json({ error: "The file has no data rows to import." });
  if (!acknowledged(req)) {
    return confirmRequired(res, describeOperation({
      level: "write",
      verb: "IMPORT",
      target: body.table.toUpperCase(),
      title: `Import ${body.rows.length.toLocaleString()} row(s) into ${body.table.toUpperCase()}?`,
      body: `${body.rows.length.toLocaleString()} row(s) will be inserted into ${body.table.toUpperCase()} on "${c.name}"${body.createNew ? " — the table will be created first" : ""}. Inserted rows are not rolled back automatically.`,
      confirmLabel: "Import rows",
    }));
  }
  try {
    res.json(await oraImport(c, body));
  } catch (e) {
    // surface SQL errors (table exists, type mismatch, …) inline rather than as a 500
    res.json({ ok: false, created: false, inserted: 0, table: body.table, error: withNetworkHint(errMsg(e), c.host) });
  }
});

/* ---------------- Compile (Oracle PL/SQL) ---------------- */

/**
 * How each compilable type spells its ALTER, in one place.
 *
 * `REUSE SETTINGS` only where the grammar allows it (views, materialized views and
 * synonyms have no such clause). It matters for a *batch*: without it, recompiling a
 * schema silently re-stamps every object with the current session's PLSQL_OPTIMIZE_LEVEL
 * / PLSQL_CODE_TYPE / PLScope settings. The user asked to fix validity, not to change
 * compiler settings, so the batch keeps each object's own.
 */
const ORA_COMPILE_FORM: Record<string, { verb: string; body?: boolean; reuse: boolean }> = {
  TYPE: { verb: "TYPE", reuse: true },
  PACKAGE: { verb: "PACKAGE", reuse: true },
  VIEW: { verb: "VIEW", reuse: false },
  "MATERIALIZED VIEW": { verb: "MATERIALIZED VIEW", reuse: false },
  FUNCTION: { verb: "FUNCTION", reuse: true },
  PROCEDURE: { verb: "PROCEDURE", reuse: true },
  "TYPE BODY": { verb: "TYPE", body: true, reuse: true },
  "PACKAGE BODY": { verb: "PACKAGE", body: true, reuse: true },
  TRIGGER: { verb: "TRIGGER", reuse: true },
  SYNONYM: { verb: "SYNONYM", reuse: false },
};

/**
 * Compile order: interfaces before the things that implement them, and the objects that
 * depend on everything (triggers, synonyms) last. Not a dependency graph — see
 * oraCompileInvalid, which simply runs more passes until nothing improves. That beats a
 * topological sort here because spec↔body dependencies are legitimately cyclic.
 */
const ORA_COMPILE_RANK = [
  "TYPE", "PACKAGE", "VIEW", "MATERIALIZED VIEW", "FUNCTION",
  "PROCEDURE", "TYPE BODY", "PACKAGE BODY", "TRIGGER", "SYNONYM",
];

const COMPILABLE_TYPES = new Set(Object.keys(ORA_COMPILE_FORM));

/** The one place an ALTER … COMPILE statement is built. Names are always quoted, so a
 *  lowercase or otherwise unusual identifier out of the dictionary compiles as itself. */
function oraCompileStmt(name: string, type: string, reuseSettings = false): string {
  const f = ORA_COMPILE_FORM[type];
  if (!f) throw new Error(`Type ${type} cannot be compiled.`);
  return (
    `ALTER ${f.verb} ${oraQuotedIdent(name)} COMPILE` +
    (f.body ? " BODY" : "") +
    (reuseSettings && f.reuse ? " REUSE SETTINGS" : "")
  );
}

interface CompileResult {
  name: string;
  type: string;
  status: string; // VALID | INVALID | UNKNOWN
  errors: { line: number; position: number; text: string; attribute: string }[];
}

/** ALTER … COMPILE an object and report the resulting status + user_errors. */
async function oraCompile(c: LiveConnection, name: string, type: string): Promise<CompileResult> {
  const stmt = oraCompileStmt(name, type);
  const conn = await getOraConn(c);
  try {
    try {
      await conn.execute(stmt);
    } catch {
      /* ALTER … COMPILE normally succeeds even with errors; a hard failure still lets us report status below */
    }
    const st = await oraRows(conn, `SELECT status FROM user_objects WHERE object_name = :n AND object_type = :t`, { n: name, t: type });
    const errs = await oraRows(
      conn,
      `SELECT line, position, text, attribute FROM user_errors WHERE name = :n AND type = :t ORDER BY sequence`,
      { n: name, t: type }
    );
    return {
      name,
      type,
      status: st.length ? String(st[0].STATUS) : "UNKNOWN",
      errors: errs.map((e) => ({
        line: Number(e.LINE) || 0,
        position: Number(e.POSITION) || 0,
        text: String(e.TEXT ?? ""),
        attribute: String(e.ATTRIBUTE ?? "ERROR"),
      })),
    };
  } finally {
    await conn.close();
  }
}

/** Compile a PL/SQL object (Oracle only): body { name, type } */
app.post("/api/connections/:id/compile", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.readOnly) return res.status(400).json({ error: "This connection is read-only — ALTER … COMPILE is blocked." });
  const name = String(req.body?.name ?? "").trim().toUpperCase();
  const type = String(req.body?.type ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_$#]+$/.test(name)) return res.status(400).json({ error: "Invalid object name." });
  if (!COMPILABLE_TYPES.has(type)) return res.status(400).json({ error: `Type ${type || "(empty)"} cannot be compiled.` });
  // Backstop for the editor's read-only gate: recompiling a dictionary object (SYS.STANDARD
  // and friends) can leave the instance unusable, so the editor path refuses outright.
  // The worksheet is still available for a DBA who really means it — that route makes the
  // statement explicit and still goes through the write guard.
  try {
    const oconn = await getOraConn(c);
    try {
      if (await oraUserIsSystem(c, oconn)) {
        return res.status(400).json({
          error: `${c.user.toUpperCase()} is an Oracle-maintained schema — compiling its objects from the editor is blocked. Run the statement from the worksheet if you really intend to.`,
        });
      }
    } finally {
      await oconn.close();
    }
  } catch (e) {
    return res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
  if (!acknowledged(req)) {
    return confirmRequired(res, describeOperation({
      level: "write",
      verb: "COMPILE",
      target: name,
      title: `Compile ${type} ${name}?`,
      body: `ALTER ${type} ${name} COMPILE runs against "${c.name}". Recompiling can invalidate dependent objects until they are recompiled too.`,
      confirmLabel: "Compile",
    }));
  }
  try {
    res.json(await oraCompile(c, name, type));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/* ---------------- Compile invalid objects (schema / group / one object) ----------------
 * The tree already shows what is broken (red icons, "N invalid" per group). This is the
 * other half: fixing it without opening every object by hand.
 */

const COMPILE_MAX_OBJECTS = 500;
const COMPILE_MAX_PASSES = 3;
const COMPILE_BUDGET_MS = 120_000;
const COMPILE_DDL_LOCK_S = 10;

type CompileScope = "schema" | "group" | "object";
type CompileScopeRef =
  | { scope: "schema" }
  | { scope: "group"; group: string }
  | { scope: "object"; name: string };

/** One object to compile, with the tree group it lives in (so the UI can refresh just that group). */
interface CompileTarget { name: string; type: string; group: string }
interface CompileSkipped { name: string; type: string; group: string; reason: string }

interface InvalidReport {
  scope: CompileScope;
  scopeLabel: string;
  targets: CompileTarget[];
  skipped: CompileSkipped[];
  breakdown: { type: string; count: number }[];
  total: number;
  cap: number;
  overCap: boolean;
  readOnly: boolean;
  systemSchema: boolean;
  checkedAt: string;
}

interface CompileObjectResult {
  name: string;
  type: string;
  group: string;
  status: string; // VALID | INVALID | UNKNOWN
  attempts: number;
  errors: { line: number; position: number; text: string; attribute: string }[];
  /** the ORA-… the ALTER itself raised, when user_errors has nothing to say (lock timeout, dropped mid-run) */
  error?: string;
}

interface CompileBatchResult {
  scope: CompileScope;
  scopeLabel: string;
  passes: number;
  attempted: number;
  compiled: number;
  stillInvalid: number;
  /** invalid at the end but not in the original target set — compiling invalidates dependents */
  newlyInvalid: number;
  results: CompileObjectResult[];
  skipped: CompileSkipped[];
  groups: string[];
  timedOut: boolean;
  elapsedMs: number;
  note?: string;
}

const compileKey = (t: { name: string; type: string }) => `${t.type} ${t.name}`;

/** Which tree group an object type is shown under (Views is a pseudo-group, not in ORA_OBJ_GROUPS). */
function oraGroupLabelFor(type: string): string {
  if (type === "VIEW") return "Views";
  const g = ORA_OBJ_GROUPS.find((x) => x.type === type || x.bodyType === type);
  return g?.label ?? "Other";
}

/** Object types a group covers, for group-scoped enumeration. */
function oraGroupTypes(label: string): string[] | null {
  if (label === "Views") return ["VIEW"];
  const g = ORA_OBJ_GROUPS.find((x) => x.label === label);
  if (!g) return null;
  return g.bodyType ? [g.type, g.bodyType] : [g.type];
}

const compileRank = (type: string) => {
  const i = ORA_COMPILE_RANK.indexOf(type);
  return i === -1 ? ORA_COMPILE_RANK.length : i;
};

/** Rows as plain objects, WITHOUT oraRows' error swallowing: a privilege error here would
 *  otherwise read as "nothing is invalid", which is the one answer we must never invent. */
async function oraExecRows(conn: oracledb.Connection, sql: string, binds: Record<string, unknown> = {}) {
  const r = await conn.execute<Record<string, unknown>>(sql, binds as oracledb.BindParameters, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return r.rows ?? [];
}

const ORA_INVALID_FULL = `SELECT object_type, object_name FROM user_objects
   WHERE status = 'INVALID' AND object_name NOT LIKE 'BIN$%'`;

/** Every compilable part of one named object, whatever its status (see the object scope). */
const ORA_OBJECT_PARTS = `SELECT object_type, object_name, status FROM user_objects
   WHERE object_name = :n AND object_name NOT LIKE 'BIN$%'
     AND object_type IN ('TYPE','TYPE BODY','PACKAGE','PACKAGE BODY','VIEW',
                         'MATERIALIZED VIEW','FUNCTION','PROCEDURE','TRIGGER','SYNONYM')`;

function skipReason(type: string): string {
  if (type === "INDEX")
    return "UNUSABLE index — rebuild it from the Table Designer (Storage → Rebuild); a compile cannot fix it.";
  return `Oracle has no ALTER … COMPILE for ${type} — fix it from the worksheet.`;
}

/**
 * What a scope would compile. Reads the dictionary; changes nothing.
 *
 * Schema and group scopes take only INVALID objects — a mass "recompile everything" is a
 * foot-gun that invalidates dependents for minutes. Object scope takes every compilable
 * part of the named object regardless of status, because the user pointed at that one
 * thing and forcing a recompile is exactly what SQL Developer's Compile does.
 */
async function oraInvalidTargets(
  conn: oracledb.Connection,
  ref: CompileScopeRef
): Promise<{ targets: CompileTarget[]; skipped: CompileSkipped[] }> {
  const targets: CompileTarget[] = [];
  const skipped: CompileSkipped[] = [];

  if (ref.scope === "object") {
    // exact case first, then the uppercase form: a schema can hold both "product_dv" and
    // PRODUCT_DV, and the dictionary spelling is what has to reach the ALTER
    let rows = await oraExecRows(conn, ORA_OBJECT_PARTS, { n: ref.name });
    if (!rows.length) rows = await oraExecRows(conn, ORA_OBJECT_PARTS, { n: ref.name.toUpperCase() });
    for (const r of rows) {
      const type = String(r.OBJECT_TYPE);
      const name = String(r.OBJECT_NAME);
      targets.push({ name, type, group: oraGroupLabelFor(type) });
    }
    if (!targets.length) {
      // it may exist but not be compilable — say which, instead of "nothing found"
      const other = await oraExecRows(conn, `SELECT object_type, object_name FROM user_objects WHERE object_name IN (:n, :u)`, {
        n: ref.name,
        u: ref.name.toUpperCase(),
      });
      for (const r of other) {
        const type = String(r.OBJECT_TYPE);
        skipped.push({ name: String(r.OBJECT_NAME), type, group: oraGroupLabelFor(type), reason: skipReason(type) });
      }
    }
  } else {
    const wanted = ref.scope === "group" ? oraGroupTypes(ref.group) : null;
    const rows = await oraExecRows(conn, ORA_INVALID_FULL);
    for (const r of rows) {
      const type = String(r.OBJECT_TYPE);
      const name = String(r.OBJECT_NAME);
      if (wanted && !wanted.includes(type)) continue;
      const group = oraGroupLabelFor(type);
      if (ORA_COMPILE_FORM[type]) targets.push({ name, type, group });
      else skipped.push({ name, type, group, reason: skipReason(type) });
    }
    // UNUSABLE indexes are "invalid" in the tree but live in a different dictionary view,
    // and a compile is not what fixes them — list them so the counts still reconcile
    if (ref.scope === "schema" || (ref.scope === "group" && ref.group === "Indexes")) {
      const idx = await oraRows(conn, ORA_UNUSABLE_INDEXES);
      for (const r of idx) {
        const name = String(r.INDEX_NAME);
        skipped.push({ name, type: "INDEX", group: "Indexes", reason: skipReason("INDEX") });
      }
    }
  }

  targets.sort((a, b) => compileRank(a.type) - compileRank(b.type) || a.name.localeCompare(b.name));
  skipped.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { targets, skipped };
}

const scopeLabelOf = (c: LiveConnection, ref: CompileScopeRef) =>
  ref.scope === "schema" ? `${c.user.toUpperCase()} schema` : ref.scope === "group" ? ref.group : ref.name;

const compileBreakdown = (targets: CompileTarget[]) => {
  const m = new Map<string, number>();
  for (const t of targets) m.set(t.type, (m.get(t.type) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => compileRank(a[0]) - compileRank(b[0]))
    .map(([type, count]) => ({ type, count }));
};

const breakdownText = (b: { type: string; count: number }[]) => b.map((x) => `${x.count} ${x.type}`).join(", ");

/** Run the compile. One pooled connection for the whole batch, like oraApplyTableDdl. */
async function oraCompileInvalid(c: LiveConnection, ref: CompileScopeRef): Promise<CompileBatchResult> {
  const t0 = Date.now();
  const conn = await getOraConn(c);
  try {
    // Without this, a single object someone else is *running* holds a library-cache lock
    // and the ALTER waits forever — one busy package would eat the whole time budget.
    await conn.execute(`ALTER SESSION SET ddl_lock_timeout = ${COMPILE_DDL_LOCK_S}`).catch(() => {});

    const { targets, skipped } = await oraInvalidTargets(conn, ref);
    const scopeLabel = scopeLabelOf(c, ref);
    // Baseline for "did *this run* break something": everything already invalid anywhere in
    // the schema, not just this scope's targets. Comparing against the targets alone would
    // report a group scope's untouched neighbours as collateral damage from the run.
    const invalidBefore = new Set(
      (await oraExecRows(conn, ORA_INVALID_FULL)).map((r) => `${String(r.OBJECT_TYPE)} ${String(r.OBJECT_NAME)}`)
    );
    const attempts = new Map<string, number>();
    const lastErr = new Map<string, string>();
    let remaining = targets;
    let passes = 0;
    let timedOut = false;

    while (remaining.length && passes < COMPILE_MAX_PASSES) {
      passes++;
      for (const t of remaining) {
        if (Date.now() - t0 > COMPILE_BUDGET_MS) { timedOut = true; break; }
        const k = compileKey(t);
        attempts.set(k, (attempts.get(k) ?? 0) + 1);
        try {
          await conn.execute(oraCompileStmt(t.name, t.type, true));
          lastErr.delete(k);
        } catch (e) {
          // ALTER … COMPILE reports "compiled with errors" as a throw; the real verdict is
          // the object's status, read below. A genuine failure (ORA-04021 lock timeout,
          // ORA-04043 dropped mid-run) is kept for the rows user_errors says nothing about.
          lastErr.set(k, errMsg(e));
        }
      }
      const invalidNow = new Set((await oraExecRows(conn, ORA_INVALID_FULL)).map((r) => `${String(r.OBJECT_TYPE)} ${String(r.OBJECT_NAME)}`));
      const next = remaining.filter((t) => invalidNow.has(compileKey(t)));
      // a pass that fixed nothing will not do better on the next one — the rest is
      // genuinely broken, not an ordering artefact
      const noProgress = next.length === remaining.length;
      remaining = next;
      if (timedOut || noProgress) break;
    }

    const invalidEnd = new Set((await oraExecRows(conn, ORA_INVALID_FULL)).map((r) => `${String(r.OBJECT_TYPE)} ${String(r.OBJECT_NAME)}`));
    const errorRows = invalidEnd.size
      ? await oraRows(conn, `SELECT name, type, line, position, text, attribute FROM user_errors ORDER BY name, type, sequence FETCH FIRST 2000 ROWS ONLY`)
      : [];
    const errorsByKey = new Map<string, CompileObjectResult["errors"]>();
    for (const e of errorRows) {
      const k = `${String(e.TYPE)} ${String(e.NAME)}`;
      const list = errorsByKey.get(k) ?? [];
      if (list.length < 10) {
        list.push({
          line: Number(e.LINE) || 0,
          position: Number(e.POSITION) || 0,
          text: String(e.TEXT ?? ""),
          attribute: String(e.ATTRIBUTE ?? "ERROR"),
        });
      }
      errorsByKey.set(k, list);
    }

    const results: CompileObjectResult[] = targets.map((t) => {
      const k = compileKey(t);
      const invalid = invalidEnd.has(k);
      const err = lastErr.get(k);
      return {
        name: t.name,
        type: t.type,
        group: t.group,
        // an object that vanished mid-run is neither valid nor invalid — say UNKNOWN
        status: invalid ? "INVALID" : err && /ORA-04043/.test(err) ? "UNKNOWN" : "VALID",
        attempts: attempts.get(k) ?? 0,
        errors: invalid ? errorsByKey.get(k) ?? [] : [],
        ...(invalid && !(errorsByKey.get(k) ?? []).length && err ? { error: err } : {}),
        ...(!invalid && err && /ORA-04043/.test(err) ? { error: err } : {}),
      };
    });
    results.sort((a, b) => Number(b.status === "INVALID") - Number(a.status === "INVALID") || compileRank(a.type) - compileRank(b.type) || a.name.localeCompare(b.name));

    const stillInvalid = results.filter((r) => r.status === "INVALID").length;
    let newlyInvalid = 0;
    for (const k of invalidEnd) if (!invalidBefore.has(k)) newlyInvalid++;

    return {
      scope: ref.scope,
      scopeLabel,
      passes,
      attempted: targets.length,
      compiled: results.filter((r) => r.status === "VALID").length,
      stillInvalid,
      newlyInvalid,
      results,
      skipped,
      groups: [...new Set(targets.map((t) => t.group))],
      timedOut,
      elapsedMs: Date.now() - t0,
      ...(targets.length ? {} : { note: `Nothing to compile — the dictionary reports no invalid objects in ${scopeLabel}.` }),
    };
  } finally {
    await conn.close();
  }
}

/** Parse + validate the scope of a compile request from a query string or a body. */
function readCompileScope(src: Record<string, unknown>): { ref: CompileScopeRef } | { error: string } {
  const scope = String(src.scope ?? "").trim() || "schema";
  if (scope === "schema") return { ref: { scope: "schema" } };
  if (scope === "group") {
    const group = String(src.group ?? "").trim();
    if (!group) return { error: "Missing group label (?group=…)." };
    if (!oraGroupTypes(group)) return { error: `"${group}" is not a schema group on this connection.` };
    return { ref: { scope: "group", group } };
  }
  if (scope === "object") {
    const name = String(src.name ?? "").trim();
    if (!name) return { error: "Missing object name (?name=…)." };
    if (name.length > 128) return { error: "Object name is too long." };
    return { ref: { scope: "object", name } };
  }
  return { error: `Unknown scope "${scope}" — use schema, group or object.` };
}

/** Preflight: what would be compiled, and what cannot be. A read — never blocked, so the
 *  UI can disable its button with the real reason instead of guessing. */
app.get("/api/connections/:id/compile/invalid", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const parsed = readCompileScope(req.query as Record<string, unknown>);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });
  try {
    const conn = await getOraConn(c);
    try {
      const systemSchema = await oraUserIsSystem(c, conn);
      const { targets, skipped } = await oraInvalidTargets(conn, parsed.ref);
      const report: InvalidReport = {
        scope: parsed.ref.scope,
        scopeLabel: scopeLabelOf(c, parsed.ref),
        targets,
        skipped,
        breakdown: compileBreakdown(targets),
        total: targets.length,
        cap: COMPILE_MAX_OBJECTS,
        overCap: targets.length > COMPILE_MAX_OBJECTS,
        readOnly: !!c.readOnly,
        systemSchema,
        checkedAt: new Date().toISOString(),
      };
      res.json(report);
    } finally {
      await conn.close();
    }
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Compile the invalid objects of a scope: body { scope, group?|name?, confirm? } */
app.post("/api/connections/:id/compile/invalid", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.readOnly) return res.status(400).json({ error: "This connection is read-only — ALTER … COMPILE is blocked." });
  const parsed = readCompileScope((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });
  const ref = parsed.ref;

  let targets: CompileTarget[];
  try {
    const conn = await getOraConn(c);
    try {
      if (await oraUserIsSystem(c, conn)) {
        return res.status(400).json({
          error: `${c.user.toUpperCase()} is an Oracle-maintained schema — compiling its objects from here is blocked. Run the statements from the worksheet if you really intend to.`,
        });
      }
      targets = (await oraInvalidTargets(conn, ref)).targets;
    } finally {
      await conn.close();
    }
  } catch (e) {
    return res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }

  const scopeLabel = scopeLabelOf(c, ref);
  // Nothing to do is not something to confirm: the guard exists to describe real changes,
  // so an empty scope answers 200 and the UI shows its empty state — no dialog at all.
  if (!targets.length) {
    return res.json({
      scope: ref.scope, scopeLabel, passes: 0, attempted: 0, compiled: 0, stillInvalid: 0, newlyInvalid: 0,
      results: [], skipped: [], groups: [], timedOut: false, elapsedMs: 0,
      note: `Nothing to compile — the dictionary reports no invalid objects in ${scopeLabel}.`,
    } satisfies CompileBatchResult);
  }
  if (targets.length > COMPILE_MAX_OBJECTS) {
    return res.status(400).json({
      error: `${targets.length} invalid object(s) is more than this tool compiles in one request (cap ${COMPILE_MAX_OBJECTS}). Run BEGIN DBMS_UTILITY.COMPILE_SCHEMA(USER, compile_all => FALSE); END; from the worksheet instead.`,
    });
  }

  if (!acknowledged(req)) {
    const breakdown = breakdownText(compileBreakdown(targets));
    const tail =
      "Compiling takes a library-cache lock on each object, so sessions using them wait, and objects that depend on the ones being compiled can go INVALID until they are recompiled too. Nothing is dropped and no data changes.";
    if (ref.scope === "object") {
      const stmts = targets.map((t) => oraCompileStmt(t.name, t.type, true));
      return confirmRequired(res, describeOperation({
        level: "write",
        verb: "COMPILE",
        target: targets[0].name,
        title: targets.length > 1 ? `Compile ${targets[0].name} (spec and body)?` : `Compile ${targets[0].type} ${targets[0].name}?`,
        body: `${stmts.join(" and ")} will run against "${c.name}". The stored source is not changed — this only recompiles what is already in the database. ${tail}`,
        confirmLabel: "Compile",
      }));
    }
    // Packages and types are two objects wearing one name in the tree; the dialog is where
    // that gets corrected, because it decides what the user is actually approving.
    const bodies = targets.filter((t) => t.type.endsWith(" BODY")).length;
    const bodyNote = bodies ? ` Spec and body are separate objects — ${bodies === 1 ? "one of these is a body" : `${bodies} of these are bodies`}.` : "";
    return confirmRequired(res, describeOperation({
      level: "write",
      verb: "COMPILE",
      target: scopeLabel,
      title: `Compile ${targets.length} invalid object(s) in ${scopeLabel}?`,
      body: `ALTER … COMPILE will run against ${targets.length} invalid object(s) in ${scopeLabel} on "${c.name}" (${breakdown}), in dependency order and up to ${COMPILE_MAX_PASSES} passes.${bodyNote} ${tail}`,
      confirmLabel: `Compile ${targets.length} object(s)`,
      danger: ref.scope === "schema",
    }));
  }

  try {
    res.json(await oraCompileInvalid(c, ref));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Real source/DDL of one object, for the Object Editor: ?name= */
app.get("/api/connections/:id/source", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const name = String(req.query.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Missing object name (?name=...)" });
  // ?type= disambiguates two objects whose names differ only in case (a lowercase
  // synonym next to an uppercase view, as 23ai duality views produce)
  const type = String(req.query.type ?? "").trim() || undefined;
  try {
    res.json(await oraObjectSource(c, name, type));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/* ---------------- Routine runner (Oracle): run procedures/functions with typed binds ----------------
 * SQL Developer-style "Run": the signature comes from user_arguments, values are BOUND
 * (never concatenated — identifiers come from the dictionary, values from the client),
 * DBMS_OUTPUT is captured on the same session, and REF CURSOR outputs are fetched as grids.
 */

type RoutineBindKind = "number" | "string" | "date" | "boolean" | "cursor";

/** user_arguments data types we can bind directly. Anything else (records, PL/SQL tables,
 *  object types, RAW…) is still listed but not runnable — honesty over a wrong guess. */
const ROUTINE_BIND_KINDS: Record<string, RoutineBindKind> = {
  NUMBER: "number", FLOAT: "number", BINARY_INTEGER: "number", PLS_INTEGER: "number",
  BINARY_FLOAT: "number", BINARY_DOUBLE: "number",
  VARCHAR2: "string", CHAR: "string", NVARCHAR2: "string", NCHAR: "string", CLOB: "string",
  DATE: "date", TIMESTAMP: "date",
  "TIMESTAMP WITH TIME ZONE": "date", "TIMESTAMP WITH LOCAL TIME ZONE": "date",
  "PL/SQL BOOLEAN": "boolean", BOOLEAN: "boolean",
  "REF CURSOR": "cursor",
};

interface RoutineParam {
  name: string;
  position: number;
  dataType: string;
  direction: "IN" | "OUT" | "IN/OUT";
  hasDefault: boolean;
  /** null = we cannot bind this type; the UI disables Run and says why */
  bindKind: RoutineBindKind | null;
  /** how to DECLARE this parameter in a hand-written block (the UI's block generator) */
  declType: string;
}

interface RoutineMember {
  name: string;
  kind: "PROCEDURE" | "FUNCTION";
  overload: string | null;
  params: RoutineParam[];
  returnType: string | null;
  returnBindKind: RoutineBindKind | null;
  returnDeclType: string | null;
}

/** A type a local variable can actually be declared as, for the editable PL/SQL block.
 *  Scalars keep their dictionary name (with the length PL/SQL requires); composite,
 *  object and collection types are rebuilt from type_owner.type_name.type_subname —
 *  which is exactly what makes a record/collection parameter runnable by hand. */
function routineDeclType(
  dt: string | null,
  owner: string | null,
  typeName: string | null,
  subName: string | null,
  schema: string
): string {
  const named = () =>
    [owner && owner.toUpperCase() !== schema.toUpperCase() ? owner : null, typeName, subName].filter(Boolean).join(".");
  if (!dt) return typeName ? named() : "VARCHAR2(32767)";
  if (dt === "REF CURSOR") return "SYS_REFCURSOR";
  if (dt === "PL/SQL BOOLEAN" || dt === "BOOLEAN") return "BOOLEAN";
  if (["VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR", "LONG"].includes(dt)) return "VARCHAR2(32767)";
  if (dt === "RAW") return "RAW(32767)";
  // records, collections and object types are only declarable through their own name
  if (!ROUTINE_BIND_KINDS[dt] && typeName) return named();
  return dt;
}

interface RoutineMeta {
  name: string;
  type: "PROCEDURE" | "FUNCTION" | "PACKAGE";
  members: RoutineMember[];
  error?: string;
}

async function oraRoutineMeta(c: LiveConnection, rawName: string): Promise<RoutineMeta> {
  const conn = await getOraConn(c);
  try {
    // case-sensitive first (quoted lowercase objects are real), same as oraObjectSource
    const hits = await oraRows(
      conn,
      `SELECT object_name, object_type FROM user_objects
       WHERE object_name IN (:nexact, :nupper)
         AND object_type IN ('PROCEDURE','FUNCTION','PACKAGE')
       ORDER BY CASE WHEN object_name = :nexact2 THEN 0 ELSE 1 END`,
      { nexact: rawName, nupper: rawName.toUpperCase(), nexact2: rawName }
    );
    if (!hits.length) {
      return { name: rawName, type: "PROCEDURE", members: [], error: `${rawName} is not a procedure, function or package in this schema.` };
    }
    const name = String(hits[0].OBJECT_NAME);
    const type = String(hits[0].OBJECT_TYPE) as RoutineMeta["type"];
    const isPkg = type === "PACKAGE";

    // data_level 0 = the argument itself (higher levels describe record/collection internals)
    const argRows = await oraRows(
      conn,
      isPkg
        ? `SELECT object_name, overload, argument_name, position, data_type, type_owner, type_name, type_subname, in_out, defaulted
             FROM user_arguments WHERE package_name = :n AND data_level = 0
            ORDER BY object_name, overload, position, sequence`
        : `SELECT object_name, overload, argument_name, position, data_type, type_owner, type_name, type_subname, in_out, defaulted
             FROM user_arguments WHERE object_name = :n AND package_name IS NULL AND data_level = 0
            ORDER BY overload, position, sequence`,
      { n: name }
    );
    // a zero-argument member has no user_arguments rows on recent versions — user_procedures still lists it
    const memberRows = isPkg
      ? await oraRows(conn, `SELECT procedure_name, overload FROM user_procedures WHERE object_name = :n AND procedure_name IS NOT NULL ORDER BY subprogram_id`, { n: name })
      : [];

    const members = new Map<string, RoutineMember>();
    const ensure = (mName: string, overload: string | null): RoutineMember => {
      const k = `${mName}|${overload ?? ""}`;
      let m = members.get(k);
      if (!m) {
        m = { name: mName, kind: "PROCEDURE", overload, params: [], returnType: null, returnBindKind: null, returnDeclType: null };
        members.set(k, m);
      }
      return m;
    };
    for (const r of memberRows) ensure(String(r.PROCEDURE_NAME), r.OVERLOAD == null ? null : String(r.OVERLOAD));
    for (const r of argRows) {
      const m = ensure(isPkg ? String(r.OBJECT_NAME) : name, r.OVERLOAD == null ? null : String(r.OVERLOAD));
      const dt = r.DATA_TYPE == null ? null : String(r.DATA_TYPE);
      const direction = String(r.IN_OUT ?? "IN").toUpperCase() as RoutineParam["direction"];
      // a cursor can only come OUT of a call through a bind; IN/IN OUT ref cursors stay unsupported
      let bindKind = dt ? ROUTINE_BIND_KINDS[dt] ?? null : null;
      if (bindKind === "cursor" && direction !== "OUT") bindKind = null;
      const str = (v: unknown) => (v == null ? null : String(v));
      // name the composite type in the display (e.g. "OBJECT (T_ADDRESS)") when we can't bind it.
      // TYPE_NAME alone is the *package* for a package-level record, so the subname has to come
      // with it — "PL/SQL RECORD (PKG_INVENTORY_LAB.T_STOCK_LINE)" is what the user must declare.
      const composite = [str(r.TYPE_NAME), str(r.TYPE_SUBNAME)].filter(Boolean).join(".");
      const display = dt && !bindKind && composite ? `${dt} (${composite})` : dt ?? "UNKNOWN";
      const declType = routineDeclType(dt, str(r.TYPE_OWNER), str(r.TYPE_NAME), str(r.TYPE_SUBNAME), c.user);
      if (Number(r.POSITION) === 0) {
        // position 0 = the function's return value
        m.kind = "FUNCTION";
        m.returnType = display;
        m.returnBindKind = dt ? ROUTINE_BIND_KINDS[dt] ?? null : null;
        m.returnDeclType = declType;
        continue;
      }
      if (r.ARGUMENT_NAME == null && dt == null) continue; // old-style "no arguments" placeholder row
      m.params.push({
        name: String(r.ARGUMENT_NAME ?? `P${r.POSITION}`),
        position: Number(r.POSITION),
        dataType: display,
        direction,
        hasDefault: String(r.DEFAULTED ?? "N") === "Y",
        bindKind,
        declType,
      });
    }
    // standalone routine with zero arguments and zero dictionary rows: synthesize its one member
    if (!isPkg && !members.size) ensure(name, null);
    if (!isPkg && type === "FUNCTION") for (const m of members.values()) m.kind = "FUNCTION";
    return { name, type, members: [...members.values()] };
  } finally {
    await conn.close();
  }
}

interface RoutineArgInput { name: string; value: string | null; useDefault?: boolean }
interface RoutineRunBody {
  name: string;
  member?: string;
  overload?: string | null;
  args: RoutineArgInput[];
  /** hand-written anonymous block to run instead of the generated call (SQL Developer's
   *  "Run PL/SQL" dialog: the block is editable and IS what executes) */
  block?: string;
}

const ROUTINE_CURSOR_MAX = 100;
const ROUTINE_OUTPUT_MAX_LINES = 1000;
const ROUTINE_BLOCK_MAX = 64_000;
const ROUTINE_BLOCK_MAX_BINDS = 32;

function readRoutineRunBody(body: unknown): { body: RoutineRunBody } | { error: string } {
  const b = body as Partial<RoutineRunBody> | undefined;
  if (!b || typeof b !== "object") return { error: "Malformed payload — expected a JSON object." };
  if (typeof b.name !== "string" || !b.name.trim()) return { error: "Missing routine name." };
  if (b.member !== undefined && typeof b.member !== "string") return { error: "member must be a string (the package member to run)." };
  if (b.overload !== undefined && b.overload !== null && typeof b.overload !== "string") return { error: "overload must be a string or null." };
  let block: string | undefined;
  if (b.block !== undefined) {
    if (typeof b.block !== "string") return { error: "block must be a string (the PL/SQL block to run)." };
    block = b.block.replace(/\r\n/g, "\n").trim();
    // a lone trailing slash is SQL*Plus's terminator, not part of the block
    block = block.replace(/\n\s*\/$/, "").trimEnd();
    if (!block) return { error: "block is empty — write a PL/SQL block or omit it to run with the parameter form." };
    if (block.length > ROUTINE_BLOCK_MAX) return { error: `block is too large (${block.length} chars, limit ${ROUTINE_BLOCK_MAX}).` };
    // Anonymous blocks only: DDL routed through here would bypass /query and therefore
    // the automatic code versioning, so CREATE OR REPLACE stays where history is captured.
    if (!/^(declare|begin|<<)/i.test(block))
      return { error: "block must be an anonymous PL/SQL block (DECLARE … BEGIN … END; or BEGIN … END;). Run standalone statements from the worksheet." };
  }
  // args stay mandatory for the parameter form (a missing array is a caller bug worth
  // reporting); a hand-written block carries its values in its own text
  if (!Array.isArray(b.args) && !(block && b.args === undefined))
    return { error: "args must be an array of { name, value, useDefault? }." };
  const args: RoutineArgInput[] = [];
  for (let i = 0; i < (b.args?.length ?? 0); i++) {
    const a = b.args![i] as Partial<RoutineArgInput> | undefined;
    if (!a || typeof a !== "object" || typeof a.name !== "string" || !a.name.trim())
      return { error: `args[${i}] must be { name: string, value: string | null, useDefault?: boolean }.` };
    if (a.value !== undefined && a.value !== null && typeof a.value !== "string")
      return { error: `args[${i}].value must be a string or null (the UI sends every value as text; the server converts by the declared type).` };
    args.push({ name: a.name, value: a.value ?? null, useDefault: a.useDefault === true });
  }
  return { body: { name: b.name.trim(), member: b.member?.trim() || undefined, overload: b.overload ?? null, args, ...(block ? { block } : {}) } };
}

/** Bind placeholders used by a hand-written block, ignoring anything inside string
 *  literals or comments (`'a:b'` and `-- :x` are text, not binds). First spelling wins:
 *  Oracle bind names are case-insensitive, so `:x` and `:X` are one placeholder. */
function plsqlBindNames(src: string): string[] {
  let bare = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] !== "'") j++;
        else if (src[j + 1] === "'") j += 2;
        else break;
      }
      const end = Math.min(j, src.length - 1); // closing quote, or the last char if unterminated
      bare += " ".repeat(end - i + 1);
      i = end;
      continue;
    }
    if (ch === "-" && src[i + 1] === "-") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      bare += " ".repeat(end - i);
      i = end - 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      bare += " ".repeat(end - i);
      i = end - 1;
      continue;
    }
    bare += ch;
  }
  // uppercased: an unquoted bind name is case-insensitive to Oracle, so `:x` and `:X` are
  // one placeholder and the driver normalises the same way
  const names: string[] = [];
  const re = /:\s*([A-Za-z][A-Za-z0-9_$#]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare))) {
    const up = m[1].toUpperCase();
    if (!names.includes(up)) names.push(up);
  }
  return names;
}

/** "2026-07-24" or "2026-07-24 18:30[:00]" — parsed as local time, matching what a DBA types. */
function parseRoutineDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return isNaN(d.getTime()) ? null : d;
}

/** Convert the UI's text value to the JS value node-oracledb binds for this parameter. */
function routineBindValue(p: RoutineParam, raw: string | null): { val: unknown } | { error: string } {
  if (raw === null) return { val: null };
  switch (p.bindKind) {
    case "number": {
      const n = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(n)) return { error: `${p.name}: "${raw}" is not a valid number.` };
      return { val: n };
    }
    case "date": {
      const d = parseRoutineDate(raw.trim());
      if (!d) return { error: `${p.name}: "${raw}" is not a valid date — use YYYY-MM-DD or YYYY-MM-DD HH:MI:SS.` };
      return { val: d };
    }
    case "boolean": {
      const t = raw.trim().toLowerCase();
      if (["true", "t", "y", "yes", "1"].includes(t)) return { val: true };
      if (["false", "f", "n", "no", "0"].includes(t)) return { val: false };
      return { error: `${p.name}: "${raw}" is not a boolean — use true or false.` };
    }
    default:
      return { val: raw }; // string kinds bind as-is
  }
}

const oraBindType = (k: RoutineBindKind) =>
  k === "number" ? oracledb.NUMBER
  : k === "date" ? oracledb.DATE
  : k === "boolean" ? oracledb.DB_TYPE_BOOLEAN
  : k === "cursor" ? oracledb.CURSOR
  : oracledb.STRING;

/** Quoted identifiers cannot contain a double quote, so stripping is safe (belt & braces). */
const oraQuotedIdent = (name: string) => `"${String(name).replace(/"/g, "")}"`;

interface RoutineRunResult {
  ok: boolean;
  durationMs: number;
  /** the anonymous block that ran — shown in the UI so what executed is never a mystery */
  block: string;
  /** which path produced it: the parameter form's typed binds, or the user's own block */
  source: "form" | "block";
  member: string;
  returnValue?: string | number | null;
  outParams: { name: string; dataType: string; value: string | number | null }[];
  cursors: { name: string; columns: string[]; rows: (string | number | null)[][]; truncated: boolean }[];
  dbmsOutput: string[];
  dbmsOutputTruncated?: boolean;
  error: { message: string; code: string; helpUrl?: string } | null;
}

/** DBMS_OUTPUT is session state — this must run on the SAME connection as the call, and the
 *  buffer still holds whatever was printed before an error, so it is read even after one. */
async function readDbmsOutput(conn: oracledb.Connection): Promise<{ lines: string[]; truncated: boolean }> {
  try {
    const o = await conn.execute(`BEGIN DBMS_OUTPUT.GET_LINES(:lines, :n); END;`, {
      lines: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767, maxArraySize: ROUTINE_OUTPUT_MAX_LINES },
      n: { dir: oracledb.BIND_INOUT, type: oracledb.NUMBER, val: ROUTINE_OUTPUT_MAX_LINES },
    });
    const ob = o.outBinds as { lines?: (string | null)[]; n?: number };
    const nLines = Number(ob.n ?? 0);
    return { lines: (ob.lines ?? []).slice(0, nLines).map((l) => l ?? ""), truncated: nLines >= ROUTINE_OUTPUT_MAX_LINES };
  } catch {
    return { lines: [], truncated: false }; // output buffer unavailable — not fatal
  }
}

/** Drain one REF CURSOR bind into a grid; one row past the cap makes truncation detectable. */
async function readRoutineCursor(label: string, rsUnknown: unknown, into: RoutineRunResult["cursors"]): Promise<void> {
  const rs = rsUnknown as oracledb.ResultSet<unknown[]> | undefined;
  if (!rs || typeof rs.getRows !== "function") return;
  try {
    const raw = await rs.getRows(ROUTINE_CURSOR_MAX + 1);
    into.push({
      name: label,
      columns: (rs.metaData ?? []).map((m) => m.name),
      rows: raw.slice(0, ROUTINE_CURSOR_MAX).map((row) => (row as unknown[]).map(mapVal)),
      truncated: raw.length > ROUTINE_CURSOR_MAX,
    });
  } finally {
    try { await rs.close(); } catch { /* already drained */ }
  }
}

function routineExecError(e: unknown, host: string): NonNullable<RoutineRunResult["error"]> {
  const err = e as { errorNum?: number };
  const code = err.errorNum ? `ORA-${String(err.errorNum).padStart(5, "0")}` : "PLS-ERROR";
  const { message, helpUrl } = splitHelpUrl(withNetworkHint(errMsg(e), host));
  return { message, code, ...(helpUrl ? { helpUrl } : {}) };
}

/** PL/SQL BOOLEAN comes back as a JS boolean; everything else goes through the grid mapper. */
const plainBindValue = (v: unknown): string | number | null => (typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : mapVal(v));

const formatNames = (items: string[], limit = 12) =>
  items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")} (+${items.length - limit} more)`;

async function oraRoutineRun(
  c: LiveConnection,
  meta: RoutineMeta,
  member: RoutineMember,
  args: RoutineArgInput[]
): Promise<RoutineRunResult | { error: string }> {
  const isPkg = meta.type === "PACKAGE";
  const qname = isPkg ? `${oraQuotedIdent(meta.name)}.${oraQuotedIdent(member.name)}` : oraQuotedIdent(meta.name);
  const byName = new Map(args.map((a) => [a.name.toUpperCase(), a]));

  // Named notation throughout: parameters left to their declared DEFAULT are simply
  // omitted from the call, and typed binds let Oracle resolve overloads.
  const binds: Record<string, unknown> = {};
  const callArgs: string[] = [];
  const outOrder: { key: string; p: RoutineParam }[] = [];
  let bi = 0;
  for (const p of member.params) {
    const a = byName.get(p.name.toUpperCase());
    if ((a?.useDefault === true || !a) && p.hasDefault) continue; // PL/SQL applies the declared default
    const key = `b${bi++}`;
    callArgs.push(`${oraQuotedIdent(p.name)} => :${key}`);
    const kind = p.bindKind as RoutineBindKind; // validated non-null by the route
    const type = oraBindType(kind);
    const sized = kind === "string" ? { maxSize: 32767 } : {};
    if (p.direction === "IN") {
      const v = routineBindValue(p, a?.value ?? null);
      if ("error" in v) return { error: v.error };
      binds[key] = { dir: oracledb.BIND_IN, type, val: v.val };
    } else if (p.direction === "OUT") {
      binds[key] = { dir: oracledb.BIND_OUT, type, ...sized };
      outOrder.push({ key, p });
    } else {
      const v = routineBindValue(p, a?.value ?? null);
      if ("error" in v) return { error: v.error };
      binds[key] = { dir: oracledb.BIND_INOUT, type, val: v.val, ...sized };
      outOrder.push({ key, p });
    }
  }
  if (member.kind === "FUNCTION") {
    const rk = member.returnBindKind as RoutineBindKind;
    binds.ret = { dir: oracledb.BIND_OUT, type: oraBindType(rk), ...(rk === "string" ? { maxSize: 32767 } : {}) };
  }

  const call = `${qname}${callArgs.length ? `(${callArgs.join(", ")})` : ""}`;
  const block = [
    "BEGIN",
    "  DBMS_OUTPUT.ENABLE(NULL);",
    member.kind === "FUNCTION" ? `  :ret := ${call};` : `  ${call};`,
    "END;",
  ].join("\n");

  const conn = await getOraConn(c);
  const started = Date.now();
  try {
    let execErr: RoutineRunResult["error"] = null;
    let outBinds: Record<string, unknown> = {};
    try {
      // autoCommit like every other write path (/query included — the status bar says
      // "Autocommit on"). Without it the connection is released with the transaction open,
      // which rolls back any routine that doesn't COMMIT itself: PLACE_ORDER would hand
      // back a real order_id for a row that no longer exists. Silently discarding work the
      // user explicitly confirmed isn't safer, just untrue.
      const r = await conn.execute(block, binds as oracledb.BindParameters, { outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: true });
      outBinds = (r.outBinds ?? {}) as Record<string, unknown>;
    } catch (e) {
      execErr = routineExecError(e, c.host);
      // A failed block leaves no committed work (autoCommit only fires on success), but the
      // connection goes back to the pool — roll back explicitly so nothing dangles on it.
      try { await conn.rollback(); } catch { /* nothing open */ }
    }

    const output = await readDbmsOutput(conn);
    const outParams: RoutineRunResult["outParams"] = [];
    const cursors: RoutineRunResult["cursors"] = [];
    let returnValue: string | number | null | undefined;
    if (!execErr) {
      for (const { key, p } of outOrder) {
        if (p.bindKind === "cursor") await readRoutineCursor(p.name, outBinds[key], cursors);
        else outParams.push({ name: p.name, dataType: p.dataType, value: plainBindValue(outBinds[key]) });
      }
      if (member.kind === "FUNCTION") {
        if (member.returnBindKind === "cursor") await readRoutineCursor("RETURN", outBinds.ret, cursors);
        else returnValue = plainBindValue(outBinds.ret);
      }
    }

    return {
      ok: !execErr,
      durationMs: Date.now() - started,
      block,
      source: "form",
      member: member.name,
      ...(returnValue !== undefined ? { returnValue } : {}),
      outParams,
      cursors,
      dbmsOutput: output.lines,
      ...(output.truncated ? { dbmsOutputTruncated: true } : {}),
      error: execErr,
    };
  } finally {
    await conn.close();
  }
}

/** Run the user's own anonymous block — SQL Developer's "Run PL/SQL" dialog. The text is
 *  executed verbatim (values live in the block, not in binds), and every `:NAME` placeholder
 *  is an OUT bind typed from the signature when the name matches a parameter. This is what
 *  makes composite parameters runnable: the block declares and builds them itself. */
async function oraRoutineRunBlock(
  c: LiveConnection,
  meta: RoutineMeta,
  member: RoutineMember | null,
  block: string
): Promise<RoutineRunResult | { error: string }> {
  const names = plsqlBindNames(block);
  if (names.length > ROUTINE_BLOCK_MAX_BINDS) {
    return { error: `The block uses ${names.length} bind placeholders — the limit is ${ROUTINE_BLOCK_MAX_BINDS}.` };
  }
  const paramOf = new Map((member?.params ?? []).map((p) => [p.name.toUpperCase(), p]));
  const binds: Record<string, unknown> = {};
  const outs: { name: string; dataType: string; kind: RoutineBindKind }[] = [];
  for (const n of names) {
    const p = paramOf.get(n);
    let kind: RoutineBindKind = "string";
    let dataType = "VARCHAR2";
    if (p) {
      if (!p.bindKind) {
        return { error: `:${n} is ${p.name} (${p.dataType}), which cannot be carried out of the block through a bind — print it with DBMS_OUTPUT instead.` };
      }
      kind = p.bindKind;
      dataType = p.dataType;
    } else if (member?.kind === "FUNCTION" && member.returnBindKind && (n === "RESULT" || n === "RETURN_VALUE")) {
      kind = member.returnBindKind;
      dataType = member.returnType ?? "";
    }
    binds[n] = { dir: oracledb.BIND_OUT, type: oraBindType(kind), ...(kind === "string" ? { maxSize: 32767 } : {}) };
    outs.push({ name: n, dataType, kind });
  }

  const conn = await getOraConn(c);
  const started = Date.now();
  try {
    // enabled by its own statement so the user's block runs exactly as written
    try { await conn.execute(`BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`); } catch { /* package unavailable */ }
    let execErr: RoutineRunResult["error"] = null;
    let outBinds: Record<string, unknown> = {};
    try {
      const r = await conn.execute(block, binds as oracledb.BindParameters, { outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: true });
      outBinds = (r.outBinds ?? {}) as Record<string, unknown>;
    } catch (e) {
      execErr = routineExecError(e, c.host);
      try { await conn.rollback(); } catch { /* nothing open */ }
    }

    const output = await readDbmsOutput(conn);
    const outParams: RoutineRunResult["outParams"] = [];
    const cursors: RoutineRunResult["cursors"] = [];
    if (!execErr) {
      for (const o of outs) {
        if (o.kind === "cursor") await readRoutineCursor(o.name, outBinds[o.name], cursors);
        else outParams.push({ name: o.name, dataType: o.dataType, value: plainBindValue(outBinds[o.name]) });
      }
    }

    return {
      ok: !execErr,
      durationMs: Date.now() - started,
      block,
      source: "block",
      member: member?.name ?? meta.name,
      outParams,
      cursors,
      dbmsOutput: output.lines,
      ...(output.truncated ? { dbmsOutputTruncated: true } : {}),
      error: execErr,
    };
  } finally {
    await conn.close();
  }
}

/** Signature of a runnable routine (Oracle): ?name= — packages list their members. */
app.get("/api/connections/:id/routine", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The routine runner currently supports Oracle connections only." });
  const name = String(req.query.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Missing routine name (?name=...)" });
  try {
    res.json(await oraRoutineMeta(c, name));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Run a procedure/function with bound parameter values, or the caller's own PL/SQL block
 *  (Oracle only). Body: { name, member?, overload?, args: { name, value, useDefault? }[],
 *  block?, confirm }. `block` wins: it runs verbatim and the args are ignored. */
app.post("/api/connections/:id/routine/run", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The routine runner currently supports Oracle connections only." });
  // hard lock, same as /query: a stored routine can write, so a read-only connection never runs one
  if (c.readOnly) return res.status(400).json({ error: "This connection is read-only — running stored code is blocked, because a routine can modify data. Edit the connection to disable read-only mode." });
  const parsed = readRoutineRunBody(req.body);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });
  const body = parsed.body;
  try {
    const meta = await oraRoutineMeta(c, body.name);
    if (meta.error) return res.status(404).json({ error: meta.error });
    // a package has no callable body of its own — say which members exist rather than
    // reporting that the package "is not a member of" itself
    if (meta.type === "PACKAGE" && !body.member && !body.block) {
      return res.status(400).json({
        error: `${meta.name} is a package — name the member to run in "member"${meta.members.length ? ` (${formatNames(meta.members.map((m) => m.name))})` : ""}.`,
      });
    }
    const member = meta.members.find(
      (m) => (meta.type === "PACKAGE" ? m.name === (body.member ?? "") : true) && (m.overload ?? null) === (body.overload ?? null)
    );
    // A hand-written block calls whatever it wants; the member is only used to type its
    // `:NAME` binds, so an unknown one is not an error there — every bind falls back to text.
    if (!member && !body.block) {
      return res.status(404).json({ error: `${body.member ?? body.name} is not a member of ${meta.name}${body.overload ? ` (overload ${body.overload})` : ""}.` });
    }
    const target = meta.type === "PACKAGE" && member ? `${meta.name}.${member.name}` : meta.name;

    if (body.block) {
      const cls = classifyStatement(body.block);
      if (!acknowledged(req)) {
        return confirmRequired(res, describeOperation({
          level: cls.level === "destructive" ? "destructive" : "write",
          verb: "EXECUTE",
          target,
          title: `Run this PL/SQL block on "${c.name}"?`,
          body: `The block runs exactly as you wrote it against "${c.name}"${cls.level === "destructive" ? `, and it contains a ${cls.verb} statement` : ""}. It executes everything it contains — calls to ${target}, DML, loops — and commits when it completes.`,
          confirmLabel: "Run block",
        }));
      }
      const outBlock = await oraRoutineRunBlock(c, meta, member ?? null, body.block);
      if ("error" in outBlock && !("ok" in outBlock)) return res.status(400).json({ error: outBlock.error });
      return res.json(outBlock);
    }
    if (!member) return res.status(404).json({ error: `${body.member ?? body.name} is not a member of ${meta.name}.` });
    // params we cannot bind (records, collections, object types) make the call unrunnable here
    const argOf = new Map(body.args.map((a) => [a.name.toUpperCase(), a]));
    const unsupported = member.params.filter((p) => {
      const a = argOf.get(p.name.toUpperCase());
      const skipped = (a?.useDefault === true || !a) && p.hasDefault;
      return !skipped && !p.bindKind;
    });
    if (unsupported.length) {
      return res.status(400).json({
        error: `Cannot bind ${unsupported.map((p) => `${p.name} (${p.dataType})`).join(", ")} — composite/unsupported types need a hand-written PL/SQL block that declares and builds the value (send it as "block", or use the Run tab's PL/SQL block editor).`,
      });
    }
    if (member.kind === "FUNCTION" && !member.returnBindKind) {
      return res.status(400).json({ error: `The return type ${member.returnType ?? "(unknown)"} cannot be bound — run this function from a hand-written PL/SQL block instead.` });
    }
    // A required IN parameter that simply isn't in `args` used to bind as NULL, and the
    // routine then failed somewhere deep inside — an ORA-01403 from a SELECT INTO tells
    // the caller nothing about the missing argument. Passing NULL has to be explicit.
    const missing = member.params.filter(
      (p) => p.direction !== "OUT" && !p.hasDefault && !argOf.has(p.name.toUpperCase())
    );
    if (missing.length) {
      return res.status(400).json({
        error: `Missing value for ${missing.map((p) => `${p.name} (${p.dataType})`).join(", ")} — ${missing.length === 1 ? "it has" : "they have"} no declared default. Send \`value: null\` explicitly to pass NULL.`,
      });
    }
    if (!acknowledged(req)) {
      return confirmRequired(res, describeOperation({
        level: "write",
        verb: "EXECUTE",
        target,
        title: `Run ${member.kind} ${target}?`,
        body: `This executes live code on "${c.name}". A stored ${member.kind.toLowerCase()} can modify data or schema — review the parameter values before running.`,
        confirmLabel: "Run",
      }));
    }
    const out = await oraRoutineRun(c, meta, member, body.args);
    if ("error" in out && !("ok" in out)) return res.status(400).json({ error: out.error });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Live table metadata for the Table Designer: ?name= (Oracle only). */
app.get("/api/connections/:id/table", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The Table Designer currently supports Oracle connections only." });
  const name = String(req.query.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Missing table name (?name=...)" });
  try {
    res.json(await oraTableMeta(c, name));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Apply Table Designer DDL: body { statements: string[] }. Runs in order, stops at the first error (Oracle only). */
app.post("/api/connections/:id/table/apply", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The Table Designer currently supports Oracle connections only." });
  if (c.readOnly) return res.status(400).json({ error: "This connection is read-only — schema changes are blocked. Edit the connection to disable read-only mode." });
  const statements = Array.isArray(req.body?.statements) ? (req.body.statements as unknown[]).map((s) => String(s)) : [];
  if (!statements.length) return res.status(400).json({ error: "No statements to apply." });
  // each statement must be a single allowed DDL — reject embedded semicolons (no compound/chained statements)
  const bad = statements.find((s) => {
    const t = s.trim();
    if (!t) return false;
    return !TABLE_DDL_ALLOWED.test(t) || t.replace(/;\s*$/, "").includes(";");
  });
  if (bad) return res.status(400).json({ error: `Statement not allowed through the Table Designer: ${bad.trim().slice(0, 60)}…` });
  if (!acknowledged(req)) {
    const cls = classifyBatch(statements);
    return confirmRequired(res, describeOperation({
      level: cls.level === "read" ? "write" : cls.level,
      verb: cls.verb,
      target: cls.target,
      title: `Apply ${statements.length} DDL statement(s)?`,
      body: `${statements.length} statement(s) will run against "${c.name}", starting with ${cls.verb}${cls.target ? ` on ${cls.target}` : ""}. Structural changes may lock the table${cls.level === "destructive" ? " and dropped objects or columns cannot be recovered" : ""}.`,
      confirmLabel: "Apply changes",
      danger: cls.level === "destructive",
    }));
  }
  try {
    res.json(await oraApplyTableDdl(c, statements));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/**
 * Rows of one table plus the ROWID of each — what the Data Browser's edit mode reads.
 * A read, so every role that may browse table data may call it; writing them back is the
 * POST below, which is Administrator/Developer only.
 */
app.get("/api/connections/:id/table/rows", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "Editing rows currently supports Oracle connections only." });
  const name = String(req.query.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Missing table name (?name=...)" });
  const limit = Number(req.query.limit) || MAX_ROWS;
  try {
    res.json(await oraTableRows(c, name, limit));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Insert / update / delete one row: body { table, action, rowId?, values? } (Oracle only). */
app.post("/api/connections/:id/table/rows", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "Editing rows currently supports Oracle connections only." });
  if (c.readOnly) return res.status(400).json({ error: "This connection is read-only — row changes are blocked. Edit the connection to disable read-only mode." });
  const action = String(req.body?.action ?? "");
  if (action !== "insert" && action !== "update" && action !== "delete") {
    return res.status(400).json({ error: `Unknown row action "${action}" — expected insert, update or delete.` });
  }
  const table = String(req.body?.table ?? "").trim();
  if (!table) return res.status(400).json({ error: "Missing `table`." });
  const values = req.body?.values;
  if (action !== "delete" && (!values || typeof values !== "object" || Array.isArray(values))) {
    return res.status(400).json({ error: "`values` must be an object of column name → value." });
  }
  const original = req.body?.original;
  if (original != null && (typeof original !== "object" || Array.isArray(original))) {
    return res.status(400).json({ error: "`original` must be an object of column name → value." });
  }
  // same default-deny as every other write: nothing runs until the caller acknowledges it
  if (!acknowledged(req)) {
    const changed = action === "delete" ? [] : Object.keys(values as Record<string, unknown>);
    return confirmRequired(res, describeOperation({
      level: action === "delete" ? "destructive" : "write",
      verb: action.toUpperCase(),
      target: table,
      title: action === "delete" ? `Delete this row from ${table}?` : action === "insert" ? `Insert a row into ${table}?` : `Save this row in ${table}?`,
      body:
        action === "delete"
          ? `The row is removed from ${table} on "${c.name}" and committed straight away — there is no undo.`
          : action === "insert"
            ? `A new row is written to ${table} on "${c.name}" and committed straight away.`
            : `${changed.length === 1 ? "1 column" : `${changed.length} columns`} (${changed.join(", ")}) ${changed.length === 1 ? "is" : "are"} overwritten on this row of ${table} on "${c.name}", committed straight away.`,
      confirmLabel: action === "delete" ? "Delete row" : action === "insert" ? "Insert row" : "Save row",
      danger: action === "delete",
    }));
  }
  try {
    const out = await oraRowChange(c, {
      table,
      action,
      rowId: req.body?.rowId == null ? undefined : String(req.body.rowId),
      values: values as Record<string, string | number | null> | undefined,
      original: (original ?? undefined) as Record<string, string | number | null> | undefined,
    });
    if ("error" in out) return res.status(400).json({ error: out.error });
    res.json(out);
  } catch (e) {
    // an ORA-nnnnn here is Oracle rejecting the values that were submitted (NOT NULL, a check
    // or FK constraint, value too large) — that is a bad request, not a backend fault, and the
    // grid should show it next to the row rather than as a server error
    const status = (e as { errorNum?: number }).errorNum ? 400 : 500;
    res.status(status).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Table + column + index statistics for the Statistics tab: ?name= (Oracle only). */
app.get("/api/connections/:id/table/stats", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The Table Designer currently supports Oracle connections only." });
  const name = String(req.query.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Missing table name (?name=...)" });
  try {
    res.json(await oraTableStats(c, name));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** DBMS_STATS action: body { name, action: "gather"|"delete"|"lock"|"unlock" } (Oracle only). */
app.post("/api/connections/:id/table/stats", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The Table Designer currently supports Oracle connections only." });
  if (c.readOnly) return res.status(400).json({ error: "This connection is read-only — gathering/deleting/locking statistics is blocked." });
  const name = String(req.body?.name ?? "").trim();
  const action = String(req.body?.action ?? "").trim() as StatsAction;
  if (!name) return res.status(400).json({ error: "Missing table name." });
  if (!["gather", "delete", "lock", "unlock"].includes(action)) return res.status(400).json({ error: `Unknown statistics action: ${action || "(empty)"}` });
  if (!acknowledged(req)) {
    const destructive = action === "delete";
    return confirmRequired(res, describeOperation({
      level: destructive ? "destructive" : "write",
      verb: `STATS ${action.toUpperCase()}`,
      target: name.toUpperCase(),
      title: `${action === "gather" ? "Gather" : action === "delete" ? "Delete" : action === "lock" ? "Lock" : "Unlock"} statistics on ${name.toUpperCase()}?`,
      body:
        action === "delete"
          ? `Deleting statistics on ${name.toUpperCase()} ("${c.name}") leaves the optimizer without data for this table until they are gathered again — plans can degrade immediately.`
          : `DBMS_STATS ${action} runs against ${name.toUpperCase()} on "${c.name}". Gathering reads the table and rewrites the dictionary statistics, which can change execution plans.`,
      confirmLabel: `${action.charAt(0).toUpperCase()}${action.slice(1)} statistics`,
    }));
  }
  try {
    await oraTableStatsAction(c, name, action);
    res.json({ ok: true, action });
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Table + index segment sizes, storage attributes, and available tablespaces: ?name= (Oracle only). */
app.get("/api/connections/:id/table/storage", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The Table Designer currently supports Oracle connections only." });
  const name = String(req.query.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Missing table name (?name=...)" });
  try {
    res.json(await oraTableStorage(c, name));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Storage maintenance action: body { name, action, tablespace?, compression?, on?, index? } (Oracle only). */
app.post("/api/connections/:id/table/storage", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The Table Designer currently supports Oracle connections only." });
  if (c.readOnly) return res.status(400).json({ error: "This connection is read-only — storage changes are blocked." });
  const name = String(req.body?.name ?? "").trim();
  const action = String(req.body?.action ?? "").trim() as StorageAction;
  if (!name) return res.status(400).json({ error: "Missing table name." });
  if (!["move", "shrink", "logging", "rebuildIndexes", "rebuildIndex"].includes(action))
    return res.status(400).json({ error: `Unknown storage action: ${action || "(empty)"}` });
  const rawComp = String(req.body?.compression ?? "KEEP").toUpperCase();
  const compression = (["KEEP", "NONE", "BASIC", "ADVANCED"].includes(rawComp) ? rawComp : "KEEP") as StorageCompression;
  const params: StorageParams = {
    tablespace: req.body?.tablespace ? String(req.body.tablespace) : undefined,
    compression,
    on: typeof req.body?.on === "boolean" ? req.body.on : undefined,
    index: req.body?.index ? String(req.body.index) : undefined,
  };
  if (!acknowledged(req)) {
    const heavy = action === "move" || action === "shrink";
    return confirmRequired(res, describeOperation({
      level: "write",
      verb: `STORAGE ${action.toUpperCase()}`,
      target: name.toUpperCase(),
      title: `Run ${action} on ${name.toUpperCase()}?`,
      body:
        action === "move"
          ? `ALTER TABLE ${name.toUpperCase()} MOVE rewrites the whole segment on "${c.name}". The table is locked for the duration and every index on it becomes UNUSABLE until rebuilt.`
        : action === "shrink"
          ? `Shrinking ${name.toUpperCase()} on "${c.name}" reorganises rows in place and holds locks while it runs.`
        : action === "logging"
          ? `Switching ${name.toUpperCase()} to ${params.on ? "LOGGING" : "NOLOGGING"} on "${c.name}" changes redo generation — NOLOGGING data is not recoverable from archive logs.`
          : `Rebuilding index(es) on ${name.toUpperCase()} ("${c.name}") reads and rewrites the index segments; the table stays available but the operation is I/O heavy.`,
      confirmLabel: `Run ${action}`,
      danger: heavy,
    }));
  }
  try {
    const out = await oraTableStorageAction(c, name, action, params);
    res.json({ ok: true, action, ...out });
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Read-only optimization findings for one table: ?name= (Oracle only). */
app.get("/api/connections/:id/table/advisor", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The Table Designer currently supports Oracle connections only." });
  const name = String(req.query.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Missing table name (?name=...)" });
  try {
    res.json(await oraTableAdvisor(c, name));
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** One-click maintenance: body { name, action } (Oracle only). */
app.post("/api/connections/:id/table/maintenance", requireFullAccess, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  if (c.engine !== "oracle") return res.status(400).json({ error: "The Table Designer currently supports Oracle connections only." });
  if (c.readOnly) return res.status(400).json({ error: "This connection is read-only — maintenance actions are blocked." });
  const name = String(req.body?.name ?? "").trim();
  const action = String(req.body?.action ?? "").trim() as MaintenanceAction;
  if (!name) return res.status(400).json({ error: "Missing table name." });
  if (!["gatherStats", "rebuildIndexes", "reorg", "shrink", "analyze", "validateConstraints"].includes(action))
    return res.status(400).json({ error: `Unknown maintenance action: ${action || "(empty)"}` });
  if (!acknowledged(req)) {
    const heavy = action === "reorg" || action === "shrink";
    return confirmRequired(res, describeOperation({
      level: "write",
      verb: `MAINTENANCE ${action.toUpperCase()}`,
      target: name.toUpperCase(),
      title: `Run ${action} on ${name.toUpperCase()}?`,
      body: `Maintenance "${action}" runs against ${name.toUpperCase()} on "${c.name}".${heavy ? " It rewrites the segment and locks the table while it runs." : " It reads the table and updates dictionary information."}`,
      confirmLabel: `Run ${action}`,
      danger: heavy,
    }));
  }
  try {
    const out = await oraTableMaintenance(c, name, action);
    res.json({ ok: true, action, ...out });
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

/** Versioned code objects for this connection (summaries). */
app.get("/api/connections/:id/versions", (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  res.json(listVersionedObjects(c));
});

/** Full version history (with sources) for one object: ?name=&type= */
app.get("/api/connections/:id/versions/object", (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const name = String(req.query.name ?? "").trim();
  const type = String(req.query.type ?? "").trim().toUpperCase();
  if (!name || !type) return res.status(400).json({ error: "Missing ?name= or ?type=" });
  const vf = readJsonFile<VersionFile | null>(versionFilePath(connKey(c), type, name), null);
  if (!vf) return res.status(404).json({ error: `No versions recorded for ${type} ${name}` });
  res.json(vf);
});

/** Change log for this connection (newest first). */
app.get("/api/connections/:id/changelog", (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const key = connKey(c);
  const log = readJsonFile<ChangeLogEntry[]>(CHANGELOG_FILE, []);
  res.json({ connKey: key, entries: log.filter((e) => e.connKey === key).reverse() });
});

/** Full captured output for one DBMS_SCHEDULER run. Read-only by design. */
app.get("/api/connections/:id/job-runs/:logId/output", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const logId = Number(req.params.logId);
  if (!Number.isSafeInteger(logId) || logId < 0) return res.status(400).json({ error: "Invalid scheduler run ID" });
  try {
    const output = await oraJobRunOutput(c, logId);
    if (!output) return res.status(404).json({ error: "Scheduler run no longer exists" });
    res.json(output);
  } catch (e) {
    res.status(500).json({ error: withNetworkHint(errMsg(e), c.host) });
  }
});

app.post("/api/connections/:id/query", async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown connection (backend may have restarted — recreate it)" });
  const sql = String(req.body?.sql ?? "").trim();
  const started = Date.now();
  if (!sql) {
    return res.json({
      columns: [], rows: [], durationMs: 0, rowsReturned: 0,
      error: { message: "Nothing to execute — the worksheet is empty.", line: 1, code: "DF-0001" },
    });
  }
  const denial = roleQueryDenial(res.locals.role as Role, sql);
  if (denial) {
    return res.json({
      columns: [], rows: [], durationMs: 0, rowsReturned: 0,
      error: { message: denial, line: 1, code: "ROLE-DENIED" },
    });
  }
  if (c.readOnly && !isReadStatement(sql)) {
    return res.json({
      columns: [], rows: [], durationMs: 0, rowsReturned: 0,
      error: {
        message: `This connection is read-only — only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN statements are allowed. Edit the connection to disable read-only mode if you need to make changes.`,
        line: 1,
        code: "READ-ONLY",
      },
    });
  }
  // default-deny: a write only runs when the caller explicitly acknowledged this statement.
  // /query keeps the 200-with-embedded-error convention; `confirmation` drives the UI dialog.
  const cls = classifyStatement(sql);
  if (cls.level !== "read" && !acknowledged(req)) {
    const confirmation = describeStatement(cls, c.name);
    return res.json({
      columns: [], rows: [], durationMs: 0, rowsReturned: 0,
      error: { message: confirmation.body, line: 1, code: "CONFIRM-REQUIRED" },
      confirmation,
    });
  }
  try {
    const out = await oraQuery(c, sql);
    // auto-version code objects on success — must never break the query path
    let versioned: VersionedInfo | null = null;
    try {
      versioned = await captureCodeVersion(c, sql);
    } catch (err) {
      console.error("Version capture failed:", err);
    }
    res.json({ ...out, durationMs: Date.now() - started, error: null, versioned });
  } catch (e) {
    const err = e as { code?: string; errorNum?: number };
    const code = err.errorNum ? `ORA-${String(err.errorNum).padStart(5, "0")}` : err.code ?? "SQL-ERROR";
    const { message, helpUrl } = splitHelpUrl(withNetworkHint(errMsg(e), c.host));
    res.json({
      columns: [], rows: [],
      durationMs: Date.now() - started,
      rowsReturned: 0,
      error: {
        message,
        line: oraErrorLine(e, sql),
        code,
        ...(helpUrl ? { helpUrl } : {}),
      },
    });
  }
});

/**
 * Last-resort error handler. Routes wrap their own work in try/catch, but a synchronous
 * throw outside one (a failed fs write, say) would otherwise reach Express's default
 * handler, which puts the stack trace and absolute filesystem paths in the response
 * body whenever NODE_ENV isn't "production" — i.e. all of local development.
 */
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[unhandled]", err);
  if (res.headersSent) return;
  res.status(500).json({ error: errMsg(err) });
});

// Serve the built frontend when dist/ exists (production container)
const dist = path.resolve(import.meta.dirname, "../dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

/**
 * Listen on loopback by default, so nothing is reachable from the network until that is
 * asked for explicitly. Set HOST=0.0.0.0 for trusted-LAN access, which additionally
 * requires DATAFORGE_AUTH_TOKEN and DATAFORGE_ENCRYPTION_KEY (enforced at startup above),
 * or bind a specific interface address when required.
 */
app.listen(PORT, HOST, () => {
  console.log(`Oracle DataForge listening on http://${HOST}:${PORT} (static: ${fs.existsSync(dist) ? "on" : "off"})`);
  // only meaningful once something is actually saved — a fresh install has nothing at risk yet
  if (registry.size) warnIfPlaintextCredentials();
});
