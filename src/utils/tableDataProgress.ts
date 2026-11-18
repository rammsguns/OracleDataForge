/** Events emitted by copyTableRows while it runs. */
export type CopyProgressEvent =
  | { kind: 'table'; name: string }
  | { kind: 'rows'; name: string; rows: number }
  | { kind: 'deferred'; name: string; rows: number }
  | { kind: 'retry'; rows: number }
  | { kind: 'committed'; name: string; rows: number }
  | { kind: 'finishing' };

export type TableProgressStatus = 'waiting' | 'truncating' | 'truncated' | 'copying' | 'committed' | 'rolled back';
export interface TableProgress {
  name: string;
  /** Rows expected from the source (after any per-table row limit). */
  planned: number;
  /** Rows inserted so far, committed or not. */
  copied: number;
  committed: number;
  status: TableProgressStatus;
  startedAt?: number;
  finishedAt?: number;
}
export interface CopyLogEntry { at: number; level: 'info' | 'warn' | 'error'; message: string }
export interface CopyProgress {
  state: 'running' | 'succeeded' | 'failed';
  sourceSchema: string;
  targetSchema: string;
  startedAt: number;
  /** Last time anything happened; lets the page show the copy is still alive. */
  updatedAt: number;
  finishedAt?: number;
  current?: string;
  plannedRows: number;
  copiedRows: number;
  tables: TableProgress[];
  log: CopyLogEntry[];
  error?: string;
}

const MAX_LOG = 3000;
/** Log a running row count for long tables at this interval. */
export const PROGRESS_LOG_EVERY = 10000;
const fmt = (n: number) => n.toLocaleString('en-US');
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function createCopyProgress(input: { sourceSchema: string; targetSchema: string; tables: { name: string; planned: number }[] }, now: () => number = Date.now) {
  const startedAt = now();
  const progress: CopyProgress = {
    state: 'running', sourceSchema: input.sourceSchema, targetSchema: input.targetSchema, startedAt, updatedAt: startedAt,
    plannedRows: input.tables.reduce((n, t) => n + t.planned, 0), copiedRows: 0,
    tables: input.tables.map(t => ({ name: t.name, planned: t.planned, copied: 0, committed: 0, status: 'waiting' })),
    log: [],
  };
  const byName = new Map(progress.tables.map(t => [t.name, t]));
  const log = (message: string, level: CopyLogEntry['level'] = 'info') => {
    progress.updatedAt = now();
    progress.log.push({ at: progress.updatedAt, level, message });
    if (progress.log.length > MAX_LOG) progress.log.splice(0, progress.log.length - MAX_LOG);
  };
  const position = (name: string) => `${progress.tables.findIndex(t => t.name === name) + 1}/${progress.tables.length}`;
  const event = (e: CopyProgressEvent) => {
    progress.updatedAt = now();
    switch (e.kind) {
      case 'table': {
        const t = byName.get(e.name);
        progress.current = e.name;
        if (t) { t.status = 'copying'; t.startedAt = progress.updatedAt; }
        log(`[${position(e.name)}] Copying ${e.name} (${fmt(t?.planned ?? 0)} rows)…`);
        break;
      }
      case 'rows': {
        const t = byName.get(e.name);
        progress.copiedRows += e.rows;
        if (!t) break;
        const before = t.copied;
        t.copied += e.rows;
        if (t.planned > PROGRESS_LOG_EVERY && Math.floor(t.copied / PROGRESS_LOG_EVERY) > Math.floor(before / PROGRESS_LOG_EVERY)) {
          log(`${e.name}: ${fmt(t.copied)} / ${fmt(t.planned)} rows`);
        }
        break;
      }
      case 'deferred':
        log(`${e.name}: ${fmt(e.rows)} row(s) wait for parent keys and will be retried.`, 'warn');
        break;
      case 'retry':
        log(`Retrying ${fmt(e.rows)} row(s) waiting for parent keys…`);
        break;
      case 'committed': {
        const t = byName.get(e.name);
        if (!t) break;
        const first = t.status !== 'committed';
        t.committed = e.rows; t.copied = e.rows; t.status = 'committed'; t.finishedAt = progress.updatedAt;
        if (first) log(`${e.name} committed: ${fmt(e.rows)} rows${t.startedAt !== undefined ? ` in ${seconds(t.finishedAt - t.startedAt)}` : ''}.`);
        else log(`${e.name}: retried rows committed (${fmt(e.rows)} rows in total).`);
        break;
      }
      case 'finishing':
        progress.current = undefined;
        log('Synchronizing identity sequences…');
        break;
    }
  };
  const truncating = (names: string[]) => {
    for (const name of names) { const t = byName.get(name); if (t) t.status = 'truncating'; }
    log(`Truncating ${names.length} table(s): ${names.join(', ')}…`, 'warn');
  };
  const truncated = (names: string[]) => {
    for (const name of names) { const t = byName.get(name); if (t?.status === 'truncating') t.status = 'truncated'; }
    log(`Truncated ${names.length} table(s).`);
  };
  const finish = (error?: string) => {
    progress.finishedAt = now();
    progress.current = undefined;
    if (error) {
      // Uncommitted rows were rolled back; only committed rows remain in the target.
      for (const t of progress.tables) {
        if (t.status === 'copying') t.status = 'rolled back';
        else if (t.status === 'truncating') t.status = 'waiting';
        t.copied = t.committed;
      }
      progress.copiedRows = progress.tables.reduce((n, t) => n + t.committed, 0);
      progress.state = 'failed';
      progress.error = error;
      log(`Copy failed after ${seconds(progress.finishedAt - startedAt)}: ${error}`, 'error');
    } else {
      progress.state = 'succeeded';
      log(`Copy finished: ${fmt(progress.copiedRows)} rows in ${progress.tables.filter(t => t.status === 'committed').length} table(s), ${seconds(progress.finishedAt - startedAt)}.`);
    }
  };
  return { progress, event, log, truncating, truncated, finish };
}
