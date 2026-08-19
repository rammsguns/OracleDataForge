/**
 * Per-tab persistence for the Table Designer. Workspace tabs unmount when
 * inactive, so the working model + the loaded snapshot live in a module-level
 * map keyed by connection + table (mirrors editBuffers.ts for the PL/SQL editor).
 */
import type { DesignModel } from "./tableDdl";

export interface TableBuffer {
  /** the table as loaded from the DB — the diff baseline */
  original: DesignModel;
  /** the current edited model */
  model: DesignModel;
}

const buffers = new Map<string, TableBuffer>();

export const tableKey = (connId: string, table: string) => `${connId}.${table}`;

export const getTableBuffer = (key: string): TableBuffer | undefined => buffers.get(key);
export const setTableBuffer = (key: string, b: TableBuffer): void => void buffers.set(key, b);

/** Drop any buffered edits for a table (called when its tab is closed with "Discard"). */
export function discardTableBuffer(table: string): void {
  for (const key of [...buffers.keys()]) if (key.endsWith(`.${table}`)) buffers.delete(key);
}
