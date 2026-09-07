import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorksheetSessions } from './worksheetSessions.ts';

class FakeConnection {
  pending = 0;
  committed = 0;
  closed = false;
  async rollback() { this.pending = 0; }
  async commit() { this.committed += this.pending; this.pending = 0; }
  async close() { this.closed = true; await this.rollback(); }
}
test('reuses a private session across queries, commit and rollback', async () => {
  const sessions = new WorksheetSessions<FakeConnection>();
  const connection = new FakeConnection();
  const id = await sessions.create('alice', 'db1', async () => connection);
  await sessions.use(id, 'alice', 'db1', async c => { c.pending += 2; });
  assert.equal(await sessions.use(id, 'alice', 'db1', async c => c.pending), 2);
  assert.equal(connection.closed, false);
  await sessions.use(id, 'alice', 'db1', c => c.rollback());
  assert.equal(connection.pending, 0);
  await sessions.use(id, 'alice', 'db1', async c => { c.pending++; await c.commit(); }, true);
  assert.equal(connection.committed, 1);
  assert.equal(connection.closed, true);
  await assert.rejects(sessions.use(id, 'alice', 'db1', async () => {}), /unavailable or expired/);
});
test('rejects other users, other connections and unknown sessions', async () => {
  const sessions = new WorksheetSessions<FakeConnection>();
  const id = await sessions.create('alice', 'db1', async () => new FakeConnection());
  for (const [token, owner, db] of [[id, 'bob', 'db1'], [id, 'alice', 'db2'], ['lost', 'alice', 'db1']]) {
    await assert.rejects(sessions.use(token, owner, db, async () => assert.fail('must not run')), /unavailable or expired/);
  }
});
test('failed statements preserve the session and previous uncommitted work', async () => {
  const sessions = new WorksheetSessions<FakeConnection>();
  const c = new FakeConnection(); c.pending = 4;
  const id = await sessions.create('a', 'db', async () => c);
  await assert.rejects(sessions.use(id, 'a', 'db', async () => { throw new Error('SQL error'); }, true));
  assert.equal(await sessions.use(id, 'a', 'db', async conn => conn.pending), 4);
  assert.equal(c.closed, false);
});
test('rejects concurrent work and disconnects while a statement is running', async () => {
  const sessions = new WorksheetSessions<FakeConnection>();
  const id = await sessions.create('a', 'db', async () => new FakeConnection());
  let release!: () => void;
  const running = sessions.use(id, 'a', 'db', () => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(sessions.use(id, 'a', 'db', async () => {}), /busy/);
  await assert.rejects(sessions.closeDatabase('db'), /executing/);
  await sessions.expire(Date.now() + 31 * 60_000);
  release(); await running;
  await sessions.use(id, 'a', 'db', async () => {});
});
test('expiration and disconnect roll back without committing', async () => {
  const sessions = new WorksheetSessions<FakeConnection>();
  const a = new FakeConnection(), b = new FakeConnection(); a.pending = b.pending = 3;
  const id = await sessions.create('a', 'db1', async () => a);
  await sessions.create('b', 'db2', async () => b);
  await sessions.closeDatabase('db1');
  assert.equal(a.pending, 0); assert.equal(a.closed, true); assert.equal(b.closed, false);
  await sessions.expire(Date.now() + 31 * 60_000);
  assert.equal(b.pending, 0); assert.equal(b.closed, true);
  assert.equal(a.committed + b.committed, 0);
  await assert.rejects(sessions.use(id, 'a', 'db1', async () => {}), /unavailable or expired/);
});
