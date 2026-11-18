import oracledb from 'oracledb';
import { limitedCopyCount, TABLE_COPY_DEFAULT_TOTAL_ROWS, TABLE_COPY_MAX_ROWS, type TableDependency } from '../src/utils/tableDataDependencies.ts';

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

export interface CopyColumn { COLUMN_NAME: string; DATA_TYPE: string; VIRTUAL_COLUMN: string; IDENTITY_COLUMN: string; GENERATION_TYPE?: string | null; IDENTITY_OPTIONS?: string | null }
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

export async function countCopyRows(source: oracledb.Connection, names: string[]) {
  const counts: Record<string, number> = Object.create(null);
  for (const name of names) {
    const result = await source.execute<{ ROW_COUNT: number }>('SELECT COUNT(*) AS row_count FROM ' + quoteCopyName(name), [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const count = result.rows?.[0]?.ROW_COUNT;
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error('Cannot determine source row count for ' + name + '.');
    counts[name] = count;
  }
  return counts;
}

/**
 * Validates the rows that will actually be copied, after any per-table row limit, against the
 * chosen total limit (default 100,000; at most 1,000,000).
 */
export function validateCopyCounts(counts: Record<string, number>, rowLimit?: number | null, maxTotal = TABLE_COPY_DEFAULT_TOTAL_ROWS) {
  const cap = maxTotal.toLocaleString('en-US');
  const effective = Object.entries(counts).map(([name, count]) => [name, limitedCopyCount(count, rowLimit)] as const);
  const oversized = effective.filter(([, count]) => count > maxTotal);
  if (oversized.length) throw new Error(`Cannot copy tables exceeding the ${cap}-row limit: ` + oversized.map(([name, count]) => name + ' (' + count.toLocaleString('en-US') + ' rows)').join(', ') + '. Set a row limit per table or raise the total row limit.');
  const total = effective.reduce((sum, [, count]) => sum + count, 0);
  if (total > maxTotal) throw new Error('Selected tables contain ' + total.toLocaleString('en-US') + ` rows to copy, exceeding the ${cap}-row limit per copy. Select fewer tables, lower the row limit per table, or raise the total row limit.`);
  return total;
}

const wholeRows = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= TABLE_COPY_MAX_ROWS;

/** Accepts no limit (undefined/null) or a whole number of rows from 1 to 1,000,000. */
export function parseCopyRowLimit(value: unknown): { rowLimit: number | null } | { error: string } {
  if (value === undefined || value === null) return { rowLimit: null };
  if (!wholeRows(value)) return { error: 'Row limit per table must be a whole number from 1 to 1,000,000, or omitted to copy all rows.' };
  return { rowLimit: value };
}

/** The total rows one copy may move: default 100,000, selectable from 1 to 1,000,000. */
export function parseCopyTotalLimit(value: unknown): { maxTotal: number } | { error: string } {
  if (value === undefined || value === null) return { maxTotal: TABLE_COPY_DEFAULT_TOTAL_ROWS };
  if (!wholeRows(value)) return { error: 'Total row limit must be a whole number from 1 to 1,000,000.' };
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
  const outside = (await referencesTo(target, tables)).filter(r => r.CHILD_OWNER !== user || !inSelection.has(r.CHILD_TABLE));
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
 * Callers must only pass tables that are empty in the target.
 *
 * - Rows rejected for a missing parent key (ORA-02291) are kept in memory and retried after
 *   every table, so self-references and cycles resolve once their parents arrive. Rows whose
 *   parents never appear (for example, outside a `rowLimit` sample) are skipped and reported.
 * - Any other error rolls back only the table in progress. Tables already committed keep their
 *   rows; the error says which ones so they can be emptied before a retry.
 * - Identity DDL (ALWAYS → BY DEFAULT) runs before the first insert; sequences are synchronized
 *   and ALWAYS restored after the last commit or after the rollback, never mid-transaction.
 */
export async function copyTableRows(source: oracledb.Connection, target: oracledb.Connection, names: string[], options: { rowLimit?: number | null; maxTotal?: number } = {}) {
  const rowLimit = options.rowLimit ?? null;
  const maxTotal = options.maxTotal ?? TABLE_COPY_DEFAULT_TOTAL_ROWS;
  let total = 0;
  type Pending = { name: string; sql: string; rows: unknown[][]; error: string; bytes: number; types?: oracledb.DbType[] };
  let pending: Pending[] = [];
  const committed: Record<string, number> = Object.create(null);
  let uncommitted: Record<string, number> = Object.create(null);
  const note = (name: string, rows: number) => { if (rows) uncommitted[name] = (uncommitted[name] ?? 0) + rows; };
  const checkPendingBytes = () => {
    if (pending.reduce((n, b) => n + b.bytes, 0) > 64 * 1024 * 1024) throw new Error('Pending parent-dependent rows exceed the 64 MB retry limit. Use a bulk migration tool.');
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
  const insert = async (batch: Pending): Promise<Pending | null> => {
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
    const offsets = new Set<number>();
    for (const e of errors) {
      if (e.offset === undefined || e.offset < 0 || e.offset >= batch.rows.length) throw new Error('Oracle returned an invalid failed-row offset.');
      offsets.add(e.offset);
    }
    note(batch.name, batch.rows.length - offsets.size);
    const rows = batch.rows.filter((_, i) => offsets.has(i));
    return { ...batch, rows, error: errors[0].message, bytes: Buffer.byteLength(JSON.stringify(rows)) };
  };
  /** Retry parent-blocked rows until no more of them can be inserted. */
  const retryPending = async () => {
    for (let pass = 0; pending.length; pass++) {
      if (pass >= 100) throw new Error('Parent dependency retry limit reached.');
      const before = pending.reduce((n, b) => n + b.rows.length, 0);
      const next: Pending[] = [];
      for (const batch of pending) {
        const failed = await insert(batch);
        if (failed) next.push(failed);
      }
      pending = next;
      if (pending.reduce((n, b) => n + b.rows.length, 0) === before) return;
    }
  };
  const commitTable = async () => {
    await target.commit();
    for (const [name, rows] of Object.entries(uncommitted)) committed[name] = (committed[name] ?? 0) + rows;
    uncommitted = Object.create(null);
  };
  const committedSummary = () => Object.entries(committed).map(([n, c]) => `${n} (${c.toLocaleString('en-US')})`).join(', ');
  let current = '';
  try {
    // Preflight every table before inserting any data.
    const plans = [];
    for (const name of names) {
      const read = async (conn: oracledb.Connection) => (await conn.execute<CopyColumn>(
        `SELECT c.column_name, c.data_type, c.virtual_column, c.identity_column, i.generation_type, i.identity_options
         FROM user_tab_cols c LEFT JOIN user_tab_identity_cols i
           ON i.table_name = c.table_name AND i.column_name = c.column_name
         WHERE c.table_name=:name AND c.hidden_column='NO' ORDER BY c.column_id`,
        { name }, { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows ?? [];
      const sourceColumns = await read(source), targetColumns = await read(target);
      const columns = copyColumns(sourceColumns, targetColumns);
      const timestampColumns = new Set(sourceColumns.filter(c => isTimestamp(c.DATA_TYPE)).map(c => c.COLUMN_NAME));
      const zonedColumns = new Map(sourceColumns.filter(c => isTimestampTz(c.DATA_TYPE) || isTimestampLtz(c.DATA_TYPE)).map(c => [c.COLUMN_NAME, isTimestampLtz(c.DATA_TYPE)] as const));
      const jsonColumns = new Set(sourceColumns.filter(c => c.DATA_TYPE === 'JSON').map(c => c.COLUMN_NAME));
      const hasLargeText = sourceColumns.some(c => ['JSON', 'CLOB', 'NCLOB'].includes(c.DATA_TYPE));
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
      plans.push({ name, columns, timestampColumns, zonedColumns, jsonColumns, hasLargeText, types, numberIndexes });
      rowidColumns.push(...sourceColumns.filter(c => c.DATA_TYPE === 'ROWID' || c.DATA_TYPE === 'UROWID').map(c => `${name}.${c.COLUMN_NAME}`));
      for (const c of targetColumns.filter(c => c.IDENTITY_COLUMN === 'YES' && columns.includes(c.COLUMN_NAME))) {
        identities.push({ name, column: c.COLUMN_NAME, always: c.GENERATION_TYPE === 'ALWAYS', options: identitySequenceOptions(c.IDENTITY_OPTIONS) });
      }
    }
    for (const id of identities.filter(id => id.always)) {
      await target.execute(alter(id, 'BY DEFAULT'));
      changed.push(id);
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
    for (const { name, columns, timestampColumns, zonedColumns, jsonColumns, hasLargeText, types, numberIndexes } of plans) {
      current = name;
      const cols = columns.map(quoteCopyName).join(', ');
      const projection = columns.map(c => jsonColumns.has(c) ? `JSON_SERIALIZE(${quoteCopyName(c)} RETURNING CLOB EXTENDED ERROR ON ERROR) AS ${quoteCopyName(c)}` : timestampColumns.has(c) ? `TO_CHAR(${quoteCopyName(c)}, '${timestampFormat}') AS ${quoteCopyName(c)}` : zonedColumns.has(c) ? `TO_CHAR(${zonedColumns.get(c) ? `CAST(${quoteCopyName(c)} AS TIMESTAMP WITH TIME ZONE)` : quoteCopyName(c)}, '${timestampTzFormat}') AS ${quoteCopyName(c)}` : quoteCopyName(c)).join(', ');
      const values = columns.map((c, i) => jsonColumns.has(c) ? `JSON(:${i + 1} EXTENDED)` : timestampColumns.has(c) ? `TO_TIMESTAMP(:${i + 1}, '${timestampFormat}')` : zonedColumns.has(c) ? `TO_TIMESTAMP_TZ(:${i + 1}, '${timestampTzFormat}')` : `:${i + 1}`).join(', ');
      const identityIndexes = identities.filter(id => id.name === name).map(id => columns.indexOf(id.column));
      const query = await source.execute<unknown[]>(`SELECT ${projection} FROM ${quoteCopyName(name)}${rowLimit ? ' WHERE ROWNUM <= :row_limit' : ''}`, rowLimit ? { row_limit: rowLimit } : [], {
        resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY,
        fetchTypeHandler: (meta: Parameters<NonNullable<oracledb.ExecuteOptions['fetchTypeHandler']>>[0]) => {
          if (meta.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING };
          if (hasLargeText && (meta.dbType === oracledb.CLOB || meta.dbType === oracledb.NCLOB)) return { type: oracledb.STRING };
        },
        ...(hasLargeText ? { fetchArraySize: 1, prefetchRows: 0 } : {}),
      });
      const cursor = query.resultSet!;
      try {
        for (;;) {
          const rows = await cursor.getRows(hasLargeText ? 1 : 200);
          if (!rows.length) break;
          if (hasLargeText && rows.some(row => row.reduce<number>((bytes, value) => bytes + (typeof value === 'string' ? Buffer.byteLength(value) : 0), 0) > 16 * 1024 * 1024)) {
            throw new Error(`${name}: text values exceed the 16 MB per-row copy limit. Use a bulk migration tool.`);
          }
          if (rows.some(row => identityIndexes.some(index => row[index] == null))) {
            throw new Error(`${name}: source identity values cannot be null; generating replacement IDs would change relationships.`);
          }
          total += rows.length;
          if (total > maxTotal) throw new Error(`Copy exceeds the ${maxTotal.toLocaleString('en-US')}-row limit. Raise the total row limit (up to 1,000,000) or use a bulk migration tool for larger copies.`);
          // Guard: NUMBER columns must arrive as text. A JS number here would already be rounded.
          if (rows.some(row => numberIndexes.some(i => typeof row[i] === 'number' && (!Number.isFinite(row[i] as number) || (Number.isInteger(row[i]) && !Number.isSafeInteger(row[i] as number)))))) {
            throw new Error('A numeric value exceeds JavaScript’s safe range. Use a database-native migration to preserve its precision.');
          }
          if (decimal !== '.') {
            for (const row of rows) for (const i of numberIndexes) if (typeof row[i] === 'string') row[i] = (row[i] as string).replace('.', decimal);
          }
          const failed = await insert({ name, sql: `INSERT INTO ${quoteCopyName(name)} (${cols}) VALUES (${values})`, rows, error: '', bytes: 0, types });
          if (failed) {
            pending.push(failed);
            checkPendingBytes();
          }
        }
      } finally { await cursor.close(); }
      // Earlier parent-blocked rows may now have their parents (and this table's own
      // self-references resolve here), then the table is committed on its own.
      await retryPending();
      await commitTable();
    }
    current = '';
  } catch (e) {
    const message = (e as Error).message.replace(/\.?\s*$/, '.');
    const kept = committedSummary();
    const partial = kept
      ? ` Tables already committed keep their rows: ${kept}.${current ? ` ${current} was rolled back.` : ''} Empty the copied tables before retrying.`
      : ' No rows were committed.';
    // Never run DDL unless rollback succeeded: DDL would commit the table in progress.
    try { await target.rollback(); }
    catch (rollbackError) { throw new Error(`${message}${partial} Rollback failed: ${(rollbackError as Error).message}. Identity modes may need manual restoration for ${changed.map(id => `${id.name}.${id.column}`).join(', ')}.`); }
    const failures = [...await synchronize(), ...await restore()];
    if (failures.length) throw new Error(`${message}${partial} Identity repair failed. Run: ${failures.join(' ')}`);
    throw new Error(`${message}${partial}`);
  }
  // Rows are committed. Cleanup failures must not be reported as a failed/retryable copy.
  const warnings: string[] = [];
  warnings.push(...(await synchronize()).map(failure => `Rows are committed. Before generating new IDs, run: ${failure}`));
  warnings.push(...(await restore()).map(failure => `Rows are committed. Restore the identity mode: ${failure}`));
  const skipped: Record<string, number> = Object.create(null);
  for (const batch of pending) skipped[batch.name] = (skipped[batch.name] ?? 0) + batch.rows.length;
  const skippedRows = Object.values(skipped).reduce((n, c) => n + c, 0);
  if (skippedRows) warnings.unshift(`${skippedRows.toLocaleString('en-US')} rows were not copied because their parent rows ${rowLimit ? 'were not in the sample' : 'do not exist in the source or target'}: ${Object.entries(skipped).map(([n, c]) => `${n} (${c.toLocaleString('en-US')})`).join(', ')}.`);
  if (rowidColumns.length) warnings.push(`ROWID/UROWID values were copied as-is in ${rowidColumns.join(', ')}. They address rows in the source database, so they will not locate rows in the target; update them if your application relies on them.`);
  const tables = names.map(name => ({ name, rows: committed[name] ?? 0, ...(skipped[name] ? { skipped: skipped[name] } : {}) }));
  return { tables, totalRows: tables.reduce((n, t) => n + t.rows, 0), ...(skippedRows ? { skippedRows } : {}), ...(warnings.length ? { warnings } : {}) };
}
