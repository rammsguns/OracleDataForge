import assert from 'node:assert/strict';
import test from 'node:test';
import { getCompletions } from './completions';

test('suggests keywords from the current input immediately', () => {
  assert.ok(getCompletions('sel', 3)?.items.some(i => i.label === 'SELECT'));
});
test('explicit completion works with no prefix', () => {
  assert.equal(getCompletions('', 0), null);
  assert.ok(getCompletions('', 0, true)?.items.length);
});
test('suppresses comments, strings, quoted identifiers and Oracle alternative literals', () => {
  for (const text of ["-- sel", '/* sel', "SELECT 'sel", 'SELECT "sel', "SELECT q'[hello ' sel", "SELECT q'!hello ' sel"]) {
    assert.equal(getCompletions(text, text.length, true), null, text);
  }
  assert.ok(getCompletions("SELECT 'hello' FROM du", 22, true));
  assert.ok(getCompletions('-- comment\nsel', 14));
});
test('offers qualified package members without unrelated keywords', () => {
  const items = getCompletions('dbms_output.pu', 14)?.items ?? [];
  assert.ok(items.some(i => i.label === 'PUT_LINE'));
  assert.ok(items.every(i => i.label.startsWith('PU')));
  assert.ok(getCompletions('DBMS_OUTPUT.', 12)?.items.some(i => i.label === 'PUT_LINE'));
});
test('replaces the whole identifier when completing in its middle', () => {
  const result = getCompletions('selct', 3);
  assert.equal(result?.start, 0);
  assert.equal(result?.end, 5);
});
test('uses document identifiers including Oracle dollar and hash characters', () => {
  const source = 'DECLARE v$total# NUMBER; BEGIN v$';
  assert.ok(getCompletions(source, source.length)?.items.some(i => i.label === 'v$total#'));
});
test('offers document members and PL/SQL snippets', () => {
  const source = 'SELECT emp.salary FROM employees emp WHERE emp.sa';
  assert.ok(getCompletions(source, source.length)?.items.some(i => i.label === 'salary'));
  assert.ok(getCompletions('beg', 3)?.items.some(i => i.text.includes('END;')));
});
