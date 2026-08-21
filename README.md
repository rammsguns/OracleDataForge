# Oracle DataForge

Oracle DataForge is a focused browser IDE for Oracle Database, extracted from the Oracle functionality in InsightDB AI Suite. It keeps the database-development workflow and removes every alternate database engine, AI assistant, model-provider integration, and enterprise control-plane dependency.

## Included Oracle features

- Oracle connection registry, connection testing, reconnect, and disconnect
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
- Automatic local version history for code objects
- CSV/JSON import and Oracle-to-Oracle migration assistant
- Dark/light themes and resizable Explorer

There is no Copilot panel, AI endpoint, provider configuration, model SDK, alternate SQL dialect, or non-Oracle driver in this project.

## Requirements

- Node.js 22 or newer
- npm
- A reachable Oracle Database service

The backend uses `node-oracledb` in Thin mode, so Oracle Instant Client is not required for normal username/password connections.

## Development

```bash
npm install
cp env.example .env.local
npm run dev:server
```

In another terminal:

```bash
npm run dev
```

Open `http://localhost:5173`. The Vite development server proxies `/api` to the backend on port 3001.

Create a connection with:

- Host: Oracle server hostname or IP
- Port: usually `1521`
- Username and password
- Service name: for example `FREEPDB1`

`SYS` connections are opened as `SYSDBA` automatically. New connections start in read-only mode; explicitly disable it when DDL, DML, compilation, imports, or routine execution are required.

## Production build

```bash
npm run typecheck
npm run build
npm start
```

The backend serves the built frontend when `dist/` exists and binds to `127.0.0.1:3001` by default. For trusted-LAN access, explicitly set `HOST=0.0.0.0`, `DATAFORGE_AUTH_TOKEN`, and `DATAFORGE_ENCRYPTION_KEY`; the browser will request the access token once via HTTP Basic authentication. Generate the encryption key with `openssl rand -base64 32` and keep both values out of source control. To migrate an existing plaintext connection file, first start on loopback with the encryption key set, then save any connection once; its registry is rewritten encrypted.

## Runtime data and security

The application is deliberately a lightweight core IDE, without the source repository's identity, tenant, vault, or audit control plane.

- Database credentials never reach browser storage; the browser receives connection metadata only.
- The backend stores saved credentials in `data/connections.json` so connections survive restarts.
- With `DATAFORGE_ENCRYPTION_KEY` configured, saved credentials are encrypted with AES-256-GCM. Existing plaintext connection files must be migrated before LAN startup; keep `data/` private regardless.
- LAN startup requires HTTP Basic authentication and an encryption key. Put TLS in front of the app before using it beyond a trusted network.
- Read-only mode and confirmation guards reduce accidental writes; they are not a substitute for Oracle privileges.

## Verification

```bash
npm run typecheck
npm run build
curl http://127.0.0.1:3001/api/health
```

The health response is JSON with `ok: true` and the number of saved Oracle connections.

## Project structure

```text
src/                 React/TypeScript Oracle IDE
server/index.ts      Express API and Oracle runtime
data/                Local runtime state (ignored)
```
