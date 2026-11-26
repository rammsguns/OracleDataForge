import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { PackageInstallRequest } from "../utils/packageInstall";
import type { SchemaCompareRequest } from "../utils/schemaCompare";
import type { Connection } from "../types";

const browser = new Window({ url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "localStorage"] as const) {
  Object.defineProperty(globalThis, name, { value: name === "window" ? browser : browser[name], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const { createRoot } = await import("react-dom/client");
const { StudioSnapshot, useStudio } = await import("../state/store");
const { default: SchemaCompare } = await import("./SchemaCompare");
const { default: PackageInstall } = await import("./PackageInstall");
const { default: PackageInstallLog } = await import("./PackageInstallLog");
const { default: ConnectionPicker } = await import("./ConnectionPicker");
const { api } = await import("../utils/api");
const { compareObjectKey } = await import("../utils/schemaCompare");
after(async () => { await browser.happyDOM.close(); });
const tablespacesKey = 'dataforge-schema-compare-tablespaces';
beforeEach(() => { localStorage.removeItem(tablespacesKey); });

async function chooseObjectTypes(host: ReturnType<typeof browser.document.createElement>) {
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
    assert.ok(button, label); await act(async () => button.click());
  };
  await click('Load object types');
  await click('All types');
}

test('object names are loaded only after explicit type selection, and changing types invalidates the loaded list', async t => {
  const table = {name: 'CATALOG_STATUS', type: 'TABLE'}, view = {name: 'VW_STATUS', type: 'VIEW'};
  const typeCalls = t.mock.method(api, 'compareCatalogTypes', async (id: string, _schema: string) => ({schema: id.toUpperCase(), types: id === 'dev' ? ['PACKAGE', 'TABLE'] : ['TABLE', 'VIEW']}));
  const catalog = t.mock.method(api, 'compareCatalog', async (id: string, _schema: string, types: string[]) => ({schema: id.toUpperCase(), objects: [table, view].filter(o => types.includes(o.type)), types}));
  const state = {connections: [
    {id: 'dev', name: 'DEV', user: 'DEV', engine: 'oracle', live: true, status: 'connected'},
    {id: 'prod', name: 'PROD', user: 'PROD', engine: 'oracle', live: true, status: 'connected'},
  ]} as unknown as ReturnType<typeof useStudio>;
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<StudioSnapshot value={state}><SchemaCompare /></StudioSnapshot>));
  const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!;
  const click = async (label: string) => act(async () => button(label).click());
  const toggleType = async (type: string) => act(async () => (host.querySelector(`[aria-label="Load object type ${type}"]`) as unknown as HTMLInputElement).click());
  assert.equal(catalog.mock.calls.length, 0); assert.equal(typeCalls.mock.calls.length, 0);
  assert.equal(button('Load objects').disabled, true);
  await click('Object comparison'); await click('Load object types');
  assert.equal(typeCalls.mock.calls.length, 2); assert.equal(catalog.mock.calls.length, 0);
  assert.ok(host.querySelector('[aria-label="Load object type VIEW"]')); // Target-only types are offered too.
  assert.ok([...host.querySelectorAll('[aria-label^="Load object type "]')].every(e => !(e as unknown as HTMLInputElement).checked));
  assert.equal(button('Load objects').disabled, true);
  await toggleType('TABLE');
  assert.equal(catalog.mock.calls.length, 0); assert.equal(button('Load objects').disabled, false);
  await click('Load objects');
  assert.deepEqual(catalog.mock.calls.map(c => c.arguments[2]), [['TABLE'], ['TABLE']]);
  assert.ok(host.querySelector('[aria-label="Select TABLE CATALOG_STATUS"]'));
  assert.equal(host.querySelector('[aria-label="Select VIEW VW_STATUS"]'), null);
  await toggleType('VIEW');
  assert.equal(host.querySelector('[aria-label="Select TABLE CATALOG_STATUS"]'), null);
  assert.equal(catalog.mock.calls.length, 2); // A type change does not fetch automatically.
  await click('Load objects');
  assert.deepEqual(catalog.mock.calls.at(-1)?.arguments[2], ['TABLE', 'VIEW']);
  assert.ok(host.querySelector('[aria-label="Select VIEW VW_STATUS"]'));
  await click('Clear types');
  assert.equal(button('Load objects').disabled, true);
  assert.equal(host.querySelector('[aria-label="Select VIEW VW_STATUS"]'), null);
  await click('Package install with dependencies');
  assert.deepEqual([...host.querySelectorAll('[aria-label^="Load object type "]')].map(e => e.getAttribute('aria-label')), ['Load object type PACKAGE']);
  assert.equal(catalog.mock.calls.length, 4);
});

