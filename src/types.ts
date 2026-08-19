export type Engine = "oracle";

export interface Connection {
  id: string;
  name: string;
  engine: Engine;
  host: string;
  port: number;
  user: string;
  status: "connected" | "idle" | "error";
  color: string;
  /** true = real database reached through the local backend (passwords stay server-side) */
  live?: boolean;
  database?: string;
  /** only read statements allowed (enforced by the backend for live connections) */
  readOnly?: boolean;
}

export type ObjectKind =
  | "table"
  | "view"
  | "procedure"
  | "function"
  | "package"
  | "trigger"
  | "sequence"
  | "user";

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  pk?: boolean;
  fk?: string; // "TABLE.COLUMN"
  default?: string;
  comment?: string;
}

export interface TableDef {
  name: string;
  kind: ObjectKind;
  columns: ColumnDef[];
  rowCount: number;
  comment?: string;
  ddl?: string;
}

export type CellValue = string | number | null;

export interface ResultSet {
  columns: string[];
  rows: CellValue[][];
  durationMs: number;
  rowsReturned: number;
  error?: { message: string; line: number; code: string; helpUrl?: string } | null;
  statement: string;
  /** the server capped the rows it sent back — the grid labels it permanently */
  truncated?: boolean;
}


export interface HistoryEntry {
  id: string;
  sql: string;
  ranAt: string;
  durationMs: number;
  rows: number;
  status: "ok" | "error";
  favorite: boolean;
  tags: string[];
}

export interface Snippet {
  id: string;
  name: string;
  sql: string;
  description: string;
}

export type TabKind =
  | "worksheet"
  | "data"
  | "object"
  | "run"
  | "tabledesign"
  | "erd"
  | "history"
  | "perf"
  | "migration"
  | "dba"
  | "deps"
  | "versions"
  | "compile";

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  payload?: string; // e.g. table name for data/object tabs
  dirty?: boolean;
}

export interface Toast {
  id: number;
  kind: "success" | "error" | "warning" | "info";
  text: string;
}

export interface MenuItem {
  label?: string;
  icon?: string;
  danger?: boolean;
  divider?: boolean;
  action?: () => void;
}
