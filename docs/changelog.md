# Changelog

All notable changes to Oracle DataForge. Entries are grouped by release date and follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions. This project does not
publish versioned releases yet, so changes are listed by date and pull request.

Dates are the date the change landed on `main`.

## Unreleased

### Added

- **Copy objects from one connection to another.** The Migration tab now opens on a choice —
  **Compare tables**, as before, or **Copy objects** — and the second one takes the same source
  and target and recreates the source schema's objects of one type in the target. One type per
  run, and there are three of them: **sequences**, **tables** and **indexes**, offered in that
  order because it is the order they have to be copied in. Reading both
  dictionaries first shows how many there are and which of them the target already has.
  Which ones to copy is a two-list picker, shaped after SQL Developer's own: everything the
  source has on the left, everything this run will copy on the right, arrows between them, and a
  name filter over the left list — the "move all" arrow moves what the filter is showing, so
  filtering to `SALES_` and pressing it picks a whole family of tables at once. Ctrl-click and
  shift-click pick several, double-click moves one, and a name already in the target is marked as
  such in both lists. It opens with everything picked, which is the copy most people came for.
  A table arrives with its columns, defaults, primary key, unique keys, check constraints and
  foreign keys, and without its rows and its indexes. DDL is read with `EMIT_SCHEMA` off, so
  nothing lands qualified with the source schema, and with `REF_CONSTRAINTS` off — not to drop
  the foreign keys but to defer them. A foreign key names a second table the run may not have
  reached yet (alphabetical order puts plenty of children before their parents), so leaving them
  inside `CREATE TABLE` would fail every child copied before its parent. They are added instead
  by a second pass once every table in the run is there, one constraint at a time, so a key
  pointing at a table nobody copied is one reported line rather than a failed table. Ones the
  target already has are left alone, which is what makes re-running a copy safe. Qualification a
  *developer* wrote (a default calling `HR.ORDER_SEQ.NEXTVAL`) is rewritten to the target schema
  by a scan that skips string literals and comments.
  An index run copies the indexes somebody wrote a `CREATE INDEX` for, and only onto a table the
  target already has. The ones Oracle made for a primary or unique key are left out: that index
  is created by the constraint and arrives with the table, so copying it again would be a second
  index over the same columns — as are LOB and index-organized-table internals, system-named
  indexes and indexes on another schema's table. An index whose table is not in the target is
  reported as a skip naming that table, and the picker marks it before the run starts rather
  than letting Oracle answer with an ORA-00942 that names neither the index nor the table it
  wanted. Copy the tables, then the indexes. Replacing an index is a rebuild rather than a
  deletion, and the confirmation dialog says so instead of the sentence it uses for tables.
  A sequence arrives at the number the source's has reached rather than at the number it
  started from, so the copy carries on from where the source is instead of handing out values
  the source has already used — which is also what makes replacing an existing sequence the
  dangerous choice, since a target sequence that has gone further is reset backwards and its
  next values collide with rows that are already there. The dialog says that in place of the
  sentence it uses for a table. The sequences Oracle creates for identity columns are left out
  of the listing: they belong to the table and arrive with it. And because a sequence occupies
  no segment, the tablespace choice is not offered for it at all — the checkbox is absent and
  the dialog says nothing about tablespaces — rather than being offered and quietly ignored.
  **Keep the source tablespace** is a choice, off by default. Off, the segment clause is
  suppressed entirely and objects land in the target's default tablespace — which is what lets a
  production table land on a laptop, since a `TABLESPACE "USERS_DATA"` clause fails outright on a
  database that has no such tablespace. On, each object is created where it lives in the source,
  for a copy between two databases laid out the same way. Storage sizing (`INITIAL`, `NEXT`) is
  left to the target either way: where a table lives is a different question from how much room
  the source gave it. The confirmation dialog says which of the two is about to happen.
  Objects the target already has are left alone by default; the other choice drops and recreates
  them, and is presented as the destructive operation it is — the confirmation dialog counts them
  and says that a dropped table takes its rows with it and does not reach the recycle bin. A
  failure does not stop the run: unlike a table migration script, this is hundreds of independent
  objects, so every one is attempted and every outcome — created, replaced, skipped, failed, with
  the Oracle error — is reported, which is also what makes re-running it useful. The skipped are
  grouped by the reason they were skipped, smallest group first: "already in the target" two
  hundred times is one line, and the handful whose table has not been copied yet is the line
  worth reading.
  Both endpoints are addressed by the target connection, so read-only mode, the
  Oracle-maintained-schema refusal, the workspace role check and the write guard already covered
  it. The copy runs on the backend and survives switching tabs. The kind catalogue, the statement
  preparation (a `CREATE TABLE`'s trailing `;` is a terminator, a PL/SQL block's is part of the
  block), the whitelist that keeps a picked name honest (it ends up inside `GET_DDL` and a
  `DROP`, so it has to be in the source's own listing) and the schema rewrite live in
  `server/objectCopy.ts` with 60 tests, because each is a mistake that looks like a success
  rather than an error. Caps and what the copy deliberately leaves out are in
  [known_limitations.md](known_limitations.md#copying-objects-between-connections).

- **Choose the connection's role, the way SQL Developer does.** The connection wizard now has a
  **Role** dropdown beside the username, offering the same list SQL Developer does — `default`,
  `SYSDBA`, `SYSOPER`, `SYSBACKUP`, `SYSDG`, `SYSKM`, `SYSASM` — and every session the
  connection opens is opened with that privilege. It is what lets an administrator reach a
  database that is only mounted, and what lets a backup, Data Guard, key management or ASM
  account connect at all, without granting any of them the unrestricted `SYSDBA` that used to be
  the only privilege the app could ask for. `SYS` still gets `SYSDBA` on its own at `default`
  (Oracle refuses anything else for it), so connections saved before this field existed keep
  working unchanged, and the wizard's summary names the role the session will really open with.
  The role is stored, exported and imported with the rest of the connection, shown in the
  Explorer tooltip and in the export and import lists, and testing the connection reports the
  role it connected as. Because a privileged session cannot come from a pool, a connection with
  a role opens a standalone connection per request — the behaviour `SYS` already had, now
  reached by the same code path for every role. It describes the session rather than the
  destination, so it is deliberately not part of the endpoint identity guarding a stored
  password: changing the role does not force the password to be retyped.

- **Connect to Oracle Autonomous Database with an Oracle Cloud wallet.** The connection wizard
  now opens on a choice — **Host and port**, as before, or **Oracle Cloud wallet** — and the
  second one replaces the endpoint fields with the zip Oracle Cloud hands you. Upload it and
  the backend unpacks it, reads its `tnsnames.ora`, and offers the services inside as a list;
  pick one (`_high`, `_medium` or `_low` are the same database at different consumer groups),
  add the database username and password and the wallet password, and the connection behaves
  like any other from there. Nothing else in the app had to learn about wallets: the host and
  port shown in the Explorer are what the alias resolved to, so tabs, history, the migration
  assistant and duplicate detection all keep working on the same fields they always used.
  No Oracle Instant Client is involved — node-oracledb's Thin mode reads the PEM wallet
  directly, which is also why an *auto-login* wallet (`cwallet.sso`, no `ewallet.pem`) is
  refused at upload with a message that says what to download instead.
  The wallet never reaches the browser. It is unpacked into `data/wallets/<id>/` (`0700`,
  files `0600`), keeping only the two files Thin mode reads and discarding the SSO wallet, the
  PKCS#12 wallet and the Java keystores — an unused copy of a private key is still a key to
  lose. Wallets are reference-counted, so three connections may share one, and a wallet
  nothing points at is swept up (after an hour's grace, so a wallet uploaded in one tab
  survives a registry change made in another) the next time a connection is saved, edited,
  deleted or imported — including one uploaded into a wizard that was then cancelled. The wallet password
  is stored and replayed exactly like the database password: encrypted with the registry,
  never returned by `GET /api/connections`, and reusable only for the endpoint it was saved
  against — which now counts the wallet itself, since swapping in a different wallet points
  the same alias at a different database. Connection export carries wallets inline, so an
  exported wallet connection restores on a machine that has never seen the zip; the import
  preview marks those entries, and the wallet lands under an id the receiving server issues.
  [credentials.md](credentials.md#oracle-cloud-wallets) covers storage and the export format,
  [known_limitations.md](known_limitations.md#oracle-cloud-wallets) what the wallet support
  does not do.
- **A zip reader and a `tnsnames.ora` parser, tested.** Both live in `server/oracleWallet.ts`,
  apart from the rest of the backend for the same reason the export envelope is: their input
  is a file someone uploaded. `npm test` now runs 22 more cases covering what a bad file does
  — a non-zip, a truncated one, an encrypted one, a decompression bomb, a wallet with no PEM,
  a PEM with no key, an entry named `../../../../etc/ewallet.pem` — alongside the parser
  reading multi-line descriptors and not mistaking the `host=` inside one for an alias. The
  reader supports stored and deflated entries and refuses everything else outright rather than
  guessing, which is the whole of what an Oracle-written wallet zip needs.
- **Export saved connections to a passphrase-encrypted JSON file.** The lock icon beside
  **Connections** in the Explorer (and **Export connections…** in a connection's context menu)
  picks any subset of the saved connections, asks for a passphrase twice, and downloads
  `dataforge-connections-<date>.json`. Until now the only copy of a connection's credentials
  was `data/connections.json`, encrypted with a key that lives in this machine's environment —
  useless on any other machine, and nothing to hand to a colleague setting up the same
  databases. The export is the portable form. The browser has no passwords to encrypt, so it
  does not build the file: it sends the passphrase, and the server derives a key with scrypt
  (N=2^15, r=8) and returns AES-256-GCM ciphertext, so nothing readable ever reaches the page.
  Full access only, a 12-character minimum on the passphrase — an export file is attacked
  offline, unlike an account password — and every export is logged to the server console.
- **Import connections from an encrypted export.** The other half of the same feature: pick the
  file, type its passphrase, and **Unlock file** shows what is inside — names, servers, users,
  read-only flags, and nothing else, because the decryption happens on the backend and
  passwords do not travel to the browser even in a preview. Nothing is written until you press
  Import, so the wrong file or a mistyped passphrase costs a click. An entry pointing at a
  server, port, user and service you already have saved is marked **ALREADY SAVED** and is
  skipped by default; choosing *Replace with the file* overwrites that connection in place,
  keeping its id so open tabs stay pointed at it. The uploaded file is treated as untrusted
  input throughout — the scrypt parameters it carries are range-checked before a key is
  derived, the payload is bounded and capped, and every entry is validated exactly like one
  typed into the connection wizard. [credentials.md](credentials.md#exporting-connections-to-an-encrypted-file)
  documents the format, the import rules, and how to decrypt a file by hand with Node.
- **The project's first automated tests**, covering that export/import crypto: `npm test`,
  21 cases on Node's built-in test runner with no new dependency and nothing to stand up.
  They check the round trip (unicode passwords included), that a wrong passphrase or a single
  flipped bit fails instead of returning something plausible, that no plaintext survives in a
  written file, and that a hostile file cannot choose this process's scrypt parameters. To
  make them possible the envelope moved to `server/connectionExport.ts` — the backend is now
  one file plus one small pure module, rather than strictly one file.
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

- **Fixed the three Low findings from the 2026-09-02 security review.**
  - An unknown or suspended sign-in used to fail before scrypt ever ran, sub-millisecond,
    while a known email with a wrong password waited on the derivation first — enough of a
    gap to enumerate account emails before ever guessing a password. The short-circuit path
    now runs the same derivation against a fixed dummy credential, so every rejected sign-in
    costs the same wall-clock time regardless of why it was rejected. Every failure is also
    logged with the source address and the attempted username — there was no server-side
    record of failed sign-ins at all before this.
  - `data/versions/*.json` and `data/changelog.json` — which hold the full source of every
    compiled code object and the connection details each change was made against — are now
    written with mode `0o600`, matching `connections.json` and `users.json`. Neither is
    encrypted by `DATAFORGE_ENCRYPTION_KEY` (that key covers the connection registry only);
    `credentials.md` now says so explicitly, since the same "keep `data/` out of synced
    folders" guidance already covers these files too.
  - CI's two actions are pinned to the commit SHA their `v4` tags currently resolve to,
    instead of the mutable tag itself, with a new `.github/dependabot.yml` watching for
    updates so the pins don't just go stale.
  See [security.md](security.md#authentication),
  [credentials.md](credentials.md#the-version-store-carries-the-same-risk-unencrypted), and
  [security-review-2026-09-02.md](security-review-2026-09-02.md) for the fixed writeups.
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