test('type-discovery errors leave object loading disabled and can be retried', async t => {
  let fail = true;
  t.mock.method(api, 'compareCatalogTypes', async () => {if (fail) throw new Error('ORA-01031: type discovery denied'); return {schema: 'APP', types: []};});
  const catalog = t.mock.method(api, 'compareCatalog', async () => ({schema: 'APP', types: [], objects: []}));
  const state = {connections: [
    {id: 'dev', name: 'DEV', user: 'DEV', engine: 'oracle', live: true, status: 'connected'},
    {id: 'prod', name: 'PROD', user: 'PROD', engine: 'oracle', live: true, status: 'connected'},
  ]} as unknown as ReturnType<typeof useStudio>;
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<StudioSnapshot value={state}><SchemaCompare /></StudioSnapshot>));
  const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!;
  await act(async () => button('Load object types').click());
  assert.match(host.textContent!, /ORA-01031/); assert.equal(button('Load objects').disabled, true);
  fail = false;
  await act(async () => button('Load object types').click());
  assert.ok(!host.textContent!.includes('ORA-01031'));
  assert.match(host.textContent!, /No package types are visible/);
  assert.equal(button('Load objects').disabled, true); assert.equal(catalog.mock.calls.length, 0);
});

test('package workflow is first before loading, and remembered tablespaces survive reopening and apply to both workflows', async t => {
  const pkg = {name: 'PKG', type: 'PACKAGE'};
  t.mock.method(api, 'compareCatalogTypes', async () => ({schema: 'APP', types: ['PACKAGE']}));
  const catalog = t.mock.method(api, 'compareCatalog', async () => ({schema: 'APP', objects: [pkg], types: ['PACKAGE']}));
  const install = t.mock.method(api, 'packageInstall', async (_id: string, _input: PackageInstallRequest) => ({sourceName: 'DEV', targetName: 'PROD', sourceSchema: 'APP', targetSchema: 'APP', comparedAt: 'now', roots: ['PKG'], objects: [], dependencies: [], suggestions: [], warnings: [], exports: [], script: ''}));
  const compare = t.mock.method(api, 'schemaCompare', async (_id: string, _input: SchemaCompareRequest) => ({sourceName: 'DEV', targetName: 'PROD', sourceSchema: 'APP', targetSchema: 'APP', comparedAt: 'now', objects: []}));
  const state = {connections: [
    {id: 'dev', name: 'DEV', user: 'DEV', engine: 'oracle', live: true, status: 'connected'},
    {id: 'prod', name: 'PROD', user: 'PROD', engine: 'oracle', live: true, status: 'connected'},
  ]} as unknown as ReturnType<typeof useStudio>;
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  let root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = async () => act(async () => root.render(<StudioSnapshot value={state}><SchemaCompare /></StudioSnapshot>));
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
    assert.ok(button, label); await act(async () => button.click());
  };
  const value = (label: string) => (host.querySelector(`input[aria-label="${label}"]`) as unknown as HTMLInputElement).value;
  const setText = async (label: string, text: string) => {
    const input = host.querySelector(`input[aria-label="${label}"]`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new browser.Event('input', {bubbles: true})); });
  };
  localStorage.setItem(tablespacesKey, JSON.stringify({tableTablespace: 'OLD_DATA', indexTablespace: 'OLD_IDX'}));
  await render();
  const buttons = [...host.querySelectorAll('button')];
  const modes = [...host.querySelectorAll('[aria-label="Deployment workflow"] button')];
  assert.deepEqual(modes.map(b => b.textContent), ['Package install with dependencies', 'Object comparison']);
  assert.equal(modes[0].getAttribute('aria-pressed'), 'true');
  assert.ok(buttons.indexOf(modes[0] as typeof buttons[number]) < buttons.findIndex(b => b.textContent === 'Load objects'));
  assert.equal(catalog.mock.calls.length, 0);
  assert.equal(value('Table tablespace'), 'OLD_DATA');
  assert.equal(value('Index tablespace'), 'OLD_IDX');
  await setText('Table tablespace', '"Deploy Data"');
  await setText('Index tablespace', 'NEXT_IDX');
  await act(async () => root.unmount()); root = createRoot(host as unknown as HTMLElement); await render();
  assert.equal(value('Table tablespace'), '"Deploy Data"');
  assert.equal(value('Index tablespace'), 'NEXT_IDX');
  await chooseObjectTypes(host);
  await click('Load objects');
  assert.ok(host.querySelector('[aria-label="Install package PKG"]'));
  assert.equal(host.querySelector('[aria-label="Select PACKAGE PKG"]'), null);
  await act(async () => (host.querySelector('[aria-label="Install package PKG"]') as unknown as HTMLInputElement).click());
  await click('Analyze package dependencies (1)');
  assert.equal(install.mock.calls[0].arguments[1].tableTablespace, '"Deploy Data"');
  assert.equal(install.mock.calls[0].arguments[1].indexTablespace, 'NEXT_IDX');
  await click('Object comparison');
  assert.equal(host.querySelector('[aria-label="Select PACKAGE PKG"]'), null);
  await chooseObjectTypes(host); await click('Load objects');
  assert.ok(host.querySelector('[aria-label="Select PACKAGE PKG"]'));
  assert.equal(catalog.mock.calls.length, 4);
  await click('Compare selected');
  assert.equal(compare.mock.calls[0].arguments[1].tableTablespace, '"Deploy Data"');
  assert.equal(compare.mock.calls[0].arguments[1].indexTablespace, 'NEXT_IDX');
  await setText('Table tablespace', ''); await setText('Index tablespace', '');
  await act(async () => root.unmount()); root = createRoot(host as unknown as HTMLElement); await render();
  assert.equal(value('Table tablespace'), '');
  assert.equal(value('Index tablespace'), '');
});

