# Credentials

How Oracle DataForge stores database credentials, when they are encrypted, and how to move an
existing install to encrypted storage.

For the wider security model — authentication, read-only enforcement, write guards — see
[security.md](security.md).

## Where credentials live

Saved connections are held in an in-memory registry and persisted to
`data/connections.json`. That file contains the Oracle **username and password** for every
saved connection, because the point of saving a connection is that it survives a restart.

The file is written with mode `0o600` (owner read/write only). That is meaningful on
Linux and macOS. On Windows the POSIX mode bits are largely ignored, so the file inherits
directory ACLs instead — treat `data/` as sensitive on its own terms there.

## The browser never receives a password

`GET /api/connections` returns metadata only. The password is removed by destructuring rather
than by building an allowlist by hand, so a field added to the config later cannot silently
begin leaking through that endpoint:

```ts
const { password: _pw, oraPool: _op, oracleMaintained: _om, ...safe } = c;
```

Credentials go browser → backend once when you create or edit a connection, and never come
back. Every query runs server-side over a pool the backend owns.

## Encryption at rest

Encryption is controlled entirely by `DATAFORGE_ENCRYPTION_KEY`:

| Key configured | On loopback | On a non-loopback `HOST` |
| --- | --- | --- |
| Yes | Registry encrypted with AES-256-GCM | Registry encrypted; required |
| No | **Registry written in clear text** | Server refuses to start |

The key must be **base64-encoded and exactly 32 bytes** once decoded. Anything else throws at
startup rather than silently weakening the cipher:

```
DATAFORGE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.
```

Generate one with:

```bash
openssl rand -base64 32
```

Or, without OpenSSL on hand:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The encrypted file is a single object — a random 12-byte IV, the GCM authentication tag, and
the ciphertext, each base64 — rather than a list of individually encrypted rows. An encrypted
registry cannot be read at all without the key, so **keep the key stable**. Losing or changing
it makes every saved connection unrecoverable, and the fix is to delete
`data/connections.json` and re-enter the connections by hand.

## The plaintext default

On loopback the key is optional, which means **a default local install stores real passwords
in clear text**. This is a deliberate convenience for single-machine development, not an
oversight, but it is easy to forget. Since 2026-08-21 the server says so out loud — once at
startup when saved connections already exist, and once on the first plaintext write:

```
WARNING  Connection passwords are stored unencrypted in .../data/connections.json
         Set DATAFORGE_ENCRYPTION_KEY to encrypt them with AES-256-GCM, then save each
         connection once to rewrite the file. Generate a key with:
           openssl rand -base64 32
         Until then, keep data/ out of synced folders and backups.
```

### Synced folders are the real risk

`.gitignore` keeps `data/` out of Git. It has no effect on anything else. If the project
directory sits inside OneDrive, Dropbox, iCloud Drive, or a backup set, then
`connections.json` — plaintext passwords included — is replicated to that provider.

This is worth checking rather than assuming, because a project cloned into a user's
`Documents` folder on Windows or macOS is frequently inside a sync root by default. Either
exclude `data/` from sync, or configure the encryption key so the synced copy is ciphertext.

Note that sync providers keep **version history**. Encrypting the file later does not retract
the plaintext copies already uploaded. If a password was exposed that way and it matters,
rotate it on the Oracle side.

### The version store carries the same risk, unencrypted

`data/versions/*.json` holds the full source of every code object created or replaced
through the worksheet, and `data/changelog.json` records the connection key (host, port,
service, user) for each change. PL/SQL source routinely embeds connection strings, wallet
paths, and API keys — the same sync-root exposure above applies to these files as much as it
does to `connections.json`.

Both are written with mode `0o600`, same caveat as above (meaningful on Linux/macOS, largely
ignored on Windows). Neither is covered by `DATAFORGE_ENCRYPTION_KEY`: that key encrypts the
connection registry only. If a saved object's source is sensitive enough to worry about, that
sensitivity lives in `data/versions/`, unencrypted, for as long as the version history is
kept. Excluding `data/` from sync (the same fix as above) covers this too — there is no
separate exclusion needed.

