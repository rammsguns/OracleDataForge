export interface Completion { label: string; detail: string; text: string }
const keywords = `SELECT FROM WHERE GROUP BY HAVING ORDER ASC DESC JOIN INNER LEFT RIGHT FULL OUTER ON AND OR NOT IN IS NULL LIKE BETWEEN EXISTS UNION ALL DISTINCT AS CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE TRUNCATE DROP CREATE TABLE VIEW INDEX SEQUENCE TRIGGER PROCEDURE FUNCTION PACKAGE REPLACE ALTER ADD CONSTRAINT PRIMARY KEY FOREIGN REFERENCES UNIQUE CHECK DEFAULT BEGIN DECLARE EXCEPTION COMMIT ROLLBACK GRANT REVOKE WITH FETCH FIRST ROWS ONLY OFFSET OVER PARTITION USING CROSS RETURNING MERGE CASCADE LOOP WHILE FOR EXIT CONTINUE IF ELSIF RETURN RAISE CURSOR OPEN CLOSE BULK COLLECT LIMIT SAVEPOINT NUMBER VARCHAR2 DATE TIMESTAMP BOOLEAN PLS_INTEGER CONSTANT TYPE RECORD ROWTYPE PRAGMA OUT NOCOPY AUTHID`.split(/\s+/);
const functions = `COUNT SUM AVG MIN MAX NVL NVL2 COALESCE DECODE TO_CHAR TO_DATE TO_NUMBER TRUNC ROUND SUBSTR INSTR UPPER LOWER LENGTH LISTAGG ROW_NUMBER RANK DENSE_RANK LAG LEAD ADD_MONTHS MONTHS_BETWEEN EXTRACT CAST CONCAT GREATEST LEAST ABS MOD FLOOR CEIL SQLERRM`.split(/\s+/);
const members: Record<string, string[]> = {
  DBMS_OUTPUT: ['PUT_LINE', 'PUT', 'NEW_LINE', 'ENABLE', 'DISABLE'],
  DBMS_LOB: ['GETLENGTH', 'SUBSTR', 'APPEND', 'CREATETEMPORARY', 'FREETEMPORARY'],
  DBMS_SQL: ['OPEN_CURSOR', 'PARSE', 'EXECUTE', 'FETCH_ROWS', 'CLOSE_CURSOR'],
  DBMS_UTILITY: ['FORMAT_ERROR_BACKTRACE', 'FORMAT_ERROR_STACK', 'GET_TIME'],
};
const snippets: Completion[] = [
  { label: 'select query', detail: 'snippet · SELECT', text: 'SELECT *\nFROM table_name\nWHERE condition;' },
  { label: 'begin block', detail: 'snippet · PL/SQL block', text: 'BEGIN\n  NULL;\nEND;\n/' },
  { label: 'declare block', detail: 'snippet · declarations', text: 'DECLARE\n  v_value NUMBER;\nBEGIN\n  NULL;\nEND;\n/' },
  { label: 'if then', detail: 'snippet · conditional', text: 'IF condition THEN\n  NULL;\nEND IF;' },
  { label: 'for loop', detail: 'snippet · cursor loop', text: 'FOR rec IN (SELECT * FROM table_name) LOOP\n  NULL;\nEND LOOP;' },
  { label: 'exception handler', detail: 'snippet · re-raise', text: 'EXCEPTION\n  WHEN OTHERS THEN\n    DBMS_OUTPUT.PUT_LINE(SQLERRM);\n    RAISE;' },
];
// Mask literals/comments without changing offsets; unfinished regions are masked too.
export function completionCode(source: string): string {
  return source.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|q'([\[({<]|[^\s'])[\s\S]*?(?:[\])}>]'|\1'|$)|'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)/gi, s => s.replace(/[^\n]/g, ' '));
}
export function getCompletions(source: string, caret: number, explicit = false) {
  caret = Math.max(0, Math.min(caret, source.length));
  const code = completionCode(source);
  // Appending a sentinel tells us whether the caret is inside an open literal/comment.
  if (completionCode(source.slice(0, caret) + '\u0001').at(-1) !== '\u0001') return null;
  const before = code.slice(0, caret);
  const word = before.match(/[A-Za-z_$#][\w$#]*$/)?.[0] ?? '';
  const qualifier = before.slice(0, before.length - word.length).match(/([\w$#]+)\.\s*$/)?.[1];
  if (!explicit && !qualifier && word.length < 2) return null;
  const start = caret - word.length;
  const end = caret + (source.slice(caret).match(/^[\w$#]*/)?.[0].length ?? 0);
  const items: Completion[] = [];
  const add = (label: string, detail: string, text = label) => items.push({ label, detail, text });
  if (qualifier) {
    (members[qualifier.toUpperCase()] ?? []).forEach(k => add(k, `${qualifier} member`));
    const escaped = qualifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of code.matchAll(new RegExp('\\b' + escaped + '\\.([A-Za-z_][\\w$#]*)', 'gi'))) {
      if (m.index !== start - qualifier.length - 1) add(m[1], 'document member');
    }
  } else {
    for (const m of code.matchAll(/[A-Za-z_][\w$#]*/g)) {
      if (m.index !== start && !keywords.includes(m[0].toUpperCase()) && !functions.includes(m[0].toUpperCase())) add(m[0], 'document identifier');
    }
    keywords.forEach(k => add(k, 'keyword'));
    functions.forEach(k => add(k, 'function'));
    ['DUAL', 'SYSDATE', 'SYSTIMESTAMP', 'SQLCODE', ...Object.keys(members)].forEach(k => add(k, 'Oracle built-in'));
    items.push(...snippets);
  }
  const seen = new Set<string>();
  const filtered = items.filter(it => {
    const key = it.label.toUpperCase();
    if (!key.startsWith(word.toUpperCase()) || seen.has(key) || key === source.slice(start, end).toUpperCase()) return false;
    seen.add(key); return true;
  }).slice(0, 40);
  return filtered.length ? { items: filtered, start, end } : null;
}
