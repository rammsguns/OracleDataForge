# Security review, 2026-09-02

Findings from a code review of the whole repository at commit `fbaffa4` plus the uncommitted
working tree (the own-password-change endpoint). The review covered `server/index.ts`, the
client under `src/`, the CI workflow, and the runtime configuration of this install.

This document lists what [security.md](security.md) does **not** already say. The gaps that
file records (lexical read-only mode, client-asserted `confirm`, no security headers,
unconditional dev origins, no MFA or session expiry, no rate limiting) were re-checked and
remain accurate; they are not repeated here.

Statuses in the table below are kept current as findings are addressed. Where a finding is
marked **Fixed**, a note under it records what actually changed and how it was checked, and
security.md has been updated to match. The findings themselves are left as written, since the
description of the flaw is the reason the fix looks the way it does. Of the gaps listed above,
"no rate limiting" now has one exception — failed authentication, from finding 2.

Each finding names the code, what an attacker gets, and the fix. Line numbers refer to
`server/index.ts` unless stated otherwise and will drift as the file changes.

## Summary

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | High | DNS rebinding bypasses the origin guard | **Fixed** |
| 2 | High | Synchronous scrypt on every authenticated request | **Fixed** |
| 3 | Medium | Read-only roles can probe the network and guess Oracle passwords | Open |
| 4 | Medium | Analyst and Viewer can read far more than table data | Open |
| 5 | Medium | GitHub token is not pinned to a repository | Open |
| 6 | Medium | Vulnerable dependency: `qs` via express and body-parser | Open |
| 7 | Low | Account enumeration through response timing | Open |
| 8 | Low | Source history stored with looser protection than credentials | Open |
| 9 | Low | CI actions pinned to tags, not commits | Open |

Severity is practical impact on the documented default install (loopback, no token, no
accounts) and on a small shared LAN install, not a CVSS score.

## Findings

### 1. DNS rebinding bypasses the origin guard (High)

**Where:** the same-origin guard middleware that reads `req.headers.origin` (around line 3423).

**What:** a request carrying an `Origin` is accepted when it equals `http://` or `https://`
followed by the request's own `Host` header. Both headers are chosen by the browser from the
URL the page was loaded from, so they always match each other. A page served from
`attacker.example:3001` whose DNS record is flipped to `127.0.0.1` after the page loads makes
requests with `Host: attacker.example:3001` and `Origin: http://attacker.example:3001`. The
guard sees a match and lets them through. GET requests carry no `Origin` at all and pass
unconditionally.

**Impact:** on the default install (no token, no accounts) any web page the operator opens
gets the full API for as long as the tab is open:

- `GET /api/connections` lists hosts, ports, users and service names.
- `PUT /api/connections/:id` with an empty password and the same endpoint flips `readOnly` off
  without knowing the password.
- `POST /api/connections/:id/query` with `confirm: true` runs any statement.
- `POST /api/users` creates the first Administrator and locks the real operator out.

When workspace accounts exist the attack is blunted, because the browser scopes Basic
credentials to the origin that was challenged and `attacker.example:3001` was never given
them. This install has accounts, so it is protected today; a fresh clone is not.

**Fix:** validate the `Host` header before anything else. Accept only `localhost`,
`127.0.0.1`, `[::1]`, and the configured `HOST`, each with or without the configured port, and
answer everything else with 421 or 403. Do this in front of the auth middleware so it also
covers the unauthenticated bootstrap state.

**Fixed.** A host guard is now the first middleware registered, ahead of the auth middleware,
so it covers the bootstrap state too. It answers **403** to any request whose `Host` is not
loopback, the configured `HOST`, a literal IP address, or a name listed in the new
`DATAFORGE_ALLOWED_HOSTS`. Entries without a port match any port, which keeps the Vite dev
proxy (`Host: localhost:5173`) and a TLS terminator on 443 working unconfigured.

Two departures from the suggested fix, both deliberate:

