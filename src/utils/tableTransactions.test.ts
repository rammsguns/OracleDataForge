import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api';

test('table refresh and every row mutation carry the private transaction token', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('{"manualTransaction":true}', { status: 200 });
  };
  try {
    await api.tableRows('live1', 'CUSTOMERS', 'manual-session');
    assert.equal(calls[0].options?.method, 'GET');
    assert.equal(new Headers(calls[0].options?.headers).get('X-Dataforge-Transaction'), 'manual-session');
    assert.ok(!calls[0].url.includes('manual-session'), 'session tokens must not enter URLs or access logs');
    for (const action of ['insert', 'update', 'delete'] as const) {
      await api.changeTableRow('live1', { table: 'CUSTOMERS', action, rowId: 'row1', values: { NAME: 'test' } }, true, 'manual-session');
      const body = JSON.parse(String(calls.at(-1)?.options?.body));
      assert.equal(body.transactionId, 'manual-session');
      assert.equal(body.action, action);
      assert.equal(body.confirm, true);
    }
    await api.tableRows('live1', 'CUSTOMERS');
    assert.equal(calls.at(-1)?.options, undefined);
  } finally { globalThis.fetch = original; }
});

test('an expired table session fails without retrying in auto-commit mode', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: 'Session expired' }), { status: 400 }); };
  try {
    await assert.rejects(api.changeTableRow('live1', { table: 'CUSTOMERS', action: 'delete', rowId: 'row1' }, true, 'expired'), /Session expired/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('manual table reads reject a legacy API without transaction support', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    await assert.rejects(api.tableRows('live1', 'CUSTOMERS', 'session'), /API needs a restart/);
  } finally { globalThis.fetch = original; }
});
