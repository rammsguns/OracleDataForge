/**
 * The table a query result can be edited as: only a plain single-table SELECT qualifies
 * (no joins, subqueries, set operators, grouping or DISTINCT), because the Data tab's row
 * editor works on one table. Returns the table name as the Explorer tree names it, or null.
 */
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z][\w$#]*)`;
const FROM_TABLE = new RegExp(String.raw`^\s*from\s+(${IDENT})(?:\s*\.\s*(${IDENT}))?(?:\s+(?:as\s+)?(?!(?:where|order|fetch|offset|for)\b)${IDENT})?\s*(?:(?:where|order\s+by|fetch|offset|for\s+update)\b[\s\S]*)?$`, "i");

function ident(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1) : raw.toUpperCase();
}

/** Blank out comments and string literals so keyword checks cannot match inside them. */
function mask(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

export function editableTableOf(statement: string, schemaUser: string): string | null {
  const sql = mask(statement).trim().replace(/;+\s*$/, "");
  if (!/^select\b/i.test(sql) || /^select\s+(?:distinct|unique)\b/i.test(sql)) return null;
  if (/\b(?:union|intersect|minus|join|group\s+by|having|connect\s+by|model)\b/i.test(sql)) return null;
  // the top-level FROM must be the only one: a subquery adds a second FROM or a "(select"
  if (/\(\s*select\b/i.test(sql)) return null;
  const froms = sql.match(/\bfrom\b/gi) ?? [];
  if (froms.length !== 1) return null;
  const tail = sql.slice(sql.search(/\bfrom\b/i));
  const m = FROM_TABLE.exec(tail);
  if (!m) return null;
  if (m[2]) {
    // schema-qualified: only the connection's own schema is browsable in the tree
    return ident(m[1]) === schemaUser.toUpperCase() ? ident(m[2]) : null;
  }
  return ident(m[1]);
}
