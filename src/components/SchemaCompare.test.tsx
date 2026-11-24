import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
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
const { default: ConnectionPicker } = await import("./ConnectionPicker");
const { api } = await import("../utils/api");
const { compareObjectKey } = await import("../utils/schemaCompare");
after(async () => { await browser.happyDOM.close(); });

test("schema compare filters types, submits selected objects and previews target deployment SQL", async t => {
  const table = { name: "ITEMS", type: "TABLE" }, proc = { name: "SAVE_ITEM", type: "PROCEDURE" };
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
  await click("Load objects");
  assert.match(host.textContent!, /2 selected/);
  await click("Clear types");
  assert.match(host.textContent!, /0 selected/);
  await click("All types");
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
  const catalog = t.mock.method(api, "compareCatalog", async () => ({ schema: "APP", objects: [{ name: "T", type: "TABLE" }], types: ["TABLE"] }));
  const state = { connections: [
    { id: "dev", name: "Development", user: "DEV", engine: "oracle", live: true, status: "connected" },
    { id: "prod", name: "Production", user: "PROD", engine: "oracle", live: true, status: "connected" },
  ] } as unknown as ReturnType<typeof useStudio>;
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<StudioSnapshot value={state}><SchemaCompare /></StudioSnapshot>));
  const load = [...host.querySelectorAll("button")].find(b => b.textContent === "Load objects")!;
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
  await act(async () => load.click());
  assert.equal(catalog.mock.calls.at(-2)?.arguments[0], "prod");
  assert.equal(catalog.mock.calls.at(-1)?.arguments[0], "prod");
});

test("source and target Connect actions track pending state, errors and retry without clearing selections", async t => {
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