## Exporting connections to an encrypted file

`data/connections.json` is only a backup of the registry for as long as the machine holding
`DATAFORGE_ENCRYPTION_KEY` survives — the file alone, copied elsewhere, decrypts to nothing.
The **export** is the portable form. In the Explorer, the lock icon beside **Connections**
(or **Export connections…** in a connection's context menu) asks for a passphrase and
downloads `dataforge-connections-<date>.json`.

What that file holds is the **Oracle username and password** of every connection you picked,
encrypted under that passphrase and nothing else. Treat it exactly as you would treat the
passwords themselves.

- The browser never assembles it. Passwords do not live there, so the encryption happens
  server-side and the browser only receives, and saves, ciphertext.
- **Full access only** (Administrator or Developer), the same bar as every other route that
  reads or writes the registry.
- The passphrase must be **at least 12 characters** — a higher floor than a workspace account
  password, because an account password is guessed online against a server that rate-limits
  and logs, while an export file is guessed offline, as fast as the attacker's hardware
  allows, for as long as they care to keep trying.
- **There is no recovery.** Lose the passphrase and the file is unreadable; the connections
  themselves are still in the app, so re-export rather than go looking for a way in.
- Each export is logged to the server console (`Exported N saved connection(s) …`), since
  credentials leaving the machine is worth a line in the operator's log.

### The file format

A single JSON object. `data` is the encrypted array of connections; everything else is what a
reader needs to derive the same key:

```json
{
  "format": "oracle-dataforge-connections",
  "version": 1,
  "exportedAt": "2026-09-03T21:16:17.424Z",
  "count": 2,
  "cipher": "aes-256-gcm",
  "kdf": { "name": "scrypt", "salt": "…base64…", "N": 32768, "r": 8, "p": 1, "keylen": 32 },
  "iv": "…base64…",
  "tag": "…base64…",
  "data": "…base64 ciphertext…"
}
```

The scrypt parameters are deliberately expensive (N=2^15, r=8 → roughly 32 MB and ~100 ms per
guess) so that offline guessing has to pay for every attempt. The GCM tag authenticates the
ciphertext: a wrong passphrase, or an edited file, fails to decrypt rather than returning
plausible-looking rubbish.

## Importing an export back

**Import connections…** (the ⬆ icon beside **Connections**, or the same entry in a connection's
context menu) is the way back in: pick the file, type its passphrase, and the connections
inside it become saved connections here. It is full-access only, like the export.

The browser cannot open the file — the passphrase-derived key never exists there — so the
envelope is uploaded and the backend decrypts it. That happens in two steps, and **nothing is
written by the first one**:

1. **Unlock file** decrypts and lists what is inside: name, server, port, user, service and
   read-only flag for every entry. Passwords stay on the server even here — the preview is
   metadata, the same rule `GET /api/connections` follows.
2. **Import** writes the entries you ticked into the registry, which persists them to
   `data/connections.json` under `DATAFORGE_ENCRYPTION_KEY` (or in clear text, if no key is
   configured — the plaintext default above applies to imported credentials exactly as it does
   to typed ones).

### Connections you already have

An entry is treated as one you already have when its **engine, host, port, user and service
name** all match a saved connection — the same identity test that governs whether a stored
password may be replayed. The preview marks those **ALREADY SAVED**, and offers a choice:

| | |
| --- | --- |
| **Keep what is here** (default) | The saved connection and its password are left alone. |
| **Replace with the file** | The saved entry is overwritten in place — name, password and read-only flag come from the file. Its id is kept, so open tabs still point at it, and its pooled sessions are closed first. |

Entries pointing somewhere new are always added. Nothing is ever deleted by an import.

### The file is untrusted input

An uploaded envelope is attacker-shaped data even when it arrives from a colleague, so the
backend checks it before it acts on it: the format, version and cipher must be the ones this
build knows; the scrypt parameters are read from the file (an export made with different ones
still has to open) but **range-checked** first, since a file claiming `N` of 2^30 would
otherwise size an allocation on this server; salt, IV, tag and payload are bounded; a file is
capped at 500 connections; and every decrypted entry goes through the same field-by-field
`pickConfig`/`validate` path as a connection typed into the wizard, so an entry with a bogus
port or a missing service name is rejected rather than saved.

A wrong passphrase and an altered file both fail the GCM authentication tag, so the error says
both — that is the honest answer, not a vague one.

### Reading one by hand

The import above is the easy path; the file is also readable without this app, which is what
makes it a real backup. Decrypt it with Node:

```bash
node -e '
const fs=require("fs"),c=require("crypto");
const f=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const k=c.scryptSync(process.argv[2],Buffer.from(f.kdf.salt,"base64"),f.kdf.keylen,
  {N:f.kdf.N,r:f.kdf.r,p:f.kdf.p,maxmem:128*f.kdf.N*f.kdf.r*2});
const d=c.createDecipheriv(f.cipher,k,Buffer.from(f.iv,"base64"));
d.setAuthTag(Buffer.from(f.tag,"base64"));
console.log(Buffer.concat([d.update(Buffer.from(f.data,"base64")),d.final()]).toString());
' dataforge-connections-2026-09-03.json 'your passphrase'
```

Note `maxmem`: at these parameters scrypt needs more than Node's 32 MB default and throws
without it. That is by design — the cost is the point.

## Migrating an existing plaintext registry

The server reads a plaintext registry on loopback so an existing install keeps working, and
rewrites it encrypted the next time a connection is saved. It refuses to read one when `HOST`
is not loopback:

```
Plaintext connection storage is not allowed for LAN access.
Configure DATAFORGE_ENCRYPTION_KEY and migrate the file.
```

To migrate, in order:

1. Generate a key and put it in `.env.local` as `DATAFORGE_ENCRYPTION_KEY=…`.
2. Start the server **on loopback** (the default `HOST`).
3. Save any one connection through the UI. This rewrites the whole registry encrypted.
4. Confirm the migration: `data/connections.json` should now be a single JSON object with
   `version`, `iv`, `tag`, and `data` fields, with no readable hostnames or usernames.
5. Only then switch `HOST` to `0.0.0.0` if LAN access is wanted.

Doing step 5 first just produces the startup error above — the ordering is enforced, not
merely advised.

## Replaying a saved password

Both "test this saved connection" and "update this saved connection" accept an **empty
password** to mean *keep the stored one*, so you are not forced to retype it to change an
unrelated field.

That convenience is deliberately constrained. A stored password may only be replayed to the
exact endpoint it was saved against — engine, host, port, user, **and service name** must all
still match. The code is explicit about why:

> point a saved connection at a rogue server, and the backend dials out and authenticates with
> the real password

Oracle's login exchange can be attacked offline once captured, so an unconstrained version of
this feature would turn the app into a credential-harvesting oracle for anyone who could edit
a connection. Change any part of the destination and you must re-enter the password:

```
The server, port, user or engine changed — re-enter the password for the new destination.
```

## Operational guidance

- **Keep `.env.local` out of source control.** It is gitignored; keep it that way.
- **Set the key before saving the first connection**, not after. Anything saved beforehand has
  already touched the disk in clear text.
- **Back up the key separately from `data/`.** A backup containing both is equivalent to a
  plaintext backup.
- **Use a distinct low-privilege Oracle account** where the work allows it. Read-only mode and
  the write guards reduce accidents, but they are application-level controls and are not a
  substitute for Oracle privileges.
- **`SYS` connects as `SYSDBA` automatically.** Be deliberate about saving a `SYS` password at
  all.

## See also

- [security.md](security.md) — authentication, read-only mode, write guards, injection defenses
- [deployment.md](deployment.md) — environment variables and LAN startup requirements
- [known_limitations.md](known_limitations.md) — single-instance and single-user assumptions