- **Ports are not pinned by default.** Checking the port adds nothing against rebinding — the
  attacker's page names its own port either way — and pinning it would break the dev proxy.
  An entry in `DATAFORGE_ALLOWED_HOSTS` may still include a port to pin it explicitly.
- **Literal IP addresses are accepted unconditionally.** Rebinding needs a *name* to
  re-point; a browser resolves nothing for `192.168.1.5`. Accepting addresses keeps a LAN
  install reached by IP working with no new configuration, which is what `HOST=0.0.0.0`
  deployments do today. Only DNS-name access needs the new variable.

Verified against a running server: `Host: attacker.example:3001` and
`Host: dataforge.lan.attacker.example` are refused with 403; loopback, `localhost:5173`, a LAN
IPv4 literal, `[::1]` and a configured name are served.

### 2. Synchronous scrypt on every authenticated request (High, availability)

**Where:** `verifyPassword` (around line 168) calls `scryptSync`; the auth middleware (around
line 3387) calls it on every request once a workspace account exists.

**What:** HTTP Basic replays the credential on every request, so every API call and every
static asset load runs a full scrypt derivation (N=16384, 64-byte output) synchronously on
the event loop. Each call blocks the process for tens of milliseconds.

**Impact:** two consequences.

- Throughput: a page load fetching the SPA bundle, CSS and several API calls serialises a
  scrypt per request. On a shared instance this is visible latency for everyone.
- Denial of service: the derivation also runs for a *wrong* password as long as the email
  exists. Anyone who can reach the port and knows one account email can keep the process
  busy with unauthenticated requests. There is no rate limit and no lockout.

**Fix:** cache successful verifications. Key a small in-memory map by a SHA-256 of the raw
`Authorization` header value, store the resolved user, and expire entries after a few
minutes or on any password change, suspension or deletion. Switch the remaining path to the
asynchronous `scrypt` so a burst of failures does not stall unrelated requests, and add a
per-IP failure counter with a short cooldown.

**Fixed**, all three parts:

- `verifyPassword` is now `async` and derives through `scrypt` on the libuv thread pool
  instead of `scryptSync` on the event loop. Its two callers — the auth middleware and
  `POST /api/session/password` — await it.
- `authCache` holds successful verifications for five minutes, keyed by a SHA-256 of the raw
  `Authorization` header, capped at 500 entries. Only successes are cached, so the map is
  bounded by real accounts. `saveUsers` clears it outright, so a password change, suspension
  or deletion takes effect on the next request rather than at TTL; a hit also re-checks that
  the account is still Active, and the break-glass token is stored as `email: null`.
- `recordAuthFailure` counts failures per address: ten inside a minute buy a 60-second
  cooldown answered with **429** and a `Retry-After`, reached *before* any derivation runs.
  The cooldown is checked after the cache, so an already-verified browser keeps working while
  a guesser on the same address is throttled. Only a credential that was **presented and
  rejected** counts — a request with no `Authorization` header is the first half of the Basic
  handshake and always gets a clean 401, since a page load fires several of those at once and
  would otherwise trip its own cooldown before the user could type a password. That path runs
  no derivation, so exempting it gives up nothing.

The token comparison was corrected in passing: it now compares UTF-8 byte lengths rather than
JavaScript string length, which is what `timingSafeEqual` receives. That closes the
`RangeError`-as-500 on a multi-byte token that security.md warned about.

Measured on a running server: a cold verification takes ~29 ms and a cached one ~1 ms, and an
authenticated request is served in ~12 ms while 25 failing sign-ins are in flight — which
would previously have serialised behind them. Password change, cache invalidation of the old
credential, and rejection of a suspended account were each confirmed.

### 3. Read-only roles can probe the network and guess Oracle passwords (Medium)

**Where:** `POST /api/connections/test` (around line 3637), `POST /api/connections/:id/test`
(around line 3661), `POST /api/connections/:id/disconnect` (around line 3714) and
`POST /api/connections/:id/reconnect` (around line 3722). None carries `requireFullAccess`.

