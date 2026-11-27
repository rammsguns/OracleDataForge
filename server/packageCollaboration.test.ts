import assert from 'node:assert/strict';
import test from 'node:test';
import { PackageCollaboration, assertPackageUnchanged } from './packageCollaboration.ts';

test('presence lists all other sessions, including shared accounts, and isolates packages', () => {
  const p = new PackageCollaboration();
  assert.deepEqual(p.heartbeat('db/schema/pkg', 'a', 'alice', 'Alice', false, 'spec', 0, 'alice@example.com'), []);
  p.heartbeat('db/schema/pkg', 'b', 'bob', 'Bob', true, 'body', 1, 'bob@example.com');
  const peers = p.heartbeat('db/schema/pkg', 'c', 'alice', 'Alice', false, 'body', 2);
  assert.deepEqual(peers.map(p => [p.name, p.email, p.editing, p.part]), [['Alice', 'alice@example.com', false, 'spec'], ['Bob', 'bob@example.com', true, 'body']]);
  assert.deepEqual(p.heartbeat('db/other/pkg', 'd', 'd', 'Dan', false, 'spec', 3), []);
  assert.throws(() => p.heartbeat('db/schema/pkg', 'b', 'alice', 'Alice', false, 'spec', 4), /another user/);
  p.leave('db/schema/pkg', 'b', 'alice');
  assert.equal(p.heartbeat('db/schema/pkg', 'a', 'alice', 'Alice', false, 'spec', 5).length, 2);
  p.leave('db/schema/pkg', 'b', 'bob');
  const remaining = p.heartbeat('db/schema/pkg', 'a', 'alice', 'Alice', true, 'body', 6);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].email, null, 'Shared sessions without account email remain identifiable by name');
});

test('closed and disconnected editors expire without blocking later saves', () => {
  const p = new PackageCollaboration(90);
  p.heartbeat('pkg', 'a', 'a', 'Alice', true, 'body', 0);
  assert.equal(p.heartbeat('pkg', 'b', 'b', 'Bob', false, 'spec', 89).length, 1);
  assert.equal(p.heartbeat('pkg', 'b', 'b', 'Bob', false, 'spec', 90).length, 0);
  p.leave('pkg', 'b', 'b');
  assert.deepEqual(p.heartbeat('pkg', 'c', 'c', 'Carol', false, 'spec', 91), []);
});

test('simultaneous saves cannot both pass the original-source check', async () => {
  const p = new PackageCollaboration();
  let database = 'original';
  const release = p.acquire('pkg');
  try {
    assertPackageUnchanged('original', database);
    await Promise.resolve();
    assert.throws(() => p.acquire('pkg'), /in progress/);
    const other = p.acquire('other'); other();
    database = 'Alice changes';
  } finally { release(); }
  const releaseBob = p.acquire('pkg');
  try { assert.throws(() => assertPackageUnchanged('original', database), /Save blocked/); }
  finally { releaseBob(); }
  const retry = p.acquire('pkg');
  assertPackageUnchanged(database, database);
  retry();
});

test('source checks reject changed, missing and unreadable baselines and preserve code differences', () => {
  assertPackageUnchanged(' CREATE\r\nPACKAGE x\r\n ', 'CREATE\nPACKAGE x');
  for (const [expected, actual] of [[null, 'new'], [undefined, 'new'], ['old', null], ['old', 'new'], ['a b', 'a  b']]) {
    assert.throws(() => assertPackageUnchanged(expected, actual as string | null), /Your edits are preserved/);
  }
});
