import assert from 'node:assert/strict';
import test from 'node:test';
import { worksheetStatement, statementRanges } from './worksheetStatement';
test('runs either query from the reported worksheet', () => {
  const sql = '-- worksheet\n-- Ctrl+Enter\nSELECT * FROM categories;\nSELECT * FROM customers;';
  assert.equal(worksheetStatement(sql, sql.indexOf('categories')), 'SELECT * FROM categories;');
  assert.equal(worksheetStatement(sql, sql.length), 'SELECT * FROM customers;');
});
test('selection takes priority and multiple selected statements are rejected', () => {
  const sql = 'SELECT 1 FROM dual;\nSELECT 2 FROM dual;';
  assert.equal(worksheetStatement(sql, 19, sql.length), 'SELECT 2 FROM dual;');
  assert.throws(() => worksheetStatement(sql, 0, sql.length), /one statement/);
});
test('ignores delimiters in comments, identifiers and Oracle literals', () => {
  for (const literal of ["'a;b'", "'a'';b'", "q'[a';b]'", "q'!a';b!'", '"a;b"']) {
    const sql = `SELECT ${literal} FROM dual /* ; */; -- ;\nSELECT 2 FROM dual;`;
    assert.equal(statementRanges(sql).length, 2, literal);
    assert.equal(worksheetStatement(sql, sql.length), 'SELECT 2 FROM dual;');
  }
});
test('preserves PL/SQL internal semicolons and strips slash terminators', () => {
  const block = 'BEGIN\n  NULL;\n  BEGIN NULL; END;\nEND;';
  const sql = block + '\n/\nSELECT 1 FROM dual;';
  assert.equal(worksheetStatement(sql, 10), block);
  assert.equal(worksheetStatement(sql, sql.length), 'SELECT 1 FROM dual;');
  assert.equal(worksheetStatement('-- heading\n' + block, 0), block);
  assert.equal(worksheetStatement('CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;'), 'CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;');
});
test('empty or comment-only worksheets do not execute', () => {
  assert.equal(worksheetStatement('-- test\n/* comment */'), '');
  assert.equal(worksheetStatement(''), '');
});
