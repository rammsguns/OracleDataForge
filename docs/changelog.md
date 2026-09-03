# Changelog

All notable changes to Oracle DataForge. Entries are grouped by release date and follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions. This project does not
publish versioned releases yet, so changes are listed by date and pull request.

Dates are the date the change landed on `main`.

## Unreleased

### Added

- **A permanent find strip in the PL/SQL editor, in SQL Developer's shape.** The object editor's
  search is now always on screen above the code rather than a popover only Ctrl+F could
  summon, and it carries the options SQL Developer offers: the **3 of 12** position of the
  current hit, **match case**, **whole word**, **regular expression**, and **highlight every
  match** painted into the syntax layer. A word boundary is Oracle-aware — `$` and `#` count
  as identifier characters, so `session` does not match inside `v$session`. The editor's action
  buttons (Find, Compile, Compile All, Run / Test) became flat icon buttons in one strip to
  match. Fixes a bug on the way: replace-all was hard-coded to a case-insensitive search and
  ignored the options entirely, so it could change more than find had shown you.
- **Change your own password from the app.** The role chip in the title bar now opens an
  **Account** dialog showing who the server authenticated you as, with a change-password form
  behind it. It is the one account action that is *not* Administrator-only — a Developer,
  Analyst or Viewer no longer has to ask someone else to rotate their credential — and it only
  ever touches the account the request authenticated as, with the current password required
  again so a session left unattended cannot lock its owner out. Because authentication is HTTP
  Basic there is no session to re-issue: the dialog says plainly that the browser is still
  sending the old password and you have to sign in again.
