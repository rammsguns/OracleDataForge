import oracledb from 'oracledb';
import type { CopyProgressEvent } from '../src/utils/tableDataProgress.ts';
import { copyRowLimitFor, limitedCopyCount, TABLE_COPY_DEFAULT_TOTAL_ROWS, TABLE_COPY_MAX_ROWS, type TableDependency } from '../src/utils/tableDataDependencies.ts';

export async function readTableDependencies(conn: oracledb.Connection, schema: string): Promise<TableDependency[]> {
  const result = await conn.execute<{ TABLE_NAME: string; CONSTRAINT_NAME: string; R_OWNER: string; PARENT_TABLE: string | null }>(
    `SELECT fk.table_name, fk.constraint_name, fk.r_owner, pk.table_name AS parent_table
     FROM user_constraints fk LEFT JOIN all_constraints pk
       ON pk.owner = fk.r_owner AND pk.constraint_name = fk.r_constraint_name
     WHERE fk.constraint_type = 'R' AND fk.status = 'ENABLED'
     ORDER BY fk.table_name, fk.constraint_name`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return (result.rows ?? []).map(r => ({ table: r.TABLE_NAME, constraint: r.CONSTRAINT_NAME,
    parent: r.PARENT_TABLE, parentSchema: r.R_OWNER, local: r.R_OWNER === schema }));
}

export interface CopyColumn { COLUMN_NAME: string; DATA_TYPE: string; VIRTUAL_COLUMN: string; IDENTITY_COLUMN: string; GENERATION_TYPE?: string | null; IDENTITY_OPTIONS?: string | null; DATA_LENGTH?: number | null }
const supported = new Set(['NUMBER', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE', 'VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'DATE', 'RAW', 'VECTOR', 'JSON', 'CLOB', 'NCLOB',
  // Fetched by the driver as their text form and converted back by Oracle on insert.
  'ROWID', 'UROWID']);
const isTimestamp = (type: string) => /^TIMESTAMP(?:\([0-9]\))?$/.test(type);
const isTimestampTz = (type: string) => /^TIMESTAMP(?:\([0-9]\))? WITH TIME ZONE$/.test(type);
const isTimestampLtz = (type: string) => /^TIMESTAMP(?:\([0-9]\))? WITH LOCAL TIME ZONE$/.test(type);
// Zoned timestamps travel as text with their zone (region name or offset), so the instant and
// the original zone survive. LOCAL TIME ZONE values are read as zoned values in the session's
// zone and the target converts them to its own database zone: the instant is what is kept.
const timestampTzFormat = 'SYYYY-MM-DD HH24:MI:SS.FF9 TZR';
// Transfer timestamps as explicit text: JS Date would discard sub-millisecond precision.
const timestampFormat = 'SYYYY-MM-DD HH24:MI:SS.FF9';
// Runtime vector metadata is not yet declared by the installed @types/oracledb.
type VectorMetadata = oracledb.Metadata<unknown> & { vectorDimensions?: number; vectorFormat?: number; isSparseVector?: boolean };
export const quoteCopyName = (name: string) => `"${name.replace(/"/g, '""')}"`;

// Thin-driver batch errors may contain only a message and row offset.
function oracleErrorNumber(error: { errorNum?: number; code?: string; message?: string }): number | undefined {
  if (typeof error.errorNum === 'number') return error.errorNum;
  const match = /^ORA-(\d{5})(?=:|$)/.exec(error.code ?? '') ?? /^ORA-(\d{5}):/.exec(error.message ?? '');
  return match ? Number(match[1]) : undefined;
}

/** The constraint named in an Oracle message such as "ORA-02291: integrity constraint (OWNER.FK_X) violated - parent key not found". */
export function violatedConstraint(message: string | undefined): string | null {
  const match = /constraint \(([^()]+)\) violated/.exec(message ?? '');
  if (!match) return null;
  const name = match[1].slice(match[1].indexOf('.') + 1);
  return name.replace(/^"|"$/g, '') || null;
}

/** Thrown when the user stops a running copy. */
export class CopyStoppedError extends Error {
  constructor() { super('Copy stopped by user.'); this.name = 'CopyStoppedError'; }
}

/** Memory for rows held back while they wait for parent keys that arrive later in the copy. */
const PENDING_RETRY_BYTES = 64 * 1024 * 1024;

/** LOBs up to this many characters are read into memory and batched; larger ones are streamed. */
export const INLINE_LOB_CHARS = 1024 * 1024;
// Characters per streamed round trip; larger chunks mean fewer round trips for big values.
const LOB_CHUNK_CHARS = 1024 * 1024;
// The Lob class is exported at runtime but only declared as an interface by @types/oracledb.
const LobClass = (oracledb as unknown as { Lob: abstract new () => oracledb.Lob }).Lob;
const isLob = (value: unknown): value is oracledb.Lob => value instanceof LobClass;
/** Size of pending rows for the retry memory limit; streamed LOBs live in the database, not here. */
/**
 * Rows per fetch and per insert. Each batch costs one fetch and one insert round trip, and round
 * trips dominate copy time (especially over a WAN or VPN), so batches are as large as roughly
 * 8 MB of declared row width allows. Tables with CLOB/NCLOB/JSON columns use small batches: each
 * inline value may hold up to INLINE_LOB_CHARS characters.
 */
export const COPY_BATCH_MIN_ROWS = 200;
export const COPY_BATCH_MAX_ROWS = 5000;
export const LOB_COPY_BATCH_ROWS = 50;
const COPY_BATCH_BYTES = 8 * 1024 * 1024;
export function copyBatchRows(columns: CopyColumn[], hasLargeText = false): number {
  if (hasLargeText) return LOB_COPY_BATCH_ROWS;
  // Unknown widths count as 100 bytes; every value also carries some per-value overhead.
  const width = columns.reduce((n, c) => n + Math.max(Number(c.DATA_LENGTH) || 100, 8) + 32, 0);
  return Math.min(COPY_BATCH_MAX_ROWS, Math.max(COPY_BATCH_MIN_ROWS, Math.floor(COPY_BATCH_BYTES / Math.max(width, 1))));
}
/** Column aliases for a LOB column's two halves: inline text, or a locator to stream. */
const inlineAlias = (i: number) => `"DF$INLINE$${i}"`;
const streamAlias = (i: number) => `"DF$STREAM$${i}"`;

const rowBytes = (rows: unknown[][]) => Buffer.byteLength(JSON.stringify(rows, (_key, value) => isLob(value) ? null : value));

export function copyColumns(source: CopyColumn[], target: CopyColumn[]): string[] {
  const writable = source.filter(c => c.VIRTUAL_COLUMN !== 'YES');
  if (!writable.length) throw new Error('No columns to copy.');
  for (const c of writable) {
    const dest = target.find(t => t.COLUMN_NAME === c.COLUMN_NAME);
    if (!dest || dest.DATA_TYPE !== c.DATA_TYPE || dest.VIRTUAL_COLUMN === 'YES') throw new Error(`Column ${c.COLUMN_NAME} is missing or incompatible in the target.`);
    if (dest.IDENTITY_COLUMN === 'YES' && !['ALWAYS', 'BY DEFAULT', 'BY DEFAULT ON NULL'].includes(dest.GENERATION_TYPE ?? '')) {
      throw new Error(`Identity column ${c.COLUMN_NAME} has an unknown generation mode.`);
    }
    if (!supported.has(c.DATA_TYPE) && !isTimestamp(c.DATA_TYPE) && !isTimestampTz(c.DATA_TYPE) && !isTimestampLtz(c.DATA_TYPE)) throw new Error(`Column ${c.COLUMN_NAME}: ${c.DATA_TYPE} is not supported by data copy.`);
  }
  return writable.map(c => c.COLUMN_NAME);
}

// START WITH can reset unspecified sequence options, so retain the original settings.
export function identitySequenceOptions(value: string | null | undefined): string {
  const options = new Map((value ?? '').split(',').map(part => part.trim().split(/:\s*/).map(s => s.trim())).map(([key, val]) => [key, val]));
  const number = (key: string) => {
    const val = options.get(key);
    if (!val || !/^-?\d+$/.test(val)) throw new Error(`Missing or invalid identity option ${key}.`);
    return val;
  };
  const flag = (key: string, yes: string, no: string) => {
    const val = options.get(key);
    if (val !== 'Y' && val !== 'N') throw new Error(`Missing or invalid identity option ${key}.`);
    return val === 'Y' ? yes : no;
  };
  for (const key of ['SCALE_FLAG', 'EXTEND_FLAG', 'SESSION_FLAG', 'SHARDED_FLAG']) {
    if (options.get(key) === 'Y') throw new Error(`Identity option ${key} requires a custom migration.`);
  }
  return `INCREMENT BY ${number('INCREMENT BY')} MINVALUE ${number('MIN_VALUE')} MAXVALUE ${number('MAX_VALUE')} ${number('CACHE_SIZE') === '0' ? 'NOCACHE' : `CACHE ${number('CACHE_SIZE')}`} ${flag('CYCLE_FLAG', 'CYCLE', 'NOCYCLE')} ${flag('ORDER_FLAG', 'ORDER', 'NOORDER')}${options.has('KEEP_VALUE') ? ` ${flag('KEEP_VALUE', 'KEEP', 'NOKEEP')}` : ''}`;
}

/** Longest WHERE filter accepted for one table. */
export const COPY_FILTER_MAX_CHARS = 2000;
// Same write/DDL verbs the worksheet read-only guard blocks, plus PL/SQL and transaction words.
const FILTER_BLOCKED = /\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|rename|flashback|purge|call|execute|lock|commit|rollback|savepoint|begin|declare|function|procedure)\b/i;

