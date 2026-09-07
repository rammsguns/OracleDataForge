import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editableArg, inputError, matchesExpected } from './routineTesting';
import type { RoutineParam } from './api';

const param = (kind: RoutineParam['bindKind']): RoutineParam => ({ name: 'P_VALUE', position: 1, direction: 'IN', dataType: 'TEST', bindKind: kind, declType: 'TEST', hasDefault: false });
const value = (text: string) => ({ value: text, isNull: false, useDefault: false });

test('editable fields recognize typed NULL and discard saved default modes', () => {
  for (const text of ['NULL', 'null', ' NuLl ']) {
    const arg = editableArg(value(text));
    assert.equal(arg.isNull, true);
    for (const kind of ['number', 'date', 'boolean', 'string'] as const) assert.equal(inputError(param(kind), arg), null);
  }
  assert.deepEqual(editableArg({ ...value(''), useDefault: true }), value(''));
  assert.deepEqual(editableArg({ ...value(''), isNull: true }), { ...value('NULL'), isNull: true });
  assert.deepEqual(editableArg(value('42')), value('42'));
  assert.equal(editableArg(value('nullable')).isNull, false);
});

test('typed inputs require a value, while explicit NULL, defaults and outputs bypass validation', () => {
  assert.ok(inputError(param('number'), value('')));
  assert.equal(inputError(param('number'), { ...value(''), isNull: true }), null);
  assert.equal(inputError({ ...param('number'), hasDefault: true }, { ...value(''), useDefault: true }), null);
  assert.ok(inputError(param('number'), { ...value(''), useDefault: true }));
  assert.equal(inputError({ ...param('number'), direction: 'OUT' }, value('')), null);
  assert.equal(inputError(param('string'), value('')), null);
});

test('validates numbers, booleans and input cursors before sending a request', () => {
  for (const text of ['42', '-3.5', '1e3']) assert.equal(inputError(param('number'), value(text)), null);
  for (const text of ['Infinity', 'NaN', 'abc']) assert.ok(inputError(param('number'), value(text)));
  for (const text of ['TRUE', 'false', 'yes', '0']) assert.equal(inputError(param('boolean'), value(text)), null);
  assert.ok(inputError(param('boolean'), value('maybe')));
  assert.ok(inputError(param('cursor'), value('cursor_name')));
});

test('date validation checks leap years, calendar boundaries and time components', () => {
  for (const text of ['2024-02-29', '2026-09-07 23:59:59', '2026-09-07T10:18']) assert.equal(inputError(param('date'), value(text)), null);
  for (const text of ['2025-02-29', '2026-04-31', '2026-00-10', '2026-13-01', '2026-09-07 24:00', '2026-09-07 10:60', 'today']) assert.ok(inputError(param('date'), value(text)), text);
});

test('expected returns distinguish NULL, missing output, numeric equality and exact text', () => {
  assert.equal(matchesExpected(42, '42.0', false), true);
  assert.equal(matchesExpected(0, '', false), false);
  assert.equal(matchesExpected(null, '', true), true);
  assert.equal(matchesExpected(undefined, '', true), false);
  assert.equal(matchesExpected('NULL', '', true), false);
  assert.equal(matchesExpected('Hello', 'hello', false), false);
  assert.equal(matchesExpected(' Hello ', ' Hello ', false), true);
  assert.equal(matchesExpected('TRUE', 'TRUE', false), true);
});