test('invalid remembered tablespaces are ignored while valid string fields are retained', async t => {
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const state = {connections: []} as unknown as ReturnType<typeof useStudio>;
  for (const [i, raw] of ['invalid json', 'null', '[]', '{"tableTablespace":42,"indexTablespace":{}}', '{"tableTablespace":false,"indexTablespace":"VALID_IDX"}'].entries()) {
    localStorage.setItem(tablespacesKey, raw);
    await act(async () => root.render(<StudioSnapshot value={state}><SchemaCompare key={i} /></StudioSnapshot>));
    assert.equal((host.querySelector('[aria-label="Table tablespace"]') as unknown as HTMLInputElement).value, '');
    assert.equal((host.querySelector('[aria-label="Index tablespace"]') as unknown as HTMLInputElement).value, i === 4 ? 'VALID_IDX' : '');
  }
});

test('tablespace editing still works when browser storage is unavailable', async t => {
  t.mock.method(localStorage, 'getItem', () => { throw new Error('Storage blocked'); });
  const save = t.mock.method(localStorage, 'setItem', () => { throw new Error('Storage full'); });
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const state = {connections: []} as unknown as ReturnType<typeof useStudio>;
  await act(async () => root.render(<StudioSnapshot value={state}><SchemaCompare /></StudioSnapshot>));
  const input = host.querySelector('[aria-label="Table tablespace"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, 'SESSION_DATA'); input.dispatchEvent(new browser.Event('input', {bubbles: true})); });
  assert.equal((input as unknown as HTMLInputElement).value, 'SESSION_DATA');
  assert.equal(save.mock.calls.length, 1);
});

test('deployment log labels severities, counts errors separately and filters while preserving diagnostics', async t => {
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<PackageInstallLog entries={[
    {severity: 'info', table: 'RECIPIENTS', message: 'Identity IDs preserved for RECIPIENT_ID.'},
    {severity: 'warning', table: 'RECIPIENTS', message: 'Explicit COMMIT; use a maintenance window.'},
    {severity: 'error', table: 'EMAIL_MESSAGES', message: 'Unsupported column', elapsedMs: 1250, details: {table: 'EMAIL_MESSAGES', sourceSchema: 'DEV', targetSchema: 'PROD', stage: 'describe source columns', row: 2, code: 'SEED_EXPORT_FAILED', columns: [{name: 'PAYLOAD', type: 'XMLTYPE', reason: 'Unsupported seed data type'}], advice: 'Use a dedicated export.'}},
  ]} />));
  assert.match(host.querySelector('[aria-label="Log severity counts"]')!.textContent!, /INFO: 1 · WARNING: 1 · ERROR: 1/);
  assert.match(host.textContent!, /Blocked: resolve errors/);
  assert.match(host.querySelector('[data-severity="info"]')!.textContent!, /\[INFO\].*Identity IDs preserved/);
  assert.match(host.querySelector('[data-severity="warning"]')!.textContent!, /\[WARNING\].*maintenance window/);
  const filter = host.querySelector('select[aria-label="Filter deployment log severity"]')!;
  const select = async (value: string) => act(async () => { (filter as unknown as HTMLSelectElement).value = value; filter.dispatchEvent(new browser.Event('change', {bubbles: true})); });
  await select('error');
  assert.equal(host.querySelectorAll('[data-severity]').length, 1);
  assert.match(host.querySelector('[data-severity="error"]')!.textContent!, /\[ERROR\].*EMAIL_MESSAGES.*Unsupported column/);
  assert.match(host.textContent!, /describe source columns.*SEED_EXPORT_FAILED.*Source row 2/);
  assert.match(host.textContent!, /PAYLOAD.*XMLTYPE.*Use a dedicated export/);
  await select('info');
  assert.equal(host.querySelector('[data-severity="error"]'), null);
  assert.match(host.textContent!, /Blocked: resolve errors/);
  await act(async () => root.render(<PackageInstallLog entries={[{severity: 'info', message: 'Identity IDs preserved.'}]} />));
  assert.match(host.textContent!, /No warnings or errors/);
  assert.ok(!host.textContent!.includes('Blocked:'));
});

