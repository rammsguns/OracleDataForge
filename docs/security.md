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

It is **not** a multi-tenant service, has no identity system, no per-user permissions, and no
audit trail. The removed control plane from the original suite is not coming back by accident.

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

## Authentication

HTTP Basic, username `dataforge`, the token as the password. The middleware runs **first** —
before the origin guard, the body parser, all API routes, and the static SPA — so it covers
everything, UI included.

The token is compared with `timingSafeEqual` after a length check, so the comparison is
constant-time on content.

Because the browser replays the `Authorization` header on same-origin requests, **no
application token is ever stored in JavaScript**. There is nothing for a script to steal from
`localStorage`.

> **Authentication is off by default.** The first line of the middleware is
> `if (!AUTH_TOKEN) return next();`. With no token set — the default loopback install — every
> route is unauthenticated. This is intentional for single-machine use and is why loopback
> binding is the default, but it means *anything able to reach port 3001 has full access*. The
> token is enforced on loopback too, if you set one.

Use an **ASCII token**. The length check compares JavaScript string length while
`timingSafeEqual` receives UTF-8 byte buffers, so a multi-byte token can produce a `RangeError`
(surfacing as a 500) rather than a clean 401. Not a bypass, but avoidable.

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
4. **No rate limiting and no security headers** — no CSP, `X-Frame-Options`, or HSTS anywhere.
   The origin guard covers the main cross-site vector, but nothing else does.
5. **Dev origins are allowed unconditionally**, including in production builds.
6. **`POST /api/connections/test` dials an arbitrary caller-supplied host and port.** That is
   what a database client does, but on a LAN deployment any token-holder gains outbound
   connect and port-probe capability from the server.

## Reporting

This is a personal project without a formal disclosure process. Open an issue for anything
non-sensitive; for something exploitable, contact the repository owner directly rather than
filing publicly.

## See also

- [credentials.md](credentials.md) — storage, encryption, migration, password replay
- [architecture.md](architecture.md) — where these controls sit in the request path
- [known_limitations.md](known_limitations.md) — non-security constraints
- [deployment.md](deployment.md) — LAN startup requirements
