import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCopyProgress } from './tableDataProgress.ts';

const clock = () => { let t = 1000; return () => (t += 500); };

test('tracks copied, committed and remaining tables, and logs each step', () => {
  const p = createCopyProgress({ sourceSchema: 'SRC', targetSchema: 'DST', tables: [{ name: 'A', planned: 3 }, { name: 'B', planned: 2 }] }, clock());
  assert.equal(p.progress.plannedRows, 5);
  p.event({ kind: 'table', name: 'A' });
  assert.equal(p.progress.current, 'A');
  assert.equal(p.progress.tables[0].status, 'copying');
  p.event({ kind: 'rows', name: 'A', rows: 3 });
  p.event({ kind: 'committed', name: 'A', rows: 3 });
  assert.deepEqual(p.progress.tables.map(t => [t.status, t.copied, t.committed]), [['committed', 3, 3], ['waiting', 0, 0]]);
  p.event({ kind: 'table', name: 'B' });
  p.event({ kind: 'rows', name: 'B', rows: 1 });
  p.event({ kind: 'deferred', name: 'B', rows: 1 });
  p.event({ kind: 'retry', rows: 1 });
  p.event({ kind: 'committed', name: 'B', rows: 1 });
  p.finish();
  assert.equal(p.progress.state, 'succeeded');
  assert.equal(p.progress.copiedRows, 4);
  assert.equal(p.progress.current, undefined);
  const messages = p.progress.log.map(e => e.message);
  assert.match(messages[0], /\[1\/2\] Copying A \(3 rows\)/);
  assert.ok(messages.some(m => /A committed: 3 rows in \d/.test(m)));
  assert.ok(messages.some(m => /B: 1 row\(s\) wait for parent keys/.test(m)));
  assert.match(messages.at(-1)!, /Copy finished: 4 rows in 2 table\(s\)/);
  assert.ok(p.progress.updatedAt > p.progress.startedAt);
});

test('long tables log running counts; a failure keeps only committed rows', () => {
  const p = createCopyProgress({ sourceSchema: 'S', targetSchema: 'T', tables: [{ name: 'A', planned: 5 }, { name: 'BIG', planned: 25000 }, { name: 'C', planned: 1 }] }, clock());
  p.truncating(['A', 'BIG']);
  assert.equal(p.progress.tables[1].status, 'truncating');
  p.truncated(['A', 'BIG']);
  assert.equal(p.progress.tables[1].status, 'truncated');
  p.event({ kind: 'table', name: 'A' });
  p.event({ kind: 'rows', name: 'A', rows: 5 });
  p.event({ kind: 'committed', name: 'A', rows: 5 });
  p.event({ kind: 'table', name: 'BIG' });
  for (let i = 0; i < 12; i++) p.event({ kind: 'rows', name: 'BIG', rows: 1000 });
  assert.equal(p.progress.log.filter(e => /BIG: 10,000 \/ 25,000 rows/.test(e.message)).length, 1);
  p.finish('boom');
  assert.equal(p.progress.state, 'failed');
  assert.deepEqual(p.progress.tables.map(t => [t.status, t.copied]), [['committed', 5], ['rolled back', 0], ['waiting', 0]]);
  assert.equal(p.progress.copiedRows, 5);
  assert.equal(p.progress.log.at(-1)!.level, 'error');
});
