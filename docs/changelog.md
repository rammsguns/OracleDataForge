# Changelog

All notable changes to Oracle DataForge. Entries are grouped by release date and follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions. This project does not
publish versioned releases yet, so changes are listed by date and pull request.

Dates are the date the change landed on `main`.

## Unreleased

### Added

- **Response compression.** The backend serves the built SPA itself, and was shipping the
  ~946 kB bundle uncompressed. gzip is now applied to responses above 1 kB, measured at
  **4.56× on first load** (989 kB → 217 kB) and applying equally to large JSON result
  payloads.
- **CI.** A GitHub Actions workflow (`.github/workflows/ci.yml`) runs `npm ci`,
  `npm run typecheck`, and `npm run build` on every push and pull request against `main`.

### Changed

- **The schema tree's dedicated-type queries run on two connections instead of one.** The
  twelve independent dictionary queries for synonyms, DB links, directories, editions, and
  similar categories ran in a fully serial loop. They now split across two pooled connections,
  roughly halving that portion of tree-load latency on a large schema.
- **Migration assistant concurrency now matches the pool.** The client fetched table metadata
  6-at-a-time against a pool capped at 4, leaving two requests queued in the driver at all
  times. The client cap is now 4.

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
