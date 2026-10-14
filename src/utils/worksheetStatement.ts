/** Mask Oracle literals and comments while preserving offsets and line breaks. */
function mask(sql: string): string {
  const chars = sql.split('');
  const blank = (a: number, b: number) => { for (let j = a; j < b; j++) if (chars[j] !== '\n' && chars[j] !== '\r') chars[j] = ' '; };
  for (let i = 0; i < sql.length;) {
    const start = i;
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; }
    else if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; }
    else if (/[qQ]/.test(sql[i]) && sql[i + 1] === "'") {
      const open = sql[i + 2];
      const close = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[open] ?? open;
      const end = sql.indexOf(close + "'", i + 3); i = end < 0 ? sql.length : end + 2;
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      while (i < sql.length) { if (sql[i++] === quote) { if (sql[i] === quote) i++; else break; } }
    } else { i++; continue; }
    blank(start, i);
  }
  return chars.join('');
}

/** SQL*Plus client directive; output capture is already enabled by the app. */
export function isServerOutputOn(sql: string): boolean {
  return /^\s*SET\s+SERVEROUTPUT\s+ON(?:\s+SIZE\s+(?:UNLIMITED|\d+))?(?:\s+FORMAT\s+(?:WRAPPED|WORD_WRAPPED|TRUNCATED))?\s*;?\s*$/i.test(mask(sql));
}

export function statementRanges(sql: string) {
  const code = mask(sql);
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  while (start < code.length) {
    while (start < code.length && /[\s;]/.test(code[start])) start++;
    if (start >= code.length) break;
    // SET commands end at the newline, without needing a SQL semicolon. Only
    // recognize them at statement boundaries, never inside stored PL/SQL.
    const lineEnd = code.indexOf('\n', start);
    const directiveEnd = lineEnd < 0 ? code.length : lineEnd;
    if (isServerOutputOn(sql.slice(start, directiveEnd))) {
      ranges.push({ start, end: directiveEnd });
      start = directiveEnd;
      continue;
    }
    // Stored PL/SQL and anonymous blocks use SQL*Plus's standalone slash delimiter.
    const block = /^(?:begin\b|declare\b|create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:procedure|function|package|trigger|type)\b|with\s+(?:function|procedure)\b)/i.test(code.slice(start));
    const slash = /^[ \t]*\/[ \t]*\r?$/gm;
    slash.lastIndex = start;
    const delimiter = slash.exec(code);
    const semi = block ? -1 : code.indexOf(';', start);
    const end = semi >= 0 && (!delimiter || semi < delimiter.index) ? semi + 1 : delimiter?.index ?? code.length;
    if (code.slice(start, end).trim()) ranges.push({ start, end });
    start = end === delimiter?.index ? end + delimiter[0].length : end;
  }
  return ranges;
}
export function worksheetStatement(sql: string, start = 0, end = start): string {
  if (start !== end) {
    const selected = sql.slice(start, end);
    const ranges = statementRanges(selected);
    if (ranges.length > 1) throw new Error('Run executes one statement at a time. Select one query or place the cursor inside it.');
    return ranges.length ? selected.slice(ranges[0].start, ranges[0].end).trim() : '';
  }
  const ranges = statementRanges(sql);
  const range = ranges.find(r => start <= r.end) ?? ranges.at(-1);
  return range ? sql.slice(range.start, range.end).trim() : '';
}

/** Run the selected script in order; without a selection, run only the cursor statement. */
export function worksheetStatements(sql: string, start = 0, end = start): string[] {
  if (start === end) {
    const statement = worksheetStatement(sql, start, end);
    return statement ? [statement] : [];
  }
  const selected = sql.slice(start, end);
  return statementRanges(selected).map(range => selected.slice(range.start, range.end).trim());
}
