/**
 * Per-tab persistence for the Data Browser preview. Workspace tabs unmount when inactive,
 * so the loaded rows live in a module-level map keyed by connection + table; returning to
 * the tab restores them instead of re-running the query. Reload/row-limit changes bump
 * `reloads`, which no longer matches the cached entry and so forces a fresh fetch.
 */
import type { LiveQueryResult, TableRowsResult } from "./api";

export interface DataPreviewCache {
  data: LiveQueryResult;
  rowLimit: number;
  rowLimitInput: string;
  reloads: number;
}

const cache = new Map<string, DataPreviewCache>();

export const dataPreviewKey = (connId: string, table: string) => `${connId}.${table}`;
export const getDataPreview = (key: string): DataPreviewCache | undefined => cache.get(key);
export const setDataPreview = (key: string, v: DataPreviewCache): void => void cache.set(key, v);

/** Drop cached rows for a table (called when its data tab is closed). */
export function discardDataPreview(table: string): void {
  for (const m of [cache, modes, editors]) for (const key of [...m.keys()]) if (key.endsWith(`.${table}`)) m.delete(key);
}

/** Data Browser mode (read-only preview vs. row editor) per connection + table. */
const modes = new Map<string, "view" | "edit">();
export const getDataMode = (key: string) => modes.get(key) ?? "view";
export const setDataMode = (key: string, m: "view" | "edit"): void => void modes.set(key, m);

/** Row editor state, so rows, sort, filter, page and unsaved drafts survive a tab switch. */
export interface RowEditorCache {
  data: TableRowsResult;
  /** the schema refresh counter the rows were read at; a newer one means re-read */
  bump: number;
  filter: string;
  columnSearch: string;
  sort: { col: number; dir: 1 | -1 } | null;
  page: number;
  editing: { rowId: string; draft: Record<string, string> } | null;
  adding: Record<string, string> | null;
}
const editors = new Map<string, RowEditorCache>();
export const getRowEditor = (key: string): RowEditorCache | undefined => editors.get(key);
export const setRowEditor = (key: string, v: RowEditorCache): void => void editors.set(key, v);
export const clearRowEditor = (key: string): void => void editors.delete(key);
