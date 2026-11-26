import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { Window, type HTMLSelectElement as HappySelect } from "happy-dom";
import { act, useState } from "react";
import type { Connection } from "../types";

const browser = new Window({ url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "localStorage"] as const) {
  Object.defineProperty(globalThis, name, { value: name === "window" ? browser : browser[name], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const { createRoot } = await import("react-dom/client");
const { StudioSnapshot, useStudio } = await import("../state/store");
const { default: Sidebar } = await import("./Sidebar");
const { api } = await import("../utils/api");
after(async () => browser.happyDOM.close());

const storageKey = "dataforge-hidden-connections";
const connections = [
  { id: "dev", name: "Development", status: "connected" },
  { id: "prod", name: "Production", status: "idle" },
].map(c => ({ ...c, user: "APP", engine: "oracle", live: true, host: "db", port: 1521, color: "#3974a6" })) as Connection[];

async function setup(t: TestContext, reconnect?: (id: string) => Promise<void>) {
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const calls: string[] = [];
  let list = connections;
  const render = async () => {
    const value = {
      activeConnId: "dev", connections: list, accessRole: "Viewer", schemaBump: 0, groupRefresh: { labels: [], seq: 0 },
      setActiveConnId: (id: string) => calls.push(`select:${id}`), disconnectConn: async () => { calls.push("disconnect"); },
      reconnectConn: async (id: string) => { calls.push(`connect:${id}`); await reconnect?.(id); },
      removeConnection: () => calls.push("remove"),
      captureConnectionStatus: () => () => true,
    } as unknown as ReturnType<typeof useStudio>;
    await act(async () => root.render(<StudioSnapshot value={value}><Sidebar /></StudioSnapshot>));
  };
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
    assert.ok(button, `Missing button: ${label}`);
    await act(async () => button.click());
  };
  const search = async (text: string) => {
    const input = host.querySelector('input[aria-label="Search connections and schema objects"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
  };
  const remount = async () => { await act(async () => root.render(null)); await render(); };
  const refreshConnections = async () => { list = connections.map(c => ({ ...c, name: `${c.name} refreshed` })); await render(); };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); browser.localStorage.clear(); });
  await render();
  return { host, calls, click, search, remount, refreshConnections };
}