/**
 * Why a per-table WHERE filter is rejected, or null. The filter is pasted into
 * `SELECT … FROM "T" WHERE (<filter>)`, so it must stay one expression inside those parentheses:
 * no statement separators, comments, bind variables or q-quoted strings, balanced parentheses
 * that never close the wrapper, and no write/DDL keywords outside string literals.
 */
export function copyFilterError(where: string): string | null {
  const text = where.trim();
  if (!text) return 'The filter is empty.';
  if (text.length > COPY_FILTER_MAX_CHARS) return `The filter is longer than ${COPY_FILTER_MAX_CHARS.toLocaleString('en-US')} characters.`;
  let depth = 0, code = '';
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) return 'A string literal is not closed.';
        if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      code += "''"; i = j + 1; continue;
    }
    if (ch === '"') {
      const j = text.indexOf('"', i + 1);
      if (j < 0) return 'A quoted name is not closed.';
      code += '""'; i = j + 1; continue;
    }
    if ((ch === 'q' || ch === 'Q') && text[i + 1] === "'") return "q'…' strings are not supported in filters; use normal quotes ('it''s').";
    if (ch === ';') return 'A filter cannot contain “;”.';
    if (text.startsWith('--', i) || text.startsWith('/*', i)) return 'A filter cannot contain comments.';
    if (ch === ':' || ch === '?') return 'A filter cannot use bind variables; write the values directly.';
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return 'The filter has an unmatched “)”.';
    code += ch; i++;
  }
  if (depth) return 'The filter has an unmatched “(”.';
  const blocked = FILTER_BLOCKED.exec(code);
  if (blocked) return `A filter cannot use “${blocked[1].toUpperCase()}”; it must only select rows.`;
  return null;
}

/** `WHERE (filter)` for a validated filter, or ''. */
const filterClause = (filter: string | undefined) => filter ? ` WHERE (${filter.trim()})` : '';

export function parseCopyTableFilters(value: unknown): { tableFilters: Record<string, string> } | { error: string } {
  if (value === undefined || value === null) return { tableFilters: Object.create(null) };
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'tableFilters must map table names to WHERE filters.' };
  const filters: Record<string, string> = Object.create(null);
  for (const [name, where] of Object.entries(value)) {
    if (typeof where !== 'string') return { error: `The filter for ${name} must be text.` };
    if (!where.trim()) continue;
    const problem = copyFilterError(where);
    if (problem) return { error: `${name} filter: ${problem}` };
    filters[name] = where.trim();
  }
  return { tableFilters: filters };
}

/** Live row counts; a table with a filter counts only the rows it selects. */
export async function countCopyRows(source: oracledb.Connection, names: string[], filters: Record<string, string> = {}) {
  const counts: Record<string, number> = Object.create(null);
  for (const name of names) {
    const filter = filters[name];
    if (filter && copyFilterError(filter)) throw new Error(`${name} filter: ${copyFilterError(filter)}`);
    let result;
    try { result = await source.execute<{ ROW_COUNT: number }>('SELECT COUNT(*) AS row_count FROM ' + quoteCopyName(name) + filterClause(filter), [], { outFormat: oracledb.OUT_FORMAT_OBJECT }); }
    catch (e) { throw filter ? new Error(`${name} filter (WHERE ${filter}): ${(e as Error).message}`) : e; }
    const count = result.rows?.[0]?.ROW_COUNT;
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error('Cannot determine source row count for ' + name + '.');
    counts[name] = count;
  }
  return counts;
}

/**
 * Validates the rows that will actually be copied, after any per-table row limit, against the
 * chosen total limit (default 100,000; at most TABLE_COPY_MAX_ROWS).
 */
export function validateCopyCounts(counts: Record<string, number>, rowLimit?: number | null | ((name: string) => number | null), maxTotal = TABLE_COPY_DEFAULT_TOTAL_ROWS) {
  const cap = maxTotal.toLocaleString('en-US');
  const effective = Object.entries(counts).map(([name, count]) => [name, limitedCopyCount(count, typeof rowLimit === 'function' ? rowLimit(name) : rowLimit)] as const);
  const oversized = effective.filter(([, count]) => count > maxTotal);
  if (oversized.length) throw new Error(`Cannot copy tables exceeding the ${cap}-row limit: ` + oversized.map(([name, count]) => name + ' (' + count.toLocaleString('en-US') + ' rows)').join(', ') + '. Set a row limit per table or raise the total row limit.');
  const total = effective.reduce((sum, [, count]) => sum + count, 0);
  if (total > maxTotal) throw new Error('Selected tables contain ' + total.toLocaleString('en-US') + ` rows to copy, exceeding the ${cap}-row limit per copy. Select fewer tables, lower the row limit per table, or raise the total row limit.`);
  return total;
}

/** Column types whose tables count as large-object tables for the separate row limit. */
export const LOB_COPY_TYPES = ['CLOB', 'NCLOB', 'JSON'] as const;

