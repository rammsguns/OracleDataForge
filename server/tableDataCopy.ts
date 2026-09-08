import oracledb from 'oracledb';
import type { TableDependency } from '../src/utils/tableDataDependencies.ts';

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
const supported = new Set(['NUMBER', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE', 'VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'DATE', 'RAW', 'VECTOR', 'JSON', 'CLOB', 'NCLOB']);
const isTimestamp = (type: string) => /^TIMESTAMP(?:\([0-9]\))?$/.test(type);
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
    if (!supported.has(c.DATA_TYPE) && !isTimestamp(c.DATA_TYPE)) throw new Error(`Column ${c.COLUMN_NAME}: ${c.DATA_TYPE} is not supported by data copy.`);
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

export function validateCopyCounts(counts: Record<string, number>) {
  const oversized = Object.entries(counts).filter(([, count]) => count > 100000);
  if (oversized.length) throw new Error('Cannot copy tables exceeding the 100,000-row limit: ' + oversized.map(([name, count]) => name + ' (' + count.toLocaleString('en-US') + ' rows)').join(', ') + '.');
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total > 100000) throw new Error('Selected tables contain ' + total.toLocaleString('en-US') + ' rows, exceeding the 100,000-row limit per copy. Select fewer tables.');
  return total;
}

export async function nonEmptyCopyTables(target: oracledb.Connection, names: string[]) {
  const occupied: string[] = [];
  for (const name of names) {
    const result = await target.execute('SELECT 1 FROM ' + quoteCopyName(name) + ' WHERE ROWNUM = 1');
    if (result.rows?.length) occupied.push(name);
  }
  return occupied;
}

