import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
const browser = new Window({ url: 'http://localhost' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'ResizeObserver'] as const) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? browser : browser[name], configurable: true });
}
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: browser.requestAnimationFrame.bind(browser), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: browser.cancelAnimationFrame.bind(browser), configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const { createRoot } = await import('react-dom/client');
const { StudioSnapshot, useStudio } = await import('../state/store');
const { default: ObjectEditor } = await import('./ObjectEditor');
const { api } = await import('../utils/api');
const { editKey, setEdits, getEdits } = await import('../utils/editBuffers');
after(async () => { await browser.happyDOM.close(); });

test('package presence names viewers/editors; blocked saves retain edits and original baseline', async t => {
  const original = 'CREATE OR REPLACE PACKAGE TEST_PKG AS END;';
  const mine = 'CREATE OR REPLACE PACKAGE TEST_PKG AS -- my edits\nEND;';
  const newer = 'CREATE OR REPLACE PACKAGE TEST_PKG AS -- newer database code\nEND;';
  const key = editKey('test', 'TEST_PKG');
  setEdits(key, { spec: mine, body: '', part: 'spec', original: { spec: original, body: '' }, baseline: { spec: original, body: '' } });
  t.mock.method(api, 'source', async () => ({ name: 'TEST_PKG', type: 'PACKAGE', source: newer }));
  t.mock.method(api, 'packagePresence', async () => ({ peers: [
    { id: 'alice', name: 'Alice', editing: false, part: 'spec' },
    { id: 'bob', name: 'Bob', editing: true, part: 'body' },
  ] }));
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  let saveCalls = 0;
  t.mock.method(api, 'packageQuery', async (_id: string, sql: string, _name: string, _type: string, expected: string | null) => {
    saveCalls++; assert.equal(sql, mine); assert.equal(expected, original);
    return { error: { code: 'SOURCE-CONFLICT', message: 'This package changed. Your edits are preserved.', line: 1 } } as never;
  });
  const compiled = t.mock.method(api, 'compile', async () => { throw Error('Must not compile a blocked save'); });
  let confirm: (() => void) | undefined;
  const studio = { activeConnId: 'test', accessRole: 'Developer', connections: [{ id: 'test', name: 'Test', live: true, readOnly: false }], setTabDirty: () => {}, toast: () => {}, askConfirm: (dialog: { onConfirm: () => void }) => { confirm = dialog.onConfirm; } } as unknown as ReturnType<typeof useStudio>;
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(<StudioSnapshot value={studio}><ObjectEditor object="TEST_PKG" tabId="test-tab" /></StudioSnapshot>); });
  assert.match(host.textContent!, /Alice.*viewing.*Bob.*editing \(unsaved changes\).*body/);
  const editor = host.querySelector('textarea')!;
  assert.equal(editor.value, mine);
  const button = host.querySelector('button[title^="Save & compile"]')!;
  assert.ok(button);
  await act(async () => { (button as unknown as HTMLButtonElement).click(); });
  assert.ok(confirm);
  await act(async () => { confirm!(); });
  assert.equal(saveCalls, 1);
  assert.equal(compiled.mock.callCount(), 0);
  assert.equal(editor.value, mine);
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /Download my edits/);
  assert.equal(getEdits(key)?.baseline?.spec, original);
});