/** Tables in the connected schema with at least one CLOB, NCLOB or JSON column. */
export async function lobCopyTables(conn: oracledb.Connection): Promise<string[]> {
  const result = await conn.execute<{ TABLE_NAME: string }>(
    `SELECT DISTINCT table_name FROM user_tab_cols WHERE hidden_column = 'NO' AND data_type IN (${LOB_COPY_TYPES.map(t => `'${t}'`).join(', ')}) ORDER BY table_name`,
    [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return (result.rows ?? []).map(r => r.TABLE_NAME);
}

const wholeRows = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= TABLE_COPY_MAX_ROWS;

/** Accepts no limit (undefined/null) or a whole number of rows from 1 to TABLE_COPY_MAX_ROWS. */
export function parseCopyRowLimit(value: unknown): { rowLimit: number | null } | { error: string } {
  if (value === undefined || value === null) return { rowLimit: null };
  if (!wholeRows(value)) return { error: `Row limit per table must be a whole number from 1 to ${TABLE_COPY_MAX_ROWS.toLocaleString('en-US')}, or omitted to copy all rows.` };
  return { rowLimit: value };
}

/** Rows chosen for individual tables: an object of table name → whole number from 1 to TABLE_COPY_MAX_ROWS. */
export function parseCopyTableRowLimits(value: unknown): { tableRowLimits: Record<string, number> } | { error: string } {
  if (value === undefined || value === null) return { tableRowLimits: Object.create(null) };
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'tableRowLimits must map table names to row counts.' };
  const limits: Record<string, number> = Object.create(null);
  for (const [name, rows] of Object.entries(value)) {
    if (!wholeRows(rows)) return { error: `Rows to copy for ${name} must be a whole number from 1 to ${TABLE_COPY_MAX_ROWS.toLocaleString('en-US')}.` };
    limits[name] = rows;
  }
  return { tableRowLimits: limits };
}

/** The total rows one copy may move: default 100,000, selectable from 1 to TABLE_COPY_MAX_ROWS. */
export function parseCopyTotalLimit(value: unknown): { maxTotal: number } | { error: string } {
  if (value === undefined || value === null) return { maxTotal: TABLE_COPY_DEFAULT_TOTAL_ROWS };
  if (!wholeRows(value)) return { error: `Total row limit must be a whole number from 1 to ${TABLE_COPY_MAX_ROWS.toLocaleString('en-US')}.` };
  return { maxTotal: value };
}

export async function nonEmptyCopyTables(target: oracledb.Connection, names: string[]) {
  const occupied: string[] = [];
  for (const name of names) {
    const result = await target.execute('SELECT 1 FROM ' + quoteCopyName(name) + ' WHERE ROWNUM = 1');
    if (result.rows?.length) occupied.push(name);
  }
  return occupied;
}

type ReferenceRow = { CHILD_OWNER: string; CHILD_TABLE: string; CONSTRAINT_NAME: string; PARENT_TABLE: string };

/** Enabled foreign keys (in any schema) that reference the given tables of this schema. */
async function referencesTo(target: oracledb.Connection, tables: string[]): Promise<ReferenceRow[]> {
  if (!tables.length) return [];
  const result = await target.execute<ReferenceRow>(
    `SELECT fk.owner AS child_owner, fk.table_name AS child_table, fk.constraint_name, pk.table_name AS parent_table
     FROM all_constraints fk JOIN user_constraints pk ON fk.r_owner = USER AND fk.r_constraint_name = pk.constraint_name
     WHERE fk.constraint_type = 'R' AND fk.status = 'ENABLED' AND pk.table_name IN (${tables.map((_, i) => ':' + (i + 1)).join(', ')})
     ORDER BY fk.table_name, fk.constraint_name`, tables, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return result.rows ?? [];
}

/**
 * Why `tables` cannot be truncated, or null. A table may only be truncated when every enabled
 * foreign key referencing it comes from a table in `selection` (which is emptied or copied
 * too); otherwise truncation would orphan rows that the copy does not replace.
 */
export async function truncateBlocker(target: oracledb.Connection, tables: string[], selection: string[]): Promise<string | null> {
  const user = (await target.execute<{ U: string }>('SELECT USER AS u FROM dual', [], { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows?.[0]?.U;
  const inSelection = new Set(selection);
  let outside = (await referencesTo(target, tables)).filter(r => r.CHILD_OWNER !== user || !inSelection.has(r.CHILD_TABLE));
  // An empty child in this schema has no rows to orphan: its foreign key is only disabled for
  // the truncation and re-enabled straight after, which validates trivially.
  const occupied = new Set(await nonEmptyCopyTables(target, [...new Set(outside.filter(r => r.CHILD_OWNER === user).map(r => r.CHILD_TABLE))]));
  outside = outside.filter(r => r.CHILD_OWNER !== user || occupied.has(r.CHILD_TABLE));
  if (!outside.length) return null;
  return 'Truncation blocked: ' + outside.map(r => `${r.CHILD_OWNER}.${r.CHILD_TABLE} (${r.CONSTRAINT_NAME}) references ${r.PARENT_TABLE}`).join('; ') +
    '. Select those child tables too, or empty them first.';
}

/**
 * TRUNCATEs `tables` (DDL: immediate, no undo, cannot be rolled back, DELETE triggers do not
 * fire). Foreign keys within the selection that reference them are disabled for the truncation
 * and re-enabled straight after, before any rows are copied.
 */
export async function truncateCopyTables(target: oracledb.Connection, tables: string[], selection: string[]) {
  const blocked = await truncateBlocker(target, tables, selection);
  if (blocked) throw new Error(blocked);
  const refs = await referencesTo(target, tables);
  const disabled: ReferenceRow[] = [];
  const constraintSql = (r: ReferenceRow, action: string) => `ALTER TABLE ${quoteCopyName(r.CHILD_TABLE)} ${action} CONSTRAINT ${quoteCopyName(r.CONSTRAINT_NAME)}`;
  const truncated: string[] = [];
  let failure: unknown;
  try {
    for (const r of refs) { await target.execute(constraintSql(r, 'DISABLE')); disabled.push(r); }
    for (const name of tables) { await target.execute(`TRUNCATE TABLE ${quoteCopyName(name)}`); truncated.push(name); }
  } catch (e) { failure = e; }
  const enableFailures: string[] = [];
  for (const r of disabled) {
    try { await target.execute(constraintSql(r, 'ENABLE')); }
    catch (e) { enableFailures.push(`${constraintSql(r, 'ENABLE')}; — ${(e as Error).message}`); }
  }
  if (failure || enableFailures.length) {
    const done = truncated.length ? ` Already truncated (cannot be undone): ${truncated.join(', ')}.` : ' No tables were truncated.';
    const repair = enableFailures.length ? ` Re-enable these foreign keys: ${enableFailures.join(' ')}` : '';
    throw new Error(`${failure ? `Truncation failed: ${(failure as Error).message}.` : 'Foreign keys could not be re-enabled after truncation.'}${done}${repair} No rows were copied.`);
  }
  return truncated;
}

/**
 * Copies tables in the given order, which must be dependency order (parents first), and
 * COMMITS EACH TABLE as soon as its rows are inserted, so undo only has to hold one table.
 * Tables are normally empty in the target; a table that keeps its rows gets the copied rows on
 * top, and a copied row with an existing key stops the copy like any other duplicate.
 *
 * - Rows rejected for a missing parent key (ORA-02291) are kept in memory and retried after
 *   every table, so self-references and cycles resolve once their parents arrive. Rows whose
 *   parents never appear (for example, outside a `rowLimit` sample) are skipped and reported.
 * - Any other error rolls back only the table in progress. Tables already committed keep their
 *   rows; the error says which ones so they can be emptied before a retry.
 * - Identity DDL (ALWAYS → BY DEFAULT) runs before the first insert; sequences are synchronized
 *   and ALWAYS restored after the last commit or after the rollback, never mid-transaction.
 * - CLOB/NCLOB/JSON values up to INLINE_LOB_CHARS are fetched inline as text; larger values are
 *   streamed into a temporary LOB on the target, so their size is not limited by memory.
 * - Rows move in large batches, and the next batch is fetched while the current one is inserted.
 */
export interface CopyTrigger { name: string; table: string }
/** Pieces of a table's INSERT, so large CLOB/NCLOB values can be inserted as EMPTY_CLOB() and written in place. */
interface DirectLobInsert { into: string; values: string[]; columns: string[]; writable: boolean[] }
/** Enabled triggers, owned by the target schema, on the given tables. */
export async function enabledCopyTriggers(target: oracledb.Connection, names: string[]): Promise<CopyTrigger[]> {
  const wanted = new Set(names);
  const result = await target.execute<{ TRIGGER_NAME: string; TABLE_NAME: string }>(
    `SELECT trigger_name, table_name FROM user_triggers WHERE status = 'ENABLED' AND base_object_type = 'TABLE' AND table_owner = USER ORDER BY table_name, trigger_name`,
    [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return (result.rows ?? []).filter(r => wanted.has(r.TABLE_NAME)).map(r => ({ name: r.TRIGGER_NAME, table: r.TABLE_NAME }));
}

export async function copyTableRows(source: oracledb.Connection, target: oracledb.Connection, names: string[], options: { rowLimit?: number | null; lobRowLimit?: number | null; tableRowLimits?: Record<string, number>; maxTotal?: number; disableTriggers?: boolean; onProgress?: (event: CopyProgressEvent) => void; signal?: AbortSignal; tableFilters?: Record<string, string> } = {}) {
  const signal = options.signal;
  /** Stop between batches. A stop during the data phase also cancels the database call in flight (see below). */
  const checkStop = () => { if (signal?.aborted) throw new CopyStoppedError(); };
  const rowLimit = options.rowLimit ?? null;
  const lobRowLimit = options.lobRowLimit ?? null;
  // Progress reporting must never break the copy.
  const emit = (event: CopyProgressEvent) => { try { options.onProgress?.(event); } catch { /* ignore */ } };
  const maxTotal = options.maxTotal ?? TABLE_COPY_DEFAULT_TOTAL_ROWS;
  let total = 0;
  // `rowErrors` holds the Oracle message for each failed row (same order as `rows`), when known.
  // `direct` builds the insert that writes large CLOB/NCLOB values straight into the new row.
  type Pending = { name: string; sql: string; rows: unknown[][]; error: string; bytes: number; types?: oracledb.DbType[]; rowErrors?: string[]; direct?: DirectLobInsert };
  let pending: Pending[] = [];
  const committed: Record<string, number> = Object.create(null);
  let uncommitted: Record<string, number> = Object.create(null);
  const note = (name: string, rows: number) => { if (rows) { uncommitted[name] = (uncommitted[name] ?? 0) + rows; emit({ kind: 'rows', name, rows }); } };
  const checkPendingBytes = () => {
    if (pending.reduce((n, b) => n + b.bytes, 0) <= PENDING_RETRY_BYTES) return;
    // Say what the held rows wait for, so the parent table can be copied first or included.
    const waiting = new Map<string, number>();
    for (const b of pending) b.rows.forEach((_, i) => {
      const key = `${b.name}${(d => d ? ` (${d})` : '')(describeBlocker(b.rowErrors?.[i] ?? b.error))}`;
      waiting.set(key, (waiting.get(key) ?? 0) + 1);
    });
    throw new Error(`Rows waiting for parent keys exceed the ${PENDING_RETRY_BYTES / 1024 / 1024} MB retry limit: ${[...waiting].map(([k, n]) => `${n.toLocaleString('en-US')} from ${k}`).join(', ')}. These parents arrive later in this copy (a cycle or self-reference), so the rows must be held until then. Copy the parent table on its own first, or set a smaller row limit for these tables.`);
  };
  const identities: { name: string; column: string; always: boolean; options: string }[] = [];
  const rowidColumns: string[] = [];
  const changed: typeof identities = [];
  const alter = (id: typeof identities[number], clause: string) =>
    `ALTER TABLE ${quoteCopyName(id.name)} MODIFY (${quoteCopyName(id.column)} GENERATED ${clause} AS IDENTITY)`;
  const restore = async () => {
    const failures: string[] = [];
    for (const id of changed) {
      const sql = alter(id, 'ALWAYS');
      try { await target.execute(sql); }
      catch (e) { failures.push(`${sql}; — ${(e as Error).message}`); }
    }
    return failures;
  };
  // Triggers this copy disabled; only these are re-enabled, never ones that were already disabled.
  const disabledTriggers: CopyTrigger[] = [];
  const enableTriggers = async () => {
    const failures: string[] = [];
    for (const trigger of disabledTriggers.splice(0)) {
      const sql = `ALTER TRIGGER ${quoteCopyName(trigger.name)} ENABLE`;
      try { await target.execute(sql); }
      catch (e) { failures.push(`${sql}; — ${(e as Error).message}`); }
    }
    return failures;
  };
  /** Advance identity sequences past the copied IDs, for tables that have committed rows. */
  const synchronize = async () => {
    const failures: string[] = [];
    for (const id of identities.filter(id => committed[id.name])) {
      const sql = `ALTER TABLE ${quoteCopyName(id.name)} MODIFY (${quoteCopyName(id.column)} GENERATED AS IDENTITY (START WITH LIMIT VALUE ${id.options}))`;
      try { await target.execute(sql); }
      catch (e) { failures.push(`${sql}; — ${(e as Error).message}`); }
    }
    return failures;
  };
  /** Rows holding a streamed LOB are bound one at a time (executeMany cannot bind LOB objects); all others in one array insert. */
  const insert = async (batch: Pending): Promise<Pending | null> => {
    const streamed = batch.rows.filter(row => row.some(isLob));
    if (!streamed.length) return insertMany(batch);
    const inline = batch.rows.filter(row => !row.some(isLob));
    const failures = [inline.length ? await insertMany({ ...batch, rows: inline }) : null, await insertEach({ ...batch, rows: streamed })].filter((f): f is Pending => !!f);
    if (!failures.length) return null;
    const rows = failures.flatMap(f => f.rows);
    return { ...batch, rows, error: failures[0].error, bytes: rowBytes(rows), rowErrors: failures.flatMap(f => f.rows.map((_, i) => f.rowErrors?.[i] ?? f.error)) };
  };
  const insertEach = async (batch: Pending): Promise<Pending | null> => {
    const failed: unknown[][] = [];
    const rowErrors: string[] = [];
    let error = '';
    const bind = (val: unknown, i: number) => isLob(val) || !batch.types ? { val } : { type: batch.types[i], val };
    for (const row of batch.rows) {
      // Large CLOB/NCLOB values are written straight into the inserted row's own LOB, one chunk
      // per round trip. Binding a temporary LOB instead makes the INSERT copy the whole value
      // server-side in a single call, which for big values outlasts the call timeout (NJS-123).
      // JSON values (bound through JSON()) still go through a temporary LOB.
      const direct = batch.direct ? row.flatMap((val, i) => isLob(val) && sourceLobs.has(val) && batch.direct!.writable[i] ? [i] : []) : [];
      // Retries reuse the temporary target LOB streamed on the first attempt.
      for (let i = 0; i < row.length; i++) if (!direct.includes(i) && isLob(row[i]) && sourceLobs.has(row[i] as oracledb.Lob)) row[i] = await streamLob(row[i] as oracledb.Lob);
      try {
        if (direct.length) {
          const { into, values, columns } = batch.direct!;
          const sql = `${into} VALUES (${values.map((v, i) => direct.includes(i) ? 'EMPTY_CLOB()' : v).join(', ')}) RETURNING ${direct.map(i => columns[i]).join(', ')} INTO ${direct.map((_, k) => `:df$out${k}`).join(', ')}`;
          const binds = [...row.flatMap((val, i) => direct.includes(i) ? [] : [bind(val, i)]),
            ...direct.map(i => ({ dir: oracledb.BIND_OUT, type: (row[i] as oracledb.Lob).type }))];
          const result = await target.execute(sql, binds as oracledb.BindParameters, { autoCommit: false });
          const outs = (result.outBinds ?? []) as unknown[];
          for (let k = 0; k < direct.length; k++) {
            const dest = (Array.isArray(outs[k]) ? (outs[k] as unknown[])[0] : outs[k]) as oracledb.Lob | undefined;
            if (!isLob(dest)) throw new Error('the inserted row returned no LOB locator to write into.');
            const value = row[direct[k]] as oracledb.Lob;
            sourceLobs.delete(value);
            row[direct[k]] = null;
            try { await copyLob(value, dest); } finally { dest.destroy(); }
          }
        } else {
          await target.execute(batch.sql, row.map(bind) as oracledb.BindParameters, { autoCommit: false });
        }
        note(batch.name, 1);
        release([row]);
      } catch (e) {
        if (oracleErrorNumber(e as Error) !== 2291) throw new Error(`${batch.name}: ${(e as Error).message}`);
        // Nothing was written; keep the values in temporary target LOBs for the retry.
        for (const i of direct) if (isLob(row[i]) && sourceLobs.has(row[i] as oracledb.Lob)) row[i] = await streamLob(row[i] as oracledb.Lob);
        failed.push(row);
        error = (e as Error).message;
        rowErrors.push(error);
      }
    }
    return failed.length ? { ...batch, rows: failed, error, bytes: rowBytes(failed), rowErrors } : null;
  };
  const insertMany = async (batch: Pending): Promise<Pending | null> => {
    const bindDefs = batch.types?.map((type, i) => ({ type,
      ...(type === oracledb.STRING || type === oracledb.DB_TYPE_NVARCHAR || type === oracledb.BUFFER ? {
        maxSize: Math.max(1, ...batch.rows.map(row => Buffer.isBuffer(row[i]) ? row[i].length : typeof row[i] === 'string' ? Buffer.byteLength(row[i]) : 0)),
      } : {}),
    }));
    const result = await target.executeMany(batch.sql, batch.rows as oracledb.BindParameters[], { autoCommit: false, batchErrors: true, ...(bindDefs ? { bindDefs } : {}) });
    const errors = result.batchErrors ?? [];
    const fatal = errors.find(e => oracleErrorNumber(e) !== 2291);
    if (fatal) throw new Error(`${batch.name}: ${fatal.message}`);
    if (!errors.length) { note(batch.name, batch.rows.length); return null; }
    const offsets = new Map<number, string>();
    for (const e of errors) {
      if (e.offset === undefined || e.offset < 0 || e.offset >= batch.rows.length) throw new Error('Oracle returned an invalid failed-row offset.');
      offsets.set(e.offset, e.message);
    }
    note(batch.name, batch.rows.length - offsets.size);
    const failedAt = batch.rows.flatMap((_, i) => offsets.has(i) ? [i] : []);
    const rows = failedAt.map(i => batch.rows[i]);
    return { ...batch, rows, error: errors[0].message, bytes: rowBytes(rows), rowErrors: failedAt.map(i => offsets.get(i)!) };
  };
  /** Retry parent-blocked rows until no more of them can be inserted. */
  const retryPending = async () => {
    if (pending.length) emit({ kind: 'retry', rows: pending.reduce((n, b) => n + b.rows.length, 0) });
    for (let pass = 0; pending.length; pass++) {
      if (pass >= 100) throw new Error('Parent dependency retry limit reached.');
      checkStop();
      const before = pending.reduce((n, b) => n + b.rows.length, 0);
      const next: Pending[] = [];
      for (const batch of pending) {
        checkStop();
        const failed = await triage(await insert(batch));
        if (failed) next.push(failed);
      }
      pending = next;
      if (pending.reduce((n, b) => n + b.rows.length, 0) === before) return;
    }
  };
  const commitTable = async (table: string) => {
    // Never cancel a COMMIT: the table's outcome must be known. A stop during it applies next.
    dataPhase = false;
    try { await target.commit(); } finally { dataPhase = !signal?.aborted; }
    for (const [name, rows] of Object.entries(uncommitted)) committed[name] = (committed[name] ?? 0) + rows;
    for (const name of new Set([table, ...Object.keys(uncommitted)])) emit({ kind: 'committed', name, rows: committed[name] ?? 0 });
    uncommitted = Object.create(null);
  };
  const committedSummary = () => Object.entries(committed).map(([n, c]) => `${n} (${c.toLocaleString('en-US')})`).join(', ');
  let current = '';
  let currentIndex = -1;
  let dataPhase = false;
  let interrupted = false;
  const interrupt = () => {
    if (!dataPhase || interrupted) return;
    interrupted = true;
    void target.break?.().catch(() => {});
    void source.break?.().catch(() => {});
  };
  signal?.addEventListener('abort', interrupt, { once: true });
  // Enabled foreign keys of this schema: constraint name → parent table (null when the parent
  // is in another schema, so this copy can never supply its rows) and a label for messages.
  // Loaded on the first parent-key error, so copies without one run no extra query.
  const foreignKeys = new Map<string, { parent: string | null; label: string }>();
  let foreignKeysLoaded = false;
  const loadForeignKeys = async () => {
    if (foreignKeysLoaded) return;
    foreignKeysLoaded = true;
    try {
      const result = await target.execute<{ CONSTRAINT_NAME?: unknown; PARENT_TABLE?: unknown; PARENT_LABEL?: unknown }>(
        `SELECT fk.constraint_name, CASE WHEN pk.owner = USER THEN pk.table_name END AS parent_table, pk.owner || '.' || pk.table_name AS parent_label
         FROM user_constraints fk JOIN all_constraints pk ON pk.owner = fk.r_owner AND pk.constraint_name = fk.r_constraint_name
         WHERE fk.constraint_type = 'R'`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      for (const r of result.rows ?? []) {
        if (typeof r.CONSTRAINT_NAME !== 'string' || typeof r.PARENT_LABEL !== 'string') continue;
        foreignKeys.set(r.CONSTRAINT_NAME, { parent: typeof r.PARENT_TABLE === 'string' ? r.PARENT_TABLE : null, label: r.PARENT_LABEL });
      }
    } catch { /* without it, parent-blocked rows are retried until the end, as before */ }
  };
  const blockingKey = (message: string) => {
    const constraint = violatedConstraint(message);
    const fk = constraint ? foreignKeys.get(constraint) : undefined;
    return constraint && fk ? { constraint, ...fk } : null;
  };
  const describeBlocker = (message: string) => { const fk = blockingKey(message); return fk ? `${fk.constraint} → ${fk.label}` : null; };
  /** Whether more rows may still arrive in `parent` during this copy. */
  const parentMayGrow = (parent: string) => parent === current || (names.indexOf(parent) > currentIndex) || pending.some(b => b.name === parent);
  // Rows dropped early, grouped by table and foreign key, for the final report.
  const dropped = new Map<string, { name: string; rows: number; reason: string }>();
  /**
   * Keeps parent-blocked rows that may still succeed and drops those whose parent table gets no
   * more rows in this copy (it is not part of it, was already copied, or lives in another
   * schema): retrying them could never work, and they would hold memory until the end.
   */
  const triage = async (failed: Pending | null): Promise<Pending | null> => {
    if (!failed) return null;
    await loadForeignKeys();
    const keep: unknown[][] = [], keepErrors: string[] = [];
    const drop = new Map<string, { rows: unknown[][]; reason: string }>();
    failed.rows.forEach((row, i) => {
      const message = failed.rowErrors?.[i] ?? failed.error;
      const fk = blockingKey(message);
      if (!fk || (fk.parent !== null && parentMayGrow(fk.parent))) { keep.push(row); keepErrors.push(message); return; }
      const where = fk.parent === null ? 'is in another schema'
        : names.includes(fk.parent) ? 'was already copied in this copy'
        : 'is not part of this copy';
      const group = drop.get(fk.constraint) ?? { rows: [], reason: `their parent keys are missing in ${fk.label} (${fk.constraint}), which ${where}. Copy or fill the parent rows first, or include ${fk.parent ?? 'that table'} in the copy.` };
      group.rows.push(row);
      drop.set(fk.constraint, group);
    });
    for (const [constraint, group] of drop) {
      release(group.rows);
      const key = `${failed.name}\u0000${constraint}`;
      const entry = dropped.get(key) ?? { name: failed.name, rows: 0, reason: group.reason };
      entry.rows += group.rows.length;
      dropped.set(key, entry);
      emit({ kind: 'skipped', name: failed.name, rows: group.rows.length, reason: group.reason });
    }
    return keep.length ? { ...failed, rows: keep, rowErrors: keepErrors, bytes: rowBytes(keep) } : null;
  };
  // Temporary target LOBs holding streamed values; freed once their row is inserted or skipped.
  const tempLobs = new Set<oracledb.Lob>();
  const release = (rows: unknown[][]) => {
    for (const row of rows) for (const value of row) if (isLob(value) && tempLobs.delete(value)) value.destroy();
  };
  // Source locators of large values, fetched but not yet streamed. A value is streamed only
  // right before its own row is inserted, so at most one large value is in flight at a time
  // and progress advances row by row.
  const sourceLobs = new Set<oracledb.Lob>();
  /** Small values become text; large ones stay as source locators until streamed. */
  const readLob = async (lob: oracledb.Lob): Promise<string | oracledb.Lob> => {
    if (lob.length > INLINE_LOB_CHARS) { sourceLobs.add(lob); return lob; }
    try { return await lob.getData() as string; } finally { lob.destroy(); }
  };
  /** Copy a large source value into a temporary target LOB, reading the next chunk while writing this one. */
  const streamLob = async (lob: oracledb.Lob): Promise<oracledb.Lob> => {
    sourceLobs.delete(lob);
    const copy: oracledb.Lob = await target.createLob(lob.type as oracledb.DbType);
    tempLobs.add(copy);
    await copyLob(lob, copy);
    return copy;
  };
  /** Copy a source LOB into a target LOB chunk by chunk, reading the next chunk while writing this one. Destroys the source. */
  const copyLob = async (lob: oracledb.Lob, copy: oracledb.Lob): Promise<void> => {
    const write = (text: string) => new Promise<void>((resolve, reject) => copy.write(text, e => e ? reject(e) : resolve()));
    const read = (offset: number) => offset <= lob.length ? lob.getData(offset, LOB_CHUNK_CHARS) as Promise<string | null> : Promise.resolve(null);
    let ahead = read(1);
    try {
      // Offsets and lengths count UTF-16 code units; a chunk never ends mid surrogate pair.
      let carry = '';
      for (let offset = 1; ;) {
        const part = await ahead;
        if (!part) break;
        offset += part.length;
        ahead = read(offset);
        ahead.catch(() => { /* awaited next */ });
        let text = carry + part;
        const last = text.charCodeAt(text.length - 1);
        carry = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : '';
        if (carry) text = text.slice(0, -1);
        if (text) await write(text);
      }
      if (carry) await write(carry);
    } finally {
      await ahead.catch(() => {});
      lob.destroy();
    }
  };
  try {
    checkStop();
    // Preflight every table before inserting any data.
    const plans = [];
    for (const name of names) {
      const read = async (conn: oracledb.Connection) => (await conn.execute<CopyColumn>(
        `SELECT c.column_name, c.data_type, c.data_length, c.virtual_column, c.identity_column, i.generation_type, i.identity_options
         FROM user_tab_cols c LEFT JOIN user_tab_identity_cols i
           ON i.table_name = c.table_name AND i.column_name = c.column_name
         WHERE c.table_name=:name AND c.hidden_column='NO' ORDER BY c.column_id`,
        { name }, { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows ?? [];
      const sourceColumns = await read(source), targetColumns = await read(target);
      const columns = copyColumns(sourceColumns, targetColumns);
      const timestampColumns = new Set(sourceColumns.filter(c => isTimestamp(c.DATA_TYPE)).map(c => c.COLUMN_NAME));
      const zonedColumns = new Map(sourceColumns.filter(c => isTimestampTz(c.DATA_TYPE) || isTimestampLtz(c.DATA_TYPE)).map(c => [c.COLUMN_NAME, isTimestampLtz(c.DATA_TYPE)] as const));
      const jsonColumns = new Set(sourceColumns.filter(c => c.DATA_TYPE === 'JSON').map(c => c.COLUMN_NAME));
      const hasLargeText = sourceColumns.some(c => (LOB_COPY_TYPES as readonly string[]).includes(c.DATA_TYPE));
      const vectors = sourceColumns.filter(c => c.DATA_TYPE === 'VECTOR');
      if (vectors.length) {
        const sql = `SELECT ${vectors.map(c => quoteCopyName(c.COLUMN_NAME)).join(', ')} FROM ${quoteCopyName(name)} WHERE 1=0`;
        const srcMeta = (await source.execute(sql)).metaData as VectorMetadata[] | undefined;
        const dstMeta = (await target.execute(sql)).metaData as VectorMetadata[] | undefined;
        for (let i = 0; i < vectors.length; i++) {
          const a = srcMeta?.[i], b = dstMeta?.[i];
          if (!a || !b || a.dbType !== oracledb.DB_TYPE_VECTOR || b.dbType !== oracledb.DB_TYPE_VECTOR ||
              a.vectorDimensions !== b.vectorDimensions || a.vectorFormat !== b.vectorFormat || a.isSparseVector !== b.isSparseVector) {
            throw new Error(`${name}.${vectors[i].COLUMN_NAME}: target VECTOR dimensions, format, or storage differ from the source.`);
          }
        }
      }
      // Explicit VECTOR binds are essential for binary vectors and all-null batches.
      const types = vectors.length || hasLargeText ? columns.map(column => {
        const type = sourceColumns.find(c => c.COLUMN_NAME === column)!.DATA_TYPE;
        if (type === 'VECTOR') return oracledb.DB_TYPE_VECTOR;
        if (type === 'JSON' || type === 'CLOB') return oracledb.CLOB;
        if (type === 'NCLOB') return oracledb.NCLOB;
        if (type === 'RAW') return oracledb.BUFFER;
        if (type === 'DATE') return oracledb.DATE;
        // NUMBER/FLOAT travel as exact decimal text (see numberIndexes); IEEE binary types are exact as JS numbers.
        if (type === 'NUMBER' || type === 'FLOAT') return oracledb.STRING;
        if (type === 'BINARY_FLOAT' || type === 'BINARY_DOUBLE') return oracledb.NUMBER;
        if (['NCHAR', 'NVARCHAR2'].includes(type)) return oracledb.DB_TYPE_NVARCHAR;
        return oracledb.STRING;
      }) : undefined;
      // Oracle NUMBER holds up to 38 significant digits; a JS number keeps ~15-17. Fetch as text.
      const numberIndexes = columns.flatMap((column, i) => ['NUMBER', 'FLOAT'].includes(sourceColumns.find(c => c.COLUMN_NAME === column)!.DATA_TYPE) ? [i] : []);
      const lobIndexes = columns.flatMap((column, i) => ['JSON', 'CLOB', 'NCLOB'].includes(sourceColumns.find(c => c.COLUMN_NAME === column)!.DATA_TYPE) ? [i] : []);
      const batchRows = copyBatchRows(sourceColumns.filter(c => columns.includes(c.COLUMN_NAME)), hasLargeText);
      plans.push({ name, columns, timestampColumns, zonedColumns, jsonColumns, types, numberIndexes, lobIndexes, batchRows, limit: copyRowLimitFor(name, rowLimit, lobRowLimit, new Set(hasLargeText ? [name] : []), options.tableRowLimits) });
      rowidColumns.push(...sourceColumns.filter(c => c.DATA_TYPE === 'ROWID' || c.DATA_TYPE === 'UROWID').map(c => `${name}.${c.COLUMN_NAME}`));
      for (const c of targetColumns.filter(c => c.IDENTITY_COLUMN === 'YES' && columns.includes(c.COLUMN_NAME))) {
        identities.push({ name, column: c.COLUMN_NAME, always: c.GENERATION_TYPE === 'ALWAYS', options: identitySequenceOptions(c.IDENTITY_OPTIONS) });
      }
    }
    for (const id of identities.filter(id => id.always)) {
      await target.execute(alter(id, 'BY DEFAULT'));
      changed.push(id);
    }
    // Like the identity DDL, runs before any insert (DDL commits) and is undone at the end.
    if (options.disableTriggers) {
      for (const trigger of await enabledCopyTriggers(target, names)) {
        await target.execute(`ALTER TRIGGER ${quoteCopyName(trigger.name)} DISABLE`);
        disabledTriggers.push(trigger);
      }
    }
    // NUMBER text is fetched with '.' as the decimal point, while Oracle converts text back to
    // NUMBER using the target session's NLS decimal character. Match it, without altering the
    // (pooled) session.
    let decimal = '.';
    if (plans.some(plan => plan.numberIndexes.length)) {
      const nls = await target.execute<{ VALUE?: unknown }>(`SELECT value FROM nls_session_parameters WHERE parameter = 'NLS_NUMERIC_CHARACTERS'`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const value = nls.rows?.[0]?.VALUE;
      if (typeof value === 'string' && value.length >= 1) decimal = value[0];
    }
    // Only now may a stop cancel calls in flight (ORA-01013): never the identity or trigger DDL
    // above, and the catch below rolls back the table in progress either way.
    dataPhase = true;
    if (signal?.aborted) interrupt();
    for (const { name, columns, timestampColumns, zonedColumns, jsonColumns, types, numberIndexes, lobIndexes, batchRows, limit } of plans) {
      checkStop();
      current = name;
      currentIndex = names.indexOf(name);
      emit({ kind: 'table', name });
      const cols = columns.map(quoteCopyName).join(', ');
      const projection = columns.map(c => jsonColumns.has(c) ? `JSON_SERIALIZE(${quoteCopyName(c)} RETURNING CLOB EXTENDED ERROR ON ERROR) AS ${quoteCopyName(c)}` : timestampColumns.has(c) ? `TO_CHAR(${quoteCopyName(c)}, '${timestampFormat}') AS ${quoteCopyName(c)}` : zonedColumns.has(c) ? `TO_CHAR(${zonedColumns.get(c) ? `CAST(${quoteCopyName(c)} AS TIMESTAMP WITH TIME ZONE)` : quoteCopyName(c)}, '${timestampTzFormat}') AS ${quoteCopyName(c)}` : quoteCopyName(c)).join(', ');
      const values = columns.map((c, i) => jsonColumns.has(c) ? `JSON(:${i + 1} EXTENDED)` : timestampColumns.has(c) ? `TO_TIMESTAMP(:${i + 1}, '${timestampFormat}')` : zonedColumns.has(c) ? `TO_TIMESTAMP_TZ(:${i + 1}, '${timestampTzFormat}')` : `:${i + 1}`);
      const identityIndexes = identities.filter(id => id.name === name).map(id => columns.indexOf(id.column));
      // CLOB/NCLOB/JSON values arrive in two columns: values up to INLINE_LOB_CHARS come back as
      // text with the rest of the row, so LOB tables still copy in batches without a round trip
      // per value; only larger values arrive as locators and are streamed.
      const filter = options.tableFilters?.[name];
      if (filter && copyFilterError(filter)) throw new Error(`${name} filter: ${copyFilterError(filter)}`);
      const inner = `SELECT ${projection} FROM ${quoteCopyName(name)}${filterClause(filter)}${limit ? `${filter ? ' AND' : ' WHERE'} ROWNUM <= :row_limit` : ''}`;
      const sql = lobIndexes.length
        ? `SELECT ${columns.map((c, i) => lobIndexes.includes(i) ? `CASE WHEN DBMS_LOB.GETLENGTH(${quoteCopyName(c)}) <= ${INLINE_LOB_CHARS} THEN ${quoteCopyName(c)} END AS ${inlineAlias(i)}` : quoteCopyName(c)).join(', ')}, ` +
          // The plain column, never an expression: a CASE over a LOB could make the source copy
          // every large value into a temporary LOB before it is even read.
          `${lobIndexes.map(i => `${quoteCopyName(columns[i])} AS ${streamAlias(i)}`).join(', ')} FROM (${inner})`
        : inner;
      const query = await source.execute<unknown[]>(sql, limit ? { row_limit: limit } : [], {
        resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, fetchArraySize: batchRows, prefetchRows: batchRows + 1,
        fetchTypeHandler: (meta: Parameters<NonNullable<oracledb.ExecuteOptions['fetchTypeHandler']>>[0]) => {
          if (meta.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING };
          if (meta.name?.startsWith('DF$INLINE$')) return { type: oracledb.STRING };
        },
      });
      const cursor = query.resultSet!;
      const statement = `INSERT INTO ${quoteCopyName(name)} (${cols}) VALUES (${values.join(', ')})`;
      const direct: DirectLobInsert | undefined = lobIndexes.length ? { into: `INSERT INTO ${quoteCopyName(name)} (${cols})`, values, columns: columns.map(quoteCopyName), writable: columns.map((c, i) => lobIndexes.includes(i) && !jsonColumns.has(c)) } : undefined;
      const fetchBatch = async () => {
        const rows = await cursor.getRows(batchRows);
        for (const row of rows) {
          // Use the locator only where the value was too large to arrive inline; release the rest.
          lobIndexes.forEach((i, j) => {
            const lob = row[columns.length + j];
            if (row[i] == null && lob != null) row[i] = lob;
            else if (isLob(lob)) lob.destroy();
          });
          row.length = columns.length;
          for (let i = 0; i < row.length; i++) if (isLob(row[i])) row[i] = await readLob(row[i] as oracledb.Lob);
        }
        return rows;
      };
      // Pipeline: the next batch is fetched from the source while this one is inserted into the
      // target, so both databases work at the same time instead of taking turns.
      let next = fetchBatch();
      next.catch(() => { /* awaited below */ });
      try {
        for (;;) {
          const rows = await next;
          checkStop();
          if (!rows.length) break;
          next = fetchBatch();
          next.catch(() => { /* awaited below */ });
          if (rows.some(row => identityIndexes.some(index => row[index] == null))) {
            throw new Error(`${name}: source identity values cannot be null; generating replacement IDs would change relationships.`);
          }
          total += rows.length;
          if (total > maxTotal) throw new Error(`Copy exceeds the ${maxTotal.toLocaleString('en-US')}-row limit. Raise the total row limit (up to ${TABLE_COPY_MAX_ROWS.toLocaleString('en-US')}) or use a bulk migration tool for larger copies.`);
          // Guard: NUMBER columns must arrive as text. A JS number here would already be rounded.
          if (rows.some(row => numberIndexes.some(i => typeof row[i] === 'number' && (!Number.isFinite(row[i] as number) || (Number.isInteger(row[i]) && !Number.isSafeInteger(row[i] as number)))))) {
            throw new Error('A numeric value exceeds JavaScript’s safe range. Use a database-native migration to preserve its precision.');
          }
          if (decimal !== '.') {
            for (const row of rows) for (const i of numberIndexes) if (typeof row[i] === 'string') row[i] = (row[i] as string).replace('.', decimal);
          }
          const failed = await triage(await insert({ name, sql: statement, rows, error: '', bytes: 0, types, direct }));
          if (failed) {
            emit({ kind: 'deferred', name, rows: failed.rows.length, waitingFor: [...new Set(failed.rows.map((_, i) => describeBlocker(failed.rowErrors?.[i] ?? failed.error)).filter((d): d is string => !!d))] });
            pending.push(failed);
            checkPendingBytes();
          }
        }
      } finally {
        // Never close the cursor (or let the error path roll back) under an in-flight fetch.
        await next.catch(() => {});
        await cursor.close();
      }
      // Earlier parent-blocked rows may now have their parents (and this table's own
      // self-references resolve here), then the table is committed on its own.
      await retryPending();
      await commitTable(name);
    }
    current = '';
    dataPhase = false;
  } catch (e) {
    dataPhase = false;
    const message = signal?.aborted ? 'Copy stopped by user.' : (e as Error).message.replace(/\.?\s*$/, '.');
    const kept = committedSummary();
    const partial = kept
      ? ` Tables already committed keep their rows: ${kept}.${current ? ` ${current} was rolled back.` : ''} Empty the copied tables before retrying.`
      : ' No rows were committed.';
    // Never run DDL unless rollback succeeded: DDL would commit the table in progress.
    try { await target.rollback(); }
    catch (rollbackError) {
      const triggers = disabledTriggers.length ? ` Disabled triggers need re-enabling: ${disabledTriggers.map(t => t.name).join(', ')}.` : '';
      throw new Error(`${message}${partial} Rollback failed: ${(rollbackError as Error).message}. Identity modes may need manual restoration for ${changed.map(id => `${id.name}.${id.column}`).join(', ')}.${triggers}`);
    }
    const failures = [...await synchronize(), ...await restore(), ...await enableTriggers()];
    if (failures.length) throw new Error(`${message}${partial} Identity or trigger repair failed. Run: ${failures.join(' ')}`);
    throw new Error(`${message}${partial}`);
  } finally {
    signal?.removeEventListener('abort', interrupt);
    for (const lob of tempLobs) lob.destroy();
    tempLobs.clear();
    for (const lob of sourceLobs) lob.destroy();
    sourceLobs.clear();
  }
  // Rows are committed. Cleanup failures must not be reported as a failed/retryable copy.
  const warnings: string[] = [];
  if (identities.some(id => committed[id.name]) || changed.length || disabledTriggers.length) emit({ kind: 'finishing' });
  warnings.push(...(await synchronize()).map(failure => `Rows are committed. Before generating new IDs, run: ${failure}`));
  warnings.push(...(await restore()).map(failure => `Rows are committed. Restore the identity mode: ${failure}`));
  const wereDisabled = [...disabledTriggers];
  warnings.push(...(await enableTriggers()).map(failure => `Rows are committed. Re-enable the trigger: ${failure}`));
  if (wereDisabled.length) warnings.push(`${wereDisabled.length} target trigger(s) were disabled while copying and are enabled again: ${wereDisabled.map(t => `${t.name} (${t.table})`).join(', ')}. They did not run for the copied rows, so sequences or audit rows they maintain were not updated.`);
  const skipped: Record<string, number> = Object.create(null);
  for (const batch of pending) skipped[batch.name] = (skipped[batch.name] ?? 0) + batch.rows.length;
  for (const d of dropped.values()) skipped[d.name] = (skipped[d.name] ?? 0) + d.rows;
  const skippedRows = Object.values(skipped).reduce((n, c) => n + c, 0);
  if (skippedRows) warnings.unshift(`${skippedRows.toLocaleString('en-US')} rows were not copied because their parent rows ${rowLimit || lobRowLimit || Object.keys(options.tableRowLimits ?? {}).length ? 'were not in the sample' : 'do not exist in the source or target'}: ${Object.entries(skipped).map(([n, c]) => `${n} (${c.toLocaleString('en-US')})`).join(', ')}.`);
  for (const d of dropped.values()) warnings.push(`${d.name}: ${d.rows.toLocaleString('en-US')} row(s) skipped — ${d.reason}`);
  if (rowidColumns.length) warnings.push(`ROWID/UROWID values were copied as-is in ${rowidColumns.join(', ')}. They address rows in the source database, so they will not locate rows in the target; update them if your application relies on them.`);
  const tables = names.map(name => ({ name, rows: committed[name] ?? 0, ...(skipped[name] ? { skipped: skipped[name] } : {}) }));
  return { tables, totalRows: tables.reduce((n, t) => n + t.rows, 0), ...(skippedRows ? { skippedRows } : {}), ...(warnings.length ? { warnings } : {}) };
}
