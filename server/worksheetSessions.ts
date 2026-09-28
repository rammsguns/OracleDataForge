import { randomUUID } from 'node:crypto';

interface SessionConnection { rollback(): Promise<void>; close(): Promise<void> }
export class WorksheetSessions<C extends SessionConnection> {
  private sessions = new Map<string, { owner: string; database: string; connection: C; busy: boolean; touched: number }>();
  async create(owner: string, database: string, connect: () => Promise<C>) {
    if (this.sessions.size >= 32) throw new Error('Too many manual worksheet sessions. Commit and turn auto-commit on in unused worksheets.');
    // Reserve before awaiting so simultaneous requests cannot exceed the limit.
    const id = randomUUID();
    const entry = { owner, database, connection: undefined as unknown as C, busy: true, touched: Date.now() };
    this.sessions.set(id, entry);
    try { entry.connection = await connect(); entry.busy = false; return id; }
    catch (error) { this.sessions.delete(id); throw error; }
  }
  async use<T>(id: string, owner: string, database: string, work: (connection: C) => Promise<T>, close = false): Promise<T> {
    const entry = this.sessions.get(id);
    if (!entry || entry.owner !== owner || entry.database !== database) throw Object.assign(new Error('Manual transaction session is unavailable or expired. Uncommitted work may have been rolled back. Turn auto-commit on, then off to start a new session.'), { code: 'TRANSACTION-EXPIRED' });
    if (entry.busy) throw new Error('This worksheet session is busy. Wait for its current operation.');
    entry.busy = true;
    try {
      const result = await work(entry.connection);
      if (close) {
        this.sessions.delete(id);
        // The transaction action already succeeded. A cleanup error must not suggest rerunning it.
        try { await entry.connection.close(); } catch { console.error('Worksheet transaction completed, but session cleanup failed.'); }
      }
      return result;
    } finally { entry.busy = false; entry.touched = Date.now(); }
  }
  async closeDatabase(database: string) {
    const entries = [...this.sessions].filter(([, e]) => e.database === database);
    if (entries.some(([, e]) => e.busy)) throw new Error('A worksheet is executing. Wait before disconnecting.');
    for (const [id] of entries) this.sessions.delete(id);
    const results = await Promise.allSettled(entries.map(async ([, entry]) => {
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
