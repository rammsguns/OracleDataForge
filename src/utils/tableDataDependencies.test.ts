import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexTableDependencies, limitedCopyCount, tableDataSelection, TABLE_COPY_MAX_TABLES, type TableDependency } from './tableDataDependencies';

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

test('dependencies are indexed once instead of rescanned for every visited table', () => {
  let tableReads = 0;
  const countedFk = (table: string, parent: string | null) => {
    const dependency = fk(table, parent);
    Object.defineProperty(dependency, 'table', { enumerable: true, get: () => { tableReads++; return table; } });
    return dependency;
  };
  const dependencies = [countedFk('A', 'B'), countedFk('B', 'C'), ...Array.from({ length: 100 }, (_, i) => countedFk(`X${i}`, null))];

  const index = indexTableDependencies(dependencies);
  assert.deepEqual(tableDataSelection(['A'], ['A', 'B', 'C'], index).names, ['C', 'B', 'A']);
  assert.deepEqual(tableDataSelection(['B'], ['A', 'B', 'C'], index).names, ['C', 'B']);
  assert.equal(tableReads, dependencies.length);
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

test('dependency expansion never silently truncates the table limit', () => {
  const size = TABLE_COPY_MAX_TABLES + 1;
  const names = Array.from({ length: size }, (_, i) => `T${i}`);
  const r = tableDataSelection(['T0'], names, names.slice(0, -1).map((n, i) => fk(n, names[i + 1])));
  assert.equal(r.names.length, size);
  assert.equal(r.overLimit, true);
  assert.equal(r.names[0], `T${size - 1}`);
});

test('selecting every table orders all parents before their children', () => {
  const all = ['ITEMS', 'AUDIT', 'ORDERS', 'CUSTOMERS', 'REGIONS'];
  const r = tableDataSelection(all, all, [fk('ITEMS', 'ORDERS'), fk('ORDERS', 'CUSTOMERS'), fk('CUSTOMERS', 'REGIONS')]);
  assert.equal(r.names.length, all.length);
  const at = (n: string) => r.names.indexOf(n);
  assert.ok(at('REGIONS') < at('CUSTOMERS') && at('CUSTOMERS') < at('ORDERS') && at('ORDERS') < at('ITEMS'));
  assert.deepEqual(r.added, []);
});

test('row limits cap each table count only when set', () => {
  assert.equal(limitedCopyCount(500, 100), 100);
  assert.equal(limitedCopyCount(50, 100), 50);
  assert.equal(limitedCopyCount(500, null), 500);
});

test('server selection detects new dependencies not in the reviewed table list', () => {
  const reviewed = ['P', 'C'];
  const r = tableDataSelection(reviewed, ['P', 'C', 'NEW_PARENT'], [fk('C', 'P'), fk('P', 'NEW_PARENT')]);
  assert.deepEqual(r.added, ['NEW_PARENT']);
});