test('package ZIP preview uses requested tablespaces when the response omits placement settings', async t => {
  const pkg = {name: 'PKG', type: 'PACKAGE'};
  const table = {name: 'T', type: 'TABLE'};
  const call = t.mock.method(api, 'packageInstall', async () => ({
    sourceName: 'DEV', targetName: 'PROD', sourceSchema: 'DEV', targetSchema: 'PROD', comparedAt: '2026-11-25', roots: ['PKG'],
    objects: [{...table, key: compareObjectKey(table), status: 'sourceOnly' as const, sourceDdl: '', targetDdl: '', script: 'CREATE TABLE "PROD"."T" (ID NUMBER GENERATED ALWAYS AS IDENTITY NOT NULL ENABLE, PRIMARY KEY (ID) USING INDEX ENABLE);'}],
    dependencies: [], suggestions: [], warnings: [], exports: [], script: '',
  }));
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<PackageInstall sourceId="dev" targetId="prod" catalogs={[{schema: 'DEV', objects: [pkg, table], types: ['PACKAGE', 'TABLE']}, {schema: 'PROD', objects: [], types: []}]} tablespaces={{tableTablespace: '"Data Files"', indexTablespace: 'APP_IDX'}} />));
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
    assert.ok(button, label); await act(async () => button.click());
  };
  await act(async () => (host.querySelector('[aria-label="Install package PKG"]') as unknown as HTMLInputElement).click());
  await click('Analyze package dependencies (1)');
  await click('Generate package install script');
  const check = () => {
    const sql = host.querySelector('[aria-label="Package install script"]')!.textContent!;
    assert.match(sql, /USING INDEX TABLESPACE "APP_IDX" ENABLE\) TABLESPACE "Data Files";/);
  };
  check();
  const select = async (label: string, value: string) => {
    const field = host.querySelector(`select[aria-label="${label}"]`)!;
    await act(async () => { (field as unknown as HTMLSelectElement).value = value; field.dispatchEvent(new browser.Event('change', {bubbles: true})); });
  };
  await select('Install script output', 'by-type'); check();
  await select('Preview archive file', 'by-type/tables.sql'); check();
  assert.equal(call.mock.calls.length, 2);
  assert.ok([...host.querySelectorAll('button')].some(b => b.textContent === 'Download scripts by type (ZIP)'));
});

