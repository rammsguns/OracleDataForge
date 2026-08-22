# Performance

What Oracle DataForge caps, caches, and pays for — and where it gets slow on a large schema.

Much of this is documented in the codebase itself with real measurements against dictionary
schemas. Those numbers are reproduced here rather than paraphrased, because they explain
*why* the limits are where they are.

## Result-set limits

Queries return at most **1,000 rows**. The server asks Oracle for 1,001 and slices, which is
how truncation is detected without a second count query.

Truncation is surfaced permanently, not just as a toast. The results grid explains why:

> without this the footer reads "1,000 rows", indistinguishable from a statement that really
> returned 1,000 — the toast is long gone by then

### All caps

| Limit | Value |
| --- | --- |
| Rows per query | 1,000 |
| Data browser preview | 1,000 (`FETCH FIRST`) |
| Import rows | 50,000 |
| ER diagram tables | 60 |
| Routine cursor rows | 100 |
| Routine `DBMS_OUTPUT` lines | 1,000 |
| PL/SQL block binds | 32 |
| Compile: objects / passes / budget | 500 / 3 / 120 s |
| Changelog entries | 1,000 |
| Query history (localStorage) | 200 |
| Grid cell characters | 140 |
| Request body | 16 MB |

Two of these interact badly: **50,000 import rows must fit inside a 16 MB body**, roughly 335
bytes per row. A wide CSV will hit the body limit and fail with a 413 long before it reaches
the row cap.

The 1,000-row limit is also duplicated in three places — the server constant, a hardcoded
`"1,000"` in a toast string, and a separate preview constant — so changing it means changing
all three.

### LOBs

`fetchAsString` is set globally for CLOBs, so **every CLOB in every query is fully
materialized** as a string. With a 1,000-row cap, a result with wide CLOBs can still produce a
very large payload. BLOBs render as `[BLOB]` placeholders, for a reason worth knowing:

> node-oracledb streams BLOB (and CLOB when not fetchAsString) as a Lob object that
> back-references its connection — JSON.stringify would hit that circular structure and throw,
> killing the whole query.

## Connection pooling

One pool per saved connection, created lazily:

```ts
poolMin: 0, poolMax: 4, connectTimeout: 8   // seconds, not ms
```

That is the entire configuration. `poolIncrement`, `poolTimeout`, `queueTimeout`, and
`stmtCacheSize` are left at driver defaults, and no fetch tuning (`fetchArraySize`,
`prefetchRows`) is set anywhere.

N saved connections means up to N pools of 4 sessions each.

**`SYS` bypasses the pool entirely** — every SYS request opens a standalone `SYSDBA`
connection and pays a fresh authentication round trip. Connection tests also bypass the pool.

Pools close on update, delete, disconnect, and reconnect. Disconnect is the documented escape
hatch for a pool left stale by a database or network restart, since the next query reopens
lazily.

> **Gap:** there is no `SIGINT`/`SIGTERM` handler, so pools are not drained on shutdown.
> Sessions are returned reliably during normal operation — every handler closes in a
> `finally` — but an abrupt exit leaves Oracle to time them out.

## Frontend rendering

### The schema tree pages at 200 items

This is the most concretely measured decision in the repository:

> A dictionary schema has 8,148 views and 19,493 objects; expanding five groups built
> **103,631 DOM nodes / 56 MB** and pushed editor keystrokes to ~52 ms. Nothing broke, but
> nobody scrolls a list of 8,148 either — the search box filters all of them in ~13 ms, which
> is how you actually find one.

Each "Show more" adds another 200. The window resets when the active connection changes.

### The results grid paginates rather than virtualizes

Ten rows are rendered at a time. With a 1,000-row ceiling and a 10-row page, virtualization
would buy nothing — the DOM ceiling is ten rows wide.

Filtering and sorting do touch all 1,000 rows on every change, and export serializes the
entire filtered set, but both are memoized.

### The editor windows its highlight layer above 4,000 tokens

> A 156k-character package (`SYS.STANDARD`) produces ~15k spans and React reconciles every one
> of them on each keystroke — ~160 ms per input. Tokenizing itself is only ~9 ms, so the DOM
> nodes are the cost, not the lexer.

Tokenizing stays whole-document so multi-line strings and comments still resolve correctly;
only the rendered span count drops.

## Caching

**The schema tree is cached outside React**, in a module-level record, because the Explorer
unmounts whenever it is collapsed:

> re-querying the whole catalog just because the user reclaimed some editor width would be a
> pointless round trip — on a large schema, a slow one

The `loading` state is deliberately excluded from that cache — its promise dies with the
component, so a panel collapsed mid-fetch would otherwise return to a spinner nothing can
resolve.

Invalidation runs off a counter bumped after any successful DDL. The comparison is against a
module-level snapshot rather than a simple "greater than zero", because the effect also runs
on every mount and would otherwise wipe the cache each time the panel expanded.

**Prefer targeted group refresh over a full bump.** The store is explicit about the cost:

> `bumpSchema` drops the whole thing and costs **~17 queries against the dictionary** — far
> too much to repaint a handful of icons after a compile

Group refreshes run **serially**, because the groups share one pooled session.

Server-side caching is limited to a single per-connection flag recording whether the schema is
Oracle-maintained — "one dictionary read per connection, not one per object opened."

