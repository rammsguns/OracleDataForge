import type { RoutineParam } from './api';
import type { ArgState } from './runBuffers';

/** Convert saved modes and typed NULL to the single editable value field. */
export function editableArg(a: ArgState): ArgState {
  const value = a.isNull && !a.value ? 'NULL' : a.value;
  return { value, isNull: /^null$/i.test(value.trim()), useDefault: false };
}

export function inputError(p: RoutineParam, a: ArgState): string | null {
  if (p.direction === 'OUT' || a.isNull || (p.hasDefault && a.useDefault) || !p.bindKind) return null;
  const value = a.value.trim();
  if (!value && p.bindKind !== 'string') return 'Enter a value or type NULL.';
  if (p.bindKind === 'number' && !Number.isFinite(Number(value))) return 'Enter a number, for example 42 or 3.5.';
  if (p.bindKind === 'boolean' && !/^(true|false|t|f|y|n|yes|no|1|0)$/i.test(value)) return 'Choose true or false.';
  if (p.bindKind === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
    if (!m) return 'Use YYYY-MM-DD or YYYY-MM-DD HH:MI:SS.';
    const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
    const date = new Date(0);
    date.setUTCFullYear(+y, +mo - 1, +d);
    if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d || +h > 23 || +mi > 59 || +sec > 59) return 'Enter a valid calendar date and time.';
  }
  if (p.bindKind === 'cursor') return 'Input cursors need a PL/SQL block.';
  return null;
}

export function matchesExpected(actual: string | number | null | undefined, expected: string, isNull: boolean): boolean {
  if (isNull) return actual === null;
  if (actual === undefined || actual === null) return false;
  if (typeof actual === 'number') return expected.trim() !== '' && Number.isFinite(Number(expected)) && actual === Number(expected);
  return actual === expected;
}
