import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countInRange, parseCountBound, sameRowCount, searchTerms, sortTableNames, tableNameMatches } from './tableListFilter';

test('search terms split on commas and spaces, upper-cased', () => {
  assert.deepEqual(searchTerms(' cat_, temp  log '), ['CAT_', 'TEMP', 'LOG']);
  assert.deepEqual(searchTerms('  '), []);
});

test('empty search matches everything', () => {
  assert.equal(tableNameMatches('ANY', '', 'starts'), true);
});

test('starts with treats underscore literally and is case-insensitive', () => {
  assert.equal(tableNameMatches('CAT_COUNTRY', 'cat_', 'starts'), true);
  assert.equal(tableNameMatches('CATALOG', 'CAT_', 'starts'), false);
});

test('contains, ends with and several terms', () => {
  assert.equal(tableNameMatches('ORDERS_TEMP_2024', 'temp', 'contains'), true);
  assert.equal(tableNameMatches('ORDERS_BAK', 'TEMP, BAK', 'ends'), true);
  assert.equal(tableNameMatches('ORDERS', 'TEMP, BAK', 'contains'), false);
});

test("doesn't contain excludes every term", () => {
  assert.equal(tableNameMatches('ORDERS', 'TEMP, BAK', 'not-contains'), true);
  assert.equal(tableNameMatches('ORDERS_BAK', 'TEMP, BAK', 'not-contains'), false);
});

test('pattern supports * and ? and escapes other characters', () => {
  assert.equal(tableNameMatches('CAT_A_LOG', 'CAT_*LOG', 'pattern'), true);
  assert.equal(tableNameMatches('T1', 'T?', 'pattern'), true);
  assert.equal(tableNameMatches('T12', 'T?', 'pattern'), false);
  assert.equal(tableNameMatches('A.B', 'A.B', 'pattern'), true);
  assert.equal(tableNameMatches('AXB', 'A.B', 'pattern'), false);
});

test('sorting by name and by counts, unknown counts last', () => {
  const names = ['B', 'A', 'C', 'D'];
  const src = { A: 5, B: 10, C: 5 };
  assert.deepEqual(sortTableNames(names, 'name-asc', src), ['A', 'B', 'C', 'D']);
  assert.deepEqual(sortTableNames(names, 'name-desc', src), ['D', 'C', 'B', 'A']);
  assert.deepEqual(sortTableNames(names, 'source-desc', src), ['B', 'A', 'C', 'D']);
  assert.deepEqual(sortTableNames(names, 'source-asc', src), ['A', 'C', 'B', 'D']);
  assert.deepEqual(sortTableNames(names, 'target-desc', src, { C: 1 }), ['C', 'A', 'B', 'D']);
  assert.deepEqual(names, ['B', 'A', 'C', 'D']);
});

test('count bounds parse digits with separators and reject bad input', () => {
  assert.equal(parseCountBound(''), null);
  assert.equal(parseCountBound('1,000'), 1000);
  assert.equal(parseCountBound('-1'), 'invalid');
  assert.equal(parseCountBound('abc'), 'invalid');
});

test('count range is inclusive, open-ended and drops unknown counts only when bounded', () => {
  assert.equal(countInRange(5, '', ''), true);
  assert.equal(countInRange(undefined, '', ''), true);
  assert.equal(countInRange(undefined, '1', ''), false);
  assert.equal(countInRange(10, '10', '10'), true);
  assert.equal(countInRange(9, '10', ''), false);
  assert.equal(countInRange(11, '', '10'), false);
  assert.equal(countInRange(0, 'x', '0'), true);
});

test('same row count needs both counts known and equal', () => {
  assert.equal(sameRowCount('A', { A: 3 }, { A: 3 }), true);
  assert.equal(sameRowCount('A', { A: 0 }, { A: 0 }), true);
  assert.equal(sameRowCount('A', { A: 3 }, { A: 4 }), false);
  assert.equal(sameRowCount('A', { A: 3 }, {}), false);
  assert.equal(sameRowCount('A', {}, {}), false);
});