**What:** security.md records that the connection tester dials a caller-supplied host and
port, but describes the caller as a token holder. Analyst and Viewer accounts reach the same
endpoints.

**Impact:**

- A Viewer can use the server as a port scanner and outbound connector from wherever the
  server sits on the network.
- A Viewer can supply a password to `/:id/test` and brute-force the Oracle account behind a
  saved connection through the server, with no rate limit and no log.
- A Viewer can call `/disconnect` or `/reconnect` and drop every pooled session, interrupting
  other users' in-flight work.

**Fix:** add `requireFullAccess` to all four routes. The Data Browser and worksheet do not
need them for read-tier roles.

### 4. Analyst and Viewer can read far more than table data (Medium)

**Where:** every `GET /api/connections/:id/*` route except `/query` and `/explain`.

**What:** the Analyst denial text says "Analyst access is limited to browsing table data",
and Viewer is described as read-only SQL. The role check runs only on `/query` and
`/explain`. These routes are open to both roles:

| Route | Returns |
| --- | --- |
| `GET …/source` | Full PL/SQL source and DDL of any object in the schema |
| `GET …/dba`, `GET …/perf` | v$ and DBA view queries: sessions, top SQL text, tablespaces |
| `GET …/job-runs/:logId/output` | Scheduler job stdout, stderr and binary output |
| `GET …/versions`, `GET …/versions/object`, `GET …/changelog` | The locally stored source history |
| `GET …/routine`, `GET …/table`, `GET …/deps`, `GET …/erd` | Signatures, table designs, dependency graphs |

**Impact:** a role that was meant to see rows can read every package body in the schema, the
SQL text other sessions are running, and the output of scheduled jobs. Whether that is
acceptable is a policy decision, but the current denial message promises a boundary the
server does not enforce.

**Fix:** decide the boundary per role and gate each route explicitly. A reasonable split:
Analyst gets `/schema`, `/schema/group`, `/table/rows` and the preview query only; Viewer
adds `/source`, `/deps`, `/erd`, `/table` and `/explain`; everything touching v$ views, job
output or the version store stays with Administrator and Developer.

### 5. GitHub token is not pinned to a repository (Medium)

**Where:** `POST /api/github/sync` (around line 3580).

**What:** `repositoryUrl`, `branch` and `directory` all come from the request body.
`parseGitHubRepository` only checks the shape of the URL, and `gitHubSourcePath` scrubs
segments so path traversal is not possible, but nothing restricts *which* repository the
server-side `GITHUB_TOKEN` is used against.

**Impact:** any Developer or Administrator can write arbitrary content to any repository and
branch the token can reach. The forced extension list (`pks`, `pkb`, `prc`, `fnc`, `trg`,
`sql`) prevents planting a workflow file, but an existing migration script or deployment SQL
file can be overwritten with attacker-chosen content, under a commit message that looks like
a routine compile. `env.example` tells the operator to scope the token to one repository;
that is the only control and it lives outside the code.

**Fix:** add a `GITHUB_REPOSITORY` (and optionally `GITHUB_BRANCH`) environment variable and
refuse a sync whose target differs. Keep the client-side setting as a display value only.

### 6. Vulnerable dependency: `qs` via express and body-parser (Medium)

**Where:** `package-lock.json`; `npm audit --omit=dev` on 2026-09-02.

**What:** three moderate advisories in `qs` (array-limit bypass via bracket-key comma parsing,
GHSA-x5fp-wj9c-mxmx; denial of service via attacker-controlled `isBuffer`,
GHSA-4mjr-xmp4-gh2g), pulled in through `express@4.22.2` and `body-parser@1.20.x`.

**Impact:** Express parses `req.query` with `qs`, and several routes read query strings
(`/schema/group`, `/deps`, `/source`, `/versions/object`, `/table/*`, `/compile/invalid`), so
the parser is reachable by any authenticated caller.

**Fix:**

