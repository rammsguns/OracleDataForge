/**
 * Client-side CSV / JSON parsing and column-type inference for the Import Wizard.
 * Pure functions — no React, no network. The parsed table (columns + string rows)
 * is what the backend `/import` endpoint receives.
 */

export interface ParsedTable {
  columns: string[];
  rows: (string | null)[][];
}

/** Robust-enough CSV parser: handles quoted fields with embedded commas, quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // did the current row have any content?
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
    } else if (ch === "\r") {
      /* ignore — handled by the \n branch */
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const cell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** Parse a file's text into a column/row table. `.json` is treated as JSON, everything else as CSV. */
export function parseFile(name: string, text: string): ParsedTable {
  const isJson = /\.json$/i.test(name) || /^\s*[[{]/.test(text);
  if (isJson) return parseJson(text);
  const grid = parseCsv(text).filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
  if (!grid.length) throw new Error("The CSV file is empty.");
  const header = grid[0].map((h, i) => h.trim() || `COLUMN_${i + 1}`);
  const rows = grid.slice(1).map((r) => header.map((_, i) => (i < r.length ? r[i] : null)));
  return { columns: header, rows };
}

function parseJson(text: string): ParsedTable {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  const arr = Array.isArray(data) ? data : Array.isArray((data as { data?: unknown })?.data) ? (data as { data: unknown[] }).data : null;
  if (!arr) throw new Error("JSON import expects an array of objects (optionally under a top-level \"data\" key).");
  if (!arr.length) throw new Error("The JSON array is empty.");
  if (typeof arr[0] !== "object" || arr[0] === null || Array.isArray(arr[0])) throw new Error("JSON import expects an array of objects with named fields.");
  const columns: string[] = [];
  for (const obj of arr as Record<string, unknown>[]) for (const k of Object.keys(obj)) if (!columns.includes(k)) columns.push(k);
  const rows = (arr as Record<string, unknown>[]).map((obj) => columns.map((c) => cell(obj[c])));
  return { columns, rows };
}

/** Sanitize a header into a valid SQL identifier (used for new-table column names). */
export function toIdentifier(name: string, engine: string): string {
  let id = name.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_$#]/g, "");
  if (!id) id = "COL";
  if (/^\d/.test(id)) id = "C_" + id;
  return engine === "oracle" ? id.toUpperCase().slice(0, 128) : id.slice(0, 64);
}

const INT_RE = /^-?\d{1,15}$/;
const NUM_RE = /^-?\d*\.?\d+(e-?\d+)?$/i;

/** Infer an engine-specific column type from a column's sample values. */
export function inferType(values: (string | null)[], engine: string): string {
  const nonNull = values.filter((v): v is string => v != null && v !== "");
  const isInt = nonNull.length > 0 && nonNull.every((v) => INT_RE.test(v));
  const isNum = nonNull.length > 0 && nonNull.every((v) => NUM_RE.test(v));
  let maxLen = 1;
  for (const v of nonNull) if (v.length > maxLen) maxLen = v.length;
  if (engine === "oracle") {
    if (isInt || isNum) return "NUMBER";
    return maxLen > 3000 ? "CLOB" : `VARCHAR2(${Math.min(4000, maxLen + 20)})`;
  }
  if (isInt) return "BIGINT";
  if (isNum) return "DOUBLE";
  return maxLen > 255 ? "TEXT" : `VARCHAR(${Math.min(255, maxLen + 20)})`;
}
