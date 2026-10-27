# Oracle DataForge

Oracle DataForge is a focused browser IDE for Oracle Database, extracted from the Oracle functionality in InsightDB AI Suite. It keeps the database-development workflow without alternate database engines or a required model-provider integration.

## Included Oracle features

- Oracle connection registry, connection testing, reconnect, and disconnect
- Connections to Oracle Autonomous Database with a downloaded Oracle Cloud wallet (mutual TLS, no Instant Client)
- Searchable schema explorer backed by Oracle dictionary views
- SQL worksheet with formatting, autocomplete, error lines, execution history, and saved snippets
- Read-only-by-default connections and server-enforced confirmation for writes and destructive SQL
- Results grid with filtering, sorting, pagination, column visibility, and CSV/JSON export
- Explain Plan with an Oracle cost tree
- Table and view data browser
- Object source/DDL viewer and in-place PL/SQL editor
- Procedure, function, package, trigger, type, view, and invalid-object compilation
- Procedure/function/package runner with typed binds, custom PL/SQL blocks, cursors, and DBMS_OUTPUT
- Oracle Table Designer, indexes, constraints, statistics, storage, advisor, maintenance, and schema comparison
- Dependency explorer and ER diagram from Oracle metadata
- DBA advisor and performance monitor
- DBA Manager: SQL Developer-style connection tree with 11 modules and 24 pages for configuration, status, Data Pump, performance, RMAN history, Resource Manager, translation profiles, Scheduler, security, storage, and tuning; searchable tablespaces with click-to-edit storage controls, object sizes, and SQL previews for storage and memory changes
- Automatic local version history for code objects
- CSV/JSON import and Oracle-to-Oracle migration assistant
- Object copy from one connection to another — sequences, tables, indexes, views, materialized views, synonyms, packages, procedures, functions, types or triggers, picked object by object, tablespace optional
- Passphrase-encrypted export and import of saved connections, wallets included (AES-256-GCM, scrypt)
- Dark/light themes and resizable Explorer

Optional worksheet assistance connects to a separately deployed OracleDBHarness. It is off by default; DataForge includes no model SDK or provider configuration.

## Requirements

- Node.js 22.12 or newer (tested through 24)
- npm
- A reachable Oracle Database service

The backend uses `node-oracledb` in Thin mode, so Oracle Instant Client is not required — neither for username/password connections nor for Oracle Cloud wallets, which Thin mode reads in their PEM form. Nothing in the dependency tree compiles native code either, so there is no build toolchain, Python, or container runtime to install — Node and npm are the whole prerequisite list.

The application installs and starts without a database; it just has nothing to connect to until one is configured.

## Development

```bash
git clone https://github.com/rammsguns/OracleDataForge.git
cd OracleDataForge
npm install
cp env.example .env.local
npm run dev:server
```

In another terminal:

```bash
npm run dev
```

Open `http://localhost:5173`. The Vite development server proxies `/api` to the backend on port 3001.

Recent npm versions block package install scripts until they are approved. `package.json` pre-approves the three this project needs — `oracledb` and both `esbuild` builds — but if `npm install` still reports them as pending, approve them and rebuild. Until esbuild fetches its platform binary, `npm run build` fails:

```bash
npm approve-scripts esbuild oracledb && npm rebuild
```

Create a connection either way the wizard offers.

**Host and port** — a database you reach directly:

- Host: Oracle server hostname or IP
- Port: usually `1521`
- Username and password
- Service name: for example `FREEPDB1`

**Oracle Cloud wallet** — an Autonomous Database, over mutual TLS:

- Wallet zip: download it from Oracle Cloud (your Autonomous Database → **Database connection** → **Download wallet**) and upload it unchanged. Give it a wallet password when Oracle asks; an auto-login wallet has no `ewallet.pem` and cannot be used without Oracle Instant Client.
- Database service: the wizard lists the services in the wallet's `tnsnames.ora` — `_high`, `_medium` and `_low` are the same database at different consumer groups.
- Username, password, and the wallet password.

