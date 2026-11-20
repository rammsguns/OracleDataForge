import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracledb from 'oracledb';
import { copyColumns, copyTableRows, countCopyRows, copyFilterError, parseCopyTableFilters, validateCopyCounts, nonEmptyCopyTables, quoteCopyName, truncateBlocker, truncateCopyTables, parseCopyRowLimit, parseCopyTotalLimit, copyBatchRows, lobCopyTables, parseCopyTableRowLimits, COPY_BATCH_MIN_ROWS, COPY_BATCH_MAX_ROWS, LOB_COPY_BATCH_ROWS, type CopyColumn } from './tableDataCopy.ts';
import { copyRowLimitFor } from '../src/utils/tableDataDependencies.ts';

const col = (name = 'ID', type = 'NUMBER'): CopyColumn => ({ COLUMN_NAME: name, DATA_TYPE: type, VIRTUAL_COLUMN: 'NO', IDENTITY_COLUMN: 'NO', IDENTITY_OPTIONS: 'START WITH: 1, INCREMENT BY: 1, MAX_VALUE: 9999999999999999999999999999, MIN_VALUE: 1, CYCLE_FLAG: N, CACHE_SIZE: 20, ORDER_FLAG: N, SCALE_FLAG: N, EXTEND_FLAG: N, SESSION_FLAG: N, KEEP_VALUE: N' });
test('matches columns by name, safely quotes identifiers, and rejects unsupported targets', () => {
  assert.deepEqual(copyColumns([col(), col('NAME', 'VARCHAR2')], [col('NAME', 'VARCHAR2'), col()]), ['ID', 'NAME']);
  assert.equal(quoteCopyName('a"b'), '"a""b"');
  assert.throws(() => copyColumns([col()], []), /missing/);
  assert.throws(() => copyColumns([col()], [col('ID', 'VARCHAR2')]), /incompatible/);
  assert.throws(() => copyColumns([col()], [{ ...col(), IDENTITY_COLUMN: 'YES' }]), /Identity/);
  assert.throws(() => copyColumns([col('DATA', 'BFILE')], [col('DATA', 'BFILE')]), /not supported/);
});

test('known identity modes preserve source columns, while unknown modes are rejected', () => {
  for (const GENERATION_TYPE of ['ALWAYS', 'BY DEFAULT', 'BY DEFAULT ON NULL']) {
    assert.deepEqual(copyColumns([col()], [{ ...col(), IDENTITY_COLUMN: 'YES', GENERATION_TYPE }]), ['ID']);
  }
  assert.throws(() => copyColumns([col()], [{ ...col(), IDENTITY_COLUMN: 'YES', GENERATION_TYPE: null }]), /unknown generation mode/);
});

function sessions(fail = false, data = [[1], [2]], targetColumns = [col()]) {
  let commits = 0, rollbacks = 0, closed = 0, inserted = 0;
  const source = {
    execute: async (sql: string) => {
      if (sql.includes('user_tab_cols')) return { rows: [col()] };
      let batch = 0;
      return { resultSet: { getRows: async () => batch++ === 0 ? data : [], close: async () => { closed++; } } };
    },
  } as unknown as oracledb.Connection;
  const target = {
    execute: async () => ({ rows: targetColumns }),
    executeMany: async (_sql: string, rows: unknown[], options: { autoCommit: boolean }) => {
      assert.equal(options.autoCommit, false);
      assert.match(_sql, /\("ID"\) VALUES \(:1\)/);
      assert.deepEqual(rows, data);
      inserted += rows.length;
      if (fail && inserted > 2) throw new Error('duplicate key');
      return {};
    },
    commit: async () => { commits++; }, rollback: async () => { rollbacks++; },
  } as unknown as oracledb.Connection;
  return { source, target, stats: () => ({ commits, rollbacks, closed, inserted }) };
}
test('copies explicit identity IDs and commits', async () => {
  const s = sessions(false, [[42], [123]], [{ ...col(), IDENTITY_COLUMN: 'YES', GENERATION_TYPE: 'BY DEFAULT' }]);
  assert.equal((await copyTableRows(s.source, s.target, ['CATEGORIES'])).totalRows, 2);
  assert.deepEqual(s.stats(), { commits: 1, rollbacks: 0, closed: 1, inserted: 2 });
});
test('always identities accept explicit source IDs', async () => {
  const s = sessions(false, [[42]], [{ ...col(), IDENTITY_COLUMN: 'YES', GENERATION_TYPE: 'ALWAYS' }]);
  assert.equal((await copyTableRows(s.source, s.target, ['CATEGORIES'])).totalRows, 1);
  assert.deepEqual(s.stats(), { commits: 1, rollbacks: 0, closed: 1, inserted: 1 });
});
test('commits each table on its own and closes every source cursor', async () => {
  const s = sessions();
  assert.deepEqual(await copyTableRows(s.source, s.target, ['PARENT', 'CHILD']), { tables: [{ name: 'PARENT', rows: 2 }, { name: 'CHILD', rows: 2 }], totalRows: 4 });
  assert.deepEqual(s.stats(), { commits: 2, rollbacks: 0, closed: 2, inserted: 4 });
});
test('a later table failure rolls back only that table and reports the tables already committed', async () => {
  const s = sessions(true);
  await assert.rejects(copyTableRows(s.source, s.target, ['PARENT', 'CHILD']), /duplicate key\. Tables already committed keep their rows: PARENT \(2\)\. CHILD was rolled back\. Empty the copied tables before retrying\./);
  assert.deepEqual(s.stats(), { commits: 1, rollbacks: 1, closed: 2, inserted: 4 });
});
test('a failure in the first table reports that nothing was committed', async () => {
  const s = sessions(false, [[Number.MAX_SAFE_INTEGER + 1]]);
  await assert.rejects(copyTableRows(s.source, s.target, ['T']), /safe range.*precision\. No rows were committed\./);
});

test('unsafe integers are refused before inserting and the transaction is rolled back', async () => {
  const s = sessions(false, [[Number.MAX_SAFE_INTEGER + 1]]);
  await assert.rejects(copyTableRows(s.source, s.target, ['T']), /safe range/);
  assert.deepEqual(s.stats(), { commits: 0, rollbacks: 1, closed: 1, inserted: 0 });
});

test('row cap never commits a partial copy', async () => {
  const s = sessions(false, Array.from({ length: 100001 }, () => [1]));
  await assert.rejects(copyTableRows(s.source, s.target, ['T']), /100,000-row limit/);
  assert.deepEqual(s.stats(), { commits: 0, rollbacks: 1, closed: 1, inserted: 0 });
});

function foreignKeySessions(data: Record<string, (number | null)[][]>, parents: Record<string, string>, duplicate = false) {
  const inserted = new Map<string, Set<number>>();
  const attempts: string[] = [];
  let commits = 0, rollbacks = 0;
  const queries: string[] = [];
  const source = { execute: async (sql: string, binds?: { row_limit?: number }) => {
    if (sql.includes('user_tab_cols')) return { rows: [col(), col('PARENT_ID')] };
    queries.push(sql);
    const table = /FROM "([^"]+)"/.exec(sql)![1];
    const rows = binds && !Array.isArray(binds) && binds.row_limit ? data[table].slice(0, binds.row_limit) : data[table];
    let index = 0;
    return { resultSet: { getRows: async () => index < rows.length ? [rows[index++]] : [], close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async () => ({ rows: [col(), col('PARENT_ID')] }),
    executeMany: async (sql: string, rows: (number | null)[][], options: { batchErrors: boolean; autoCommit: boolean }) => {
      assert.equal(options.batchErrors, true); assert.equal(options.autoCommit, false);
      const table = /INTO "([^"]+)"/.exec(sql)![1];
      const keys = inserted.get(table) ?? new Set<number>();
      inserted.set(table, keys);
      const batchErrors: { errorNum: number; offset: number; message: string }[] = [];
      rows.forEach(([id, parent], offset) => {
        attempts.push(`${table}:${id}`);
        if (duplicate || keys.has(id!)) batchErrors.push({ errorNum: 1, offset, message: 'duplicate key' });
        else if (parent !== null && !(parents[table] === table && parent === id) && !inserted.get(parents[table])?.has(parent)) batchErrors.push({ errorNum: 2291, offset, message: 'parent key not found' });
        else keys.add(id!);
      });
      return { batchErrors };
    },
    commit: async () => { commits++; },
    rollback: async () => { rollbacks++; inserted.clear(); },
  } as unknown as oracledb.Connection;
  return { source, target, attempts, inserted, queries, stats: () => ({ commits, rollbacks }) };
}

