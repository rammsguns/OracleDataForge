# Deployment

Oracle DataForge is a Node application with two supported ways to run it: a development setup
with hot reload, and a production build served by the backend itself. There is no container
image — see [Why there is no Docker path](#why-there-is-no-docker-path).

## Prerequisites

- Node.js 22 or newer (tested through 24). Declared in `package.json` as `engines`, so npm
  warns at install time on an older runtime.
- npm.
- A reachable Oracle Database service, if you want to connect to anything.

Nothing else. The backend uses `node-oracledb` in **Thin mode**, a pure-JavaScript driver, so
Oracle Instant Client is not required. No dependency compiles native code, so there is no
build toolchain or Python to install.

## Development

```bash
git clone https://github.com/rammsguns/OracleDataForge.git
cd OracleDataForge
npm install
cp env.example .env.local
npm run dev:server
```

In a second terminal:

```bash
npm run dev
```

Open `http://localhost:5173`. Vite serves the frontend and proxies `/api` to the backend on
port 3001, so both processes are required.

### If `npm run build` fails right after install

Recent npm versions block package install scripts until approved. `npm install` exits `0`
while reporting them as pending:

```
npm warn allow-scripts 3 packages have install scripts not yet covered by allowScripts:
  esbuild@0.25.12, esbuild@0.28.1, oracledb@7.0.1
```

esbuild never fetches its platform binary, and the build fails later with nothing pointing
back at the install. `package.json` pre-approves all three, so this should not occur on a
fresh clone. If it does:

```bash
npm approve-scripts esbuild oracledb && npm rebuild
```

## Production

```bash
npm run typecheck
npm run build
npm start
```

`npm run build` emits the frontend to `dist/`. The backend serves it automatically when that
directory exists — the startup line reports `(static: on)` when it found it — so a production
install runs as a **single process** on one port. Vite is not involved at runtime.

By default the server binds `127.0.0.1:3001`, reachable only from the machine it runs on.

### Serving on a trusted LAN

Loopback is the default precisely so that nothing is exposed without an explicit decision.
To open the app to other machines, set all three:

| Variable | Purpose |
| --- | --- |
| `HOST=0.0.0.0` | Bind all interfaces instead of loopback |
| `DATAFORGE_AUTH_TOKEN` | Access token; the browser prompts once via HTTP Basic auth |
| `DATAFORGE_ENCRYPTION_KEY` | Encrypts saved credentials at rest (AES-256-GCM) |

The last two are **enforced**: the server throws at startup if `HOST` is not loopback and
either is missing. This is a deliberate refusal to run in a half-configured exposed state, not
a bug — if startup fails with `DATAFORGE_AUTH_TOKEN is required when HOST is not loopback`,
that guard is working.

Generate the key with:

```bash
openssl rand -base64 32
```

An existing plaintext connection file must be migrated before LAN startup. Start on loopback
with the key set, save any connection once to rewrite the registry encrypted, then switch to
`0.0.0.0`. See [credentials.md](credentials.md) for the full procedure.

**HTTP Basic auth is not transport security.** Put TLS in front of the app — a reverse proxy
terminating HTTPS — before using it beyond a network you fully trust. The token crosses the
wire on every request.

**Reaching the app by a DNS name needs that name declared.** Every request's `Host` header
must name this server, or it is refused with 403 — that is what stops a web page from
re-pointing its own DNS record at this port and driving the API through the operator's
browser. Loopback, whatever `HOST` is set to, and any literal IP address are always accepted,
so `HOST=0.0.0.0` reached as `http://192.168.1.5:3001` needs nothing extra. A name — a
hostname on the LAN, or the name a reverse proxy is fronted by — goes in
`DATAFORGE_ALLOWED_HOSTS`, comma-separated:

```bash
DATAFORGE_ALLOWED_HOSTS=dataforge.lan,dataforge.internal.example
```

An entry may include a port to pin it; without one, any port matches. If the app answers on
loopback but a browser using its hostname gets *"This server does not answer to that host
name"*, this is the variable to set.

## Environment variables

Copy `env.example` to `.env.local`; both `npm run dev:server` and `npm start` load it via
Node's `--env-file-if-exists`, so it is read automatically when present and ignored when not.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Loopback. Any other value requires the two secrets below. |
| `PORT` | `3001` | Backend listener. |
| `NODE_ENV` | `development` | Set to `production` when serving the built SPA. |
| `DATAFORGE_AUTH_TOKEN` | unset | Required when `HOST` is not loopback. |
| `DATAFORGE_ENCRYPTION_KEY` | unset | Required when `HOST` is not loopback. Base64, 32 bytes. |
| `DATAFORGE_ALLOWED_HOSTS` | unset | Extra host names the server answers to, comma-separated. Only needed to reach it by DNS name. |
| `GITHUB_TOKEN` | unset | Optional. Enables `POST /api/github/sync`. |
| `GITHUB_REPOSITORY` | unset | Required when `GITHUB_TOKEN` is set — `owner/repo`. Pins which repository the token may write to; the server refuses to start without it if the token is present. |
| `GITHUB_BRANCH` | unset | Optional. Also pins the branch a sync may target. |

`.env.local` is gitignored. Keep the two secrets out of source control and stable across
restarts — changing the encryption key makes an existing registry unreadable.

## Runtime state

Everything persistent lives in `data/`, resolved relative to the server source:

| Path | Contents |
| --- | --- |
| `data/connections.json` | Saved connection registry, including credentials |
| `data/versions/` | Local version history for edited code objects |
| `data/changelog.json` | Local record of schema changes (capped at 1000 entries) |

The directory is gitignored and must stay private. It is **not** covered by `.gitignore` for
anything other than Git — if the project lives inside a synced folder such as OneDrive,
Dropbox, or iCloud Drive, `data/` is replicated to that provider along with any unencrypted
credentials it holds. Exclude it from sync, or configure the encryption key.

## Verifying an install

```bash
npm run typecheck
npm run build
curl http://127.0.0.1:3001/api/health
```

The health endpoint returns JSON with `ok: true` and the number of saved connections. A
successful startup logs:

```
Oracle DataForge listening on http://127.0.0.1:3001 (static: on)
```

`static: off` means `dist/` was not found — expected in development, a problem in production.

## Why there is no Docker path

The project shipped a `Dockerfile` and `docker-compose.yml` until 2026-08-21. Both were
removed because:

- **Nothing needed containerising.** Thin mode means there are no native Oracle client
  libraries to bundle, which is the usual reason a database tool ships an image. What is left
  is a plain Node app that `npm install && npm start` covers on any OS.
- **The compose file could not boot.** It set `HOST=0.0.0.0` without either required secret,
  so the startup guard rejected it. The documented quickstart failed for anyone who ran it.

Running the app in a container is still perfectly possible — write a Dockerfile that installs
dependencies, builds, and runs `npm start` with the three LAN variables set. The application
detects container execution via `/.dockerenv` and adjusts connection-error advice accordingly,
so `localhost` confusion is explained rather than left mysterious. The full previous setup is
recoverable from history with `git revert` if a real deployment target ever needs it.

## See also

- [credentials.md](credentials.md) — credential storage, encryption, and migration
- [security.md](security.md) — the full security model
- [known_limitations.md](known_limitations.md) — single-instance assumptions that affect deployment
