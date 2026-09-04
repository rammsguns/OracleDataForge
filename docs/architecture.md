# Architecture

Oracle DataForge is a two-process application: a React single-page frontend and an Express
backend that owns every Oracle session. About 20,300 lines of TypeScript across `src/` and
`server/`.

The shape is deliberately flat. There is no router, no state-management library, no ORM and
no service layer. The backend is **one file plus two modules**: `server/index.ts` holds every
route, while `server/connectionExport.ts` (the encrypted-export envelope) and
`server/oracleWallet.ts` (reading an Oracle Cloud wallet zip and its `tnsnames.ora`) sit
apart — the pieces of backend logic pure enough to test without a server around them, and
the pieces whose input is a file someone uploaded. They are also all the test suite covers;
the rest of the backend is still verified by hand.

## Layout

```text
index.html                       SPA entry; mounts #root, loads src/main.tsx
vite.config.ts                   dev server, /api proxy, watch-ignore rules
tsconfig.json                    app config (src/)
tsconfig.server.json             server config (server/)
server/index.ts                  the backend: routes, registry, guards — 6,017 lines
server/connectionExport.ts       the encrypted-export envelope, kept pure so it can be tested
server/connectionExport.test.ts  its tests — `npm test`, node:test, no framework
server/oracleWallet.ts           Oracle Cloud wallet zip reader and tnsnames.ora parser
server/oracleWallet.test.ts      its tests, run by the same `npm test`
src/                             the entire frontend
data/                            runtime state, gitignored
dist/                            built SPA, served by the backend in production
```

## The two processes

In **development**, Vite serves the frontend on 5173 and proxies `/api` to the backend on
3001. Both must run.

In **production**, `npm run build` emits `dist/`, and the backend serves it directly — a
single process on one port. Vite is not involved. `express.static(dist)` is mounted with an
SPA catch-all that explicitly excludes `/api/`, so client-side routes fall back to
`index.html` while API 404s stay real 404s.

The backend is **never compiled**. Both `dev:server` and `start` run `tsx` over the
TypeScript source, which is why `tsconfig.server.json` is `noEmit` — it exists to type-check,
not to build.

## Frontend

### State

`src/state/store.tsx` (699 lines) is a single React Context store — no Redux, no Zustand, no
reducer. `useStudio()` throws if called outside the provider, and every component uses it. The
context value is a `useMemo` over roughly forty fields covering theme and layout, connections,
tabs, the worksheet, explain plans, history, toasts, confirmation dialogs, and modals.

Three `localStorage` keys persist client state: connections, history (capped at 200 entries),
and layout. **Only connection metadata is stored — never passwords.** On load, only entries
marked `live` survive, and all are forced back to `status: "idle"`, so a reload never claims a
session that isn't open. The store then reconciles against the backend registry and repairs a
dangling active-connection id.

One detail worth knowing: `schemaOf(conn)` returns the connected **user**, uppercased — not
the service name. The schema you browse is the Oracle user you authenticated as; `FREEPDB1`
identifies the database service, not a schema.

### Tabs

`TabKind` is a fourteen-member union: `worksheet`, `data`, `object`, `run`, `tabledesign`,
`erd`, `history`, `perf`, `migration`, `dba`, `deps`, `versions`, `compile`, `joblog`. A tab
carries an optional `payload` holding the object or table name.

`openTab` **deduplicates on kind + payload**, so re-opening an object focuses the existing tab
rather than stacking duplicates. Closing a dirty tab routes through a confirmation and
discards its edit buffer. Closing the last tab resets to a single worksheet.

Inactive tabs **unmount**. That is why `src/utils/` contains three buffer modules —
`editBuffers.ts`, `tableBuffers.ts`, `runBuffers.ts` — plus `compileRuns.ts`. They are
module-level `Map`s keyed by `${connId}.${name}` that hold editor and run state for tabs that
aren't currently mounted. Without them, switching tabs would discard in-progress edits.

### Components

Twenty-two files in `src/components/`. The largest by far is `TableDesigner.tsx` (2,467
lines), then `Sidebar.tsx` (963). `Workspace.tsx` is the tab host and maps each `TabKind` to
its component.

There are **two separate editors**: `SqlEditor.tsx` for the worksheet and `CodeEditor.tsx`
for PL/SQL objects (with find/replace and an imperative `goTo(line, col)` handle). Both share
tokenizing and windowed highlighting.

Types are split by purpose rather than merged: `src/types.ts` holds UI shapes, while every
wire/DTO type lives in `src/utils/api.ts` alongside the typed fetch client. The two files do
not import each other.

## Backend