test("package install requires explicit seed selection and invalidates preview when options change", async t => {
  const pkg = { name: 'MAIL_PKG', type: 'PACKAGE' };
  const call = t.mock.method(api, 'packageInstall', async (_targetId: string, _input: PackageInstallRequest) => ({
    sourceName: 'DEV', targetName: 'PROD', sourceSchema: 'DEV', targetSchema: 'PROD', comparedAt: '2026-11-24', roots: ['MAIL_PKG'],
    objects: [{...pkg, key: compareObjectKey(pkg), status: 'sourceOnly' as const, sourceDdl: '', targetDdl: '', script: 'CREATE PACKAGE MAIL_PKG;'}], dependencies: [], suggestions: [{ table: 'MAIL_BLACK_LIST', recommended: true, reasons: ['Read by package'], evidence: ['PACKAGE BODY MAIL_PKG:12 FROM MAIL_BLACK_LIST'] }],
    warnings: ['Review dynamic SQL'], exports: _input.seedTables?.length ? [{table: 'MAIL_BLACK_LIST', rows: 1, script: 'INSERT INTO MAIL_BLACK_LIST VALUES (1);', infos: ['Identity IDs preserved for RECIPIENT_ID.'], warnings: ['Review triggers.']}] : [], script: 'CREATE PACKAGE MAIL_PKG;\nINSERT INTO MAIL_BLACK_LIST VALUES (1);',
  }));
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<PackageInstall sourceId="dev" targetId="prod" catalogs={[{ schema: 'DEV', objects: [pkg], types: ['PACKAGE'] }, { schema: 'PROD', objects: [], types: [] }]} tablespaces={{tableTablespace: "PKG_DATA", indexTablespace: "PKG_IDX"}} />));
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
    assert.ok(button, label); await act(async () => button.click());
  };
  await act(async () => (host.querySelector('[aria-label="Install package MAIL_PKG"]') as unknown as HTMLInputElement).click());
  await click('Analyze package dependencies (1)');
  assert.deepEqual(call.mock.calls[0].arguments[1].packages, ['MAIL_PKG']);
  assert.equal(call.mock.calls[0].arguments[1].tableTablespace, 'PKG_DATA');
  assert.equal(call.mock.calls[0].arguments[1].seedTables, undefined);
  assert.equal(host.querySelector('[aria-label="Export inserts MAIL_BLACK_LIST"]'), null);
  assert.equal(host.querySelector('[aria-label="Seed row limit"]'), null);
  const toggle = [...host.querySelectorAll('button')].find(b => b.textContent === 'Show Table INSERT suggestions')!;
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await click('Show Table INSERT suggestions');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  let seed = host.querySelector('[aria-label="Export inserts MAIL_BLACK_LIST"]') as unknown as HTMLInputElement;
  assert.equal(seed.checked, false);
  assert.match(host.textContent!, /MAIL_PKG:12 FROM MAIL_BLACK_LIST/);
  await act(async () => seed.click());
  await click('Hide Table INSERT suggestions');
  assert.equal(host.querySelector('[aria-label="Export inserts MAIL_BLACK_LIST"]'), null);
  assert.match(host.textContent!, /1 tables selected for separate INSERT export/);
  await click('Generate package install script');
  assert.deepEqual(call.mock.calls[1].arguments[1].seedTables, ['MAIL_BLACK_LIST']);
  assert.equal(call.mock.calls[1].arguments[1].indexTablespace, 'PKG_IDX');
  assert.equal(call.mock.calls[1].arguments[0], 'prod');
  assert.ok(host.querySelector('[aria-label="Package install script"]'));
  assert.ok(!host.querySelector('[aria-label="Package install script"]')!.textContent!.includes('INSERT INTO MAIL_BLACK_LIST'));
  assert.match(host.querySelector('[aria-label="INSERT script"]')!.textContent!, /INSERT INTO MAIL_BLACK_LIST/);
  const insertOutput = host.querySelector('select[aria-label="INSERT script output"]')!;
  assert.equal((insertOutput as unknown as HTMLSelectElement).value, 'single');
  await act(async () => { (insertOutput as unknown as HTMLSelectElement).value = 'per-table'; insertOutput.dispatchEvent(new browser.Event('change', {bubbles: true})); });
  assert.match(host.querySelector('[aria-label="INSERT script"]')!.textContent!, /@@tables\/0001_MAIL_BLACK_LIST.sql/);
  const insertFile = host.querySelector('select[aria-label="Preview INSERT file"]')!;
  await act(async () => { (insertFile as unknown as HTMLSelectElement).value = 'tables/0001_MAIL_BLACK_LIST.sql'; insertFile.dispatchEvent(new browser.Event('change', {bubbles: true})); });
  assert.match(host.querySelector('[aria-label="INSERT script"]')!.textContent!, /INSERT INTO MAIL_BLACK_LIST/);
  assert.ok([...host.querySelectorAll('button')].some(b => b.textContent === 'Download INSERT scripts by table (ZIP)'));
  assert.equal(call.mock.calls.length, 2);
  assert.match(host.querySelector('[aria-label="Deployment log"] [data-severity="info"]')!.textContent!, /source rows scripted/);
  assert.ok([...host.querySelectorAll('[data-severity="info"]')].some(e => e.textContent?.includes('Identity IDs preserved for RECIPIENT_ID')));
  const output = host.querySelector('select[aria-label="Install script output"]')!;
  assert.equal((output as unknown as HTMLSelectElement).value, 'single');
  await act(async () => { (output as unknown as HTMLSelectElement).value = 'by-type'; output.dispatchEvent(new browser.Event('change', {bubbles: true})); });
  assert.equal(call.mock.calls.length, 2); // Formatting does not repeat Oracle analysis or seed export.
  assert.ok([...host.querySelectorAll('button')].some(b => b.textContent === 'Download scripts by type (ZIP)'));
  const archive = host.querySelector('select[aria-label="Preview archive file"]')!;
  assert.match(archive.textContent!, /install.sql/);
  assert.match(archive.textContent!, /export-log.json/);
  assert.ok(!archive.textContent!.includes('data.sql'));
  assert.match(host.querySelector('[aria-label="Package install script"]')!.textContent!, /CREATE PACKAGE MAIL_PKG/);
  await act(async () => { (archive as unknown as HTMLSelectElement).value = 'export-log.json'; archive.dispatchEvent(new browser.Event('change', {bubbles: true})); });
  assert.match(host.querySelector('[aria-label="Package install script"]')!.textContent!, /"exports"/);
  await act(async () => { (output as unknown as HTMLSelectElement).value = 'single'; output.dispatchEvent(new browser.Event('change', {bubbles: true})); });
  assert.match(host.querySelector('[aria-label="Package install script"]')!.textContent!, /CREATE PACKAGE MAIL_PKG/);
  await click('Show Table INSERT suggestions');
  seed = host.querySelector('[aria-label="Export inserts MAIL_BLACK_LIST"]') as unknown as HTMLInputElement;
  assert.equal(seed.checked, true);
  await act(async () => seed.click());
  assert.equal(host.querySelector('[aria-label="Package install script"]'), null);
  assert.equal(host.querySelector('[aria-label="INSERT script export"]'), null);
  assert.ok(!host.querySelector('[aria-label="Deployment log"]')!.textContent!.includes('Identity IDs preserved'));
  assert.ok(![...host.querySelectorAll('button')].some(b => b.textContent?.includes('Download package-install.sql')));
});

