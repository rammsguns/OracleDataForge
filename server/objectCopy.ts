/**
 * Copying objects of one kind from one Oracle connection into another: the parts of it that
 * are pure text, kept out of `index.ts` for the same reason `connectionRole.ts` and
 * `oracleWallet.ts` are.
 *
 * Everything here decides what will be *run against a live database*, and every mistake it
 * can make is quiet rather than loud. A statement whose terminator is stripped when it should
 * not be fails with a syntax error naming a line the user never wrote; one whose terminator is
 * *kept* when it should not be fails the same way. A schema qualifier left pointing at the
 * source is worse still: the copied object is created, it is VALID, and it reads the source
 * database forever.
 *
 * `index.ts` owns the Oracle side: which dictionary view lists a kind, how its DDL is read,
 * and how the statements are applied and reported.
 */

/**
 * One kind of object a copy can move.
 *
 * A union rather than a bare string, so the compiler points at every place a new kind has to
 * be described: an entry in `OBJECT_COPY_KINDS`, a listing query beside it in `index.ts`, and
 * — for a kind built on a table — the query that says which table each one belongs to.
 */
export type CopyKind = "sequences" | "tables" | "indexes";

export interface CopyKindSpec {
  kind: CopyKind;
  /** what the UI calls it — read as "12 Tables", so it is plural */
  label: string;
  /** USER_OBJECTS.object_type this kind lists */
  objectType: string;
  /**
   * Objects of this kind can own foreign keys, so the run adds them in a second pass once
   * every object it is copying exists. Only tables can, but the flag is what keeps the pass
   * from running for a kind that has nothing to add.
   */
  foreignKeys: boolean;
  /**
   * Objects of this kind are built *on* a table, so one cannot land before its table does.
   * The run looks for the table in the target first and reports a missing one as a skip that
   * names it, rather than letting `CREATE` fail with an ORA-00942 that names nothing useful.
   */
  requiresTable: boolean;
  /**
   * Objects of this kind occupy a segment, so "keep the source tablespace" means something for
   * them. A sequence is a row in the dictionary and lives nowhere, so the choice is not offered
   * for it rather than offered and quietly ignored.
   */
  hasTablespace: boolean;
  /** what the copy brings with the object, and what it does not — shown in the UI, so it has to be true */
  note: string;
  /** what "drop and recreate" costs for this kind — a table and an index are not the same bet */
  replaceNote: string;
}

/**
 * Every kind a copy can move, in the order the UI offers them.
 *
 * One kind is copied per run. That is the shape of the feature rather than a limitation of
 * this array: a run reads one listing, one kind of DDL, and reports one kind of outcome, so
 * what it did is legible from the result instead of having to be untangled from it. Copying a
 * schema is then several runs in the order the kinds are listed here, each one confirmed and
 * reported on its own.
 *
 * **The order is the order they have to be copied in**, which is why it is worth stating: a
 * column default calling `ORDER_SEQ.NEXTVAL` fails with ORA-02289 if the sequence is not there
 * yet, and an index cannot be created before its table. Sequences, then tables, then indexes.
 * Someone working down the list in order gets a schema that comes out whole.
 */
export const OBJECT_COPY_KINDS: CopyKindSpec[] = [
  {
    kind: "sequences",
    label: "Sequences",
    objectType: "SEQUENCE",
    foreignKeys: false,
    requiresTable: false,
    hasTablespace: false,
    note: "The sequence and the number it has reached in the source, so the copy carries on from there rather than starting again at 1. Not the tables, defaults or triggers that use it.",
    replaceNote:
      "Each existing sequence is dropped and recreated at the source's number. A target sequence that has gone further will hand out numbers it has already given away, which is a duplicate key waiting to happen.",
  },
  {
    kind: "tables",
    label: "Tables",
    objectType: "TABLE",
    foreignKeys: true,
    requiresTable: false,
    hasTablespace: true,
    note: "Columns, defaults, constraints and, once every table is there, foreign keys. Not the rows or the indexes.",
    replaceNote:
      "Each existing table is dropped before it is recreated. A dropped table takes its rows with it and does not go to the recycle bin.",
  },
  {
    kind: "indexes",
    label: "Indexes",
    objectType: "INDEX",
    foreignKeys: false,
    requiresTable: true,
    hasTablespace: true,
    note: "The indexes someone created, on tables the target already has. Not the ones Oracle built for a primary or unique key — those arrive with the table.",
    replaceNote:
      "Each existing index is dropped before it is recreated. That costs the time to rebuild it and queries run without it in between, but no data goes with it.",
  },
];

