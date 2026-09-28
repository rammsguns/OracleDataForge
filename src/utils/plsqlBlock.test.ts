import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRoutineBlock } from './plsqlBlock';
import type { RoutineMember, RoutineMeta } from './api';

const member: RoutineMember = { name: 'STOCK_LINE', kind: 'FUNCTION', overload: null, params: [], returnType: 'PL/SQL RECORD', returnDeclType: 'PKG_INVENTORY_LAB.T_STOCK_LINE', returnBindKind: null, returnFields: [
  { name: 'STORE_ID', dataType: 'NUMBER', bindKind: 'number' },
  { name: 'LABEL', dataType: 'VARCHAR2', bindKind: 'string' },
] };
const meta: RoutineMeta = { name: 'PKG_INVENTORY_LAB', type: 'PACKAGE', members: [member] };
const arg = () => ({ value: '', isNull: true, useDefault: false });

test('record results are assigned to typed locals and exported one field at a time', () => {
  const block = generateRoutineBlock(meta, member, arg);
  assert.match(block, /V_RESULT\s+PKG_INVENTORY_LAB.T_STOCK_LINE;/);
  assert.match(block, /:DF_RECORD_1 := V_RESULT.STORE_ID;/);
  assert.match(block, /:DF_RECORD_2 := V_RESULT.LABEL;/);
  assert.doesNotMatch(block, /:RESULT := V_RESULT;/);
});

test('unknown composite returns and OUT parameters never generate invalid scalar assignments', () => {
  const block = generateRoutineBlock(meta, { ...member, returnFields: undefined, params: [{ name: 'P_RECORD', position: 1, direction: 'OUT', dataType: 'PL/SQL RECORD', declType: 'PKG_INVENTORY_LAB.T_STOCK_LINE', bindKind: null, hasDefault: false }] }, arg);
  assert.doesNotMatch(block, /:RESULT :=|:P_RECORD :=/);
  assert.match(block, /Inspect/);
});

test('field references preserve quoted identifiers and avoid conflicting parameter bind names', () => {
  const block = generateRoutineBlock(meta, { ...member, returnFields: [{ name: 'Mixed Name', dataType: 'VARCHAR2', bindKind: 'string' }] }, arg);
  assert.match(block, /V_RESULT\."Mixed Name"/);
  const conflict = generateRoutineBlock(meta, { ...member, params: [{ name: 'DF_RECORD_1', position: 1, direction: 'IN', dataType: 'NUMBER', declType: 'NUMBER', bindKind: 'number', hasDefault: false }] }, arg);
  assert.doesNotMatch(conflict, /:DF_RECORD_1 :=/);
});
