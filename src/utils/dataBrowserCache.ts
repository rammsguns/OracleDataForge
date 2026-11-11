/**
 * Per-tab persistence for the Data Browser preview. Workspace tabs unmount when inactive,
 * so the loaded rows live in a module-level map keyed by connection + table; returning to
 * the tab restores them instead of re-running the query. Reload/row-limit changes bump
 * `reloads`, which no longer matches the cached entry and so forces a fresh fetch.
 */
import type { LiveQueryResult } from "./api";

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
  for (const key of [...cache.keys()]) if (key.endsWith(`.${table}`)) cache.delete(key);
}
