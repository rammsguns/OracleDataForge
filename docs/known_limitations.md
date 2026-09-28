# Known limitations

What Oracle DataForge does not do, and where its edges are. Nothing here is a defect report —
these are deliberate scope decisions, accepted trade-offs, and honest edges.

Numeric caps are listed in [performance.md](performance.md); this document covers functional
limits.

## Deliberately absent

Verified against the source, not just the README:

- **No AI, model provider, or assistant of any kind.** No such code exists anywhere in `src/`
  or `server/`.
- **No database engine except Oracle.** `Engine` is a single-member type and the server
  rejects anything else outright: *"Only Oracle Database connections are supported"*.
- **No demo or sample data.** Removed deliberately — the Performance Monitor comment explains
  the reasoning: the first thing a new user saw was fabricated performance data, and *"an
  empty state is the honest answer"*.
- **No container image.** See [deployment.md](deployment.md).
- **No object-name autocomplete.** Completions are keyword-only; object names previously came
  from mock data that no longer exists.
- **Almost no tests.** `npm test` covers four pure modules — the connection-export envelope,
  the Oracle Cloud wallet reader, the connection role and the object copy — on Node's built-in
  runner. Everything else is verified by `npm run typecheck`, `npm run build`, a health check,
  and hand.

## SQL execution

### One statement per run

**The worksheet executes the entire buffer as a single statement.** There is no statement
splitter and no "run selection" — the text is sent verbatim, with only a single trailing
semicolon stripped.

Two `;`-separated statements will fail to parse. Scripts must be run one statement at a time.

### No cancel, no timeout

**A running statement cannot be cancelled or killed.** There is no `break()`, no
`AbortController`, no statement timeout, and no `callTimeout` anywhere. The only timeout of
any kind is an 8-second *connect* timeout. A long query simply blocks its HTTP request until
Oracle returns.

The compile batch is the one exception, and it self-limits rather than cancelling: three
passes, a 120-second budget checked per object, and a DDL lock timeout — because *"one busy
package would eat the whole time budget."* The UI is upfront that the run *"can take minutes
and cannot be cancelled"*, and that the elapsed counter is *"the only honest progress signal
we have (nothing streams)."*

### Transactions cannot span statements

This is the most surprising limitation, and it follows from the connection model rather than
from a decision about transactions.

**Every call acquires its own pooled connection and closes it when finished**, and everything
runs with `autoCommit: true`. Consequently:

- A `COMMIT` or `ROLLBACK` typed into the worksheet lands on a **different session** than the
  DML that preceded it, and does nothing useful.
- `SELECT … FOR UPDATE` releases its locks immediately.
- There is no way to hold an open transaction across statements.

Autocommit on routine calls is deliberate, and the reasoning is worth repeating:

> Without it the connection is released with the transaction open, which rolls back any
> routine that doesn't COMMIT itself: PLACE_ORDER would hand back a real order_id for a row
> that no longer exists.

Generated PL/SQL blocks end with a commented `ROLLBACK;` and the caveat that *"code that
COMMITs itself cannot be undone."*

**Batch DDL stops at the first failure and does not roll back** — Oracle auto-commits each DDL
statement, so the code breaks out rather than pushing past a failure. Partial application is
the normal outcome of a failed apply.

## Data types

### In results

| Type | Handling |
| --- | --- |
| CLOB | Fully materialized as a string |
| BLOB | Rendered as a `[BLOB]` placeholder — never streamed |
| RAW / Buffer | Truncated to 32 bytes (64 hex characters) |
| DATE / TIMESTAMP | **Converted to UTC; fractional seconds and time zone dropped** |
| 23ai VECTOR | Supported, rounded to 9 significant digits for Float32 |
| LONG | Fetched separately and tolerantly, so *"a LONG hiccup can't drop the whole column list"* |

The date handling deserves emphasis: sub-second precision and offset are lost in the grid.

**XMLType, JSON, INTERVAL, BFILE, and user-defined types have no specific handling.** They are
not rejected — they fall through a generic stringify path. What they actually render as has
not been verified against a live database.

### In the Table Designer and importer

The type picker offers a fixed list and accepts free text. The importer whitelists only
`NUMBER`, `VARCHAR2(n)`, `CHAR(n)`, `CLOB`, `DATE`, and `TIMESTAMP`, silently falling back to
`VARCHAR2(4000)` for anything else.

Import inference only ever produces `NUMBER`, `VARCHAR2(n)`, or `CLOB` — **never `DATE`**, so
dates depend on session NLS conversion. Every value binds as a string capped at 4,000
characters, so **values longer than 4,000 characters will not import even into a CLOB
column**.