/** Canonical position of each kind — small, but consulted once per copied object. */
const KIND_ORDER = new Map<CopyKind, number>(OBJECT_COPY_KINDS.map((k, i) => [k.kind, i]));

export const copyKindSpec = (kind: CopyKind): CopyKindSpec => OBJECT_COPY_KINDS[KIND_ORDER.get(kind)!];

/** Every kind there is, in the order they are offered. */
export const ALL_COPY_KINDS: CopyKind[] = OBJECT_COPY_KINDS.map((k) => k.kind);

/** What a copy moves when nothing is chosen. */
export const DEFAULT_COPY_KIND: CopyKind = "tables";

/**
 * The kind an untrusted value asks for, or the default when it asks for nothing this app
 * copies.
 *
 * A whitelist, like `normalizeRole`: the value arrives as a request body or a query string,
 * and whatever survives it decides which DDL is read and run against a live database. An
 * unrecognised kind falls back to the documented default rather than being passed through to
 * a listing query that has no entry for it.
 */
export function normalizeKind(value: unknown): CopyKind {
  if (typeof value !== "string") return DEFAULT_COPY_KIND;
  const asked = value.trim().toLowerCase();
  return ALL_COPY_KINDS.find((k) => k === asked) ?? DEFAULT_COPY_KIND;
}

/**
 * The objects an untrusted list asks for, or null when it asks for none in particular.
 *
 * `available` is the source dictionary's own listing, and the answer is an intersection with
 * it — which is the point. Names arrive in a request body and end up as the argument to
 * `dbms_metadata.get_ddl` and inside a `DROP`, so a name that is not in the listing is dropped
 * rather than passed through: what cannot be named cannot be read or dropped, whether it was
 * mistyped, dropped since the plan was read, or made up.
 *
 * Null means the request named nothing at all, which the caller reads as "everything of this
 * kind". An empty array is different, and deliberately so: the request *did* name objects and
 * none of them exist, so the caller copies nothing and says so rather than falling back to
 * copying the whole schema. Matching is exact, because the dictionary's spelling of a name is
 * the object's actual name and case is part of it.
 *
 * The result is in `available` order, so a run walks the dictionary's order however the
 * request happened to be sorted.
 */
export function normalizeNames(value: unknown, available: string[]): string[] | null {
  if (!Array.isArray(value)) return null;
  const asked = new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()));
  return available.filter((name) => asked.has(name));
}

/**
 * The DBMS_METADATA transform parameters the *source* session reads DDL with.
 *
 * `EMIT_SCHEMA=FALSE` is the important one: without it every statement names the source
 * schema and the copy recreates the source's objects, in the source, from the target's
 * session. `CONSTRAINTS=TRUE` keeps the primary key, the unique keys and the check
 * constraints, which belong to the table alone.
 *
 * `REF_CONSTRAINTS=FALSE` takes the foreign keys out of `CREATE TABLE` — not to drop them, but
 * because one names a second table this run may not have copied yet, and alphabetical order
 * puts plenty of children before their parents. They are added afterwards instead, by a second
 * pass over the tables that landed, which is what makes the order they were created in
 * irrelevant. Leaving them inside `CREATE TABLE` would fail every child copied before its
 * parent, and those are the tables a copy is least able to retry.
 *
 * Both constraint parameters describe tables, and Oracle ignores them for a kind that has no
 * constraints — which is why one set of parameters serves every kind rather than one per kind.
 *
 * The tablespace is the caller's choice, and the two parameters move together because Oracle
 * makes them: `TABLESPACE=TRUE` emits nothing while `SEGMENT_ATTRIBUTES=FALSE` suppresses the
 * whole segment clause the tablespace lives in. Off — the default — is what lets a production
 * table land on a laptop, since a `TABLESPACE "USERS_DATA"` clause fails outright on a
 * database that has no such tablespace. On is for a copy between two databases laid out the
 * same way, where landing everything in the target's default tablespace would be the wrong
 * answer.
 *
 * `STORAGE` stays off either way: `INITIAL`, `NEXT` and `MAXEXTENTS` sized for the source's
 * data are not sizes for the target's, and preserving where a table lives is a different
 * question from preserving how much room it was given.
 */
