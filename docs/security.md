# Security

The security model of Oracle DataForge, what each control actually guarantees, and where the
limits are. Credential storage is covered separately in [credentials.md](credentials.md).

This document states weaknesses as plainly as strengths. A tool that connects to production
databases earns nothing from optimistic documentation.

## Threat model

Oracle DataForge is a **single-user development tool** that holds database credentials and
executes arbitrary SQL. It assumes:

- One trusted operator per instance.
- The machine it runs on is trusted.
- The Oracle account it connects with already has whatever privileges it has — the app never
  elevates.

It is **not** a multi-tenant service and has no audit trail. The removed control plane from the
original suite is not coming back by accident. An optional, lightweight identity/role layer
exists (see [Workspace roles](#workspace-roles) below) for the case of a few trusted people
sharing one instance — it is not a tenant system, and every account still shares the same
Oracle connections and credentials.

## Network exposure

The server binds **`127.0.0.1` by default**, reachable only from the machine it runs on.
Exposure is opt-in, and the opt-in is guarded.

Setting `HOST` to anything non-loopback **throws at startup** unless both
`DATAFORGE_AUTH_TOKEN` and `DATAFORGE_ENCRYPTION_KEY` are set. The process never begins
listening in a half-configured exposed state.

```
DATAFORGE_AUTH_TOKEN is required when HOST is not loopback.
DATAFORGE_ENCRYPTION_KEY is required when HOST is not loopback.
```

**TLS is the operator's responsibility.** The app speaks plain HTTP. Basic auth sends the
token on every request, so put a TLS-terminating reverse proxy in front of anything beyond
loopback.

### The host guard

Before authentication, before the origin guard, before anything: every request's `Host`
header must name this server. Anything else gets **403**.

Accepted are loopback (`localhost`, `127.0.0.1`, `[::1]`), the configured `HOST`, any literal
IP address, and any name listed in `DATAFORGE_ALLOWED_HOSTS` (comma-separated; an entry may
carry a port to pin it, otherwise any port matches).

This exists because the origin guard below cannot stand on its own. It compares `Origin`
against `Host`, and a browser fills both in from the same URL, so they always agree —
including for a page the operator did not intend to trust. A site on `attacker.example:3001`
that re-points its own DNS record at `127.0.0.1` after the page loads sends
`Origin: http://attacker.example:3001` and `Host: attacker.example:3001`, matches itself, and
walks into the API: the connection list, arbitrary SQL with `confirm: true`, and
`POST /api/users` to plant an Administrator on an install that has none. Pinning the names
the server answers to closes that, because the attacker controls DNS and not this list.

Literal IP addresses are allowed unconditionally, which costs nothing: rebinding needs a
*name* to re-point, and a browser resolves nothing for `192.168.1.5`. A LAN install reached
by address therefore needs no configuration; one reached by DNS name needs that name in
`DATAFORGE_ALLOWED_HOSTS`.

## Authentication

HTTP Basic. The middleware runs before the origin guard, the body parser, all API routes, and
the static SPA — so it covers everything, UI included. Only the host guard above precedes it.
Two kinds of credential are accepted:

- **`dataforge` / `DATAFORGE_AUTH_TOKEN`** — the original break-glass credential, always
  Administrator. Compared with `timingSafeEqual` after a length check, so the comparison is
  constant-time on content.
- **A workspace account's email / password** — see [Workspace roles](#workspace-roles).

Basic replays the credential on **every** request — each API call and each static asset — and
scrypt is deliberately expensive, so two things follow:

- **Verified credentials are cached** for five minutes, keyed by a SHA-256 of the raw
  `Authorization` header, so a page load costs one derivation rather than one per request.
  The cache stores only successes. Any account change clears it wholesale, so a password
  change, suspension or deletion takes effect on the next request; a cache hit still re-checks
  that the account is Active.
- **The derivation runs off the event loop**, and repeated failures from one address meet a
  cooldown — ten failures inside a minute buy a minute of `429`s, during which no derivation
  runs at all. Without both, anyone who knew a single account email could keep the process
  busy with unauthenticated requests, since scrypt runs just as long for a wrong password as
  for a right one.

Only a credential that was **presented and rejected** counts as a failure. A request carrying
no `Authorization` header at all is the first half of the Basic handshake — the browser asks
with nothing, takes the challenge, and retries with the password — and a page load opens
several of those at once. Counting them would let an ordinary first visit trip its own
cooldown before anyone could type anything, so a credential-less request always gets a clean
401 challenge, even mid-cooldown. It costs nothing to serve: no derivation runs on that path.

The cooldown is checked *after* the cache, so a browser whose credential is already warm keeps
working while a guesser from the same address is being throttled.

Because the browser replays the `Authorization` header on same-origin requests, **no
application credential is ever stored in JavaScript**. There is nothing for a script to steal
from `localStorage`.

> **Authentication is off by default.** With no token set and no workspace accounts created —
> the default loopback install — every route is unauthenticated and every request is treated as
> Administrator. This is intentional for single-machine use and is why loopback binding is the
> default, but it means *anything able to reach port 3001 has full access* until either a token
> is configured or the first account is created.

The token's length check compares **UTF-8 byte lengths**, matching the buffers
`timingSafeEqual` actually receives. A multi-byte token used to compare JavaScript string
length instead, so it could raise a `RangeError` and surface as a 500 rather than a clean 401.
Never a bypass, and no longer a wrong answer.

## Workspace roles

Four roles — Administrator, Developer, Analyst, Viewer — enforced **server-side**, on the
actual endpoint, not just by hiding a tab in the UI:

| Role | Server enforces |
| --- | --- |
| Administrator, Developer | Unrestricted (still subject to read-only connections and the write guard above) |
| Analyst | `POST /query` and `POST /explain` accept **only** the exact single-table preview statement the Data Browser itself generates (`SELECT * FROM "T" FETCH FIRST 1000 ROWS ONLY`) — not any other SELECT |
| Viewer | `POST /query` and `POST /explain` accept only statements the same read-statement classifier used for read-only connections would pass |

Every endpoint that changes Oracle data, DDL, the connection registry, or writes to GitHub
(`/api/github/sync`) requires Administrator or Developer — including `POST …/table/rows`, the
Data Browser's row editor. Its read half (`GET …/table/rows`) is *not* restricted: it returns
the same rows the preview already shows, so any role allowed to browse table data may call it.
Account management (`/api/users/*`) requires Administrator specifically. The one exception is
`POST /api/session/password`, which any signed-in account may call to change **its own**
password: it resolves the target from the credential the request authenticated with — never
from the body — and re-checks the current password before writing, so it cannot be aimed at
another account or used to take over an unattended session.

> **Why Analyst and Viewer differ:** the server sees identical SQL text whether it was typed by
> hand or generated by the Data Browser — there is no way to cryptographically distinguish
> them. Analyst's ceiling is therefore the literal shape of that generated query; anything else,
> including a harmless `SELECT COUNT(*)`, is refused.

**Accounts** live in `data/users.json` — name, email (the Basic-auth username), role, an `mfa`
flag, and a password hashed with `scrypt` (salted, not reversible; no plaintext password is
ever stored, unlike the AES-256-GCM-*encrypted* Oracle credentials in `connections.json`, which
the server must be able to decrypt to actually connect). `GET/POST/PUT/DELETE /api/users*` are
Administrator-only, and a change that would leave **zero active Administrators** — suspending,
demoting, or removing the last one — is rejected outright, so an operator can't accidentally
lock themselves out short of deleting `data/users.json` on disk.

Creating the very first account is deliberately unauthenticated — until one exists, every
caller is already treated as Administrator, so `POST /api/users` from that state is how a fresh
install bootstraps itself without a chicken-and-egg login problem. Every request after that
requires real credentials.

> **Gap:** `mfa` is stored on the account but not enforced — there is no second factor, TOTP or
> otherwise. It's a flag for future use, not a control today.

The client's tab-gating (which panels render for which role) is a UX convenience mirroring
these rules for instant feedback, exactly like the existing read-only-connection pattern — the
server enforcement above is what actually holds if a client is modified or bypassed.

## The origin guard

With no authentication in the default install, the browser's origin check is the only thing
standing between this API and any web page the operator happens to have open. The code says so
directly, and records that a previous wildcard `cors()` had actively removed that barrier —
any site could have read the connection list and posted SQL, since there are no cookies for
the browser's own credential rules to withhold.

Current behavior:

- Requests with **no** `Origin` header — the app's own SPA, `curl`, `Invoke-RestMethod` — pass
  through untouched.
- Requests **with** an `Origin` are allowed only if it matches this server's own host, or one
  of the dev origins. Anything else gets **403**.

The `Host` it matches against is no longer attacker-controllable: the
[host guard](#the-host-guard) has already rejected any request naming something this server
does not answer to. That closes the DNS-rebinding hole this check had on its own, where
`Origin` and `Host` both came from the attacker's page and so agreed with each other.

> **Gap:** the dev origins — `localhost` and `127.0.0.1` on ports 5173 and 4173 — are allowed
> **unconditionally**, not gated on `NODE_ENV`. On a default loopback install with no token, a
> page served by any other project's dev server on those ports can call this API
> cross-origin. Gating that set on development would cost nothing.

## Read-only connections

**New connections default to read-only**, in both the wizard and the server-side config
parser: a request that says nothing about writes is treated as the safest thing it could mean.

Enforcement is entirely server-side, on every write-capable endpoint — query, import, compile,
compile-invalid, routine run, table apply, stats, storage, and maintenance. The browser cannot
opt itself out.

> **Gap, inherent to classifying statement text:** the read/write decision is *lexical*. A
> statement like `SELECT my_writing_fn(1) FROM dual` contains no write verb and passes as a
> read. If that function carries `PRAGMA AUTONOMOUS_TRANSACTION`, it writes — through a
> connection marked read-only.
>
> This is why read-only mode is described as reducing accidents rather than enforcing a
> boundary. **It is not a substitute for Oracle privileges.** If a connection genuinely must
> not write, connect as an account that cannot.

`GET /compile/invalid` deliberately does not block on read-only; it reports the flag so the UI
can disable its button with the real reason rather than failing at click time.

## The write guard

**Nothing that changes the database runs unless the request carries `confirm: true`.**

The classifier lives only on the server, so the browser never decides what counts as
dangerous, and the server also authors the dialog text — one classifier, no client/server
drift.

Two response conventions, which is a real trap for anyone writing a client:

| Endpoint | Convention |
| --- | --- |
| `POST /query` | HTTP 200 with an embedded error, `code: "CONFIRM-REQUIRED"` (hyphen) |
| Every other mutating endpoint | HTTP **409**, `code: "CONFIRM_REQUIRED"` (underscore) |

Same concept, two spellings. A client that checks only one will silently miss the other.

> **State plainly:** `confirm: true` is a **client-asserted flag**, not a server-issued nonce
> bound to the operation that was described. Any scripted client can set it and skip the
> dialog, and nothing cryptographically ties the text a user approved to the statement that
> subsequently runs. It is a forcing function against accidents, not an authorization control.

A nice touch: an empty compile scope answers 200 with a note instead of a confirmation prompt
— "nothing to do is not something to confirm."

## Statement classification

The thing standing between a typo and a dropped table.

`stripSqlNoise()` blanks comments and string literals in a **single left-to-right scan**
rather than chained regex replaces, because whichever construct opens first must win.
Comments-then-literals loses everything after a quoted `--`; literals-then-comments lets an
apostrophe inside a comment swallow the rest of the statement.

It handles Oracle **q-quotes** (`q'[…]'` and friends, with mirrored delimiters) and copies
**quoted identifiers verbatim**, so an object can still be named while its contents cannot
open a comment or literal.

A statement is a read only if all three hold:

1. It starts with `select`, `with`, `show`, `desc`, `describe`, or `explain`.
2. It is **not** `WITH … FUNCTION|PROCEDURE`. Oracle 12c+ lets a `WITH` clause carry a whole
   PL/SQL routine that can do anything an autonomous transaction can, while still starting
   with `WITH` and using none of the blacklisted verbs.
3. It contains none of `insert`, `update`, `delete`, `merge`, `drop`, `create`, `alter`,
   `truncate`, `grant`, `revoke`, `rename`, `flashback`, `purge`, `call`, `execute`, `lock`
   anywhere — which also catches `SELECT … FOR UPDATE`.

Beyond that: destructive verbs are classified as destructive, write verbs as write, and
**anything unrecognized defaults to write**. The code is explicit — "the default has to be
'ask', never 'run'." For batches, the worst level wins: one `DROP` makes the whole script
destructive.

A client-side mirror exists in `src/utils/sql.ts` purely to avoid a round trip on obvious
reads. Its own comment states the backend stays authoritative and the two verb lists must be
kept in sync — an accepted duplication, not an oversight.

## SQL injection defenses

**Bind variables are the norm.** Every dictionary read binds its parameters, including
`DBMS_METADATA.GET_DDL` and `DBMS_STATS`. Imports use `executeMany` with positional binds and
per-column bind definitions.

Where SQL text must be assembled, identifiers pass through scrubbers that keep only
`[A-Z0-9_$#]`, and client-supplied column types go through a strict whitelist that falls back
to `VARCHAR2(4000)` — the code notes it "can never smuggle DDL."

Three places execute user SQL verbatim, each deliberately and each gated:

- **The worksheet** (`POST /query`) — the entire point of the tool; gated by read-only and the
  write guard.
- **Custom PL/SQL blocks** in the routine runner — gated by read-only and confirmation, with
  binds capped at 32.
- **Table Designer DDL** — additionally **allow-listed** to `CREATE TABLE`, `ALTER TABLE`,
  `COMMENT ON`, and index DDL, and rejected outright if it contains an interior `;`, so no
  chained statements.

`EXPLAIN PLAN` interpolates the user's statement by design — that is the statement being
explained, `EXPLAIN PLAN` parses rather than executes, and the driver refuses multiple
statements per call.

**Path traversal was found and fixed.** Version-history filenames scrub every segment; the
code records the original bug, where `?type=` reached `path.join` unsanitized and `..` allowed
reading files outside the versions directory.

> **Honesty caveat:** identifier scrubbers **strip** illegal characters rather than rejecting
> them, so `MY-TABLE` silently becomes `MYTABLE`. Injection is impossible; *targeting* is not
> guaranteed faithful. Confirmation dialogs render the raw uppercased name while execution
> uses the scrubbed one, so in rare cases the dialog can name a slightly different object than
> the one that runs.

## What the browser never sees

`GET /api/connections` returns metadata only. The password is removed by **destructuring**
rather than an allowlist, so a field added to the config later cannot silently begin leaking:

```ts
const { password: _pw, oraPool: _op, oracleMaintained: _om, ...safe } = c;
```

Result data is also shaped defensively: LOBs render as `[BLOB]`/`[CLOB]` placeholders rather
than bytes, and raw buffers are truncated.

## Caps

Denial-of-service resistance is incidental rather than designed, but the limits are real:

| Limit | Value |
| --- | --- |
| Rows returned per query | 1,000 |
| Import rows | 50,000 |
| ER diagram tables | 60 |
| Compile objects / passes / budget | 500 / 3 / 120 s |
| Routine output lines | 1,000 |
| PL/SQL block binds | 32 |
| Request body | 16 MB |
| Failed sign-ins per address | 10 per minute, then a 60 s cooldown |
| Verified-credential cache | 5 minutes, 500 entries |

## Error handling

A last-resort error handler exists for a specific reason: Express's default handler puts
**stack traces and absolute filesystem paths in the response body** whenever `NODE_ENV` is not
`production` — which is all of local development. The custom handler logs the detail and
returns only a message.

Oracle error text — schema names, object names, ORA codes — is passed through verbatim.
Correct for a DBA tool, worth knowing if the instance is ever exposed.

## System-schema backstop

Compiling from the object editor is blocked when connected as an Oracle-maintained schema,
because recompiling something like `SYS.STANDARD` can leave the instance unusable. It remains
reachable from the worksheet, where the statement is explicit and passes through the write
guard.

## Known gaps, collected

For anyone assessing this honestly, in rough order of practical significance:

1. **Read-only mode is lexical** and can be bypassed by a `SELECT` over a writing function.
   Use Oracle privileges for real boundaries.
2. **Plaintext credentials by default on loopback**, and the `0o600` file mode is applied only
   at file *creation* — migrating an existing looser-permissioned file leaves it as-is. On
   Windows POSIX modes are effectively ignored regardless. See
   [credentials.md](credentials.md).
3. **`confirm: true` is client-asserted**, not a bound server nonce.
4. **No security headers** — no CSP, `X-Frame-Options`, or HSTS anywhere. The host and origin
   guards cover the cross-site vector, but nothing else does. Rate limiting exists only on
   failed authentication; every other endpoint is uncapped.
5. **Dev origins are allowed unconditionally**, including in production builds.
6. **`POST /api/connections/test` dials an arbitrary caller-supplied host and port.** That is
   what a database client does, but on a LAN deployment any token-holder gains outbound
   connect and port-probe capability from the server.
7. **Workspace accounts have no MFA, no session expiry, and no audit trail.** The `mfa` flag is
   stored, not enforced; Basic auth credentials are valid indefinitely once set; and the
   Admin panel's "Recent activity" list is local to one browser, not a server-side log.

## Reporting

This is a personal project without a formal disclosure process. Open an issue for anything
non-sensitive; for something exploitable, contact the repository owner directly rather than
filing publicly.

## See also

- [credentials.md](credentials.md) — storage, encryption, migration, password replay
- [architecture.md](architecture.md) — where these controls sit in the request path
- [known_limitations.md](known_limitations.md) — non-security constraints
- [security-review-2026-09-02.md](security-review-2026-09-02.md) — findings from the 2026-09-02 code review, with fixes
- [deployment.md](deployment.md) — LAN startup requirements
