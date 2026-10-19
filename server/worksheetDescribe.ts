import type { Metadata } from 'oracledb';

/** Accept identifiers only: the generated query must never contain arbitrary SQL. */
export function describeTarget(sql: string): string | null {
  const code = sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  if (!/^(?:desc|describe)\b/i.test(code)) return null;
  const identifier = '(?:"(?:[^"]|"")+"|[a-zA-Z][a-zA-Z0-9_$#]*)';
  const match = new RegExp(`^(?:desc|describe)\\s+(${identifier}(?:\\s*\\.\\s*${identifier})?)\\s*;?\\s*$`, 'i').exec(code);
  if (!match) throw new Error('Usage: DESC [schema.]object_name;');
  return match[1];
}

export function describeRows(metadata: Pick<Metadata<unknown>, 'name' | 'dbTypeName' | 'precision' | 'scale' | 'byteSize' | 'nullable'>[]): string[][] {
  return metadata.map(column => {
    let type = column.dbTypeName ?? 'UNKNOWN';
    if (type === 'NUMBER' && column.precision) {
      type = column.scale === -127 ? `FLOAT(${column.precision})`
        : `NUMBER(${column.precision}${column.scale ? `,${column.scale}` : ''})`;
    } else if (/^(?:N?VARCHAR2|N?CHAR|RAW)$/.test(type) && column.byteSize != null) {
      type += `(${column.byteSize})`;
    }
    return [column.name, column.nullable === false ? 'NOT NULL' : '', type];
  });
}