Middleware order is: host guard → gzip compression → Basic auth → same-origin guard →
`express.json({ limit: "16mb" })` → routes → error handler → static `dist/`. The host guard
comes first because the origin guard downstream compares `Origin` against `Host`, and
because running ahead of auth is what covers the unauthenticated bootstrap state. Compression
is registered next so it still covers the static SPA mounted last.

All data routes are namespaced `/api/connections/:id/…` and begin with the same registry
lookup and 404.

| Area | Endpoints |
| --- | --- |
| Health | `GET /api/health` |
| Session | `GET /api/session` — the role the server authenticated this caller as; `POST /api/session/password` — change your own password (any role) |
| Users | list, create, update, `:id/status`, delete — Administrator-only |
| Connections | list, test, test-existing, create, update, delete, disconnect, reconnect; `POST /api/connections/export`, `POST /api/connections/import/preview`, `POST /api/connections/import` — passphrase-encrypted backup and restore of the saved connections (full access only) |
| Wallets | `POST /api/wallets` — unpack an uploaded Oracle Cloud wallet zip and list the services in it; `GET /api/wallets/:id` — the services of one already stored (both full access only) |
| Schema | `GET …/schema`, `GET …/schema/group?label=` |
| Query | `POST …/query`, `POST …/explain` |
| Compile | `POST …/compile`, `GET …/compile/invalid`, `POST …/compile/invalid` |
| Object source | `GET …/source?name=&type=` |
| Routines | `GET …/routine`, `POST …/routine/run` |
| Table design | `table`, `table/apply`, `table/stats`, `table/storage`, `table/advisor`, `table/maintenance` |
| Row editor | `GET …/table/rows?name=` (rows + their ROWIDs), `POST …/table/rows` (insert / update / delete one row) |
| Import | `POST …/import` |
| Analysis | `dba`, `perf`, `deps`, `erd` |
| Versions | `versions`, `versions/object`, `changelog` |
| Jobs | `GET …/job-runs/:logId/output` |
| GitHub sync | `POST /api/github/sync` — writes compiled PL/SQL to the repository pinned by `GITHUB_REPOSITORY` |

`src/utils/api.ts` mirrors this one-to-one.

**There is no migration endpoint.** The Oracle-to-Oracle migration assistant is composed
entirely on the client from table metadata read off two connections, with the diff and sync
script computed locally in `src/utils/tableCompare.ts`.

## Oracle integration

The driver is `oracledb` 7 in **Thin mode** — pure JavaScript, no Instant Client.

**Pooling.** One pool per saved connection, created lazily (`poolMin: 0`, `poolMax: 4`,
`connectTimeout: 8`). The pool handle lives inside the registry entry, so pools are
process-wide and per-connection. Every call site closes its connection in a `finally`.

**`SYS` bypasses the pool entirely** and gets a standalone `SYSDBA` connection per use.

**Two ways to reach a database**, carried on the connection's `authMode`. A `basic`
connection dials the `host:port/service` connect string. A `wallet` connection connects
through an Oracle Cloud wallet instead: `database` holds a `tnsnames.ora` alias rather than a
service name, and the driver is handed `configDir` (so the alias resolves) and
`walletLocation` / `walletPassword` (so mutual TLS completes), all pointing at
`data/wallets/<id>/`. Thin mode reads the PEM wallet, which is why the uploaded zip's
`cwallet.sso` and `ewallet.p12` are discarded and its `ewallet.pem` is required. The host and
port stored on a wallet connection are what its alias resolved to when it was saved — they
are what the UI shows and what duplicate detection compares, never what is dialled.

**The registry** is an in-memory `Map` persisted to `data/connections.json`, in one of two
formats: a plain array, or an AES-256-GCM envelope. Plaintext is refused outright when `HOST`
is not loopback. See [credentials.md](credentials.md).

**Sessions are lazy.** Nothing opens until a query, explain, or schema read runs — the UI only
flips to `connected` after a statement actually reaches the database. `disconnect` closes
pools while keeping the saved connection, and reports whether anything was open, so the UI can
distinguish "disconnected" from "already disconnected". The Explorer deliberately does not
reopen a pool for a connection the user set to idle.

**Rows.** `MAX_ROWS` is 1000; the server fetches 1001 to detect truncation and flags it.
Statements that return no result set produce a synthetic one-column "N row(s) affected".

## The write guard

The central safety mechanism: **nothing that changes the database runs unless the request
carries `confirm: true`.**

A three-level classifier — `read`, `write`, `destructive` — decides what a statement does, and
the **server authors the confirmation wording** so there is one classifier and no client/server
drift.

Two response conventions exist, which is easy to trip over:

- `POST /query` keeps the 200-with-embedded-error convention and returns a
  `CONFIRM-REQUIRED` error plus the confirmation payload.