test("hidden connections survive remounts and registry refreshes without changing the selected session", async t => {
  const { host, calls, click, search, remount, refreshConnections } = await setup(t);
  await click("Hide connection Development");
  assert.equal(host.querySelector('button[aria-label^="Development connection"]'), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(JSON.parse(browser.localStorage.getItem(storageKey)!), ["dev"]);
  await search("  dEVeLoPMent  ");
  assert.ok(host.querySelector('button[aria-label^="Development connection"]'));
  assert.equal(host.querySelector('button[aria-label^="Production connection"]'), null);
  assert.deepEqual(JSON.parse(browser.localStorage.getItem(storageKey)!), ["dev"]);
  await search("   ");
  assert.equal(host.querySelector('button[aria-label^="Development connection"]'), null);
  await remount();
  await refreshConnections();
  assert.equal(host.querySelector('button[aria-label^="Development refreshed connection"]'), null);
  await click("Show hidden connections (1)");
  assert.ok(host.querySelector('button[aria-label^="Development refreshed connection"]'));
  // Revealing hidden rows is temporary; refreshing hides them again until explicitly restored.
  await remount();
  assert.equal(host.querySelector('button[aria-label^="Development refreshed connection"]'), null);
  await click("Show hidden connections (1)");
  await click("Show connection Development refreshed");
  await remount();
  assert.ok(host.querySelector('button[aria-label^="Development refreshed connection"]'));
  assert.deepEqual(JSON.parse(browser.localStorage.getItem(storageKey)!), []);
  assert.deepEqual(calls, []);
});

test("Hide All and Show All persist for every connection, including those outside the search", async t => {
  const { host, calls, click, search, remount } = await setup(t);
  const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!;
  assert.equal(button("Show All").disabled, true);
  await search("Production");
  await click("Hide All");
  assert.deepEqual(JSON.parse(browser.localStorage.getItem(storageKey)!), ["dev", "prod"]);
  assert.equal(button("Hide All").disabled, true);
  await remount();
  assert.match(host.textContent!, /All connections are hidden/);
  await search("missing connection");
  assert.match(host.textContent!, /No matching connections/);
  await search("Production");
  assert.ok(host.querySelector('button[aria-label^="Production connection"]'));
  assert.equal(host.querySelector('button[aria-label^="Development connection"]'), null);
  await search("");
  assert.match(host.textContent!, /All connections are hidden/);
  await click("Show hidden connections (2)");
  await search("Production");
  assert.ok(host.querySelector('button[aria-label^="Production connection"]'));
  assert.equal(host.querySelector('button[aria-label^="Development connection"]'), null);
  await click("Show connection Production");
  assert.deepEqual(JSON.parse(browser.localStorage.getItem(storageKey)!), ["dev"]);
  await click("Show All");
  assert.deepEqual(JSON.parse(browser.localStorage.getItem(storageKey)!), []);
  await remount();
  assert.ok(host.querySelector('button[aria-label^="Development connection"]'));
  assert.ok(host.querySelector('button[aria-label^="Production connection"]'));
  assert.equal(button("Show All").disabled, true);
  assert.deepEqual(calls, []);
});

test("invalid visibility preferences do not prevent the navigator from opening", async t => {
  browser.localStorage.setItem(storageKey, "{invalid");
  const { host, remount } = await setup(t);
  assert.ok(host.querySelector('button[aria-label^="Development connection"]'));
  browser.localStorage.setItem(storageKey, '{"unexpected":true}');
  await remount();
  assert.ok(host.querySelector('button[aria-label^="Production connection"]'));
});

test("Connect beside the name reuses connected sessions and connects hidden search results once", async t => {
  t.mock.method(api, "schema", async () => ({ schemaName: "APP", tables: [], views: [] }));
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const { host, calls, click, search } = await setup(t, () => pending);
  await click("Connect Development");
  assert.deepEqual(calls, ["select:dev"]);
  await click("Hide All");
  await search("Production");
  const connect = host.querySelector('button[aria-label="Connect Production"]')!;
  assert.equal(host.querySelector('button[aria-label^="Production connection"]')!.getAttribute("aria-expanded"), "false");
  await click("Connect Production");
  assert.equal(connect.getAttribute("aria-busy"), "true");
  assert.equal(connect.hasAttribute("disabled"), true);
  assert.match(connect.textContent!, /Connecting/);
  await click("Connect Production");
  assert.deepEqual(calls, ["select:dev", "connect:prod"]);
  await act(async () => { finish(); await pending; });
  assert.equal(connect.hasAttribute("disabled"), false);
  assert.deepEqual(JSON.parse(browser.localStorage.getItem(storageKey)!), ["dev", "prod"]);
  await search("");
  assert.equal(host.querySelector('button[aria-label="Connect Production"]'), null);
});

test("object filters default to Packages and distinguish categories sharing the same kind", async t => {
  t.mock.method(api, "schema", async () => ({
    schemaName: "APP", tables: [{ name: "APP_TABLE", rowCount: 1 }], views: ["APP_VIEW"],
    extras: [
      { label: "Packages", kind: "package", items: ["APP_PACKAGE"] },
      { label: "Queues Tables", kind: "table", items: ["APP_QUEUE_TABLE"] },
      { label: "Materialized Views", kind: "view", items: ["APP_MVIEW"] },
    ],
  }));
  const { host, click } = await setup(t);
  const filter = host.querySelector<HappySelect>("#schema-object-type")!;
  assert.equal(filter.value, "Packages");
  assert.ok([...filter.options].some(option => option.textContent === "Public Database Links"));
  assert.ok([...filter.options].some(option => option.textContent === "RDF Semantic Graph"));
  await click("Refresh schema");
  const tree = () => host.querySelector('[aria-label="Development schema tree"]')!.textContent!;
  assert.match(tree(), /APP_PACKAGE/);
  assert.doesNotMatch(tree(), /APP_TABLE|APP_VIEW|APP_MVIEW|APP_QUEUE_TABLE/);
  const select = async (value: string) => act(async () => {
    filter.value = value;
    filter.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  await select("Tables");
  assert.match(tree(), /APP_TABLE/);
  assert.doesNotMatch(tree(), /APP_QUEUE_TABLE|APP_PACKAGE/);
  await select("Views");
  assert.match(tree(), /APP_VIEW/);
  assert.doesNotMatch(tree(), /APP_MVIEW/);
  await select("Materialized Views");
  assert.match(tree(), /APP_MVIEW/);
  assert.doesNotMatch(tree(), /APP_VIEW/);
  await click("Clear filters");
  assert.equal(filter.value, "all");
});

test("Connect loads the selected object category after success, while failed attempts do not read the schema", async t => {
  const reads: string[] = [];
  t.mock.method(api, "schema", async (id: string) => {
    reads.push(id);
    return { schemaName: "APP", tables: [{ name: "AUTO_TABLE", rowCount: 1 }], views: [], extras: [
      { label: "Packages", kind: "package", items: ["AUTO_PACKAGE"] },
      { label: "Functions", kind: "function", items: ["AUTO_FUNCTION"] },
    ] };
  });
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  let fail = true, finish!: () => void;
  function App() {
    const [connection, setConnection] = useState<Connection>({ ...connections[1], id: "auto", name: "Automatic" });
    const [activeConnId, setActiveConnId] = useState("");
    const [schemaBump, setSchemaBump] = useState(0);
    const state = {
      connections: [connection], activeConnId, setActiveConnId, schemaBump, accessRole: "Viewer",
      groupRefresh: { labels: [], seq: 0 }, captureConnectionStatus: () => () => true,
      reconnectConn: async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        setConnection(c => ({ ...c, status: fail ? "error" : "connected" }));
        if (!fail) { setActiveConnId("auto"); setSchemaBump(bump => bump + 1); }
      },
    } as unknown as ReturnType<typeof useStudio>;
    return <StudioSnapshot value={state}><Sidebar /></StudioSnapshot>;
  }
  await act(async () => root.render(<App />));
  const filter = host.querySelector<HappySelect>("#schema-object-type")!;
  await act(async () => { filter.value = "Functions"; filter.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  const connect = host.querySelector('button[aria-label="Connect Automatic"]')!;
  await act(async () => connect.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(reads, []);
  await act(async () => finish());
  assert.deepEqual(reads, []);
  assert.equal(host.querySelector('[aria-label="Automatic schema tree"]'), null);
  fail = false;
  await act(async () => connect.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(reads, []);
  await act(async () => finish());
  assert.deepEqual(reads, ["auto"]);
  const tree = host.querySelector('[aria-label="Automatic schema tree"]')!;
  assert.ok(tree);
  assert.match(tree.textContent!, /AUTO_FUNCTION/);
  assert.doesNotMatch(tree.textContent!, /AUTO_PACKAGE|AUTO_TABLE|Load schema/);
  assert.equal(filter.value, "Functions");
  await act(async () => connect.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(reads, ["auto"]);
});