- **Edit data: insert, update and delete rows from the Data Browser.** A table's Data tab now
  has an **Edit data** toggle (and an **Edit data…** entry in the tree's table context menu)
  that swaps the read-only preview for an editable grid — edit a row in place, delete it, or
  add a new one. Rows are identified by **ROWID** rather than the primary key, so a table
  without one is still editable and changing a key column does not lose the row. Each change is
  one statement that goes through the same write guard as everything else: the first call is
  unacknowledged and comes back as the confirmation dialog's wording, and only the user's
  confirmation runs it. Column names are matched against the data dictionary and every value is
  bound, so nothing from the request becomes SQL. Columns the grid cannot round-trip losslessly
  — LOBs, RAW, VECTOR, time-zone timestamps, virtual and GENERATED ALWAYS identity columns —
  are shown read-only with the reason, rather than silently writing their rendered preview back.

### Fixed

- **Dates and timestamps were displayed shifted by the machine's UTC offset.** node-oracledb
  builds a JavaScript `Date` from the Oracle value's own components in the process's local
  zone, and the server then formatted it with `toISOString()` — re-reading those local
  components as UTC. On a UTC-6 machine a `DATE` stored as `09:15` was shown everywhere as
  `15:15`. An Oracle `DATE` carries no time zone to convert into, so the local components are
  now formatted back unchanged. This affected every grid, export and preview in the app, and
  would have made the new row editor move a date by the offset on every save.

### Security

- **Fixed the four Medium findings from the 2026-09-02 security review.**
  - `POST /api/connections/test` — the connection tester with no saved connection behind it,
    dialing whatever host and port the caller supplies — now requires Administrator or
    Developer. `POST /:id/test`, `/disconnect` and `/reconnect` stay open to every role on
    purpose: gating them was tried once (PR #11) and reverted the same day because it broke
    basic browsing for Analyst and Viewer, who need to open a session before any read can
    happen. That reasoning still stands, so only the one route without that justification
    changed.
  - Every `GET /api/connections/:id/*` route that wasn't already covered by `/query`'s SQL
    classifier now has its own role gate. Analyst is limited to `/schema`, `/schema/group`
    and `GET .../table/rows`, matching the ceiling its denial message already promised.
    Viewer additionally reaches object source, dependencies, ERD, table/routine design and
    stats. Everything touching v$ views, scheduled-job output, or the local source-version
    store — `/dba`, `/perf`, `/versions`, `/versions/object`, `/changelog`,
    `/job-runs/:logId/output` — stays Administrator/Developer only.
  - `POST /api/github/sync` now requires a `GITHUB_REPOSITORY` (`owner/repo`) whenever
    `GITHUB_TOKEN` is set — the server refuses to start otherwise — and refuses any sync
    whose repository (or, if `GITHUB_BRANCH` is also set, branch) doesn't match, with 403
    before any GitHub API call. Previously the request body's `repositoryUrl` was the only
    thing selecting the target, so any Developer or Administrator could point a sync at any
    repository the token could reach. The client's repository setting is unchanged — it's a
    display value now, and a mismatch surfaces through the existing best-effort sync-failure
    toast rather than breaking the compile it rode in on.
  - The three moderate `qs` advisories (reachable through Express's query-string parsing on
    routes like `/schema/group`, `/deps`, `/source`) are resolved via an npm `overrides` entry
    pinning `qs` to `6.16.0` — the version npm's own advisory data names as fixed for both.
    `npm audit fix` was a no-op here: `qs@6.15.3` was already the newest version Express
    4.22.2's dependency range permitted, and reaching `6.16.0` needed either the override or a
    breaking major-version bump to Express, which was out of scope for a dependency patch.
  See [security.md](security.md#beyond-query-what-the-read-tiers-can-browse),
  [security.md](security.md#github-sync), and
  [security-review-2026-09-02.md](security-review-2026-09-02.md) for the fixed writeups.
- **A host guard closes a DNS-rebinding hole in the same-origin check.** The origin guard
  compared `Origin` against `Host`, and a browser fills both in from the same URL — so they
  always agreed, including for a page the operator never meant to trust. A site that
  re-pointed its own DNS record at `127.0.0.1` after loading matched itself and reached the
  whole API: the connection list, arbitrary SQL with `confirm: true`, and `POST /api/users` to
  plant an Administrator on an install that had none. Every request's `Host` header must now
  name this server or it is refused with 403, checked ahead of authentication so the
  unauthenticated bootstrap state is covered too. Loopback, the configured `HOST` and any
  literal IP address are accepted — rebinding needs a *name* to re-point, so a LAN install
  reached by address is unaffected — and reaching the app by DNS name means listing that name
  in the new `DATAFORGE_ALLOWED_HOSTS`. See
  [security.md](security.md#the-host-guard) and [deployment.md](deployment.md).
- **Authentication no longer runs scrypt on the event loop for every request.** HTTP Basic
  replays the credential on each API call and each static asset, and the derivation ran
  synchronously for a wrong password just as long as for a right one — visible latency on a
  shared instance, and a denial of service for anyone who knew a single account email. The
  derivation now runs off-thread, a successful verification is cached for five minutes (keyed
  by a hash of the `Authorization` header, and cleared outright whenever any account changes),
  and ten rejected credentials from one address buy a 60-second cooldown answered with 429
  before any derivation runs. A cached credential is honoured during that cooldown, so a
  throttled guesser does not lock out a browser already signed in, and a request carrying no
  credential — the first half of every Basic handshake, several per page load — always gets a
  clean 401 rather than counting against the limit. Measured: ~29 ms cold, ~1 ms cached,
  and an authenticated request served in ~12 ms while 25 failing sign-ins were in flight.
  Fixes in passing a multi-byte `DATAFORGE_AUTH_TOKEN` returning 500 instead of 401, by
  comparing UTF-8 byte lengths rather than JavaScript string length.
  See [security.md](security.md#authentication).
- **Workspace roles are now enforced server-side, not just by the client's tab-gating.** The
  role picker used to be a client-chosen `localStorage` value — trivially bypassed by anyone
  editing storage or calling the API directly. The server now authenticates named accounts
  (HTTP Basic, `data/users.json`, scrypt-hashed passwords) and enforces Administrator/Developer,
  Analyst, and Viewer independently on every endpoint: write/DDL/GitHub-sync endpoints require
  full access, Viewer is restricted to read statements, and Analyst is restricted to the exact
  single-table preview the Data Browser generates. A guard refuses any change that would leave
  zero active Administrators. Until the first account is created, the app behaves exactly as
  before. See [security.md](security.md#workspace-roles).
  ([#10](https://github.com/rammsguns/OracleDataForge/pull/10))

## 2026-08-22

### Added

- **Administration and GitHub PL/SQL sync.** An Admin workspace for managing users and roles,
  and an optional PL/SQL Repository workspace that syncs successfully compiled objects to a
  configured GitHub repository through the backend (`GITHUB_TOKEN` stays server-side).
  ([#2](https://github.com/rammsguns/OracleDataForge/pull/2))
- **Response compression.** The backend serves the built SPA itself, and was shipping the
  ~946 kB bundle uncompressed. gzip is now applied to responses above 1 kB, measured at
  **4.56× on first load** (989 kB → 217 kB) and applying equally to large JSON result
  payloads. ([#9](https://github.com/rammsguns/OracleDataForge/pull/9))
- **CI.** A GitHub Actions workflow (`.github/workflows/ci.yml`) runs `npm ci`,
  `npm run typecheck`, and `npm run build` on every push and pull request against `main`.
  ([#9](https://github.com/rammsguns/OracleDataForge/pull/9))

### Changed

- **The schema tree's dedicated-type queries run on two connections instead of one.** The
  twelve independent dictionary queries for synonyms, DB links, directories, editions, and
  similar categories ran in a fully serial loop. They now split across two pooled connections,
  roughly halving that portion of tree-load latency on a large schema.
  ([#9](https://github.com/rammsguns/OracleDataForge/pull/9))
- **Migration assistant concurrency now matches the pool.** The client fetched table metadata
  6-at-a-time against a pool capped at 4, leaving two requests queued in the driver at all
  times. The client cap is now 4. ([#9](https://github.com/rammsguns/OracleDataForge/pull/9))

### Security

- **The `WMT_RETAIL` connection's password is now encrypted at rest.** It had been saved in
  clear text in `data/connections.json` under the default loopback configuration. With
  `DATAFORGE_ENCRYPTION_KEY` set and the connection re-saved, the file now stores an
  AES-256-GCM envelope instead of a plaintext password. See [credentials.md](credentials.md)
  for the same steps applied to any other saved connection.

## 2026-08-21

### Fixed

- **A fresh clone could not be built.** A bare `data/` pattern in `.gitignore` matches at any
  directory depth in Git, so it covered `src/data/` as well as the runtime directory it was
  written for. `src/data/catalog.ts` was therefore never committed, and `npm run typecheck`
  and `npm run build` both failed on four unresolved imports in a new checkout. The pattern is
  now anchored to `/data/`. ([#3](https://github.com/rammsguns/OracleDataForge/pull/3))
- **Container detection misfired on host installs.** `IN_CONTAINER` tested
  `NODE_ENV === "production"`, which the supported host production install sets. Every
  connection-refused error in that setup advised using `host.docker.internal`, an address that
  does not resolve outside a container. It now tests for `/.dockerenv`.
  ([#4](https://github.com/rammsguns/OracleDataForge/pull/4))
- **A comment described the inverse of the server's bind behaviour.** The `listen()` comment
  claimed the server listens on every interface by default; it binds `127.0.0.1`, and
  `0.0.0.0` is opt-in. ([#6](https://github.com/rammsguns/OracleDataForge/pull/6))

### Changed

- **The demo catalog is gone.** `ENGINE_LABEL`, `schemaForConnection()`, and the canned
  example snippets went with the lost `src/data/catalog.ts` rather than being reconstructed.
  The schema tree now falls back to an empty schema instead of sample content, the Query
  History panel drops its example-snippets column, and the single-entry engine label is
  rendered literally. This finishes a direction the code had already taken — only live
  connections have survived a reload for some time.
  ([#3](https://github.com/rammsguns/OracleDataForge/pull/3))
- **The Node requirement is declared.** `package.json` gained `"engines": { "node": ">=22" }`,
  so npm reports `EBADENGINE` at install time instead of letting an older runtime fail later
  in ways that do not point back at the cause.
  ([#6](https://github.com/rammsguns/OracleDataForge/pull/6))

### Added

- **A warning when credentials are stored unencrypted.** `DATAFORGE_ENCRYPTION_KEY` is
  optional on loopback, so a default local install writes Oracle passwords to
  `data/connections.json` in clear text. The server now says so once at startup (only when
  saved connections exist) and once on the first plaintext write, naming the file and giving
  the command to generate a key. Storage behaviour is unchanged.
  ([#6](https://github.com/rammsguns/OracleDataForge/pull/6))

### Removed

- **The Docker deployment path.** `Dockerfile`, `Dockerfile.prebuilt`, `docker-compose.yml`,
  and both `.dockerignore` files were deleted, along with the README section documenting them.
  The compose file could not boot as shipped — it set `HOST=0.0.0.0` while supplying neither
  `DATAFORGE_AUTH_TOKEN` nor `DATAFORGE_ENCRYPTION_KEY`, which the startup guard rejects — and
  node-oracledb Thin mode means there are no native client libraries to bundle, which is the
  usual reason a database tool ships a container. See [deployment.md](deployment.md) for the
  supported paths. ([#4](https://github.com/rammsguns/OracleDataForge/pull/4))

### Documentation

- README now states the full prerequisite list (Node and npm only — nothing in the dependency
  tree compiles native code), documents the npm install-scripts approval step, and states
  plainly that a default local install stores passwords in clear text.
  ([#5](https://github.com/rammsguns/OracleDataForge/pull/5))

## 2026-08-19

### Added

- Scheduler job support, including the Job Run Log panel
  (`src/components/JobRunLog.tsx`). ([#1](https://github.com/rammsguns/OracleDataForge/pull/1))

### Changed

- Improved connection controls in the Explorer sidebar.
  ([#1](https://github.com/rammsguns/OracleDataForge/pull/1))

## 2026-08-18

### Added

- Initial Oracle-only IDE, extracted from the Oracle functionality of InsightDB AI Suite. The
  extraction removed every alternate database engine, AI assistant, model-provider
  integration, and enterprise control-plane dependency. See
  [architecture.md](architecture.md) for what the remaining system looks like.

---

## Maintaining this file

Add an entry when a change affects someone using or deploying the project — behaviour, a
default, a requirement, or a removed capability. Internal refactors that change nothing
observable do not need one.

Group entries under `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`, or
`Documentation`, and link the pull request. Write what changed and why it mattered; a reader
scanning for the cause of surprising behaviour is the audience.