- Every other mutating endpoint returns **HTTP 409**, which the API client converts into a
  thrown `ConfirmRequiredError`.

**Caveat, stated honestly:** the "server always words the dialog" rule holds for the query,
compile, and routine paths, but several Table Designer and Object Editor paths call the
confirmation dialog with their *own* wording and then pass `confirm: true` through. The
server-side gate still applies; only the wording is local.

Independently of the guard, **read-only connections are hard-blocked before classification**
on every mutating endpoint. New connections default to read-only in both the wizard and the
server-side config parser. `explain` also refuses to plan a non-read statement, because
building a plan writes to `plan_table`.

## The SQL classifier

Worth understanding, because it is the thing standing between a typo and a dropped table.

`stripSqlNoise()` blanks comments and string literals in a **single left-to-right scan** — not
chained regex replaces — while preserving quoted identifiers, and handles Oracle q-quotes.
Order matters: replacing comments before literals would let `… ename = '--' FOR UPDATE`
swallow the rest of the statement.

A statement counts as a read only if it starts with `select`, `with`, `show`, `desc`,
`describe`, or `explain` **and** contains no write verb. `WITH … FUNCTION|PROCEDURE` — Oracle
12c+ inline PL/SQL — is always treated as a write, since it can do anything.

Everything else falls through to destructive (`drop`, `truncate`, `delete`, `alter`, `grant`,
`revoke`, `rename`, `flashback`, `purge`) or write. **Anything unrecognized defaults to
write.** For batches, the worst level wins: one `DROP` makes the whole batch destructive.

A deliberate client-side mirror in `src/utils/sql.ts` avoids a round trip for obvious reads.
Its own comment states the backend stays authoritative and the verb lists must be kept in
sync — a known duplication, consciously accepted.

## Local version history

Only **code objects** are versioned: procedures, functions, packages, package bodies, and
triggers. Tables and data are out of scope by design.

After every successful query, a change detector looks for a `CREATE` or `DROP` of a code
object. On a hit it fetches the canonical source from the data dictionary, hashes it, and
appends a version — **skipping no-op recompiles** when the hash is unchanged. The whole path
is wrapped so that versioning can never break the query that triggered it.

Objects are keyed by `engine_host_port_database_user` rather than connection id, so history
survives deleting and recreating a connection to the same database. Every filename segment is
sanitized; the code notes this explicitly as the fix for a path-traversal through the `type`
query parameter.

Storage is one JSON file per object under `data/versions/`, plus `data/changelog.json` capped
at 1000 entries.

## Security boundary

- **A host guard** refuses any request whose `Host` header does not name this server — the
  thing that makes the origin guard below meaningful, since a rebound DNS record otherwise
  lets a page satisfy that check with its own name.
- **HTTP Basic auth**, comparing either the break-glass `dataforge` / token pair or a workspace
  account's email/password (`timingSafeEqual`, scrypt). Required once a token is set or the
  first workspace account exists; open on a bare loopback install. Because Basic replays the
  credential on every request, a verified result is cached briefly and the scrypt derivation
  runs off the event loop, with a per-address cooldown on repeated failures.
- **Four roles enforced server-side** (Administrator, Developer, Analyst, Viewer) — see
  [security.md](security.md#workspace-roles) for exactly what each can call, including the
  per-route metadata gating beyond `/query` and `/explain`.
- **A same-origin guard** rejects requests carrying a foreign `Origin`, allowing only this
  host and the dev origins. It replaced a wildcard CORS setup.
- **Non-loopback binding throws at startup** unless both the auth token and encryption key are
  present. The same posture applies to GitHub sync: the server refuses to start with
  `GITHUB_TOKEN` set and `GITHUB_REPOSITORY` unset.

Details in [security.md](security.md).

## Build tooling

Vite with the React and Tailwind v4 plugins — Tailwind is configured through the plugin, so
there is no `tailwind.config.js` or PostCSS config.

The dev server's watcher ignores `data/`, `server/`, `docs/`, markdown, and `deploy/`. Without
that, every versioned DDL statement the backend writes to `data/` would trigger a full SPA
reload.

Two tsconfigs, checked separately by `npm run typecheck`: the root one covers `src` with DOM
libs and bundler resolution; the server one covers `server/` with NodeNext and no DOM. Note
that `build` runs `tsc -b` even though no project `references` array exists, so it currently
type-checks only `src` — an inconsistency worth being aware of, though harmless because
`typecheck` covers both explicitly.

## See also

- [security.md](security.md) — the full security model
- [credentials.md](credentials.md) — credential storage and encryption
- [performance.md](performance.md) — limits, pooling, and caching behavior
- [known_limitations.md](known_limitations.md) — what this design does not do
- [deployment.md](deployment.md) — running it
