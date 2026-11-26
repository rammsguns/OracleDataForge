import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Connection } from "../types";

const browser = new Window({ url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "localStorage"] as const) {
  Object.defineProperty(globalThis, name, { value: name === "window" ? browser : browser[name], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const { createRoot } = await import("react-dom/client");
const { StudioSnapshot, useStudio } = await import("../state/store");
const { default: ToolConnectionGate } = await import("./ToolConnectionGate");
after(async () => browser.happyDOM.close());

const connections = [
  { id: "dev", name: "Development", user: "APP_DEV", host: "dev-db", database: "FREEPDB1", status: "connected" },
  { id: "prod", name: "Production", user: "APP", host: "prod-db", database: "ORDERS", status: "idle" },
].map(c => ({ ...c, port: 1521, engine: "oracle", live: true, color: "#3974a6" })) as Connection[];

async function setup(t: TestContext, options: { activeId?: string; fail?: boolean; empty?: boolean } = {}) {
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const requests: string[] = [];
  let mounted = 0;
  function Reader() { mounted++; return <div>Database reader ready</div>; }
  function App() {
    const [activeConnId, setActiveConnId] = useState(options.activeId ?? "");
    const [list, setList] = useState(options.empty ? [] : connections);
    const state = { activeConnId, setActiveConnId, connections: list, accessRole: "Viewer", reconnectConn: async (id: string) => {
      requests.push(id);
      if (options.fail) { setList(previous => previous.map(c => c.id === id ? { ...c, status: "error", lastError: "Connection refused" } : c)); return; }
      setList(previous => previous.map(c => c.id === id ? { ...c, status: "connected" } : c)); setActiveConnId(id);
    } } as unknown as ReturnType<typeof useStudio>;
    return <StudioSnapshot value={state}><ToolConnectionGate title="Sessions"><Reader /></ToolConnectionGate></StudioSnapshot>;
  }
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<App />));
  const click = async (selector: string) => { const button = host.querySelector(selector); assert.ok(button, selector); await act(async () => button.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }))); };
  const open = async () => { const button = [...host.querySelectorAll('button')].find(b => /^(Connect and open|Open tool)$/.test(b.textContent?.trim() ?? "")); assert.ok(button); await act(async () => button.click()); };
  return { host, requests, click, open, mounted: () => mounted };
}

test("a tool opens without a connection, focuses search, and defers database readers until selection", async t => {
  const { host, requests, mounted, click, open } = await setup(t);
  assert.equal(mounted(), 0);
  const search = host.querySelector('input[aria-label="Search Tool connections"]')!;
  assert.equal(browser.document.activeElement, search);
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(search, "app_dev freepdb1");
    search.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  assert.equal(host.querySelectorAll('[data-connection-option]').length, 1);
  await click('[data-connection-option="dev"]');
  assert.equal(mounted(), 0);
  await open();
  assert.equal(mounted(), 1);
  assert.deepEqual(requests, []); // Existing sessions must not be reconnected (or rolled back).
});

test("an offline connection is connected before mounting the tool", async t => {
  const { host, requests, mounted, click, open } = await setup(t, { activeId: "missing" });
  await click('[data-connection-option="prod"]');
  assert.equal(mounted(), 0);
  await open();
  assert.deepEqual(requests, ["prod"]);
  assert.equal(mounted(), 1);
  assert.match(host.textContent!, /Database reader ready/);
});

test("connection failure keeps the picker available, shows the reason, and allows retry", async t => {
  const { host, requests, mounted, click, open } = await setup(t, { fail: true });
  await click('[data-connection-option="prod"]'); await open();
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /Connection refused/);
  assert.equal(mounted(), 0);
  await open(); assert.deepEqual(requests, ["prod", "prod"]);
});

test("a ready active connection bypasses the prompt; empty lists do not mount tools", async t => {
  const ready = await setup(t, { activeId: "dev" });
  assert.equal(ready.mounted(), 1);
  assert.deepEqual(ready.requests, []);
  const empty = await setup(t, { empty: true });
  assert.equal(empty.mounted(), 0);
  assert.match(empty.host.textContent!, /No saved Oracle connections/);
  assert.equal(empty.host.querySelector('button'), null); // Viewer cannot add a connection.
});