```bash
npm audit fix
```

Then re-run the typecheck and build.

### 7. Account enumeration through response timing (Low)

**Where:** the auth middleware (around line 3387).

**What:** `users.get(username.toLowerCase())` is checked first and scrypt runs only when the
user exists. A request for an unknown email answers in under a millisecond; a request for a
known email with a wrong password takes tens of milliseconds. Failed attempts are not
counted, logged or throttled.

**Impact:** an attacker can confirm which email addresses hold accounts before guessing
passwords, and finding 2 removes the cost of the guessing itself.

**Fix:** run the derivation against a fixed dummy salt and hash when the user does not exist,
so both paths take the same time, and log failed attempts with the source address.

### 8. Source history stored with looser protection than credentials (Low)

**Where:** `appendChangeLog` (around line 1395) and `captureCodeVersion` (around line 1481)
call `fs.writeFileSync` without a `mode`; neither file is encrypted.

**What:** `data/versions/*.json` holds the full source of every code object created or
replaced through the worksheet, and `data/changelog.json` records the connection key (host,
port, service, user) for each change. `connections.json` and `users.json` are written with
`0o600`; these are not, and `DATAFORGE_ENCRYPTION_KEY` does not cover them.

**Impact:** PL/SQL source routinely embeds connection strings, wallet paths and API keys.
This working copy lives inside a OneDrive folder, so `data/versions/` is synced off the
machine today. The credentials file is encrypted here and is fine; the version store is not.

**Fix:** write both files with `{ mode: 0o600 }`. Consider encrypting the version store with
the same key when it is configured, or documenting in credentials.md that the sync warning
applies to `data/versions/` as much as to `connections.json`.

### 9. CI actions pinned to tags, not commits (Low)

**Where:** `.github/workflows/ci.yml`.

**What:** `actions/checkout@v4` and `actions/setup-node@v4` are mutable tags.

**Impact:** a compromised or force-moved tag changes what runs in CI with no diff in this
repository. The workflow has no secrets today, so exposure is limited to the build itself.

**Fix:** pin to full commit SHAs and let Dependabot or Renovate raise the bumps.

## Verified as sound

Recorded so the next review does not repeat the work.

- Every dictionary read binds its parameters; the only interpolated SQL fragments are
  constants (`ORA_NOISE_TABLE`, object-type lists, the perf metric names) or identifiers that
  pass `oraIdent` / `identOra` / `quoteIdent`.
- `stripSqlNoise` and `isReadStatement` behave as documented, including q-quotes, quoted
  identifiers and the `WITH … FUNCTION` case.
- Table Designer DDL is allow-listed and rejects interior semicolons.
- Version-file paths scrub every segment; the earlier traversal is closed.
- The registry is AES-256-GCM with a random IV per write; passwords are scrypt-hashed with a
  per-user salt and compared with `timingSafeEqual`.
- `GET /api/connections` strips the password by destructuring.
- The client has no `dangerouslySetInnerHTML` or `innerHTML`; the only external links are
  Oracle help URLs restricted to `http(s)` with `rel="noreferrer"`. No token is stored in
  `localStorage`; the GitHub setting there is URL, branch and path only.
- `POST /api/session/password` (uncommitted) resolves the target from the authenticated
  credential, re-checks the current password, and cannot be aimed at another account.
- The last-resort error handler returns a message only, no stack or path.

## This install, as checked on 2026-09-02

| Item | State |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `DATAFORGE_ENCRYPTION_KEY` | Set |
| `data/connections.json` | Encrypted (version 2 object) |
| `data/users.json` | 2 accounts: one Administrator, one Viewer, so Basic auth is active |
| `data/` and `.env.local` | Ignored by Git |
| Working copy location | Inside a OneDrive sync root; see finding 8 |

## See also

- [security.md](security.md): the security model and the gaps already accepted
- [credentials.md](credentials.md): storage, encryption and migration
- [deployment.md](deployment.md): LAN startup requirements