test("schema compare filters types, submits selected objects and previews target deployment SQL", async t => {
  const table = { name: "ITEMS", type: "TABLE" }, proc = { name: "SAVE_ITEM", type: "PROCEDURE" };
  t.mock.method(api, 'compareCatalogTypes', async () => ({schema: 'APP', types: ['TABLE', 'PROCEDURE']}));
  t.mock.method(api, "compareCatalog", async () => ({ schema: "APP", objects: [table, proc], types: ["TABLE", "PROCEDURE"] }));
  const compare = t.mock.method(api, "schemaCompare", async (_targetId: string, _input: SchemaCompareRequest) => ({
    sourceSchema: "DEV", targetSchema: "PROD", sourceName: "Development", targetName: "Production", comparedAt: "2026-11-24T12:00:00Z",
    objects: [{ ...proc, key: compareObjectKey(proc), status: "sourceOnly" as const, sourceDdl: "CREATE PROCEDURE SAVE_ITEM AS BEGIN NULL; END;\n/", targetDdl: "", script: 'CREATE PROCEDURE "PROD".SAVE_ITEM AS BEGIN NULL; END;\n/' }],
  }));
  const state = { connections: [
    { id: "dev", name: "Development", user: "DEV", engine: "oracle", live: true, status: "connected" },
    { id: "prod", name: "Production", user: "PROD", engine: "oracle", live: true, status: "connected" },
  ] } as unknown as ReturnType<typeof useStudio>;
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<StudioSnapshot value={state}><SchemaCompare /></StudioSnapshot>));
  const click = async (label: string) => {
    const btn = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
    assert.ok(btn, `Missing ${label}`); await act(async () => btn.click());
  };
  await click("Object comparison");
  await chooseObjectTypes(host);
  await click("Load objects");
  assert.match(host.textContent!, /2 selected/);
  await click("Clear types");
  assert.equal(host.querySelector('[aria-label="Select TABLE ITEMS"]'), null);
  await click("All types");
  await click("Load objects");
  const tableCheckbox = host.querySelector('input[aria-label="Select TABLE ITEMS"]')!;
  await act(async () => (tableCheckbox as unknown as HTMLInputElement).click());
  await click("Compare selected");
  assert.equal(compare.mock.calls.length, 1);
  assert.equal(compare.mock.calls[0].arguments[0], "prod");
  assert.deepEqual(compare.mock.calls[0].arguments[1].objects, [proc]);
  await click("Generate script (1)");
  const script = host.querySelector('[aria-label="Deployment script"]')!.textContent!;
  assert.match(script, /CURRENT_SCHEMA = "PROD"/);
  assert.match(script, /CREATE PROCEDURE "PROD"/);
  assert.ok(!script.includes("DROP TABLE"));
  const output = host.querySelector('select[aria-label="Install script output"]')!;
  assert.equal((output as unknown as HTMLSelectElement).value, 'single');
  await act(async () => { (output as unknown as HTMLSelectElement).value = 'by-type'; output.dispatchEvent(new browser.Event('change', {bubbles: true})); });
  assert.equal(compare.mock.calls.length, 1);
  assert.equal(host.querySelector('[aria-label="Deployment script"]')!.textContent, script);
  const archive = host.querySelector('select[aria-label="Preview archive file"]')!;
  assert.match(archive.textContent!, /by-type\/procedures.sql/);
  await act(async () => { (archive as unknown as HTMLSelectElement).value = 'by-type/procedures.sql'; archive.dispatchEvent(new browser.Event('change', {bubbles: true})); });
  assert.match(host.querySelector('[aria-label="Deployment script"]')!.textContent!, /CREATE PROCEDURE "PROD"/);
  assert.ok([...host.querySelectorAll('button')].some(b => b.textContent?.includes('Download scripts by type (ZIP)')));
  await click("Change selection");
  assert.ok(host.querySelector('input[aria-label="Select PROCEDURE SAVE_ITEM"]'));
});