There is **no HTTP caching**. Responses are gzipped — see [Compression](#compression).

## The expensive paths

### Schema tree load — ~17 sequential queries

Loading the tree runs roughly nineteen dictionary queries, most of them sequentially on one
session. The twelve "dedicated" object-type queries (synonyms, DB links, directories, editions,
semantic models, recycle bin) are the exception: they're independent, so they now run as two
groups of six on two pooled connections at once, roughly halving that portion of tree-load
latency. Each connection still runs its own six one at a time — node-oracledb does not support
concurrent `execute()` calls on a single connection.

Real optimizations are already applied: public synonyms are restricted and capped at 500 rows
because "the full list is thousands of Oracle-owned entries"; validity for the whole schema is
fetched in one pass rather than per group; and Oracle Text noise tables are filtered out, with
receipts:

> A single Oracle Text CONTEXT index adds ten `DR$<index>$B/$C/$G/…` tables: in one real
> 37-table schema they were 20 of the entities and 90 of the 201 columns.

### ER diagram — the one query with measured tuning

> each touch of `user_mviews` costs ~250 ms … NO_UNNEST keeps the optimizer from merging the
> anti-join into the main query, which otherwise defeats the ORDER BY + FETCH FIRST top-N plan
> (**1,050 ms → 515**)

Follow-up queries filter to the kept tables in SQL rather than JavaScript, because doing it
client-side meant reading the whole dictionary — "on SYS that is ~133k column rows to draw 60
boxes."

### Dependency explorer — the slowest single-object endpoint

Five sequential `ALL_` view queries, including a `CONNECT BY NOCYCLE` recursive traversal of
`all_dependencies` with a correlated per-row lookup against `all_objects`. Only a 500-row cap
bounds it. On a large schema this is the heaviest single request in the app.

### Migration assistant — the worst-case workload

Table metadata costs **twelve sequential dictionary queries per table**. The assistant compares
up to 250 tables across two connections, so a full compare approaches **~6,000 round trips**.

The client's concurrency cap now matches the pool: 4 metadata fetches at once, same as
`poolMax`, so requests don't sit queued in the driver behind a client-side limit the pool can't
actually serve.

### Import

The entire payload goes to Oracle in **a single `executeMany`** — no chunking — with all
values bound as strings and per-column `maxSize` computed by scanning every row of every
column first. For 50,000 rows across 30 columns that is 1.5 million length reads before the
database is touched. Client-side CSV parsing is synchronous and parses the whole file just to
show a 5-row preview.

## Row counts are never `COUNT(*)`

Worth stating positively: **no row count in this application counts user data.** Every one —
schema tree, ERD, stats panels, advisor — reads `num_rows` from the data dictionary.

The trade-off is accuracy rather than speed: `num_rows` is only as fresh as the last stats
gather, which the app surfaces via a stale-stats indicator. The only `COUNT(*)` queries in the
codebase run against `V$` views and metadata.

## Bundle size

```text
dist/assets/index-….css   43.16 kB │ gzip:   8.37 kB
dist/assets/index-….js   946.16 kB │ gzip: 208.52 kB
```

One JavaScript chunk from 1,616 modules, exceeding Vite's 500 kB warning threshold. There is
**no code splitting** — no `build` section in the Vite config, no `manualChunks`, and no
dynamic `import()` or `React.lazy` anywhere in the source.

The largest single contributor is the Table Designer at 2,467 lines, followed by the icon
library. Both are the obvious split candidates.

## Compression

The backend gzips responses, so the bundle is **not** shipped at its on-disk size. Measured
against a production build:

| Asset | Uncompressed | gzip | Ratio |
| --- | --- | --- | --- |
| JS bundle | 946,160 B | 208,518 B | 4.54× |
| CSS | 43,158 B | 8,371 B | 5.16× |
| **First load total** | **989,318 B** | **216,889 B** | **4.56×** |

Compression is registered as the first middleware so it also covers the static SPA, which is
mounted last. `Vary: Accept-Encoding` is set, so shared caches stay correct.

The default 1 kB threshold is deliberate — smaller responses are sent uncompressed, since
below that the gzip framing costs more than it saves. `/api/health` is a good example: it
comes back plain.

JSON result payloads compress on the same terms, which matters most for wide 1,000-row
results.

## Version history overhead

Version capture runs after **every** successful query. For a `CREATE` it adds a source fetch
on its own pooled connection plus two synchronous file writes — and appending to the changelog
**re-reads and rewrites the entire JSON file** each time. Listing versioned objects reads and
parses every matching file per request.

At the 1,000-entry changelog cap this is not a problem, but it is O(n) on every code change
rather than an append.

## Summary of tuning opportunities

None of these are bugs; all are known trade-offs worth revisiting if the app is used against
very large schemas:

1. Code-split the Table Designer and icon imports — worth less now that responses are gzipped,
   but it would cut parse time as well as transfer.
2. Batch imports rather than one `executeMany` for up to 50,000 rows.
3. Make changelog appends append-only instead of rewrite-whole-file.

Done: response compression (4.56× on first load); parallelized the schema tree's dedicated-type
queries across two connections; aligned migration assistant concurrency with `poolMax`.

## See also

- [architecture.md](architecture.md) — where these paths live
- [known_limitations.md](known_limitations.md) — the caps as functional limits
- [security.md](security.md) — caps as denial-of-service resistance