export function copyTransforms(preserveTablespace: boolean): [string, boolean][] {
  return [
    ["EMIT_SCHEMA", false],
    ["SEGMENT_ATTRIBUTES", preserveTablespace],
    ["STORAGE", false],
    ["TABLESPACE", preserveTablespace],
    ["REF_CONSTRAINTS", false],
    ["CONSTRAINTS", true],
    ["SQLTERMINATOR", true],
    ["PRETTY", true],
  ];
}

/**
 * The statements inside one DBMS_METADATA answer.
 *
 * `GET_DDL` returns some objects as more than one statement, separated by the SQL*Plus slash
 * on a line of its own — one CLOB holding statements the driver can only run one at a time.
 * Splitting on that line is the whole job: a slash anywhere else (a division, a path inside a
 * string) is not alone on its line and is left where it is.
 */
export function splitDdl(ddl: string): string[] {
  return ddl
    .split(/^[ \t]*\/[ \t]*\r?$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does this statement *contain* PL/SQL, and therefore end with a semicolon that belongs to it?
 *
 * `CREATE TABLE … ;` ends with a terminator the driver must never see. A PL/SQL block ends
 * with `END;`, and stripping that semicolon yields `PLS-00103: Encountered the symbol
 * "end-of-file"`. The two are indistinguishable from the end of the string, so the decision is
 * taken from the front of it — which is what makes `prepareDdl` safe for DDL of any kind
 * rather than only for the kinds copied today.
 */
export function isPlsqlDdl(sql: string): boolean {
  return /^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE|LIBRARY)\b|DECLARE\b|BEGIN\b)/i.test(sql);
}

/**
 * One statement, ready for `connection.execute`.
 *
 * The driver takes a single statement with no terminator, while DBMS_METADATA emits SQL*Plus
 * script text: a trailing `/` on its own line for PL/SQL, a trailing `;` for everything else.
 * Both go; the semicolon only when it is a terminator rather than the end of a block.
 */
export function prepareDdl(raw: string): string {
  const sql = raw.replace(/\s*\r?\n[ \t]*\/[ \t]*$/, "").trim();
  return (isPlsqlDdl(sql) ? sql : sql.replace(/;\s*$/, "")).trim();
}

/** A DBMS_METADATA answer as the runnable statements it holds, in order. */
export function copyStatements(ddl: string): string[] {
  return splitDdl(ddl).map(prepareDdl).filter(Boolean);
}

/**
 * Point DDL written for one schema at another one.
 *
 * DBMS_METADATA is asked for unqualified DDL (`EMIT_SCHEMA=FALSE`), so most statements need
 * nothing here. What is left is the qualification a *human* wrote — a column default calling
 * `HR.ORDER_SEQ.NEXTVAL`, a check constraint naming `HR.SOMETHING`. Leaving those alone is the
 * one failure mode of a copy that still looks like a success: the object is created, it is
 * VALID, and it reads the source database.
 *
 * The scan skips string literals and comments, so `'Ask HR.'` in a message and a
 * `-- HR.OLD_NAME` note are not identifiers and are not rewritten. Beyond that it is
 * deliberately narrow: only `SOURCE.` immediately before a name is a schema qualifier, and a
 * source and target that are the same schema make the whole pass a no-op.
 */
