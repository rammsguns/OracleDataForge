import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { Window, type HTMLButtonElement as HappyButton } from "happy-dom";
import { act } from "react";

const browser = new Window({ url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "localStorage"] as const) {
  Object.defineProperty(globalThis, name, { value: name === "window" ? browser : browser[name], configurable: true });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { value: (callback: () => void) => browser.requestAnimationFrame(callback), configurable: true });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const { createRoot } = await import("react-dom/client");
const { StudioSnapshot, useStudio } = await import("../state/store");
const { default: DesktopMenu } = await import("./DesktopMenu");
after(async () => { await browser.happyDOM.close(); });

async function setup(t: TestContext, role = "Developer") {
  const calls: unknown[][] = [];
  const state = {
    accessRole: role, theme: "light", sidebarOpen: true, activeConnId: "dev", activeTabId: "ws",
    tabs: [{ id: "ws", kind: "worksheet", title: "Worksheet 1" }],
    openTab: (...args: unknown[]) => calls.push(args),
  } as unknown as ReturnType<typeof useStudio>;
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<StudioSnapshot value={state}><DesktopMenu onAbout={() => {}} onAccount={() => {}} onShortcuts={() => {}} /></StudioSnapshot>));
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
    assert.ok(button, `Missing command: ${label}`);
    await act(async () => button.click());
    return button;
  };
  return { host, calls, click };
}

test("menus launch tools and close after a command; toolbar opens a distinct worksheet", async t => {
  const { host, calls, click } = await setup(t);
  await click("Tools");
  await click("Monitor Sessions");
  assert.deepEqual(calls, [["sessions", "Sessions"]]);
  assert.equal(host.querySelector('[role="menu"]'), null);
  await act(async () => host.querySelector<HappyButton>('[aria-label="New SQL Worksheet"]')!.click());
  assert.equal(calls[1][0], "worksheet");
  assert.equal(calls[1][1], "Worksheet 2");
  assert.match(String(calls[1][2]), /^ws-/);
});

test("viewer and analyst menus cannot invoke restricted tools", async t => {
  for (const role of ["Viewer", "Analyst"]) {
    const { host, calls, click } = await setup(t, role);
    await click("Tools");
    const sessions = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Monitor Sessions")!;
    assert.equal(sessions.disabled, true);
    await act(async () => sessions.click());
    assert.deepEqual(calls, []);
    assert.equal(host.querySelector<HappyButton>('[aria-label="New Connection"]')?.disabled, true);
    if (role === "Analyst") assert.equal(host.querySelector<HappyButton>('[aria-label="New SQL Worksheet"]')?.disabled, true);
  }
});

test("keyboard navigation skips disabled commands and Escape restores menu focus", async t => {
  const { host, click } = await setup(t, "Viewer");
  const file = await click("File");
  const first = host.querySelector<HappyButton>('[role="menu"] button')!;
  first.focus();
  await act(async () => first.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  assert.equal(browser.document.activeElement?.textContent?.trim(), "Open SQL File…");
  await act(async () => browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(host.querySelector('[role="menu"]'), null);
  assert.equal(browser.document.activeElement, file);
});
