import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorDiagnostics } from './editorDiagnostics';

test('reports accurate line and column for unmatched parentheses', () => {
  const issues = editorDiagnostics('SELECT 1\nFROM dual);\nSELECT (2 FROM dual;');
  assert.deepEqual(issues.map(d => [d.severity, d.line, d.column]), [['error', 2, 10], ['error', 3, 8]]);
});
test('ignores literals, quoted identifiers and comments', () => {
  assert.deepEqual(editorDiagnostics(`SELECT 'it''s ) = NULL', "weird(" FROM dual; -- (\n/* ) */`), []);
});
test('recognizes paired and custom Oracle alternative quotes', () => {
  for (const literal of ["q'[it' ( ) ]'", "q'{x )}'", "q'<x (>'", "q'(x ))'", "q'!x' )!'", "nq'[x')]'", "Q'[a }' ( b]' "]) {
    assert.deepEqual(editorDiagnostics(`SELECT ${literal} FROM dual;`), [], literal);
  }
});
test('identifies unfinished lexical regions', () => {
  for (const source of ["SELECT 'abc", 'SELECT "abc', '/* abc', "SELECT q'[abc"]) {
    assert.equal(editorDiagnostics(source)[0]?.severity, 'error', source);
  }
});
test('warns about null equality but not assignment or null predicates', () => {
  assert.equal(editorDiagnostics('SELECT * FROM t WHERE a = NULL OR b != NULL OR c <> NULL').length, 3);
  assert.deepEqual(editorDiagnostics('BEGIN a := NULL; END;\nSELECT * FROM t WHERE a IS NULL OR b IS NOT NULL;'), []);
});
test('warns about swallowed exceptions without flagging re-raised handlers', () => {
  assert.equal(editorDiagnostics('BEGIN NULL; EXCEPTION WHEN OTHERS THEN NULL; END;')[0]?.severity, 'warning');
  assert.deepEqual(editorDiagnostics('BEGIN NULL; EXCEPTION WHEN OTHERS THEN RAISE; END;'), []);
});
test('bounds output for large invalid documents', () => {
  assert.equal(editorDiagnostics(')'.repeat(10000)).length, 200);
});
