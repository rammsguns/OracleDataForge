import type { CellValue } from "../types";

const KEYWORDS = new Set(
  `select from where group by having order asc desc join inner left right full outer on and or not in is null like between exists union all distinct as case when then else end insert into values update set delete truncate drop create table view index sequence trigger procedure function package replace alter add constraint primary key foreign references unique check default begin declare exception commit rollback grant revoke with fetch first rows only limit offset over partition using cross returning merge cascade`.split(/\s+/)
);
const FUNCTIONS = new Set(
  `count sum avg min max nvl coalesce decode to_char to_date to_number sysdate trunc round substr instr upper lower length listagg row_number rank dense_rank lag lead add_months months_between extract cast concat greatest least abs mod floor ceil`.split(/\s+/)
);

export type Token = { text: string; cls: string };

/** Tokenize SQL for syntax highlighting. Returns tokens covering the entire input. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const re =
    /(--[^\n]*)|(\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$#]*)|(:=|<>|!=|>=|<=|\|\||[(),;.*=<>+\-/%])|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const [text] = m;
    let cls = "ident";
    if (m[1] || m[2]) cls = "cmt";
    else if (m[3]) cls = "str";
    else if (m[4]) cls = "num";
    else if (m[5]) {
      const w = text.toLowerCase();
      cls = KEYWORDS.has(w) ? "kw" : FUNCTIONS.has(w) ? "fn" : "ident";
    } else if (m[6]) cls = "op";
    else cls = "ws";
    tokens.push({ text, cls });
  }
  return tokens;
}

/** Very small SQL formatter: uppercases keywords, newlines before major clauses. */
export function formatSql(sql: string): string {
  const major = /\b(select|from|where|group by|having|order by|left join|right join|inner join|full outer join|cross join|join|union all|union|fetch first|values|set|on)\b/gi;
  let out = sql
    .replace(/\s+/g, " ")
    .replace(major, (k) => "\n" + k.toUpperCase())
    .replace(/\n(JOIN|LEFT JOIN|RIGHT JOIN|INNER JOIN|FULL OUTER JOIN|CROSS JOIN|ON)\b/g, "\n  $1")
    .replace(/,\s*/g, ",\n  ")
    .trim();
  // restore comment lines that got collapsed
  out = out.replace(/--\s?/g, "\n-- ");
  return out.replace(/\n{2,}/g, "\n").trim();
}

export interface DestructiveInfo {
  verb: string;
  target: string;
}

/**
 * Mirrors `isReadStatement` in server/index.ts. The backend stays the authority — it
 * re-classifies every statement and refuses unacknowledged writes — but the worksheet
 * uses this to block writes on a read-only connection without a round trip.
 * Keep the two verb lists in sync when either changes.
 */
export function isReadOnlySql(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, "``");
  if (!/^\s*(select|with|show|desc|describe|explain)\b/i.test(stripped)) return false;
  return !/\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|rename|flashback|purge|call|execute|lock)\b/i.test(stripped);
}

/** Name the verb/target of a write statement — used for wording, not for the decision. */
export function destructiveCheck(sql: string): DestructiveInfo | null {
  const clean = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const m = clean.match(
    /\b(drop|truncate|delete|update|alter|insert|merge|create|grant|revoke|rename|flashback|purge|call|execute|lock)\b\s+(?:from\s+|into\s+|or\s+replace\s+)?(?:table\s+)?([A-Za-z_][A-Za-z0-9_$#.]*)?/i
  );
  if (!m) return null;
  return { verb: m[1].toUpperCase(), target: (m[2] || "object").toUpperCase() };
}

export function toCsv(columns: string[], rows: CellValue[][]): string {
  const esc = (v: CellValue) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

export function toJson(columns: string[], rows: CellValue[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2);
}

/** Export raw result values, independently of grid pagination and formatting. */
export function toInserts(columns: string[], rows: CellValue[][], table: string): string {
  // Accept a table or schema.table, including SQL quoted identifiers.
  const identifier = '(?:"(?:[^"\\r\\n]|"")+"|[A-Za-z_][A-Za-z0-9_$#]*)';
  if (!new RegExp(`^${identifier}(?:\\s*\\.\\s*${identifier})?$`).test(table.trim())) {
    throw new Error('Enter a table name or schema.table (use double quotes for special names).');
  }
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const literal = (value: CellValue) => {
    if (value === null) return "NULL";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Cannot export a non-finite number as SQL.");
      return String(value);
    }
    return `'${value.replace(/'/g, "''")}'`;
  };
  const target = table.trim();
  const names = columns.map(quote).join(", ");
  return rows.map((row) => `INSERT INTO ${target} (${names}) VALUES (${columns.map((_, i) => literal(row[i] ?? null)).join(", ")});`).join("\n") + "\n";
}

export function download(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
