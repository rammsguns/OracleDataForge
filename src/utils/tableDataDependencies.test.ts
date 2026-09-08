import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableDataSelection, type TableDependency } from './tableDataDependencies';

const fk = (table: string, parent: string | null, local = true): TableDependency => ({ table, parent, local, parentSchema: local ? 'TARGET' : 'EXTERNAL', constraint: `FK_${table}_${parent}` });

test('selecting a child expands transitive parents in parent-first order', () => {
  const r = tableDataSelection(['ITEMS'], ['ITEMS', 'ORDERS', 'CUSTOMERS'], [fk('ITEMS', 'ORDERS'), fk('ORDERS', 'CUSTOMERS')]);
  assert.deepEqual(r.names, ['CUSTOMERS', 'ORDERS', 'ITEMS']);
  assert.deepEqual(r.added, ['CUSTOMERS', 'ORDERS']);
  assert.deepEqual(r.cycles, []);
  assert.deepEqual(r.warnings, []);
});

test('shared parents appear once and selecting a parent does not select its children', () => {
  const deps = [fk('A', 'P'), fk('B', 'P')];
  assert.deepEqual(tableDataSelection(['A', 'B'], ['A', 'B', 'P'], deps).names, ['P', 'A', 'B']);
  assert.deepEqual(tableDataSelection(['P'], ['A', 'B', 'P'], deps).names, ['P']);
  assert.deepEqual(tableDataSelection([], ['A', 'B', 'P'], deps).names, []);
});

test('missing source parents and external or invisible parents generate actionable warnings', () => {
  for (const dependency of [fk('C', 'MISSING'), fk('C', 'P', false), fk('C', null, false)]) {
    const r = tableDataSelection(['C'], ['C', 'P'], [dependency]);
    assert.deepEqual(r.names, ['C']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /required data must already exist/);
  }
});

test('cycles and self-references are detected without hanging', () => {
  assert.ok(tableDataSelection(['A'], ['A', 'B'], [fk('A', 'B'), fk('B', 'A')]).cycles.length);
  assert.deepEqual(tableDataSelection(['A'], ['A'], [fk('A', 'A')]).cycles, ['A']);
});

test('dependency expansion never silently truncates the 25-table limit', () => {
  const names = Array.from({ length: 26 }, (_, i) => `T${i}`);
  const r = tableDataSelection(['T0'], names, names.slice(0, -1).map((n, i) => fk(n, names[i + 1])));
  assert.equal(r.names.length, 26);
  assert.equal(r.overLimit, true);
  assert.equal(r.names[0], 'T25');
});

test('server selection detects new dependencies not in the reviewed table list', () => {
  const reviewed = ['P', 'C'];
  const r = tableDataSelection(reviewed, ['P', 'C', 'NEW_PARENT'], [fk('C', 'P'), fk('P', 'NEW_PARENT')]);
  assert.deepEqual(r.added, ['NEW_PARENT']);
});