test("connection picker sorts and filters without changing selection, and supports keyboard selection", async t => {
  const connections: Connection[] = [
    { id: "a", name: "DB 10", engine: "oracle", user: "OPS", host: "west", port: 1521, database: "warehouse", status: "connected", readOnly: false, color: "" },
    { id: "b", name: "DB 2", engine: "oracle", user: "FINANCE", host: "east", port: 1521, database: "billing", status: "idle", readOnly: true, color: "" },
    { id: "c", name: "Archive", engine: "oracle", user: "HISTORY", host: "north", port: 1521, database: "reports", status: "error", readOnly: true, color: "" },
  ];
  const changes: string[] = [];
  function Picker() {
    const [value, setValue] = useState("a");
    return <ConnectionPicker label="source" connections={connections} value={value} onChange={id => { changes.push(id); setValue(id); }} />;
  }
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<Picker />));
  const trigger = host.querySelector('button[aria-label="source connection"]')!;
  const click = async (element: unknown) => act(async () => (element as HTMLElement).click());
  const options = () => [...host.querySelectorAll("[data-connection-option]")].map(el => el.getAttribute("data-connection-option"));
  const select = async (label: string, value: string) => {
    const el = host.querySelector(`select[aria-label="${label}"]`)!;
    await act(async () => { (el as unknown as HTMLSelectElement).value = value; el.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  };
  await click(trigger);
  assert.deepEqual(options(), ["c", "b", "a"]); // Natural numeric ordering: DB 2 precedes DB 10.
  await click(host.querySelector('[aria-label="source connection sort direction"]')!);
  assert.deepEqual(options(), ["a", "b", "c"]);
  await select("source connection access filter", "readOnly");
  assert.deepEqual(options(), ["b", "c"]);
  assert.match(trigger.textContent!, /DB 10/);
  assert.deepEqual(changes, []);
  await select("source connection status filter", "idle");
  assert.deepEqual(options(), ["b"]);
  await select("source connection status filter", "connected");
  assert.match(host.textContent!, /No connections match these filters/);
  const reset = [...host.querySelectorAll("button")].find(b => b.textContent === "Reset filters")!;
  await click(reset);
  await select("source connection sort", "user");
  await click(host.querySelector('[aria-label="source connection sort direction"]')!);
  assert.deepEqual(options(), ["b", "c", "a"]);
  const search = host.querySelector('input[aria-label="Search source connections"]')!;
  await act(async () => {
    search.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  assert.equal(browser.document.activeElement?.getAttribute("data-connection-option"), "b");
  await act(async () => browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  assert.equal(browser.document.activeElement?.getAttribute("data-connection-option"), "c");
  await act(async () => search.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(browser.document.activeElement, trigger);
  await click(trigger);
  await click(host.querySelector('[data-connection-option="b"]')!);
  assert.deepEqual(changes, ["b"]);
  assert.match(trigger.textContent!, /FINANCE · east:1521 \/ billing/);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("changing source through the enhanced picker invalidates the old object inventory", async t => {
  t.mock.method(api, 'compareCatalogTypes', async () => ({schema: 'APP', types: ['TABLE']}));
  const catalog = t.mock.method(api, "compareCatalog", async () => ({ schema: "APP", objects: [{ name: "T", type: "TABLE" }], types: ["TABLE"] }));
  const state = { connections: [
    { id: "dev", name: "Development", user: "DEV", engine: "oracle", live: true, status: "connected" },
    { id: "prod", name: "Production", user: "PROD", engine: "oracle", live: true, status: "connected" },
  ] } as unknown as ReturnType<typeof useStudio>;
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<StudioSnapshot value={state}><SchemaCompare /></StudioSnapshot>));
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Object comparison')!.click());
  const load = [...host.querySelectorAll("button")].find(b => b.textContent === "Load objects")!;
  await chooseObjectTypes(host);
  await act(async () => load.click());
  assert.ok(host.querySelector('[aria-label="Select TABLE T"]'));
  await act(async () => (host.querySelector('[aria-label="source connection"]') as unknown as HTMLButtonElement).click());
  // Opening and filtering options leaves the reviewed inventory intact.
  const statusFilter = host.querySelector('[aria-label="source connection status filter"]')!;
  await act(async () => { (statusFilter as unknown as HTMLSelectElement).value = "connected"; statusFilter.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  assert.ok(host.querySelector('[aria-label="Select TABLE T"]'));
  await act(async () => (host.querySelector('[data-connection-option="prod"]') as unknown as HTMLButtonElement).click());
  assert.equal(host.querySelector('[aria-label="Select TABLE T"]'), null);
  assert.match(host.querySelector('[aria-label="target connection"]')!.textContent!, /Production/);
  assert.equal(load.disabled, true);
  await chooseObjectTypes(host);
  await act(async () => load.click());
  assert.equal(catalog.mock.calls.at(-2)?.arguments[0], "prod");
  assert.equal(catalog.mock.calls.at(-1)?.arguments[0], "prod");
});

test("source and target Connect actions track pending state, errors and retry without clearing selections", async t => {
  t.mock.method(api, 'compareCatalogTypes', async () => ({schema: 'APP', types: ['TABLE']}));
  const catalog = t.mock.method(api, "compareCatalog", async () => ({ schema: "APP", objects: [{ name: "T", type: "TABLE" }], types: ["TABLE"] }));
  const calls: string[] = [];
  let finish = () => {};
  let disconnectTarget = () => {};
  let fail = false;
  function ConnectedCompare() {
    const [connections, setConnections] = useState<Connection[]>([
      { id: "dev", name: "Development", user: "DEV", host: "dev", port: 1521, engine: "oracle", live: true, status: "idle", color: "" },
      { id: "prod", name: "Production", user: "PROD", host: "prod", port: 1521, engine: "oracle", live: true, status: "error", lastError: "Previous connection failed", color: "" },
    ]);
    disconnectTarget = () => setConnections(current => current.map(c => c.id === "prod" ? { ...c, status: "idle" } : c));
    const state = { connections, reconnectConn: async (id: string) => {
      calls.push(id);
      await new Promise<void>(resolve => { finish = resolve; });
      setConnections(current => current.map(c => c.id === id ? { ...c, status: fail ? "error" : "connected", lastError: fail ? "ORA-01017: invalid credentials" : undefined } : c));
    } } as unknown as ReturnType<typeof useStudio>;
    return <StudioSnapshot value={state}><SchemaCompare /></StudioSnapshot>;
  }
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<ConnectedCompare />));
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Object comparison')!.click());
  const connectButton = (side: string) => host.querySelector(`button[aria-label="Connect ${side} connection"]`);
  const load = [...host.querySelectorAll("button")].find(b => b.textContent === "Load objects")!;
  assert.equal(load.disabled, true);
  await act(async () => load.click());
  assert.equal(catalog.mock.calls.length, 0);
  const source = connectButton("source")!;
  await act(async () => { (source as unknown as HTMLButtonElement).click(); (source as unknown as HTMLButtonElement).click(); });
  assert.deepEqual(calls, ["dev"]);
  assert.match(source.textContent!, /Connecting/);
  assert.equal(source.hasAttribute("disabled"), true);
  assert.equal(connectButton("target")!.hasAttribute("disabled"), true);
  await act(async () => finish());
  assert.equal(connectButton("source"), null);
  assert.match(host.querySelector('[aria-label="source connection"]')!.textContent!, /Development.*DEV.*Connected/);
  assert.equal(load.disabled, true);

  fail = true;
  await act(async () => (connectButton("target") as unknown as HTMLButtonElement).click());
  await act(async () => finish());
  assert.match(host.textContent!, /ORA-01017: invalid credentials/);
  assert.equal(connectButton("target")!.hasAttribute("disabled"), false);
  fail = false;
  await act(async () => (connectButton("target") as unknown as HTMLButtonElement).click());
  await act(async () => finish());
  assert.equal(connectButton("target"), null);
  assert.deepEqual(calls, ["dev", "prod", "prod"]);
  assert.match(host.querySelector('[aria-label="target connection"]')!.textContent!, /Production.*PROD.*Connected/);
  assert.ok(!host.textContent!.includes("ORA-01017"));
  assert.equal(load.disabled, true);
  await chooseObjectTypes(host);
  assert.equal(load.disabled, false);
  await act(async () => load.click());
  assert.equal(catalog.mock.calls.length, 2);
  await act(async () => disconnectTarget());
  const compare = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === "Compare selected")!;
  assert.equal(load.disabled, true); assert.equal(compare.disabled, true);
  await act(async () => (connectButton("target") as unknown as HTMLButtonElement).click());
  assert.equal(compare.disabled, true);
  await act(async () => finish());
  assert.deepEqual(calls, ["dev", "prod", "prod", "prod"]);
  assert.equal(compare.disabled, false);
  assert.ok(host.querySelector('[aria-label="Select TABLE T"]'));
});


test('Object comparison expands a package selection into deployable tables, views, sequences and indexes', async t => {
  const pkg = { name: 'PKG_MATERIALIDAD', type: 'PACKAGE' };
  const objects = [
    { name: 'SEQ_MATERIALIDAD', type: 'SEQUENCE' },
    { name: 'MATERIALIDAD', type: 'TABLE' },
    { name: 'IX_MATERIALIDAD', type: 'INDEX' },
    { name: 'VW_MATERIALIDAD', type: 'VIEW' },
    pkg, { ...pkg, type: 'PACKAGE BODY' },
  ];
  t.mock.method(api, 'compareCatalogTypes', async () => ({schema: 'APP', types: objects.map(o => o.type)}));
  t.mock.method(api, 'compareCatalog', async () => ({ schema: 'APP', objects, types: objects.map(o => o.type) }));
  const compare = t.mock.method(api, 'schemaCompare', async (_target: string, _input: SchemaCompareRequest) => ({
    sourceSchema: 'DEV', targetSchema: 'PROD', sourceName: 'DEV', targetName: 'PROD', comparedAt: '2026-11-24',
    objects: objects.map(o => ({ ...o, key: compareObjectKey(o), status: 'sourceOnly' as const, sourceDdl: '', targetDdl: '', script: 'CREATE ' + o.type + ' "PROD"."' + o.name + '";' })),
  }));
  const state = { connections: [
    { id: 'dev', name: 'DEV', user: 'DEV', engine: 'oracle', live: true, status: 'connected' },
    { id: 'prod', name: 'PROD', user: 'PROD', engine: 'oracle', live: true, status: 'connected' },
  ] } as unknown as ReturnType<typeof useStudio>;
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<StudioSnapshot value={state}><SchemaCompare /></StudioSnapshot>));
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
    assert.ok(button, text); await act(async () => button.click());
  };
  const setText = async (label: string, value: string) => {
    const input = host.querySelector('input[aria-label="' + label + '"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new browser.Event('input', {bubbles: true}));
    });
  };
  await setText('Table tablespace', 'DEPLOY_DATA');
  await setText('Index tablespace', 'DEPLOY_INDEX');
  await click('Object comparison');
  await chooseObjectTypes(host);
  await click('Load objects');
  await click('Clear visible');
  await act(async () => (host.querySelector('input[aria-label="Select PACKAGE PKG_MATERIALIDAD"]') as unknown as HTMLInputElement).click());
  await click('Compare selected');
  assert.deepEqual(compare.mock.calls[0].arguments[1].objects, [pkg]);
  assert.equal(compare.mock.calls[0].arguments[1].includePackageDependencies, true);
  assert.equal(compare.mock.calls[0].arguments[1].tableTablespace, 'DEPLOY_DATA');
  assert.equal(compare.mock.calls[0].arguments[1].indexTablespace, 'DEPLOY_INDEX');
  await click('Generate script (6)');
  const sql = host.querySelector('[aria-label="Deployment script"]')!.textContent!;
  for (const o of objects) assert.ok(sql.includes('CREATE ' + o.type + ' "PROD"."' + o.name + '";'), o.name);
  await setText('Table tablespace', 'OTHER_DATA');
  assert.equal(host.querySelector('[aria-label="Deployment script"]'), null);
});
