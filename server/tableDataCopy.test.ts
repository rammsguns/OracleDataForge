import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracledb from 'oracledb';
import { copyColumns, copyTableRows, countCopyRows, validateCopyCounts, nonEmptyCopyTables, quoteCopyName, parseCopyRowLimit, parseCopyTotalLimit, type CopyColumn } from './tableDataCopy.ts';

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
    const handler = options.fetchTypeHandler!;
    assert.equal(handler({ name: 'BODY', dbType: oracledb.CLOB } as Parameters<NonNullable<oracledb.ExecuteOptions['fetchTypeHandler']>>[0], [])?.type, oracledb.STRING);
    assert.equal(options.fetchArraySize, 1);
    let i = 0;
    return { resultSet: { getRows: async (size: number) => { assert.equal(size, 1); return i < documents.length ? [[documents[i++], text, null]] : []; }, close: async () => {} } };
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async () => ({ rows: columns }),
    executeMany: async (sql: string, rows: unknown[][], options: oracledb.ExecuteManyOptions) => {
      assert.match(sql, /JSON\(:1 EXTENDED\)/);
      assert.deepEqual((options.bindDefs as oracledb.BindDefinition[]).map(b => b.type), [oracledb.CLOB, oracledb.CLOB, oracledb.NCLOB]);
      assert.equal(rows[0][0], documents[attempt < documents.length ? attempt : 0]);
      assert.equal(rows[0][1], text);
      assert.equal(rows[0][2], null);
      return attempt++ === 0 ? { batchErrors: [{ errorNum: 2291, offset: 0, message: 'parent missing' }] } : {};
    },
    commit: async () => { committed = true; }, rollback: async () => assert.fail('unexpected rollback'),
  } as unknown as oracledb.Connection;
  assert.equal((await copyTableRows(source, target, ['DOCS'])).totalRows, documents.length);
  assert.equal(attempt, documents.length + 1);
  assert.equal(committed, true);
});


test('oversized CLOB rows roll back and close their source cursor before any insert', async () => {
  const columns = [col('BODY', 'CLOB')];
  let closed = false, rolledBack = false;
  const source = { execute: async (sql: string) => sql.includes('user_tab_cols') ? { rows: columns } : {
    resultSet: { getRows: async () => [['x'.repeat(16 * 1024 * 1024 + 1)]], close: async () => { closed = true; } },
  } } as unknown as oracledb.Connection;
  const target = {
    execute: async () => ({ rows: columns }), executeMany: async () => assert.fail('must not insert oversized data'),
    commit: async () => assert.fail('must not commit'), rollback: async () => { rolledBack = true; },
  } as unknown as oracledb.Connection;
  await assert.rejects(copyTableRows(source, target, ['DOCS']), /16 MB/);
  assert.equal(closed, true);
  assert.equal(rolledBack, true);
});


test('checks actual row existence using quoted names', async () => {
  const sqls: string[] = [];
  const target = { execute: async (sql: string) => { sqls.push(sql); return { rows: sql.includes('EMPTY') ? [] : [[1]] }; } } as unknown as oracledb.Connection;
  assert.deepEqual(await nonEmptyCopyTables(target, ['EMPTY', 'a"b']), ['a"b']);
  assert.equal(sqls[1], 'SELECT 1 FROM "a""b" WHERE ROWNUM = 1');
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
