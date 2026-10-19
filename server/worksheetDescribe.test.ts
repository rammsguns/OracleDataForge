import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTarget, describeRows } from './worksheetDescribe.ts';

test('recognizes describe commands and preserves quoted identifiers', () => {
  assert.equal(describeTarget('DESC email_messages;'), 'email_messages');
  assert.equal(describeTarget('-- columns\n describe "My Schema"."My""Table";'), '"My Schema"."My""Table"');
  assert.equal(describeTarget('desc app.messages'), 'app.messages');
  assert.equal(describeTarget('SELECT * FROM messages ORDER BY id DESC'), null);
});

test('rejects extra SQL and malformed describe targets', () => {
  for (const sql of ['desc', 'desc a; drop table a', 'desc a where 1=1', 'desc a.b.c']) {
    assert.throws(() => describeTarget(sql), /Usage:/);
  }
});

test('formats column metadata for the worksheet grid', () => {
  assert.deepEqual(describeRows([
    { name: 'ID', dbTypeName: 'NUMBER', precision: 10, scale: 0, nullable: false },
    { name: 'AMOUNT', dbTypeName: 'NUMBER', precision: 8, scale: 2, nullable: true },
    { name: 'BODY', dbTypeName: 'CLOB', nullable: true },
    { name: 'SUBJECT', dbTypeName: 'VARCHAR2', byteSize: 200, nullable: true },
  ]), [['ID', 'NOT NULL', 'NUMBER(10)'], ['AMOUNT', '', 'NUMBER(8,2)'], ['BODY', '', 'CLOB'], ['SUBJECT', '', 'VARCHAR2(200)']]);
});