## Routine runner

Only directly bindable argument types can be run from the form. The code states the principle
plainly — *"honesty over a wrong guess"* — and lists unsupported parameters rather than
hiding them.

Supported: the numeric family, `VARCHAR2`/`CHAR`/`N*` variants, `CLOB`, `DATE`, the
`TIMESTAMP` family, `BOOLEAN`, and `REF CURSOR`.

Not runnable from the form: **PL/SQL records, collections and tables, object types, `RAW`,
`BLOB`, `LONG`, `XMLTYPE`, `INTERVAL`, `ROWID`**. These need a hand-written PL/SQL block, and
the app says so. `REF CURSOR` is **OUT-only** — `IN`/`IN OUT` ref cursors are unsupported.

## Table Designer

Accepts only `CREATE TABLE`, `ALTER TABLE`, `COMMENT ON`, and index DDL, and rejects
statements containing an interior semicolon. **No `DROP TABLE`, no rename, no partitioning
operations.**

Its advisor findings are explicitly *"heuristics, review before applying."*

## Compilation

Only ten object types have an `ALTER … COMPILE` form; anything else is skipped with a
directive to use the worksheet. Unusable indexes are called out specifically — *"a compile
cannot fix it"*, rebuild from the Table Designer instead.

Compile ordering is *"not a dependency graph"* — it runs more passes until nothing improves,
short-circuiting when a pass fixes nothing, because *"the rest is genuinely broken, not an
ordering artefact."*

Editing and compiling is blocked for Oracle-maintained schemas, since recompiling something
like `SYS.STANDARD` can leave the instance unusable.

## Objects without a Drop action

Some object kinds have no Drop menu entry at all, deliberately:

> Kinds missing here need a PL/SQL call (jobs, queues, XML schemas) or a name we don't have (a
> mview log is dropped by its master table), so they get no Drop entry instead of a statement
> that can't run.

## Multi-user

The app assumes **one operator per instance**. It is not a defect that it behaves badly with
two — the control plane that would make it safe was deliberately removed — but the specific
failure modes are worth knowing:

1. **Identity is optional, and only as granular as an email/password/role triple.** Named
   accounts and server-enforced roles exist (see
   [security.md](security.md#workspace-roles)), but there is still a single break-glass
   credential that is always Administrator, no session expiry, no MFA enforcement, and no
   per-account audit trail — anyone with an account can see everything short of what their
   role blocks. On a bare loopback install with no accounts created, there is still no
   authentication at all.
2. **The connection registry is global regardless of role.** Any authenticated account can list
   and use any saved connection, including its stored password, which is replayed server-side.
   Editing and deleting a connection (Administrator/Developer only) affect everyone.
   including its stored password, which is replayed server-side. Editing and deleting affect
   everyone.
3. **Disconnect is global** — it closes pooled sessions another person is working through.
4. **Read-only is a property of the connection, not the user.** One person disabling it
   silently un-protects everyone.
5. **Version history and changelog are read-modify-write with no locking.** Two concurrent
   `CREATE OR REPLACE` operations lose one entry.
6. **No audit trail.** Entries record the connection, never a user or client address. Two
   people on the same Oracle account are indistinguishable.
7. **Concurrent compile runs collide** — a run snapshots the whole schema's invalid set and
   diffs against it, so another person's work in the same schema is attributed to your run.

Only **code objects** are versioned. Table DDL, imports, statistics, storage and maintenance
actions, and routine runs leave **no record anywhere**.

## Browser session

Persisted in `localStorage`: connection metadata (never passwords), query history capped at
200 entries, and sidebar layout. All degrade silently if storage is unavailable, such as in
private browsing.

**Lost on reload:** open tabs, worksheet text, the last result set and explain plan, the
selected object, theme choice, unsaved PL/SQL edits, Table Designer buffers, routine-run form
state, and in-flight compile runs.

Several of those survive *tab switching* — that is what the buffer modules exist for — but not
a page refresh. Discarded edits are *"gone for good."*

Connections always return as **idle**, never connected:

> nothing opens a database session until the user asks for one, and a stored "connected" would
> be a lie anyway because the pools of the previous page do not survive the reload

## Local state growth

- **Version history files are never capped.** Each versioned object accumulates every version
  forever in its own JSON file.
- **The changelog is capped globally at 1,000 entries, not per connection.** A busy connection
  will evict another connection's history.
- Restoring from version history **does not execute anything** — it seeds the worksheet with a
  runnable statement.

## Privilege-related silence

Many dictionary helpers return an empty list on error, so a missing privilege can look like a
missing object. The code is aware of the risk and guards the case where it matters most:

> a privilege error here would otherwise read as "nothing is invalid", which is the one answer
> we must never invent

Similarly, an unreadable validity check leaves the tree uncoloured rather than green — *"an
uncoloured tree is honest, an all-green one would be a lie."*

The DBA panel detects a total privilege failure and says so, but **partial** privilege loss
shows zeros with no warning. All DBA ratios are computed from counters **since instance
startup**, not over a window — they describe the instance's lifetime, not current conditions.

## Reconstructed DDL

Sequence DDL is rebuilt from the dictionary rather than taken from `DBMS_METADATA`, because
that package will not emit identity-backing sequences. The output is flagged in the generated
comment as reconstructed.

Schema comparison in the migration assistant is **structure only** — no data. Indexes and
constraints are matched by semantic signature rather than name, and renamed objects are
reported as informational with no DDL generated.

## Copying objects between connections

The Migration tab's **Copy objects** is a working copy of a development schema, not a
replacement for Data Pump.

- **One object type per run: sequences, types, tables, indexes, views, materialized views,
  synonyms, packages, procedures, functions and triggers.** Packages and types include their
  specification and optional body as one picker item. Procedures and functions are standalone;
  packaged routines belong to their package. Generated and secondary code objects are excluded.
  The suggested order is not dependency sorting. Copy dependencies and recompile invalid
  objects afterwards; compilation warnings do not necessarily mean a dependency is missing.
  Grants, roles, quotas, profiles, database links and directories are not copied.
- **PL/SQL replacement is in place and DDL is not transactional.** Existing grants survive,
  but dependents can become invalid and active package state can be discarded. A body failure
  can leave the new specification applied. A source without a body does not remove an existing
  target body. Type replacement may be refused when it has dependents; there is no DROP or
  FORCE fallback. Skip leaves the whole existing logical object alone.
- **Schema rewriting handles identifiers, not dynamic SQL.** Literals (including alternative
  quoting) and comments are preserved. Schema names in dynamic SQL strings or wrapped code
  cannot be retargeted automatically; review those before copying. Source OIDs are omitted so Oracle assigns target identities.
  Same-database type copying, dependent-type replacement, wrapped code and body compilation need live Oracle validation.
- **A sequence arrives at the number the source has reached, not the number it started from.**
  That is what stops a copy handing out values the source has already used, and it is what
  makes replacing an existing sequence the dangerous choice: a target sequence that has gone
  further than the source's is reset *backwards*, and the next rows it numbers collide with
  rows that are already there. The sequences Oracle creates for identity columns (`ISEQ$_…`)
  are left out of the listing — they belong to the table and arrive with it.
- **A table arrives without its rows or its indexes.** Its columns, defaults, primary key,
  unique keys, check constraints and foreign keys come with it — the foreign keys through a
  second pass after every table in the run exists, which is why the order the tables were
  copied in does not matter. The indexes are the other run.
- **Indexes are copied only onto a table the target already has.** An index is created on a
  table, so one whose table has not been copied yet is reported as a skip naming the table
  rather than attempted; the picker marks it the same way before the run starts. Copy the
  tables first, then the indexes — which is the order the two types are offered in.
- **The indexes Oracle made for you are not copied.** An index behind a primary or unique key
  is created by that constraint and arrives with the table, so copying it again would be a
  second index over the same columns; those, along with LOB and index-organized-table
  internals, system-named indexes and indexes on another schema's table, are left out of the
  listing entirely. What is offered is the indexes somebody wrote a `CREATE INDEX` for.
- **A partitioned or domain index can still fail.** The DDL is copied as the source wrote it, so
  a local index needs a target table partitioned the same way and a domain index needs its
  indextype installed. Neither is checked in advance: the failure is reported per index, with
  Oracle's error, and the rest of the run continues.
- **A view is created whether or not the target has what it selects from.** DBMS_METADATA
  emits `CREATE OR REPLACE FORCE VIEW`, and `FORCE` is what makes the order views are copied in
  irrelevant — alphabetical order puts plenty of views before the views they are built on. The
  price is that a view whose tables are missing is created INVALID rather than refused, so the
  run asks the target which of the views it just created are invalid and reports those
  separately from the ones that work. Nothing has to be re-run to fix one: copy what it needs
  and Oracle compiles the view the next time anything uses it.
- **A view's dependencies are not checked in advance, the way an index's table is.** An index
  has exactly one base table and the run can look for it first; a view can select from any
  number of tables, views, functions and synonyms, and reading that out of `user_dependencies`
  before the run would cost a query per view to say what one query afterwards says exactly.
  The picker therefore marks nothing for views, and the result is where the news is.
- **A view is copied as text, so a schema name written inside it is rewritten.** A body naming
  `HR.ORDERS` is repointed at the target schema, because a copy that left it would create a
  view that is valid, looks right, and reads the source database for ever. Only a qualifier
  that is genuinely an identifier is rewritten: the same name inside a string literal or a
  comment is left exactly as the source wrote it.
- **Replacing a view does not drop it.** Its own `CREATE OR REPLACE` is the replacement, so the
  grants on it and the views built on it survive — which is the one kind where "replace" costs
  nothing but the definition itself. Anything selecting from the old view sees the source's
  columns from that moment on.
- **A view, a synonym or a trigger from a newer database can fail on an older one.** `GET_DDL`
  emits the `EDITIONABLE` keyword on 12.1 and later, which 11g does not accept; any of them
  copied backwards across that line fails with Oracle's own syntax error, reported per object,
  and the rest of the run continues.
- **A materialized view is the one kind that moves data.** Oracle builds it the way the source
  wrote it, and that is almost always `BUILD IMMEDIATE`: the `CREATE` runs the view's query
  against the *target's* tables and fills the container table before it returns. So the rows
  are the target's own rather than the source's — this is not a data copy — but it is real work,
  it can take minutes, and a single one can run past the copy's five-minute budget, which is
  checked between objects rather than during one.
- **A materialized view over a table the target has not got fails outright.** There is no
  `FORCE` for one the way there is for a view, so Oracle answers ORA-00942 and the object is
  reported as a failure with that error while the run continues. Copy the tables and the views
  first — which is the order the types are offered in.
- **`REFRESH FAST` needs materialized view logs the copy does not bring.** The logs are not
  copied (they are not one of the six types), so a materialized view that refreshes fast on a
  base table without one fails with ORA-23413 at creation. `ENABLE QUERY REWRITE` similarly
  needs the privilege on the target. Both are reported per object, with Oracle's error.
- **The container table is not offered as a table, and its index is not offered as an index.** A
  materialized view keeps its rows in a table of the same name that `user_tables` lists like any
  other; copying that as a plain table would put a table where a materialized view belongs and
  leave the materialized-view run to fail on the name with ORA-00955. Both listings leave those
  out, so the whole object arrives from one run. A target that already has a *materialized view*
  where the source has a plain *table* of that name is the one case left over: the table run
  sees the name as taken and, if replacing, gets Oracle's ORA-12083 telling it to use `DROP
  MATERIALIZED VIEW`, reported as the failure it is.
- **Replacing a materialized view throws its rows away and computes them again.** `DROP
  MATERIALIZED VIEW` takes the container table with it, so the replacement is a full rebuild
  from the target's tables — and anything querying it in between finds it missing rather than
  stale.
- **A synonym for the source's own object is repointed at the target; one for a third schema is
  not.** A synonym is nothing but a qualified name, so this is the whole of what the copy does
  to it. `HR.EMPLOYEES` copied out of `HR` into `STAGE` arrives as `STAGE.EMPLOYEES`, which is
  what stops the target's queries reading the source database through the name. A synonym for
  `FINANCE.LEDGER` is left naming `FINANCE.LEDGER`, because that is a cross-schema reference
  somebody meant — and it is therefore a synonym that resolves only where the target database
  has a `FINANCE` with that object in it. Copying between two databases rather than two schemas
  of one is where that bites.
- **A synonym is created whether or not what it points at exists.** Oracle does not resolve the
  target of a synonym at creation, so nothing is pre-checked here the way an index's table or a
  trigger's base object is: the run would otherwise turn away objects the database was going to
  accept, and a synonym's target can be a package or a database link, neither of which this
  copies. A synonym whose object is not in the target is created and answers ORA-00980 the first
  time anything uses it. The run asks the target afterwards which of the new synonyms it marks
  invalid and reports those as created with the sentence saying they do not work yet — but
  whether Oracle marks a never-resolvable synonym invalid **at all** has not been checked
  against a live database, and where it does not, such a synonym is reported as the plain
  "created" it also is. That is the first thing to look at when a database is available.
- **A synonym over a database link lands, and the link does not.** Database links are not one of
  the eleven types and are not copied — nor are the credentials stored in one. A synonym naming
  `TABLE@LINK` is offered and created anyway, on the grounds that a target which already has the
  link needs the synonym and dropping the object silently would be worse; on a target without
  the link it is one more synonym that does not resolve.
- **Public synonyms are not offered.** A public synonym belongs to `PUBLIC` rather than to the
  schema and is visible to every session on the database, so creating one is a change to the
  database rather than to the target schema — outside what this feature does, and needing a
  privilege of its own. Only the connected schema's private synonyms are listed. Nor are the
  ones Oracle named for something of its own, or one left pointing at a `BIN$` name by a table
  that has since been dropped.
- **Replacing a synonym changes what a name means, and nothing has to be recompiled for it to
  take effect.** Its own `CREATE OR REPLACE` lands on the old one, so nothing is dropped and the
  grants on the name survive — but from that moment every query in the target that goes through
  the name reads whatever the source's synonym pointed at, which may be a different table or
  another schema entirely. It is the quietest replacement of the eleven types: no error, no
  invalid object, and a different table behind the same name.
- **A trigger fires for a table or a view, and that object has to be in the target first.**
  Oracle refuses `CREATE TRIGGER` on an object it cannot find (ORA-00942), so the run looks for
  the base object among the target's tables *and* views before it tries — an `INSTEAD OF`
  trigger's base object is a view — and a missing one is a skip naming it and naming the runs to
  do first. Copy the tables and the views, then the triggers.
- **What a trigger's body calls is not checked, and one that cannot compile is still created.**
  The base object is the only thing pre-checked; a trigger whose body calls a package,
  sequence or table the target has not got is created and left INVALID, and reported as created
  with the sentence saying it does not work yet. Nothing has to be re-run to fix one — copy what
  it needs and Oracle compiles the trigger the next time anything writes to the table. Whether
  such a create comes back clean (and the invalid check reports it) or comes back as the
  driver's ORA-24344 "success with compilation error" (in which case it is reported as a failure
  and the invalid trigger is in the target all the same) has **not** been checked against a live
  database — it is the first thing to look at when one is available.
- **Triggers on the schema or the database are not offered.** A DDL, logon or servererror
  trigger is a rule about the account rather than one of its objects, and recreating it in the
  target would change what that account is allowed to do; only triggers on a table or a view are
  listed. Nor are the triggers Oracle keeps on its own tables (a materialized view log, a
  materialized view's container, a Text index table), the ones it named itself, or triggers on
  another schema's table.
- **Replacing a trigger swaps what it does at that moment.** Its own `CREATE OR REPLACE` lands
  on the old one, so nothing is dropped and the table is never briefly without a trigger — but
  from then on every insert, update and delete on that table runs the source's code rather than
  the target's, and there is no way back to the old definition from here.
- **A trigger arrives enabled or disabled the way the source has it.** `GET_DDL` answers with
  the `CREATE OR REPLACE` and an `ALTER TRIGGER … ENABLE` (or `DISABLE`), and the copy runs
  both. A trigger somebody turned off in the source stays off in the target, which is usually
  what is wanted and is worth knowing when it is not.
- **A foreign key pointing outside the copy is reported, not created.** One that references a
  table the run did not bring across cannot be added until that table is in the target; the
  result names it and the reason. Copy the missing table and run the copy again — the second
  pass fills in what is now possible and leaves alone what is already there.
- **Replacing a table drops the foreign keys pointing *at* it.** `DROP TABLE … CASCADE
  CONSTRAINTS` is what lets a parent be replaced at all, and it takes the children's references
  with it. A child in the same run gets its key back in the second pass; one outside the run
  does not, and has to be copied again itself. It takes the target table's own indexes with it
  too, so a table replaced after its indexes were copied needs the index run again.
- **Replacing an index rebuilds it.** `DROP INDEX` and a fresh `CREATE INDEX` cost the build
  time and leave queries running without the index in between; no data goes with it. An index
  Oracle built for a constraint refuses to be dropped at all (ORA-02429), which is reported as
  the failure it is rather than worked around.
- **The tablespace is a choice for the kinds that occupy one, and not offered for the rest.** A
  sequence is a row in the dictionary, a synonym is a name pointing at something else, and a
  view and a trigger are text, so none of them lives in a segment: the checkbox is not shown for
  them and the confirmation dialog says nothing about tablespaces.
  For tables and indexes: left off — the
  default — the segment clause is suppressed and objects land on the target's default
  tablespace, which is what lets a production schema land on a laptop. Turned on, each object
  is created in the tablespace it has in the source, and the copy fails outright on a target
  that has no tablespace of that name. Storage sizing (`INITIAL`, `NEXT`, `MAXEXTENTS`) is
  never carried either way, so the copy is not a way to reproduce a tuned physical design.
- **A name that is not in the source's listing is not copied.** The picker's selection is
  intersected with the dictionary before anything is read, because a name reaches
  `dbms_metadata.get_ddl` and a `DROP`. Matching is exact, and the dictionary's spelling of a
  name is the object's name — a hand-written API call asking for `employees` instead of
  `EMPLOYEES` copies nothing and says so, rather than guessing.
- **Caps, not streams.** A copy runs inside one HTTP request: at most 2,000 objects and a
  five-minute budget. Both are reported before the copy starts, and a run that hits one says so
  rather than reporting success.

Schema qualification a *developer* wrote — a column default calling `HR.ORDER_SEQ.NEXTVAL` — is
rewritten to the target schema by a scan that skips string literals and comments. It is a text
pass, not a PL/SQL parser: a qualifier assembled at run time from a variable is not rewritten,
and the copied object will read the source schema. DDL that Oracle itself emits is read
unqualified (`EMIT_SCHEMA=FALSE`) and needs no rewriting.

## Oracle Cloud wallets

- **The wallet must carry `ewallet.pem`.** node-oracledb runs in Thin mode here, which reads
  the PEM wallet and cannot use `cwallet.sso` — so an *auto-login* wallet is refused at upload
  with a message saying so. Download the wallet again and give it a wallet password.
- **Only the two files Thin mode reads are kept**, `ewallet.pem` and `tnsnames.ora`. Anything
  else in the zip — the SSO wallet, the PKCS#12 wallet, the Java keystores, `sqlnet.ora`,
  `ojdbc.properties` — is discarded rather than stored.
- **The zip reader is deliberately minimal.** Stored and deflated entries only; zip64,
  encrypted archives and unknown compression methods are refused, not worked around. A wallet
  zip is a few kilobytes written by Oracle, so nothing legitimate reaches those paths. Uploads
  are capped at 2 MB and each extracted file at 512 KB.
- **`data/wallets/` is not covered by `DATAFORGE_ENCRYPTION_KEY`.** That key encrypts the
  connection registry; the wallet files sit on disk as they came out of the zip. The wallet
  *password* is in the registry and therefore is encrypted. See
  [credentials.md](credentials.md#oracle-cloud-wallets).
- **A wallet is not refreshed automatically.** Oracle Cloud wallets expire (rotating
  certificates, or a regional wallet re-issued); when yours does, download a new zip and use
  **Replace wallet** in the connection's edit dialog. Nothing in the app warns you beforehand —
  the first sign is a TLS failure on connect.
- **No proxy, no `TNS_ADMIN`, no thick mode.** There is no setting for an HTTP proxy in front
  of the database endpoint, no way to point at an existing `TNS_ADMIN` directory instead of
  uploading a zip, and no Instant Client path — all three are things Thin mode either does not
  support or this app does not expose.

## Platform notes

- **File permissions are weak on Windows.** `connections.json` is written with `0o600`, which
  Windows largely ignores in favour of directory ACLs. Worse, **`data/versions/*.json` and
  `data/changelog.json` are written with no mode at all** — world-readable on POSIX systems
  under a typical umask. Those files contain source code, not credentials, but the asymmetry
  is unintentional.
- **`0o600` applies only at file creation.** Migrating an existing file created with looser
  permissions leaves those permissions in place — exactly the case where it matters.
- **Container detection uses `/.dockerenv`**, a POSIX path, so the container-networking hint
  never fires on Windows even under Docker Desktop. Correct behaviour, but worth knowing.
- **A default local install stores Oracle passwords in clear text.** See
  [credentials.md](credentials.md).

## Recovery from a stale connection

There is no pool ping, no retry, and no detection of a dropped connection. If the database or
network restarts, the pool goes stale and errors surface as raw ORA/NJS messages.

The documented recovery is **Disconnect** — it drops the pooled sessions while keeping the
saved connection, and *"the next query re-opens a pool lazily, so this is also the way out of a
pool left stale by a database or network restart."*

## See also

- [performance.md](performance.md) — the numeric caps and why they are set where they are
- [security.md](security.md) — security-specific gaps
- [credentials.md](credentials.md) — credential storage limitations
- [architecture.md](architecture.md) — the design decisions these limits follow from
