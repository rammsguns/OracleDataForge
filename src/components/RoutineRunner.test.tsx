import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { RoutineMember, RoutineMeta } from "../utils/api";

const browser = new Window({ url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "localStorage"] as const) {
  Object.defineProperty(globalThis, name, { value: name === "window" ? browser : browser[name], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
browser.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
const { StudioSnapshot, useStudio } = await import("../state/store");
const { api } = await import("../utils/api");
const { default: RoutineRunner } = await import("./RoutineRunner");
const { default: RoutineNavigator } = await import("./RoutineNavigator");
after(async () => browser.happyDOM.close());

const param = { name: "P_CUSTOMER", position: 1, direction: "IN", dataType: "NUMBER", hasDefault: false, bindKind: "number", declType: "NUMBER" } as const;
const members: RoutineMember[] = [
  { name: "GET_TOTAL", kind: "FUNCTION", overload: "1", params: [param], returnType: "NUMBER", returnBindKind: "number", returnDeclType: "NUMBER" },
  { name: "GET_TOTAL", kind: "FUNCTION", overload: "2", params: [{ ...param, dataType: "VARCHAR2", bindKind: "string" }], returnType: "NUMBER", returnBindKind: "number", returnDeclType: "NUMBER" },
  { name: "CLOSE_ORDER", kind: "PROCEDURE", overload: null, params: [], returnType: null, returnBindKind: null, returnDeclType: null },
];

function setup(t: TestContext) {
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const change = async (label: string, value: string, select = false) => {
    const control = host.querySelector(`[aria-label="${label}"]`)!;
    assert.ok(control, label);
    await act(async () => {
      const prototype = select ? browser.HTMLSelectElement.prototype : control.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new browser.Event(select ? "change" : "input", { bubbles: true }));
    });
  };
  return { host, root, change };
}

test("routine search combines type and signature terms, retains selection and exposes overloads", async t => {
  const { host, root, change } = setup(t);
  const selections: string[] = [];
  await act(async () => root.render(<RoutineNavigator members={members} selected="GET_TOTAL#1" onSelect={key => selections.push(key)} />));
  await change("Search procedures and functions", "get p_customer varchar2");
  assert.match(host.textContent!, /1 of 3 routines/);
  assert.match(host.querySelector('[aria-label="Matching routines"]')!.textContent!, /overload 2/);
  assert.deepEqual(selections, []);
  await act(async () => host.querySelector('[aria-label="Matching routines"] button')!.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(selections, ["GET_TOTAL#2"]);
  await change("Routine type", "PROCEDURE", true);
  assert.match(host.textContent!, /No matching routines/);
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Clear filters")!.click());
  assert.match(host.textContent!, /3 of 3 routines/);
  assert.equal(host.querySelector('[aria-pressed="true"] strong')?.textContent, "GET_TOTAL");
});

test("switching test members preserves typed inputs, and Ctrl+Enter runs only the selected routine", async t => {
  const { host, root, change } = setup(t);
  t.mock.method(api, "routine", async () => ({ name: "ORDERS_PKG", type: "PACKAGE", members } as RoutineMeta));
  const run = t.mock.method(api, "routineRun", async () => ({ ok: true, member: "GET_TOTAL", source: "form", durationMs: 1, returnValue: 12, outParams: [], cursors: [], dbmsOutput: [], error: null, block: "BEGIN NULL; END;" } as Awaited<ReturnType<typeof api.routineRun>>));
  const state = { activeConnId: "routine-test", connections: [{ id: "routine-test", name: "DEV", live: true, readOnly: false }], toast: () => {}, askConfirm: () => {} } as unknown as ReturnType<typeof useStudio>;
  await act(async () => root.render(<StudioSnapshot value={state}><RoutineRunner routine="ORDERS_PKG" /></StudioSnapshot>));
  await change("Value for P_CUSTOMER", "42");
  const selectMember = async (name: string) => act(async () => [...host.querySelectorAll('.routine-member-list > button')].find(b => b.textContent?.includes(name))!.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })));
  await selectMember("CLOSE_ORDER");
  assert.match(host.textContent!, /No inputs needed/);
  await selectMember("overload 1");
  assert.equal((host.querySelector('[aria-label="Value for P_CUSTOMER"]') as unknown as HTMLTextAreaElement).value, "42");
  let worksheetShortcuts = 0;
  const listener = () => { worksheetShortcuts++; };
  browser.addEventListener("keydown", listener);
  t.after(() => browser.removeEventListener("keydown", listener));
  await act(async () => host.querySelector('[aria-label="Value for P_CUSTOMER"]')!.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
  assert.equal(run.mock.callCount(), 1);
  assert.equal(worksheetShortcuts, 0);
  assert.equal(run.mock.calls[0].arguments[1]!.overload, "1");
  assert.deepEqual(run.mock.calls[0].arguments[1]!.args, [{ name: "P_CUSTOMER", value: "42" }]);
  assert.match(host.textContent!, /EXECUTED/);
});
