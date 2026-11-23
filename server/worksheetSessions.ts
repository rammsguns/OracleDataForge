import { randomUUID } from 'node:crypto';

interface SessionConnection { rollback(): Promise<void>; close(): Promise<void>; break?(): Promise<void> }
type Entry<C> = { owner: string; database: string; connection: C; busy: boolean; touched: number; running?: Promise<unknown> };

/** How long a cancelled statement gets to stop before the disconnect gives up on it. */
export const CANCEL_WAIT_MS = 15_000;
const settle = (p: Promise<unknown> | undefined) => (p ?? Promise.resolve()).then(() => undefined, () => undefined);
const within = (p: Promise<unknown>, ms: number) =>
  new Promise<boolean>((resolve) => { const t = setTimeout(() => resolve(false), ms); void p.then(() => { clearTimeout(t); resolve(true); }); });

export class WorksheetSessions<C extends SessionConnection> {
  private sessions = new Map<string, Entry<C>>();
  constructor(private cancelWaitMs = CANCEL_WAIT_MS) {}
  async create(owner: string, database: string, connect: () => Promise<C>) {
    if (this.sessions.size >= 32) throw new Error('Too many manual worksheet sessions. Commit and turn auto-commit on in unused worksheets.');
    // Reserve before awaiting so simultaneous requests cannot exceed the limit.
    const id = randomUUID();
    const entry: Entry<C> = { owner, database, connection: undefined as unknown as C, busy: true, touched: Date.now() };
    this.sessions.set(id, entry);
    const opening = connect();
    entry.running = opening;
    try { entry.connection = await opening; }
    catch (error) { this.sessions.delete(id); throw error; }
    if (this.sessions.get(id) !== entry) {
      // Disconnected while the session was opening: don't leak the new connection.
      try { await entry.connection.close(); } catch { /* already gone */ }
      throw new Error('The connection was closed while the worksheet session was opening. Run the statement again.');
    }
    entry.busy = false;
    return id;
  }
  async use<T>(id: string, owner: string, database: string, work: (connection: C) => Promise<T>, close = false): Promise<T> {
    const entry = this.sessions.get(id);
    if (!entry || entry.owner !== owner || entry.database !== database) throw Object.assign(new Error('Manual transaction session is unavailable or expired. Uncommitted work may have been rolled back. Turn auto-commit on, then off to start a new session.'), { code: 'TRANSACTION-EXPIRED' });
    if (entry.busy) throw new Error('This worksheet session is busy. Wait for its current operation.');
    entry.busy = true;
    const running = work(entry.connection);
    entry.running = running;
    try {
      const result = await running;
      if (close) {
        this.sessions.delete(id);
        // The transaction action already succeeded. A cleanup error must not suggest rerunning it.
        try { await entry.connection.close(); } catch { console.error('Worksheet transaction completed, but session cleanup failed.'); }
      }
      return result;
    } finally { entry.busy = false; entry.touched = Date.now(); }
  }
  /**
   * Ends every worksheet session on a database, rolling back uncommitted work. A statement
   * still executing (e.g. a long SELECT whose tab was closed) is cancelled with break() first,
   * so a reconnect is never blocked by work nobody is waiting for any more.
   */
  async closeDatabase(database: string) {
    const entries = [...this.sessions].filter(([, e]) => e.database === database);
    for (const [id] of entries) this.sessions.delete(id);
    const results = await Promise.allSettled(entries.map(async ([, entry]) => {
      if (entry.busy) {
        if (entry.connection?.break) { try { await entry.connection.break(); } catch { /* finished meanwhile */ } }
        if (!(await within(settle(entry.running), this.cancelWaitMs))) {
          // Still running: release the connection whenever it does stop, but report the unknown outcome now.
          void settle(entry.running).then(async () => { try { await entry.connection.rollback(); } catch { /* lost */ } try { await entry.connection.close(); } catch { /* closed */ } });
          throw new Error('statement did not stop');
        }
      }
      if (!entry.connection) return; // the session never finished opening
      try { await entry.connection.rollback(); } finally { await entry.connection.close(); }
    }));
    if (results.some(result => result.status === 'rejected')) throw new Error('Some worksheet sessions could not be closed. Their transaction outcome is unknown.');
    return entries.length > 0;
  }
  async expire(now = Date.now()) {
    for (const [id, entry] of this.sessions) {
      if (entry.busy || now - entry.touched < 30 * 60 * 1000) continue;
      this.sessions.delete(id);
      try { await entry.connection.rollback(); } catch { /* already lost */ }
      try { await entry.connection.close(); } catch { /* already closed */ }
    }
  }
}