test('self-referencing child-before-parent rows across batches are retried, never duplicating successful rows', async () => {
  const s = foreignKeySessions({ EMPLOYEES: [[3, 2], [2, 1], [1, null]] }, { EMPLOYEES: 'EMPLOYEES' });
  const result = await copyTableRows(s.source, s.target, ['EMPLOYEES']);
  assert.equal(result.totalRows, 3);
  assert.deepEqual(s.stats(), { commits: 1, rollbacks: 0 });
  assert.equal(s.attempts.filter(a => a === 'EMPLOYEES:1').length, 1);
  assert.equal(s.inserted.get('EMPLOYEES')!.size, 3);
});

test('a table-level cycle with insertable rows resolves after the later table supplies its parent', async () => {
  const s = foreignKeySessions({ A: [[1, 2]], B: [[2, null]] }, { A: 'B', B: 'A' });
  assert.equal((await copyTableRows(s.source, s.target, ['A', 'B'])).totalRows, 2);
  // A's row waits for B, so it is inserted and committed with B.
  assert.deepEqual(s.stats(), { commits: 2, rollbacks: 0 });
});

test('missing parents and true row cycles are skipped rather than looping', async () => {
  for (const [rows, copied, skipped] of [[[[1, 99], [2, null]], 1, 1], [[[1, 2], [2, 1]], 0, 2]] as const) {
    const s = foreignKeySessions({ T: rows.map(r => [...r]) }, { T: 'T' });
    const result = await copyTableRows(s.source, s.target, ['T']);
    assert.equal(result.totalRows, copied);
    assert.equal(result.skippedRows, skipped);
    assert.deepEqual(s.stats(), { commits: 1, rollbacks: 0 });
  }
});

test('a row limit samples each table, skips children whose parents were not sampled, and commits the rest', async () => {
  const s = foreignKeySessions({ P: [[1, null], [2, null], [3, null]], C: [[10, 3], [11, 1], [12, 2]] }, { C: 'P' });
  const result = await copyTableRows(s.source, s.target, ['P', 'C'], { rowLimit: 2 });
  assert.ok(s.queries.every(q => q.includes('WHERE ROWNUM <= :row_limit')));
  assert.deepEqual(result.tables, [{ name: 'P', rows: 2 }, { name: 'C', rows: 1, skipped: 1 }]);
  assert.equal(result.totalRows, 3);
  assert.equal(result.skippedRows, 1);
  assert.match(result.warnings![0], /not in the sample: C \(1\)/);
  assert.deepEqual(s.stats(), { commits: 2, rollbacks: 0 });
  assert.deepEqual([...s.inserted.get('C')!], [11]);
});

test('without a row limit, every row is read and rows with missing parents are skipped and reported', async () => {
  const s = foreignKeySessions({ P: [[1, null]], C: [[10, 3], [11, 1]] }, { C: 'P' });
  const result = await copyTableRows(s.source, s.target, ['P', 'C']);
  assert.ok(s.queries.every(q => !q.includes('ROWNUM')));
  assert.deepEqual(result.tables, [{ name: 'P', rows: 1 }, { name: 'C', rows: 1, skipped: 1 }]);
  assert.match(result.warnings![0], /do not exist in the source or target: C \(1\)/);
  assert.deepEqual(s.stats(), { commits: 2, rollbacks: 0 });
});

test('row limits apply to count validation and reject invalid values', () => {
  assert.equal(validateCopyCounts({ BIG: 5_000_000, SMALL: 10 }, 1000), 1010);
  assert.throws(() => validateCopyCounts({ BIG: 5_000_000 }), /row limit per table/);
  assert.throws(() => validateCopyCounts(Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`T${i}`, 50_000])), 40_000), /lower the row limit/);
  assert.deepEqual(parseCopyRowLimit(undefined), { rowLimit: null });
  assert.deepEqual(parseCopyRowLimit(500), { rowLimit: 500 });
  assert.deepEqual(parseCopyRowLimit(1_000_000), { rowLimit: 1_000_000 });
  for (const bad of [0, -1, 1.5, '10', 1_000_001]) assert.ok('error' in parseCopyRowLimit(bad));
});

test('the total row limit defaults to 100,000 and is selectable up to 1,000,000', async () => {
  assert.deepEqual(parseCopyTotalLimit(undefined), { maxTotal: 100_000 });
  assert.deepEqual(parseCopyTotalLimit(1_000_000), { maxTotal: 1_000_000 });
  for (const bad of [0, 2.5, '500', 1_000_001]) assert.ok('error' in parseCopyTotalLimit(bad));
  assert.equal(validateCopyCounts({ A: 600_000, B: 400_000 }, null, 1_000_000), 1_000_000);
  assert.throws(() => validateCopyCounts({ A: 600_000, B: 400_001 }, null, 1_000_000), /1,000,000-row limit/);
  assert.throws(() => validateCopyCounts({ A: 300 }, null, 200), /200-row limit/);
  // The copy itself enforces the chosen total, not the default.
  const big = sessions(false, Array.from({ length: 150_000 }, () => [1]));
  assert.equal((await copyTableRows(big.source, big.target, ['T'], { maxTotal: 1_000_000 })).totalRows, 150_000);
  const small = sessions(false, Array.from({ length: 11 }, () => [1]));
  await assert.rejects(copyTableRows(small.source, small.target, ['T'], { maxTotal: 10 }), /10-row limit/);
  assert.deepEqual(small.stats().commits, 0);
});

test('non-FK batch errors are fatal and are never retried', async () => {
  const s = foreignKeySessions({ T: [[1, null]] }, { T: 'T' }, true);
  await assert.rejects(copyTableRows(s.source, s.target, ['T']), /duplicate key/);
  assert.equal(s.attempts.length, 1);
  assert.deepEqual(s.stats(), { commits: 0, rollbacks: 1 });
});

test('identity DDL surrounds the row transaction; failures restore only after rollback', async () => {
  for (const fail of [false, true]) {
    const s = sessions(fail, [[1], [2]], [{ ...col(), IDENTITY_COLUMN: 'YES', GENERATION_TYPE: 'ALWAYS' }]);
    const events: string[] = [];
    const execute = s.target.execute.bind(s.target), insert = s.target.executeMany.bind(s.target);
    s.target.execute = (async (sql: string, ...args: unknown[]) => {
      events.push(sql);
      return (execute as Function)(sql, ...args);
    }) as typeof s.target.execute;
    s.target.executeMany = (async (...args: unknown[]) => { events.push('INSERT'); return (insert as Function)(...args); }) as typeof s.target.executeMany;
    s.target.commit = async () => { events.push('COMMIT'); };
    s.target.rollback = async () => { events.push('ROLLBACK'); };
    if (fail) await assert.rejects(copyTableRows(s.source, s.target, ['A', 'B']), /duplicate key/);
    else await copyTableRows(s.source, s.target, ['A', 'B']);
    const boundary = fail ? events.indexOf('ROLLBACK') : events.lastIndexOf('COMMIT');
    const firstInsert = events.indexOf('INSERT');
    // No DDL while any table's rows are uncommitted: DDL would commit them implicitly.
    assert.equal(events.slice(firstInsert, boundary).some(e => e.startsWith('ALTER')), false);
    assert.equal(events.slice(0, firstInsert).filter(e => e.includes('GENERATED BY DEFAULT')).length, 2);
    assert.equal(events.slice(boundary).filter(e => e.includes('GENERATED ALWAYS')).length, 2);
    // After a failure, only the table that was committed (A) has its sequence synchronized.
    assert.equal(events.filter(e => e.includes('START WITH LIMIT VALUE')).length, fail ? 1 : 2);
    assert.equal(events.filter(e => e === 'COMMIT').length, fail ? 1 : 2);
  }
});

test('post-commit sequence failure returns repair warnings and still restores ALWAYS', async () => {
  const s = sessions(false, [[42]], [{ ...col(), IDENTITY_COLUMN: 'YES', GENERATION_TYPE: 'ALWAYS' }]);
  const execute = s.target.execute.bind(s.target);
  let restored = false;
  s.target.execute = (async (sql: string, ...args: unknown[]) => {
    if (sql.includes('START WITH LIMIT VALUE')) throw new Error('DDL lock timeout');
    if (sql.includes('GENERATED ALWAYS')) restored = true;
    return (execute as Function)(sql, ...args);
  }) as typeof s.target.execute;
  const result = await copyTableRows(s.source, s.target, ['CATEGORIES']);
  assert.equal(result.totalRows, 1);
  assert.match(result.warnings![0], /Rows are committed.*START WITH LIMIT VALUE/);
  assert.equal(restored, true);
  assert.equal(s.stats().rollbacks, 0);
});