export function retargetSchema(ddl: string, from: string, to: string): string {
  const src = from.trim().toUpperCase();
  const dst = to.trim().toUpperCase();
  if (!src || !dst || src === dst) return ddl;

  let out = "";
  let i = 0;
  while (i < ddl.length) {
    const ch = ddl[i];
    // string literal — copied through untouched, doubled quotes included
    if (ch === "'") {
      const end = skipQuoted(ddl, i + 1, "'");
      out += ddl.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "-" && ddl[i + 1] === "-") {
      const nl = ddl.indexOf("\n", i);
      const end = nl === -1 ? ddl.length : nl;
      out += ddl.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && ddl[i + 1] === "*") {
      const close = ddl.indexOf("*/", i + 2);
      const end = close === -1 ? ddl.length : close + 2;
      out += ddl.slice(i, end);
      i = end;
      continue;
    }
    // "HR". — a quoted identifier is a schema only when a dot and a name follow it
    if (ch === '"') {
      const end = skipQuoted(ddl, i + 1, '"');
      const word = ddl.slice(i + 1, end - 1);
      const after = qualifierTail(ddl, end);
      if (after !== null && word === src) {
        out += `"${dst}".`;
        i = after;
        continue;
      }
      out += ddl.slice(i, end);
      i = end;
      continue;
    }
    // HR. — a bare identifier, matched only when nothing identifier-like precedes it
    if (isIdentStart(ch) && !isIdentChar(ddl[i - 1] ?? "")) {
      let j = i;
      while (j < ddl.length && isIdentChar(ddl[j])) j++;
      const word = ddl.slice(i, j);
      const after = qualifierTail(ddl, j);
      if (after !== null && word.toUpperCase() === src) {
        out += `${dst}.`;
        i = after;
        continue;
      }
      out += word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Index just past the closing `quote`, treating a doubled one as an escape. */
function skipQuoted(s: string, from: number, quote: string): number {
  let i = from;
  while (i < s.length) {
    if (s[i] === quote) {
      if (s[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return s.length;
}

const isIdentStart = (c: string) => /[A-Za-z]/.test(c);
const isIdentChar = (c: string) => /[A-Za-z0-9_$#]/.test(c);

/**
 * If the name ending at `end` is followed by `.` and another name, the index just past that
 * dot — where a rewrite resumes. Otherwise null: it was not a schema qualifier.
 */
function qualifierTail(s: string, end: number): number | null {
  let i = end;
  while (i < s.length && /[ \t]/.test(s[i])) i++;
  if (s[i] !== ".") return null;
  let j = i + 1;
  while (j < s.length && /[ \t]/.test(s[j])) j++;
  return isIdentStart(s[j] ?? "") || s[j] === '"' ? j : null;
}

/**
 * An Oracle identifier as a quoted literal, or null when it cannot be one at all.
 *
 * Names reaching this come from the source database's own dictionary rather than from a
 * request, but they are still concatenated into a statement, so a double quote inside one is
 * doubled rather than trusted — the same escaping `index.ts` applies to the names the row
 * editor writes. Only a name that is empty or longer than Oracle allows is refused, because
 * for those there is nothing to quote and no object to find; the caller reports that as a
 * skip rather than guessing at a statement.
 */
export function copyIdent(name: string): string | null {
  const n = name.trim();
  if (!n || n.length > 128) return null;
  return `"${n.replace(/"/g, '""')}"`;
}

/**
 * The statement removing an object the target already has, when the copy replaces rather than
 * skips it. Null when the name cannot be quoted safely.
 *
 * `CASCADE CONSTRAINTS` is what lets tables be replaced in any order — a table a foreign key
 * points at cannot be dropped otherwise — and `PURGE` is what stops every replacement leaving
 * a recycle-bin copy of the old table behind. Both are why "replace" is offered as the
 * destructive choice it is rather than as a checkbox.
 *
 * Every other kind drops by name alone. `DROP INDEX "SALES_IX"` is a plain drop, and an index
 * Oracle built for a constraint refuses it with ORA-02429 — which is the right answer, since
 * that index belongs to the constraint and the copy has no business replacing it. `DROP
 * SEQUENCE "ORDER_SEQ"` always succeeds, and leaves every default and trigger that called it
 * invalid until the new one is there — which is why replacing a sequence says what it costs.
 */
export function dropStatement(kind: CopyKind, name: string): string | null {
  const spec = copyKindSpec(kind);
  const ident = copyIdent(name);
  if (!ident) return null;
  if (kind === "tables") return `DROP TABLE ${ident} CASCADE CONSTRAINTS PURGE`;
  return `DROP ${spec.objectType} ${ident}`;
}

/** "12 Tables" — how a count of one kind is named in a confirmation dialog. */
export function copyCountLabel(kind: CopyKind, count: number): string {
  return `${count.toLocaleString("en-US")} ${copyKindSpec(kind).label}`;
}