export async function deleteCopyRows(target: oracledb.Connection, names: string[]) {
  // Reject incoming references outside the selection, including cascading deletes.
  const refs = await target.execute<{ CHILD_OWNER: string; CHILD_TABLE: string; PARENT_TABLE: string }>(
    `SELECT fk.owner AS child_owner, fk.table_name AS child_table, pk.table_name AS parent_table
     FROM all_constraints fk JOIN user_constraints pk ON fk.r_owner = USER AND fk.r_constraint_name = pk.constraint_name
     WHERE fk.constraint_type = 'R' AND fk.status = 'ENABLED' AND (fk.owner <> USER OR fk.table_name NOT IN (${names.map((_, i) => ':' + (i + 1)).join(', ')}))`, names, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  const external = refs.rows?.find(r => names.includes(r.PARENT_TABLE));
  if (external) throw new Error('Replacement blocked: ' + external.CHILD_OWNER + '.' + external.CHILD_TABLE + ' references ' + external.PARENT_TABLE + ' outside the selection.');
  let pending = [...names].reverse();
  while (pending.length) {
    const next: string[] = [];
    for (const name of pending) {
      try { await target.execute('DELETE FROM ' + quoteCopyName(name), [], { autoCommit: false }); }
      catch (e) { if (oracleErrorNumber(e as Error) === 2292) next.push(name); else throw e; }
    }
    if (next.length === pending.length) throw new Error('Cannot delete existing rows because foreign keys still reference: ' + next.join(', ') + '. No row changes committed.');
    pending = next;
  }
}

/** Row DML is one transaction. Identity DDL runs only before DML or after commit/rollback. */
export async function copyTableRows(source: oracledb.Connection, target: oracledb.Connection, names: string[], mode: 'append' | 'replace' = 'append') {
  const results: { name: string; rows: number }[] = [];
  let total = 0;
  type Pending = { name: string; sql: string; rows: unknown[][]; error: string; types?: oracledb.DbType[] };
  let pending: Pending[] = [];
  let pendingBytes = 0;
  const identities: { name: string; column: string; always: boolean; options: string }[] = [];
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
    if (!errors.length) return null;
    const offsets = new Set<number>();
    for (const e of errors) {
      if (e.offset === undefined || e.offset < 0 || e.offset >= batch.rows.length) throw new Error('Oracle returned an invalid failed-row offset.');
      offsets.add(e.offset);
    }
    return { ...batch, rows: batch.rows.filter((_, i) => offsets.has(i)), error: errors[0].message };
  };
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
        if (['NUMBER', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE'].includes(type)) return oracledb.NUMBER;
        if (['NCHAR', 'NVARCHAR2'].includes(type)) return oracledb.DB_TYPE_NVARCHAR;
        return oracledb.STRING;
      }) : undefined;
      plans.push({ name, columns, timestampColumns, jsonColumns, hasLargeText, types });
      for (const c of targetColumns.filter(c => c.IDENTITY_COLUMN === 'YES' && columns.includes(c.COLUMN_NAME))) {
        identities.push({ name, column: c.COLUMN_NAME, always: c.GENERATION_TYPE === 'ALWAYS', options: identitySequenceOptions(c.IDENTITY_OPTIONS) });
      }
    }
    for (const id of identities.filter(id => id.always)) {
      await target.execute(alter(id, 'BY DEFAULT'));
      changed.push(id);
    }
    if (mode === 'replace') await deleteCopyRows(target, names);
    for (const { name, columns, timestampColumns, jsonColumns, hasLargeText, types } of plans) {
      const cols = columns.map(quoteCopyName).join(', ');
      const projection = columns.map(c => jsonColumns.has(c) ? `JSON_SERIALIZE(${quoteCopyName(c)} RETURNING CLOB EXTENDED ERROR ON ERROR) AS ${quoteCopyName(c)}` : timestampColumns.has(c) ? `TO_CHAR(${quoteCopyName(c)}, '${timestampFormat}') AS ${quoteCopyName(c)}` : quoteCopyName(c)).join(', ');
      const values = columns.map((c, i) => jsonColumns.has(c) ? `JSON(:${i + 1} EXTENDED)` : timestampColumns.has(c) ? `TO_TIMESTAMP(:${i + 1}, '${timestampFormat}')` : `:${i + 1}`).join(', ');
      const identityIndexes = identities.filter(id => id.name === name).map(id => columns.indexOf(id.column));
      const query = await source.execute<unknown[]>(`SELECT ${projection} FROM ${quoteCopyName(name)}`, [], {
        resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY,
        ...(hasLargeText ? { fetchArraySize: 1, prefetchRows: 0,
          fetchTypeHandler: (meta: Parameters<NonNullable<oracledb.ExecuteOptions['fetchTypeHandler']>>[0]) => {
            if (meta.dbType === oracledb.CLOB || meta.dbType === oracledb.NCLOB) return { type: oracledb.STRING };
          },
        } : {}),
      });
      const cursor = query.resultSet!;
      let count = 0;
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
          if (total > 100000) throw new Error('Copy exceeds the 100,000-row limit. Use a bulk migration tool for larger copies.');
          if (rows.some(row => row.some(value => typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))))) {
            throw new Error('A numeric value exceeds JavaScript’s safe range. Use a database-native migration to preserve its precision.');
          }
          const failed = await insert({ name, sql: `INSERT INTO ${quoteCopyName(name)} (${cols}) VALUES (${values})`, rows, error: '', types });
          if (failed) {
            pendingBytes += Buffer.byteLength(JSON.stringify(failed.rows));
            if (pendingBytes > 64 * 1024 * 1024) throw new Error('Pending parent-dependent rows exceed the 64 MB retry limit. Use a bulk migration tool.');
            pending.push(failed);
          }
          count += rows.length;
        }
      } finally { await cursor.close(); }
      results.push({ name, rows: count });
    }
    // Only failed FK rows are retried. Successful rows stay in this transaction and are
    // never inserted twice. Later batches/tables may supply their missing parents.
    for (let pass = 0; pending.length; pass++) {
      if (pass >= 100) throw new Error('Parent dependency retry limit reached; no rows were committed.');
      const before = pending.reduce((n, b) => n + b.rows.length, 0);
      const next: Pending[] = [];
      for (const batch of pending) {
        const failed = await insert(batch);
        if (failed) next.push(failed);
      }
      const remaining = next.reduce((n, b) => n + b.rows.length, 0);
      if (remaining === before) throw new Error(`Cannot resolve parent data for ${[...new Set(next.map(b => b.name))].join(', ')} (${remaining} rows). Required parent keys are missing or the rows form a non-insertable cycle. ${next[0].error}`);
      pending = next;
    }
    await target.commit();
  } catch (e) {
    // Never run restoration DDL unless rollback succeeded: DDL would commit pending rows.
    try { await target.rollback(); }
    catch (rollbackError) { throw new Error(`${(e as Error).message}. Rollback failed: ${(rollbackError as Error).message}. Identity modes may need manual restoration for ${changed.map(id => `${id.name}.${id.column}`).join(', ')}.`); }
    const failures = await restore();
    if (failures.length) throw new Error(`${(e as Error).message}. Rows rolled back, but identity restoration failed. Run: ${failures.join(' ')}`);
    throw e;
  }
  // Rows are committed. Cleanup failures must not be reported as a failed/retryable copy.
  const warnings: string[] = [];
  for (const id of identities) {
    const sql = `ALTER TABLE ${quoteCopyName(id.name)} MODIFY (${quoteCopyName(id.column)} GENERATED AS IDENTITY (START WITH LIMIT VALUE ${id.options}))`;
    try { await target.execute(sql); }
    catch (e) { warnings.push(`Rows are committed. Before generating new IDs, run: ${sql}; — ${(e as Error).message}`); }
  }
  warnings.push(...(await restore()).map(failure => `Rows are committed. Restore the identity mode: ${failure}`));
  return { tables: results, totalRows: total, ...(warnings.length ? { warnings } : {}) };
}