test('timestamp precisions and zoned timestamps are supported without accepting unrelated types', () => {
  for (const type of ['TIMESTAMP', 'TIMESTAMP(0)', 'TIMESTAMP(6)', 'TIMESTAMP(9)']) {
    assert.deepEqual(copyColumns([col('ORDER_TS', type)], [col('ORDER_TS', type)]), ['ORDER_TS']);
  }
  assert.throws(() => copyColumns([col('ORDER_TS', 'TIMESTAMP(9)')], [col('ORDER_TS', 'TIMESTAMP(6)')]), /incompatible/);
  for (const type of ['TIMESTAMP(6) WITH TIME ZONE', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP(9) WITH LOCAL TIME ZONE']) {
    assert.deepEqual(copyColumns([col('ORDER_TS', type)], [col('ORDER_TS', type)]), ['ORDER_TS']);
  }
  assert.throws(() => copyColumns([col('ORDER_TS', 'TIMESTAMP(6) WITH TIME ZONE')], [col('ORDER_TS', 'TIMESTAMP(6)')]), /incompatible/);
  for (const type of ['TIMESTAMP(10)', 'TIMESTAMP(6) WITH TIME ZONES', 'INTERVAL DAY(2) TO SECOND(6)']) {
    assert.throws(() => copyColumns([col('ORDER_TS', type)], [col('ORDER_TS', type)]), /not supported/);
  }
});

test('timestamp text and nulls reach Oracle conversion binds unchanged, including FK retries', async () => {
  const metadata = [col(), col('ORDER_TS', 'TIMESTAMP(6)')];
  const rows = [[1, ' 2026-09-08 12:34:56.123456000'], [2, null]];
  let attempts = 0, committed = false;
  const source = { execute: async (sql: string) => {
    if (sql.includes('user_tab_cols')) return { rows: metadata };
    assert.match(sql, /TO_CHAR\("ORDER_TS", 'SYYYY-MM-DD HH24:MI:SS.FF9'\) AS "ORDER_TS"/);
    let fetched = false;
    return { resultSet: { getRows: async () => { if (fetched) return []; fetched = true; return rows; }, close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async () => ({ rows: metadata }),
    executeMany: async (sql: string, binds: unknown[][]) => {
      assert.match(sql, /VALUES \(:1, TO_TIMESTAMP\(:2, 'SYYYY-MM-DD HH24:MI:SS.FF9'\)\)/);
      assert.deepEqual(binds, attempts === 0 ? rows : [rows[0]]);
      return attempts++ === 0 ? { batchErrors: [{ errorNum: 2291, offset: 0, message: 'parent missing' }] } : {};
    },
    commit: async () => { committed = true; }, rollback: async () => { assert.fail('unexpected rollback'); },
  } as unknown as oracledb.Connection;
  assert.equal((await copyTableRows(source, target, ['ORDERS'])).totalRows, 2);
  assert.equal(attempts, 2);
  assert.equal(committed, true);
});


test('zoned timestamps keep their zone as text, and LOCAL TIME ZONE values convert through a zoned cast', async () => {
  const metadata = [col(), col('RECEIVED_DATE_TIME', 'TIMESTAMP(6) WITH TIME ZONE'), col('SEEN_AT', 'TIMESTAMP(6) WITH LOCAL TIME ZONE')];
  const rows = [[1, '2026-09-08 12:34:56.123456000 AMERICA/CHICAGO', '2026-09-08 17:34:56.123456000 +00:00'], [2, null, null]];
  let sql = '';
  const source = { execute: async (query: string) => {
    if (query.includes('user_tab_cols')) return { rows: metadata };
    assert.match(query, /TO_CHAR\("RECEIVED_DATE_TIME", 'SYYYY-MM-DD HH24:MI:SS.FF9 TZR'\) AS "RECEIVED_DATE_TIME"/);
    assert.match(query, /TO_CHAR\(CAST\("SEEN_AT" AS TIMESTAMP WITH TIME ZONE\), 'SYYYY-MM-DD HH24:MI:SS.FF9 TZR'\) AS "SEEN_AT"/);
    let fetched = false;
    return { resultSet: { getRows: async () => { if (fetched) return []; fetched = true; return rows; }, close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async () => ({ rows: metadata }),
    executeMany: async (insert: string, binds: unknown[][]) => { sql = insert; assert.deepEqual(binds, rows); return {}; },
    commit: async () => {}, rollback: async () => assert.fail('unexpected rollback'),
  } as unknown as oracledb.Connection;
  assert.equal((await copyTableRows(source, target, ['MESSAGES'])).totalRows, 2);
  assert.match(sql, /VALUES \(:1, TO_TIMESTAMP_TZ\(:2, 'SYYYY-MM-DD HH24:MI:SS.FF9 TZR'\), TO_TIMESTAMP_TZ\(:3, 'SYYYY-MM-DD HH24:MI:SS.FF9 TZR'\)\)/);
});

test('ROWID and UROWID columns copy their text form and warn that the addresses refer to the source', async () => {
  for (const type of ['ROWID', 'UROWID']) assert.deepEqual(copyColumns([col('RID', type)], [col('RID', type)]), ['RID']);
  assert.throws(() => copyColumns([col('RID', 'UROWID')], [col('RID', 'VARCHAR2')]), /incompatible/);
  const metadata = [col(), col('RID', 'UROWID')];
  const rows = [[1, 'AAAR3sAAEAAAACXAAA'], [2, '*BAMAAJ0CwQL+'], [3, null]];
  const source = { execute: async (query: string) => {
    if (query.includes('user_tab_cols')) return { rows: metadata };
    assert.match(query, /SELECT "ID", "RID" FROM "LINKS"/);
    let fetched = false;
    return { resultSet: { getRows: async () => { if (fetched) return []; fetched = true; return rows; }, close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async () => ({ rows: metadata }),
    executeMany: async (insert: string, binds: unknown[][]) => { assert.match(insert, /VALUES \(:1, :2\)/); assert.deepEqual(binds, rows); return {}; },
    commit: async () => {}, rollback: async () => assert.fail('unexpected rollback'),
  } as unknown as oracledb.Connection;
  const result = await copyTableRows(source, target, ['LINKS']);
  assert.equal(result.totalRows, 3);
  assert.match(result.warnings!.join(' '), /ROWID\/UROWID values were copied as-is in LINKS\.RID/);
});

test('NUMBER values beyond JavaScript precision are fetched and bound as exact text in the target decimal format', async () => {
  for (const [nls, expected] of [['.,', ['12345678901234567890123456789012345678', '-0.000000000000000000123456789012345678901', '9007199254740993.25']], [',.', ['12345678901234567890123456789012345678', '-0,000000000000000000123456789012345678901', '9007199254740993,25']]] as const) {
    const metadata = [col('BIG'), col('RATE', 'BINARY_DOUBLE'), col('NOTE', 'CLOB')];
    const values = ['12345678901234567890123456789012345678', '-0.000000000000000000123456789012345678901', '9007199254740993.25'];
    let handler: oracledb.ExecuteOptions['fetchTypeHandler'];
    const source = { execute: async (query: string, _binds: unknown, options: oracledb.ExecuteOptions) => {
      if (query.includes('user_tab_cols')) return { rows: metadata };
      handler = options.fetchTypeHandler;
      let i = 0;
      return { resultSet: { getRows: async () => i < values.length ? [[values[i++], 1e300, 'x']] : [], close: async () => {} } };
    } } as unknown as oracledb.Connection;
    const bound: unknown[] = [];
    const target = {
      execute: async (query: string) => query.includes('nls_session_parameters') ? { rows: [{ VALUE: nls }] } : { rows: metadata },
      executeMany: async (_sql: string, rows: unknown[][], options: oracledb.ExecuteManyOptions) => {
        assert.deepEqual((options.bindDefs as oracledb.BindDefinition[]).map(b => b.type), [oracledb.STRING, oracledb.NUMBER, oracledb.CLOB]);
        bound.push(rows[0][0]);
        assert.equal(rows[0][1], 1e300);
        return {};
      },
      commit: async () => {}, rollback: async () => assert.fail('unexpected rollback'),
    } as unknown as oracledb.Connection;
    assert.equal((await copyTableRows(source, target, ['LEDGER'])).totalRows, 3);
    assert.deepEqual(bound, expected);
    const meta = (dbType: unknown) => ({ name: 'X', dbType }) as Parameters<NonNullable<oracledb.ExecuteOptions['fetchTypeHandler']>>[0];
    assert.equal(handler!(meta(oracledb.DB_TYPE_NUMBER), [])?.type, oracledb.STRING);
    assert.equal(handler!(meta(oracledb.DB_TYPE_BINARY_DOUBLE), []), undefined);
  }
});

test('native vectors and nulls retain their representation and explicit bind type during retries', async () => {
  for (const vector of [new Float32Array([0.1, -2]), new Float64Array([1.123456789, -2]), new Int8Array([1, -2]), new Uint8Array([255, 0]), new oracledb.SparseVector({ numDimensions: 8, indices: new Uint32Array([1]), values: new Float32Array([0.5]) }), null]) {
    const columns = [col(), col('DESCRIPTION_EMBEDDING', 'VECTOR')];
    const metaData = [{ dbType: oracledb.DB_TYPE_VECTOR, vectorDimensions: 8, vectorFormat: oracledb.VECTOR_FORMAT_FLOAT32, isSparseVector: false }];
    const rows = [[1, vector], [2, null]];
    let attempt = 0, committed = false;
    const source = { execute: async (sql: string) => {
      if (sql.includes('user_tab_cols')) return { rows: columns };
      if (sql.includes('WHERE 1=0')) return { metaData };
      let fetched = false;
      return { resultSet: { getRows: async () => { if (fetched) return []; fetched = true; return rows; }, close: async () => {} } };
    } } as unknown as oracledb.Connection;
    const target = {
      execute: async (sql: string) => sql.includes('WHERE 1=0') ? { metaData } : { rows: columns },
      executeMany: async (_sql: string, binds: unknown[][], options: oracledb.ExecuteManyOptions) => {
        assert.equal((options.bindDefs as oracledb.BindDefinition[])[1].type, oracledb.DB_TYPE_VECTOR);
        assert.equal(binds[0][1], vector);
        assert.equal(options.autoCommit, false);
        return attempt++ === 0 ? { batchErrors: [{ errorNum: 2291, offset: 0, message: 'parent missing' }] } : {};
      },
      commit: async () => { committed = true; }, rollback: async () => { assert.fail('unexpected rollback'); },
    } as unknown as oracledb.Connection;
    assert.equal((await copyTableRows(source, target, ['PRODUCTS'])).totalRows, 2);
    assert.equal(attempt, 2);
    assert.equal(committed, true);
  }
});

test('incompatible vector metadata fails before any inserts or identity DDL', async () => {
  const columns = [col('DESCRIPTION_EMBEDDING', 'VECTOR')];
  let rollback = false;
  const connection = (dimensions: number) => ({
    execute: async (sql: string) => {
      assert.ok(sql.startsWith('SELECT'));
      return sql.includes('user_tab_cols') ? { rows: columns } : { metaData: [{ dbType: oracledb.DB_TYPE_VECTOR, vectorDimensions: dimensions, vectorFormat: oracledb.VECTOR_FORMAT_FLOAT32 }] };
    },
    executeMany: async () => { assert.fail('must preflight'); },
    rollback: async () => { rollback = true; },
  } as unknown as oracledb.Connection);
  await assert.rejects(copyTableRows(connection(768), connection(384), ['PRODUCTS']), /VECTOR dimensions/);
  assert.equal(rollback, true);
});

test('JSON and large Unicode CLOB/NCLOB text are bound without parsing or truncation, including retries', async () => {
  const columns = [col('DOC', 'JSON'), col('BODY', 'CLOB'), col('NATIONAL', 'NCLOB')];
  const documents = ['{"n":123456789012345678901234567890,"v":[true,null]}', 'null', null, 'false', '"text"', '[1,2]'];
  const text = '日本語🙂'.repeat(10000);
  let attempt = 0, committed = false;
  const source = { execute: async (sql: string, _binds: unknown, options: oracledb.ExecuteOptions) => {
    if (sql.includes('user_tab_cols')) return { rows: columns };
    assert.match(sql, /JSON_SERIALIZE\("DOC" RETURNING CLOB EXTENDED ERROR ON ERROR\)/);
    // Each LOB column is fetched twice: inline text up to the limit, a locator only beyond it.
    assert.match(sql, /CASE WHEN DBMS_LOB\.GETLENGTH\("BODY"\) <= 1048576 THEN "BODY" END AS "DF\$INLINE\$1"/);
    // The locator half is the plain column: no LOB expression the source would have to materialize.
    assert.match(sql, /, "BODY" AS "DF\$STREAM\$1"/);
    assert.doesNotMatch(sql, /> 1048576/);
    const handler = options.fetchTypeHandler!;
    type Meta = Parameters<NonNullable<oracledb.ExecuteOptions['fetchTypeHandler']>>[0];
    assert.deepEqual(handler({ name: 'DF$INLINE$1', dbType: oracledb.DB_TYPE_CLOB } as Meta, []), { type: oracledb.STRING });
    assert.equal(handler({ name: 'DF$STREAM$1', dbType: oracledb.DB_TYPE_CLOB } as Meta, []), undefined);
    // LOB tables are fetched in batches, not one row per round trip.
    assert.equal(options.fetchArraySize, LOB_COPY_BATCH_ROWS);
    let sent = false;
    return { resultSet: { getRows: async (size: number) => {
      assert.equal(size, LOB_COPY_BATCH_ROWS);
      if (sent) return [];
      sent = true;
      return documents.map(doc => [doc, text, null, null, null, null]);
    }, close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async () => ({ rows: columns }),
    executeMany: async (sql: string, rows: unknown[][], options: oracledb.ExecuteManyOptions) => {
      assert.match(sql, /JSON\(:1 EXTENDED\)/);
      assert.deepEqual((options.bindDefs as oracledb.BindDefinition[]).map(b => b.type), [oracledb.CLOB, oracledb.CLOB, oracledb.NCLOB]);
      // First the whole batch (the first row is parent-blocked), then the retry of that row.
      assert.deepEqual(rows.map(row => row[0]), attempt === 0 ? documents : [documents[0]]);
      for (const row of rows) { assert.equal(row.length, 3); assert.equal(row[1], text); assert.equal(row[2], null); }
      return attempt++ === 0 ? { batchErrors: [{ errorNum: 2291, offset: 0, message: 'parent missing' }] } : {};
    },
    commit: async () => { committed = true; }, rollback: async () => assert.fail('unexpected rollback'),
  } as unknown as oracledb.Connection;
  assert.equal((await copyTableRows(source, target, ['DOCS'])).totalRows, documents.length);
  assert.equal(attempt, 2);
  assert.equal(committed, true);
});


import { Duplex } from 'node:stream';
const LobBase = (oracledb as unknown as { Lob: typeof Duplex }).Lob;
class FakeLob extends LobBase {
  text: string; written: string[] = []; destroyed = false; kind: oracledb.DbType; reads = 0;
  constructor(text = '', kind: oracledb.DbType = oracledb.CLOB) { super({ decodeStrings: false }); this.text = text; this.kind = kind; }
  get length() { return this.text.length; }
  get type() { return this.kind; }
  async getData(offset?: number, amount?: number) { this.reads++; return offset ? this.text.slice(offset - 1, offset - 1 + amount!) : this.text; }
  override _write(data: unknown, _encoding: unknown, cb: (e?: Error | null) => void) { assert.equal(typeof data, 'string'); this.written.push(data as string); cb(); }
  override _destroy(_e: unknown, cb: (e?: Error | null) => void) { this.destroyed = true; cb(); }
}

test('small LOBs are read as text, large LOBs stream into temporary target LOBs, including retries', async () => {
  const columns = [col('ID'), col('BODY', 'CLOB'), col('NATIONAL', 'NCLOB')];
  const big = '日本語🙂'.repeat(300000);
  const small = new FakeLob('short'), large = new FakeLob(big, oracledb.NCLOB);
  const temps: FakeLob[] = [];
  let attempts = 0, committed = false;
  const source = { execute: async (sql: string) => {
    if (sql.includes('user_tab_cols')) return { rows: columns };
    let sent = false;
    return { resultSet: { getRows: async () => sent ? [] : (sent = true, [['1', small, large]]), close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async (sql: string, binds: { val: unknown; type?: unknown }[]) => {
      if (sql.includes('user_tab_cols')) return { rows: columns };
      if (sql.includes('nls_session_parameters')) return { rows: [{ VALUE: '.,' }] };
      assert.match(sql, /^INSERT INTO "DOCS"/);
      assert.deepEqual(binds.slice(0, 2), [{ type: oracledb.STRING, val: '1' }, { type: oracledb.CLOB, val: 'short' }]);
      assert.equal(binds[2].val, temps[0]);
      assert.equal(binds[2].type, undefined);
      if (attempts++ === 0) throw Object.assign(new Error('ORA-02291: parent missing'), { errorNum: 2291 });
      return {};
    },
    createLob: async (type: oracledb.DbType) => { assert.equal(type, oracledb.NCLOB); const lob = new FakeLob('', type); temps.push(lob); return lob; },
    executeMany: async () => assert.fail('streamed rows are inserted one by one'),
    commit: async () => { committed = true; }, rollback: async () => assert.fail('unexpected rollback'),
  } as unknown as oracledb.Connection;
  assert.equal((await copyTableRows(source, target, ['DOCS'])).totalRows, 1);
  assert.equal(attempts, 2);
  assert.equal(temps.length, 1);
  assert.equal(temps[0].written.join(''), big);
  assert.ok(large.reads > 1, 'large LOBs are read in chunks');
  assert.ok(temps[0].written.every(chunk => !/[\ud800-\udbff]$/.test(chunk) && !/^[\udc00-\udfff]/.test(chunk)), 'chunks never split a surrogate pair');
  assert.equal(large.destroyed, true);
  assert.equal(small.destroyed, true);
  assert.equal(temps[0].destroyed, true);
  assert.equal(committed, true);
});


test('checks actual row existence using quoted names', async () => {
  const sqls: string[] = [];
  const target = { execute: async (sql: string) => { sqls.push(sql); return { rows: sql.includes('EMPTY') ? [] : [[1]] }; } } as unknown as oracledb.Connection;
  assert.deepEqual(await nonEmptyCopyTables(target, ['EMPTY', 'a"b']), ['a"b']);
  assert.equal(sqls[1], 'SELECT 1 FROM "a""b" WHERE ROWNUM = 1');
});

function truncateTarget(refs: { CHILD_OWNER: string; CHILD_TABLE: string; CONSTRAINT_NAME: string; PARENT_TABLE: string }[], fail?: (sql: string) => boolean, occupied: string[] = ['INVOICES']) {
  const sqls: string[] = [];
  const target = { execute: async (sql: string, binds?: string[]) => {
    if (sql.includes('FROM dual')) return { rows: [{ U: 'APP' }] };
    if (sql.includes('all_constraints')) return { rows: refs.filter(r => binds!.includes(r.PARENT_TABLE)) };
    const probed = /^SELECT 1 FROM "([^"]+)" WHERE ROWNUM = 1$/.exec(sql);
    if (probed) return { rows: occupied.includes(probed[1]) ? [[1]] : [] };
    sqls.push(sql);
    if (fail?.(sql)) throw new Error('ORA-00054: resource busy');
    return {};
  } } as unknown as oracledb.Connection;
  return { target, sqls };
}
const ref = (child: string, parent: string, owner = 'APP') => ({ CHILD_OWNER: owner, CHILD_TABLE: child, CONSTRAINT_NAME: `FK_${child}_${parent}`, PARENT_TABLE: parent });

test('truncation disables foreign keys inside the selection, truncates, then re-enables them', async () => {
  const t = truncateTarget([ref('ORDERS', 'CUSTOMERS'), ref('CUSTOMERS', 'CUSTOMERS')]);
  assert.deepEqual(await truncateCopyTables(t.target, ['CUSTOMERS', 'ORDERS'], ['CUSTOMERS', 'ORDERS']), ['CUSTOMERS', 'ORDERS']);
  assert.deepEqual(t.sqls, [
    'ALTER TABLE "ORDERS" DISABLE CONSTRAINT "FK_ORDERS_CUSTOMERS"', 'ALTER TABLE "CUSTOMERS" DISABLE CONSTRAINT "FK_CUSTOMERS_CUSTOMERS"',
    'TRUNCATE TABLE "CUSTOMERS"', 'TRUNCATE TABLE "ORDERS"',
    'ALTER TABLE "ORDERS" ENABLE CONSTRAINT "FK_ORDERS_CUSTOMERS"', 'ALTER TABLE "CUSTOMERS" ENABLE CONSTRAINT "FK_CUSTOMERS_CUSTOMERS"',
  ]);
});

test('truncation is blocked by references from tables outside the selection or other schemas', async () => {
  for (const outside of [ref('INVOICES', 'CUSTOMERS'), ref('ORDERS', 'CUSTOMERS', 'OTHER')]) {
    const t = truncateTarget([outside]);
    assert.match((await truncateBlocker(t.target, ['CUSTOMERS'], ['CUSTOMERS', 'ORDERS']))!, /Truncation blocked: .*references CUSTOMERS/);
    await assert.rejects(truncateCopyTables(t.target, ['CUSTOMERS'], ['CUSTOMERS', 'ORDERS']), /Truncation blocked/);
    assert.deepEqual(t.sqls, []);
  }
  assert.equal(await truncateBlocker(truncateTarget([ref('ORDERS', 'CUSTOMERS')]).target, ['CUSTOMERS'], ['CUSTOMERS', 'ORDERS']), null);
});

test('a failed truncation still re-enables foreign keys and reports what was already truncated', async () => {
  const t = truncateTarget([ref('ORDERS', 'CUSTOMERS')], sql => sql === 'TRUNCATE TABLE "ORDERS"');
  await assert.rejects(truncateCopyTables(t.target, ['CUSTOMERS', 'ORDERS'], ['CUSTOMERS', 'ORDERS']), /Truncation failed: ORA-00054.*Already truncated \(cannot be undone\): CUSTOMERS\. No rows were copied\./);
  assert.equal(t.sqls.at(-1), 'ALTER TABLE "ORDERS" ENABLE CONSTRAINT "FK_ORDERS_CUSTOMERS"');
  const e = truncateTarget([ref('ORDERS', 'CUSTOMERS')], sql => sql.includes('ENABLE'));
  await assert.rejects(truncateCopyTables(e.target, ['CUSTOMERS'], ['CUSTOMERS', 'ORDERS']), /could not be re-enabled.*Re-enable these foreign keys: ALTER TABLE "ORDERS" ENABLE CONSTRAINT/);
});

test('message-only and code-only manager FK errors from the thin driver are retried', async () => {
  for (const representation of ['message', 'code']) {
    const s = foreignKeySessions({ EMPLOYEES: [[3, 2], [2, 1], [1, null]] }, { EMPLOYEES: 'EMPLOYEES' });
    const executeMany = s.target.executeMany.bind(s.target);
    s.target.executeMany = (async (...args: unknown[]) => {
      const result = await (executeMany as Function)(...args);
      result.batchErrors = result.batchErrors.map((e: { offset: number }) => ({
        offset: e.offset,
        ...(representation === 'code' ? { code: 'ORA-02291', message: 'parent missing' } : { message: 'ORA-02291: integrity constraint (WMT_RETAIL.FK_EMPLOYEES_MGR) violated - parent key not found' }),
      }));
      return result;
    }) as typeof s.target.executeMany;
    assert.equal((await copyTableRows(s.source, s.target, ['EMPLOYEES'])).totalRows, 3);
    assert.deepEqual(s.stats(), { commits: 1, rollbacks: 0 });
    assert.equal(s.attempts.filter(a => a === 'EMPLOYEES:1').length, 1);
    assert.equal(s.inserted.get('EMPLOYEES')!.size, 3);
  }
});

/** Names each table's foreign key FK_<TABLE> in ORA-02291 messages and in the target dictionary. */
function namedForeignKeys(s: ReturnType<typeof foreignKeySessions>, parents: Record<string, string>, otherSchema: string[] = []) {
  const execute = s.target.execute.bind(s.target);
  s.target.execute = (async (sql: string, ...rest: unknown[]) => sql.includes('user_constraints fk')
    ? { rows: Object.entries(parents).map(([table, parent]) => ({ CONSTRAINT_NAME: `FK_${table}`, PARENT_TABLE: otherSchema.includes(parent) ? null : parent, PARENT_LABEL: `${otherSchema.includes(parent) ? 'OTHER' : 'APP'}.${parent}` })) }
    : (execute as Function)(sql, ...rest)) as typeof s.target.execute;
  const executeMany = s.target.executeMany.bind(s.target);
  s.target.executeMany = (async (sql: string, ...rest: unknown[]) => {
    const table = /INTO "([^"]+)"/.exec(sql)![1];
    const result = await (executeMany as Function)(sql, ...rest);
    result.batchErrors = result.batchErrors.map((e: { errorNum: number; offset: number; message: string }) => e.errorNum === 2291 ? { ...e, message: `ORA-02291: integrity constraint (APP.FK_${table}) violated - parent key not found` } : e);
    return result;
  }) as typeof s.target.executeMany;
}

test('rows whose parent table is not in the copy are skipped at once, naming the foreign key', async () => {
  const s = foreignKeySessions({ REPORTS: [[1, 10], [2, 11]] }, { REPORTS: 'CATALOG' });
  namedForeignKeys(s, { REPORTS: 'CATALOG' });
  const events: { kind: string; reason?: string; waitingFor?: string[] }[] = [];
  const result = await copyTableRows(s.source, s.target, ['REPORTS'], { onProgress: e => events.push(e) });
  assert.equal(result.totalRows, 0);
  assert.equal(result.skippedRows, 2);
  // Each row was tried once: nothing waited for a retry.
  assert.deepEqual(s.attempts, ['REPORTS:1', 'REPORTS:2']);
  assert.ok(!events.some(e => e.kind === 'deferred' || e.kind === 'retry'));
  const skipped = events.filter(e => e.kind === 'skipped');
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason!, /APP\.CATALOG \(FK_REPORTS\), which is not part of this copy/);
  assert.ok(result.warnings!.some(w => /REPORTS: 2 row\(s\) skipped — .*FK_REPORTS/.test(w)));
});

test('rows waiting for a parent later in the copy are kept, retried and named in the log', async () => {
  const s = foreignKeySessions({ A: [[1, 5]], B: [[5, null]] }, { A: 'B' });
  namedForeignKeys(s, { A: 'B' });
  const events: { kind: string; waitingFor?: string[] }[] = [];
  const result = await copyTableRows(s.source, s.target, ['A', 'B'], { onProgress: e => events.push(e) });
  assert.equal(result.totalRows, 2);
  assert.equal(result.skippedRows, undefined);
  assert.deepEqual(events.find(e => e.kind === 'deferred')?.waitingFor, ['FK_A → APP.B']);
});

test('rows whose parent was already copied, or is in another schema, are not retried', async () => {
  const done = foreignKeySessions({ P: [[1, null]], C: [[2, 9]] }, { C: 'P' });
  namedForeignKeys(done, { C: 'P' });
  const r1 = await copyTableRows(done.source, done.target, ['P', 'C']);
  assert.equal(r1.skippedRows, 1);
  assert.ok(r1.warnings!.some(w => /which was already copied in this copy/.test(w)));
  assert.equal(done.attempts.filter(a => a === 'C:2').length, 1);
  const other = foreignKeySessions({ C: [[2, 9]] }, { C: 'X' });
  namedForeignKeys(other, { C: 'X' }, ['X']);
  const r2 = await copyTableRows(other.source, other.target, ['C']);
  assert.equal(r2.skippedRows, 1);
  assert.ok(r2.warnings!.some(w => /OTHER\.X \(FK_C\), which is in another schema/.test(w)));
});

test('a stop between tables rolls back the table in progress and keeps committed tables', async () => {
  const s = sessions();
  const stop = new AbortController();
  let breaks = 0;
  (s.target as unknown as { break: () => Promise<void> }).break = async () => { breaks++; };
  const commit = s.target.commit.bind(s.target);
  // Stop as soon as the first table commits.
  s.target.commit = (async () => { await commit(); stop.abort(); }) as typeof s.target.commit;
  await assert.rejects(copyTableRows(s.source, s.target, ['PARENT', 'CHILD'], { signal: stop.signal }), /^Error: Copy stopped by user\. Tables already committed keep their rows: PARENT \(2\)\./);
  assert.deepEqual(s.stats(), { commits: 1, rollbacks: 1, closed: 1, inserted: 2 });
  // A stop during COMMIT never cancels the commit call.
  assert.equal(breaks, 0);
});

test('a stop while rows are being inserted cancels the call in flight, then rolls back', async () => {
  const s = sessions();
  const stop = new AbortController();
  let breaks = 0;
  (s.target as unknown as { break: () => Promise<void> }).break = async () => { breaks++; };
  s.target.executeMany = (async () => { stop.abort(); throw Object.assign(new Error('ORA-01013: user requested cancel of current operation'), { errorNum: 1013 }); }) as unknown as typeof s.target.executeMany;
  await assert.rejects(copyTableRows(s.source, s.target, ['T'], { signal: stop.signal }), /^Error: Copy stopped by user\. No rows were committed\./);
  assert.equal(breaks, 1);
  assert.equal(s.stats().commits, 0);
  assert.equal(s.stats().rollbacks, 1);
});

test('a copy stopped before it starts inserts nothing', async () => {
  const s = sessions();
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(copyTableRows(s.source, s.target, ['T'], { signal: stop.signal }), /Copy stopped by user\. No rows were committed\./);
  assert.equal(s.stats().inserted, 0);
});

test('message-only duplicate errors remain fatal', async () => {
  const s = sessions();
  s.target.executeMany = (async () => ({ batchErrors: [{ offset: 0, message: 'ORA-00001: unique constraint violated' }] })) as unknown as typeof s.target.executeMany;
  await assert.rejects(copyTableRows(s.source, s.target, ['T']), /ORA-00001/);
  assert.equal(s.stats().commits, 0);
  assert.equal(s.stats().rollbacks, 1);
});



test('source counts use live COUNT queries and quoted names, not dictionary estimates', async () => {
  const queries: string[] = [];
  const source = { execute: async (sql: string) => { queries.push(sql); return { rows: [{ ROW_COUNT: queries.length === 1 ? 0 : 100001 }] }; } } as unknown as oracledb.Connection;
  const counts = await countCopyRows(source, ['EMPTY', 'a"b']);
  assert.equal(counts.EMPTY, 0);
  assert.equal(counts['a"b'], 100001);
  assert.equal(queries[1], 'SELECT COUNT(*) AS row_count FROM "a""b"');
  assert.throws(() => validateCopyCounts(counts), /a"b.*100,001/);
});

test('count preflight permits the boundary and rejects oversized combined selections', () => {
  assert.equal(validateCopyCounts({ EMPTY: 0, T: 100000 }), 100000);
  assert.throws(() => validateCopyCounts({ PARENT: 60000, CHILD: 40001 }), /100,001.*Select fewer tables/);
  assert.throws(() => validateCopyCounts({ BIG: 100001 }), /BIG.*100,001/);
});

test('unavailable or invalid counts fail closed', async () => {
  for (const value of [undefined, -1, NaN, 1.5]) {
    const source = { execute: async () => ({ rows: [{ ROW_COUNT: value }] }) } as unknown as oracledb.Connection;
    await assert.rejects(countCopyRows(source, ['T']), /Cannot determine source row count/);
  }
});

test('reports progress: table start, inserted rows, and each commit', async () => {
  const s = sessions();
  const events: unknown[] = [];
  await copyTableRows(s.source, s.target, ['PARENT', 'CHILD'], { onProgress: e => events.push(e) });
  assert.deepEqual(events, [
    { kind: 'table', name: 'PARENT' }, { kind: 'rows', name: 'PARENT', rows: 2 }, { kind: 'committed', name: 'PARENT', rows: 2 },
    { kind: 'table', name: 'CHILD' }, { kind: 'rows', name: 'CHILD', rows: 2 }, { kind: 'committed', name: 'CHILD', rows: 2 },
  ]);
});

test('a failing progress listener never breaks the copy', async () => {
  const s = sessions();
  const outcome = await copyTableRows(s.source, s.target, ['PARENT'], { onProgress: () => { throw new Error('listener'); } });
  assert.equal(outcome.totalRows, 2);
});

test('batch size follows declared row width, within bounds, and LOB tables use small batches', () => {
  const sized = (length: number, count = 1) => Array.from({ length: count }, (_, i) => ({ ...col(`C${i}`, 'VARCHAR2'), DATA_LENGTH: length }));
  assert.equal(copyBatchRows(sized(22, 3)), COPY_BATCH_MAX_ROWS);
  assert.equal(copyBatchRows(sized(4000, 20)), COPY_BATCH_MIN_ROWS);
  assert.equal(copyBatchRows(sized(4000, 2)), Math.floor(8 * 1024 * 1024 / (2 * (4000 + 32))));
  assert.equal(copyBatchRows([col()]), COPY_BATCH_MAX_ROWS, 'unknown widths still get a large batch');
  assert.equal(copyBatchRows(sized(22), true), LOB_COPY_BATCH_ROWS);
});

test('rows are fetched and inserted in large batches, and the next batch is fetched while one is inserted', async () => {
  const data = Array.from({ length: 12000 }, (_, i) => [String(i)]);
  const events: string[] = [];
  let index = 0, fetchArraySize = 0;
  const sizes: number[] = [];
  const source = { execute: async (sql: string, _binds: unknown, options: oracledb.ExecuteOptions) => {
    if (sql.includes('user_tab_cols')) return { rows: [{ ...col(), DATA_LENGTH: 22 }] };
    fetchArraySize = options.fetchArraySize!;
    return { resultSet: { getRows: async (size: number) => {
      sizes.push(size); events.push('fetch');
      const rows = data.slice(index, index + size); index += size; return rows;
    }, close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async (sql: string) => sql.includes('nls_session_parameters') ? { rows: [{ VALUE: '.,' }] } : { rows: [{ ...col(), DATA_LENGTH: 22 }] },
    executeMany: async (_sql: string, rows: unknown[]) => {
      events.push(`insert ${rows.length}`);
      await new Promise(resolve => setImmediate(resolve));
      return {};
    },
    commit: async () => {}, rollback: async () => assert.fail('unexpected rollback'),
  } as unknown as oracledb.Connection;
  assert.equal((await copyTableRows(source, target, ['T'], { maxTotal: 1_000_000 })).totalRows, 12000);
  assert.equal(fetchArraySize, COPY_BATCH_MAX_ROWS);
  assert.ok(sizes.every(size => size === COPY_BATCH_MAX_ROWS));
  assert.deepEqual(events, ['fetch', 'fetch', 'insert 5000', 'fetch', 'insert 5000', 'fetch', 'insert 2000']);
});

test('a batch mixing inline and streamed LOBs inserts the inline rows as one array and streams the rest', async () => {
  const columns = [col('ID'), col('BODY', 'CLOB')];
  const large = new FakeLob('x'.repeat(2_000_000));
  const temps: FakeLob[] = [];
  let arrayRows: unknown[][] = [], single = 0;
  const source = { execute: async (sql: string) => {
    if (sql.includes('user_tab_cols')) return { rows: columns };
    let sent = false;
    // Columns: ID, inline BODY text, streamed BODY locator.
    return { resultSet: { getRows: async () => sent ? [] : (sent = true, [['1', 'a', null], ['2', null, large], ['3', 'c', null]]), close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async (sql: string, binds: { val: unknown }[]) => {
      if (sql.includes('user_tab_cols')) return { rows: columns };
      if (sql.includes('nls_session_parameters')) return { rows: [{ VALUE: '.,' }] };
      single++;
      assert.equal(binds[0].val, '2');
      assert.equal(binds[1].val, temps[0]);
      return {};
    },
    createLob: async () => { const lob = new FakeLob(''); temps.push(lob); return lob; },
    executeMany: async (_sql: string, rows: unknown[][]) => { arrayRows = rows; return {}; },
    commit: async () => {}, rollback: async () => assert.fail('unexpected rollback'),
  } as unknown as oracledb.Connection;
  assert.equal((await copyTableRows(source, target, ['DOCS'])).totalRows, 3);
  assert.deepEqual(arrayRows, [['1', 'a'], ['3', 'c']]);
  assert.equal(single, 1);
  assert.equal(temps[0].written.join('').length, 2_000_000);
  assert.equal(large.destroyed, true);
});

test('a fetch failure while a batch is being inserted waits for the insert, then rolls back', async () => {
  let fetches = 0, inserting = false, rolledBackWhileInserting = false, closed = 0;
  const source = { execute: async (sql: string) => {
    if (sql.includes('user_tab_cols')) return { rows: [col()] };
    return { resultSet: { getRows: async () => { if (fetches++ === 0) return [['1']]; throw new Error('ORA-03113: end-of-file on communication channel'); }, close: async () => { closed++; } } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async () => ({ rows: [col()] }),
    executeMany: async () => { inserting = true; await new Promise(resolve => setTimeout(resolve, 5)); inserting = false; return {}; },
    commit: async () => assert.fail('must not commit'),
    rollback: async () => { rolledBackWhileInserting = inserting; },
  } as unknown as oracledb.Connection;
  await assert.rejects(copyTableRows(source, target, ['T']), /ORA-03113.*No rows were committed/);
  assert.equal(rolledBackWhileInserting, false);
  assert.equal(closed, 1);
});

test('large LOBs are streamed one row at a time, each inserted before the next is streamed', async () => {
  const columns = [col('ID'), col('BODY', 'CLOB')];
  const lobs = [1, 2, 3].map(n => new FakeLob(String(n).repeat(1_500_000)));
  const events: string[] = [];
  const source = { execute: async (sql: string) => {
    if (sql.includes('user_tab_cols')) return { rows: columns };
    let sent = false;
    return { resultSet: { getRows: async () => sent ? [] : (sent = true, lobs.map((lob, i) => [String(i + 1), null, lob])), close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const temps: FakeLob[] = [];
  const target = {
    execute: async (sql: string, binds: { val: unknown }[]) => {
      if (sql.includes('user_tab_cols')) return { rows: columns };
      if (sql.includes('nls_session_parameters')) return { rows: [{ VALUE: '.,' }] };
      events.push(`insert ${binds[0].val}`);
      return {};
    },
    createLob: async () => { const lob = new FakeLob(''); temps.push(lob); events.push(`stream ${temps.length}`); return lob; },
    executeMany: async () => assert.fail('streamed rows are inserted one by one'),
    commit: async () => {}, rollback: async () => assert.fail('unexpected rollback'),
  } as unknown as oracledb.Connection;
  const progress: number[] = [];
  const result = await copyTableRows(source, target, ['DOCS'], { onProgress: e => { if (e.kind === 'rows') progress.push(e.rows); } });
  assert.equal(result.totalRows, 3);
  assert.deepEqual(events, ['stream 1', 'insert 1', 'stream 2', 'insert 2', 'stream 3', 'insert 3']);
  assert.deepEqual(progress, [1, 1, 1], 'progress advances with every streamed row');
  assert.deepEqual(temps.map(t => t.written.join('').length), [1_500_000, 1_500_000, 1_500_000]);
  assert.ok(lobs.every(lob => lob.destroyed) && temps.every(t => t.destroyed));
});

test('the CLOB/JSON row limit applies only to tables with those columns, and the smaller limit wins', () => {
  const lob = new Set(['DOCS']);
  assert.equal(copyRowLimitFor('DOCS', null, 100, lob), 100);
  assert.equal(copyRowLimitFor('PLAIN', null, 100, lob), null);
  assert.equal(copyRowLimitFor('DOCS', 50, 100, lob), 50);
  assert.equal(copyRowLimitFor('DOCS', 1000, 100, lob), 100);
  assert.equal(copyRowLimitFor('PLAIN', 1000, 100, lob), 1000);
  assert.equal(copyRowLimitFor('DOCS', null, null, lob), null);
  assert.equal(validateCopyCounts({ DOCS: 5000, PLAIN: 300 }, name => copyRowLimitFor(name, null, 100, lob)), 400);
  assert.throws(() => validateCopyCounts({ DOCS: 5000, PLAIN: 300 }, name => copyRowLimitFor(name, null, 100, lob), 399), /400 rows/);
});

test('copying samples only CLOB/JSON tables with the LOB row limit', async () => {
  const limits: Record<string, number | undefined> = {};
  const columns: Record<string, CopyColumn[]> = { DOCS: [col('ID'), col('BODY', 'CLOB')], PLAIN: [col('ID')] };
  const source = { execute: async (sql: string, binds: { name?: string; row_limit?: number }) => {
    if (sql.includes('user_tab_cols')) return { rows: columns[binds.name!] };
    const table = /FROM "([^"]+)"/.exec(sql)![1];
    limits[table] = binds && !Array.isArray(binds) ? binds.row_limit : undefined;
    return { resultSet: { getRows: async () => [], close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async (sql: string, binds: { name?: string }) => sql.includes('user_tab_cols') ? { rows: columns[binds.name!] } : { rows: [{ VALUE: '.,' }] },
    commit: async () => {}, rollback: async () => {},
  } as unknown as oracledb.Connection;
  await copyTableRows(source, target, ['DOCS', 'PLAIN'], { lobRowLimit: 25 });
  assert.deepEqual(limits, { DOCS: 25, PLAIN: undefined });
  await copyTableRows(source, target, ['DOCS', 'PLAIN'], { rowLimit: 10, lobRowLimit: 25 });
  assert.deepEqual(limits, { DOCS: 10, PLAIN: 10 });
});

test('lists tables with CLOB, NCLOB or JSON columns', async () => {
  let sql = '';
  const conn = { execute: async (text: string) => { sql = text; return { rows: [{ TABLE_NAME: 'ARCHIVO' }] }; } } as unknown as oracledb.Connection;
  assert.deepEqual(await lobCopyTables(conn), ['ARCHIVO']);
  assert.match(sql, /data_type IN \('CLOB', 'NCLOB', 'JSON'\)/);
  assert.match(sql, /hidden_column = 'NO'/);
});

function triggerSessions(failInsert = false) {
  const ddl: string[] = [];
  let commits = 0;
  const source = { execute: async (sql: string) => sql.includes('user_tab_cols') ? { rows: [col()] } : { resultSet: { getRows: (() => { let sent = false; return async () => sent ? [] : (sent = true, [['1']]); })(), close: async () => {} } } } as unknown as oracledb.Connection;
  const target = {
    execute: async (sql: string) => {
      if (sql.includes('user_tab_cols')) return { rows: [col()] };
      if (sql.includes('user_triggers')) return { rows: [{ TRIGGER_NAME: 'TR_A', TABLE_NAME: 'A' }, { TRIGGER_NAME: 'TR_OTHER', TABLE_NAME: 'NOT_COPIED' }] };
      if (sql.includes('nls_session_parameters')) return { rows: [{ VALUE: '.,' }] };
      ddl.push(sql);
      return {};
    },
    executeMany: async () => { ddl.push('INSERT'); if (failInsert) throw new Error('ORA-00001: unique constraint violated'); return {}; },
    commit: async () => { commits++; ddl.push('COMMIT'); }, rollback: async () => { ddl.push('ROLLBACK'); },
  } as unknown as oracledb.Connection;
  return { source, target, ddl, commits: () => commits };
}

test('target triggers on the copied tables are disabled before inserting and enabled again afterwards', async () => {
  const s = triggerSessions();
  const result = await copyTableRows(s.source, s.target, ['A'], { disableTriggers: true });
  assert.deepEqual(s.ddl, ['ALTER TRIGGER "TR_A" DISABLE', 'INSERT', 'COMMIT', 'ALTER TRIGGER "TR_A" ENABLE']);
  assert.match(result.warnings!.join(' '), /enabled again: TR_A \(A\)/);
});

test('a failed copy rolls back first, then re-enables the triggers it disabled', async () => {
  const s = triggerSessions(true);
  await assert.rejects(copyTableRows(s.source, s.target, ['A'], { disableTriggers: true }), /ORA-00001/);
  assert.deepEqual(s.ddl, ['ALTER TRIGGER "TR_A" DISABLE', 'INSERT', 'ROLLBACK', 'ALTER TRIGGER "TR_A" ENABLE']);
});

test('triggers are left alone unless disabling them is requested', async () => {
  const s = triggerSessions();
  await copyTableRows(s.source, s.target, ['A']);
  assert.deepEqual(s.ddl, ['INSERT', 'COMMIT']);
});

test('an empty child outside the selection does not block truncation; its foreign key is disabled and re-enabled around it', async () => {
  const t = truncateTarget([ref('AUDIT_LOG', 'CUSTOMERS')], undefined, []);
  assert.equal(await truncateBlocker(t.target, ['CUSTOMERS'], ['CUSTOMERS']), null);
  assert.deepEqual(await truncateCopyTables(t.target, ['CUSTOMERS'], ['CUSTOMERS']), ['CUSTOMERS']);
  assert.deepEqual(t.sqls, [
    'ALTER TABLE "AUDIT_LOG" DISABLE CONSTRAINT "FK_AUDIT_LOG_CUSTOMERS"',
    'TRUNCATE TABLE "CUSTOMERS"',
    'ALTER TABLE "AUDIT_LOG" ENABLE CONSTRAINT "FK_AUDIT_LOG_CUSTOMERS"',
  ]);
});

test('rows chosen for a table override the per-table and CLOB/JSON limits for that table only', async () => {
  const lob = new Set(['DOCS']);
  assert.equal(copyRowLimitFor('DOCS', 10, 5, lob, { DOCS: 500 }), 500);
  assert.equal(copyRowLimitFor('PLAIN', 10, 5, lob, { DOCS: 500 }), 10);
  assert.equal(copyRowLimitFor('PLAIN', null, null, lob, { PLAIN: 3 }), 3);
  assert.equal(copyRowLimitFor('toString', null, null, lob, {}), null, 'inherited names are not chosen limits');
  assert.equal(validateCopyCounts({ DOCS: 900, PLAIN: 900 }, name => copyRowLimitFor(name, 10, null, lob, { DOCS: 700 })), 710);

  const limits: Record<string, number | undefined> = {};
  const source = { execute: async (sql: string, binds: { row_limit?: number }) => {
    if (sql.includes('user_tab_cols')) return { rows: [col()] };
    limits[/FROM "([^"]+)"/.exec(sql)![1]] = binds && !Array.isArray(binds) ? binds.row_limit : undefined;
    return { resultSet: { getRows: async () => [], close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = { execute: async (sql: string) => sql.includes('user_tab_cols') ? { rows: [col()] } : { rows: [] }, commit: async () => {}, rollback: async () => {} } as unknown as oracledb.Connection;
  await copyTableRows(source, target, ['A', 'B', 'C'], { rowLimit: 100, tableRowLimits: { B: 2500 } });
  assert.deepEqual(limits, { A: 100, B: 2500, C: 100 });
});

test('rows chosen per table must be whole numbers from 1 to 1,000,000', () => {
  assert.deepEqual(Object.entries((parseCopyTableRowLimits(undefined) as { tableRowLimits: Record<string, number> }).tableRowLimits), []);
  assert.deepEqual({ ...(parseCopyTableRowLimits({ A: 5, B: 1_000_000 }) as { tableRowLimits: Record<string, number> }).tableRowLimits }, { A: 5, B: 1_000_000 });
  for (const bad of [[1], 'x', { A: 0 }, { A: 1.5 }, { A: '5' }, { A: 1_000_001 }]) assert.ok('error' in parseCopyTableRowLimits(bad), JSON.stringify(bad));
});

test('WHERE filters accept read-only conditions', () => {
  for (const ok of ["num_anio = 2026", "fecha >= DATE '2026-01-01' AND estado IN ('A', 'B')", "nombre = 'it''s; -- not a comment'", '"Num Anio" = 2026', "id IN (SELECT id FROM cat_x WHERE activo = 1)", "update_date > SYSDATE - 30"]) {
    assert.equal(copyFilterError(ok), null, ok);
  }
});

test('WHERE filters reject anything that could leave the condition or write', () => {
  const cases: [string, RegExp][] = [
    ['', /empty/], ['x = 1; DELETE FROM t', /;/], ['x = 1 -- c', /comments/], ['x = 1 /* c */', /comments/],
    ['x = :v', /bind/], ["x = q'[a]'", /q'/], ["x = 'a", /not closed/], ['"x = 1', /not closed/],
    ['1=1) UNION SELECT 1 FROM dual WHERE (1=1', /unmatched “\)”/], ['(x = 1', /unmatched “\(”/],
    ['x IN (SELECT id FROM t FOR UPDATE)', /UPDATE/], ['f() = 1 OR EXECUTE', /EXECUTE/],
    ['x = 1'.padEnd(2001, ' ') + 'x', /longer/],
  ];
  for (const [where, error] of cases) assert.match(copyFilterError(where) ?? '', error, where);
});

test('table filters parse, trim, drop empty ones and report the table of a bad one', () => {
  assert.deepEqual({ ...(parseCopyTableFilters({ A: '  num_anio = 2026 ', B: ' ' }) as { tableFilters: object }).tableFilters }, { A: 'num_anio = 2026' });
  assert.match((parseCopyTableFilters({ A: 'x = 1;' }) as { error: string }).error, /^A filter: /);
  assert.match((parseCopyTableFilters(['x']) as { error: string }).error, /map table names/);
  assert.match((parseCopyTableFilters({ A: 5 }) as { error: string }).error, /must be text/);
});

test('counts and copy reads apply the filter, combined with a row limit', async () => {
  const counted: string[] = [];
  const source = { execute: async (sql: string) => { counted.push(sql); return { rows: [{ ROW_COUNT: 7 }] }; } } as unknown as oracledb.Connection;
  assert.deepEqual({ ...await countCopyRows(source, ['T', 'U'], { T: 'num_anio = 2026' }) }, { T: 7, U: 7 });
  assert.deepEqual(counted, ['SELECT COUNT(*) AS row_count FROM "T" WHERE (num_anio = 2026)', 'SELECT COUNT(*) AS row_count FROM "U"']);
  await assert.rejects(countCopyRows(source, ['T'], { T: 'x = 1; drop' }), /T filter: /);
  const s = sessions();
  const queries: string[] = [];
  const execute = s.source.execute.bind(s.source);
  s.source.execute = (async (sql: string, ...rest: unknown[]) => { if (!sql.includes('user_tab_cols')) queries.push(sql); return (execute as Function)(sql, ...rest); }) as typeof s.source.execute;
  await copyTableRows(s.source, s.target, ['T'], { tableFilters: { T: 'num_anio = 2026' }, tableRowLimits: { T: 5 } });
  assert.equal(queries[0], 'SELECT "ID" FROM "T" WHERE (num_anio = 2026) AND ROWNUM <= :row_limit');
});