The wallet is unpacked on the backend and never reaches the browser; the host, port and service come from the wallet rather than from the form. See [credentials.md](docs/credentials.md#oracle-cloud-wallets) for where the files land and what protects them.

`SYS` connections are opened as `SYSDBA` automatically. New connections start in read-only mode; explicitly disable it when DDL, DML, compilation, imports, or routine execution are required.

## Production build

```bash
npm run typecheck
npm run build
npm start
```

The backend serves the built frontend when `dist/` exists and binds to `127.0.0.1:3001` by default. For trusted-LAN access, explicitly set `HOST=0.0.0.0`, `DATAFORGE_AUTH_TOKEN`, and `DATAFORGE_ENCRYPTION_KEY`; the browser will request the access token once via HTTP Basic authentication. Generate the encryption key with `openssl rand -base64 32` and keep both values out of source control. To migrate an existing plaintext connection file, first start on loopback with the encryption key set, then save any connection once; its registry is rewritten encrypted.

## Runtime data and security

The application is deliberately a lightweight core IDE, without the source repository's tenant, vault, or audit control plane.

- Database credentials never reach browser storage; the browser receives connection metadata only.
- The backend stores saved credentials in `data/connections.json` so connections survive restarts, and uploaded Oracle Cloud wallets in `data/wallets/`.
- With `DATAFORGE_ENCRYPTION_KEY` configured, saved credentials are encrypted with AES-256-GCM. The key is optional on loopback, so **a default local install writes passwords to `data/connections.json` in clear text** — set the key before saving a connection whose password matters. Existing plaintext files must be migrated before LAN startup; keep `data/` private regardless.
- LAN startup requires HTTP Basic authentication and an encryption key. Put TLS in front of the app before using it beyond a trusted network.
- Read-only mode and confirmation guards reduce accidental writes; they are not a substitute for Oracle privileges.
- Optional workspace accounts (Admin tab → Add user) add named logins with a real, server-enforced role — Administrator, Developer, Analyst, or Viewer. Until you create the first one, the app stays exactly as open as before. See [security.md](docs/security.md#workspace-roles).

## Verification

```bash
npm run typecheck
npm test
npm run build
curl http://127.0.0.1:3001/api/health
```

`npm test` runs the backend and frontend utility suites using Node's built-in test
runner. Coverage includes connection export, wallets, roles and users, authentication
concurrency, session ownership, object and table-data copy, DBA management, worksheet
statement selection, autocomplete, diagnostics, transaction requests, and routine inputs.
These tests need no network or database. Live Oracle behavior and browser interactions
still require separate verification.

The health response is JSON with `ok: true` and the number of saved Oracle connections.

## Project structure

```text
src/                 React/TypeScript Oracle IDE
server/index.ts      Express API and Oracle runtime
data/                Local runtime state (ignored)
docs/                Reference documentation
```
## GitHub PL/SQL sync

GitHub integration is optional. To sync a successfully compiled PL/SQL object, configure a GitHub repository in the Repository tab and set `GITHUB_TOKEN` in `.env.local`. Create a fine-grained GitHub token restricted to the target repository with **Contents: Read and write** permission. For example, the test repository is `https://github.com/rammsguns/PLSQL`.

The token stays in the local backend. After Oracle compilation succeeds without errors, Dataforge writes the source to the configured directory and branch using GitHub's Contents API. Packages are saved as `.pks` / `.pkb`; procedures, functions, and triggers use `.prc`, `.fnc`, and `.trg`.

## Documentation

| Document | Covers |
| --- | --- |
| [architecture.md](docs/architecture.md) | How the frontend, backend, and Oracle layer fit together |
| [deployment.md](docs/deployment.md) | Development, production, LAN access, environment variables |
| [security.md](docs/security.md) | Authentication, read-only mode, write guards, injection defenses |
| [credentials.md](docs/credentials.md) | Credential storage, encryption, migrating a plaintext registry |
| [performance.md](docs/performance.md) | Row limits, pooling, caching, and what gets slow at scale |
| [known_limitations.md](docs/known_limitations.md) | Caps, unsupported inputs, and single-instance assumptions |
| [changelog.md](docs/changelog.md) | What changed, when, and why |

## Optional harness assistance

Assistance is disabled unless `DATAFORGE_HARNESS_ENABLED=true` is set on the backend.
Editing, execution and compilation continue independently of the harness.

Issue a scoped integration credential as a harness Administrator with
`POST /api/v1/admin/integrations` and the body
`{"name":"dataforge","kind":"dataforge","scopes":["copilot:assist"]}`.
Store the returned one-time credential only in backend environment configuration:

```dotenv
DATAFORGE_HARNESS_ENABLED=true
DATAFORGE_HARNESS_URL=https://harness.example.com
DATAFORGE_HARNESS_TOKEN=<integration credential>
DATAFORGE_INSTANCE_ID=dataforge-production
```

Use a stable, unique instance ID for each installation. HTTPS is required except on
loopback. Optional limits are `DATAFORGE_HARNESS_TIMEOUT_MS` (default `60000`) and
`DATAFORGE_HARNESS_MAX_CONTEXT_BYTES` (default `131072`). Never put the credential
in browser configuration, URLs or logs. Revoke it in the harness to disconnect.

Open **Assist** in a worksheet, choose an action and review outgoing context before
sending. The backend forwards the supplied selection (or full buffer when nothing
is selected), question, complete editor buffer and revision, schema, opaque target
reference, actor identity and supplied error/plan text. The harness owns provider
configuration, context policy and request history. Review its retention and provider
policy before sending source. The current resolver does not expand schema metadata
or query Oracle for context and leaves the database version unspecified.

Analysts receive explain-only assistance; the server rejects other actions and
proposal apply checks under their current role. Other roles use the harness's
advertised actions. Responses stream, cancellation propagates upstream, and proposed
changes require diff review plus a fresh editor revision/text check before applying.
Applying changes edits the buffer only. The integration never executes proposals,
compiles objects, commits transactions, changes connection settings, sends database
credentials or wallets, or opens another Oracle connection. Selected-text explanation
does not execute EXPLAIN PLAN.

Known limits: no dedicated integration settings screen; configuration is server-side.
Hosted providers and proxies beyond the shipped harness nginx are unqualified.
Agent-run backend and browser checks on Oracle test stand-ins are recorded in the
[harness compatibility matrix](https://github.com/rammsguns/OracleDBHarness/blob/main/integrations/dataforge/COMPATIBILITY.md);
they do not establish human pilot or production qualification.
