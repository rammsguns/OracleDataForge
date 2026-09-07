export interface EditorDiagnostic {
  offset: number;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
}

/** Conservative local checks, not an Oracle parser. Never execute code to validate it. */
export function editorDiagnostics(source: string): EditorDiagnostic[] {
  const out: EditorDiagnostic[] = [];
  const code = source.split('');
  const positions: { offset: number; severity: EditorDiagnostic['severity']; message: string }[] = [];
  const add = (offset: number, severity: EditorDiagnostic['severity'], message: string) => {
    if (positions.length < 200) positions.push({ offset, severity, message });
  };
  const mask = (a: number, b: number) => { for (let k = a; k < b; k++) if (code[k] !== '\n') code[k] = ' '; };
  const stack: number[] = [];
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source.startsWith('--', i)) {
      const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; mask(start, i); continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) add(start, 'error', 'Unclosed block comment. Expected */.');
      i = end < 0 ? source.length : end + 2; mask(start, i); continue;
    }
    if ((source[i] === 'q' || source[i] === 'Q') && source[i + 1] === "'" && source[i + 2] && !/\s/.test(source[i + 2])) {
      const open = source[i + 2];
      const close = ({ '[': ']', '(': ')', '{': '}', '<': '>' } as Record<string, string>)[open] ?? open;
      const end = source.indexOf(close + "'", i + 3);
      if (end < 0) add(start, 'error', `Unclosed alternative quoted string. Expected ${close}'.`);
      i = end < 0 ? source.length : end + 2; mask(start, i); continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i++]; let closed = false;
      while (i < source.length) {
        if (source[i++] !== quote) continue;
        if (source[i] === quote) { i++; continue; }
        closed = true; break;
      }
      if (!closed) add(start, 'error', quote === "'" ? 'Unclosed string literal.' : 'Unclosed quoted identifier.');
      mask(start, i); continue;
    }
    if (source[i] === '(') stack.push(i);
    if (source[i] === ')' && stack.pop() === undefined) add(i, 'error', 'Closing parenthesis has no matching opening parenthesis.');
    i++;
  }
  for (const offset of stack) add(offset, 'error', 'Opening parenthesis has no matching closing parenthesis.');
  const clean = code.join('');
  for (const m of clean.matchAll(/(?:<>|!=|(?<![:<>!=])=)\s*\bNULL\b/gi)) add(m.index!, 'warning', 'Comparison with NULL does not test for null values. Use IS NULL or IS NOT NULL.');
  for (const m of clean.matchAll(/\bWHEN\s+OTHERS\s+THEN\s+NULL\s*;/gi)) add(m.index!, 'warning', 'This exception handler silently ignores every error. Consider handling or re-raising the exception.');
  positions.sort((a, b) => a.offset - b.offset);
  let cursor = 0, line = 1, column = 1;
  for (const item of positions) {
    while (cursor < item.offset) { if (source[cursor++] === '\n') { line++; column = 1; } else column++; }
    out.push({ ...item, line, column });
  }
  return out;
}
