import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { Window } from "happy-dom";
import { act, useEffect, useState, type ReactNode } from "react";

const browser = new Window({ url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "localStorage"] as const) {
  Object.defineProperty(globalThis, name, { value: name === "window" ? browser : browser[name], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(browser.document, "visibilityState", { value: "visible", configurable: true });
const { createRoot } = await import("react-dom/client");
const { StudioSnapshot, useStudio } = await import("../state/store");
const { default: RetainedTool } = await import("./RetainedTool");
const { default: JobRunLog } = await import("./JobRunLog");
const { default: PerformanceMonitor } = await import("./PerformanceMonitor");
const { api } = await import("../utils/api");
const capture = () => () => true;
const noop = () => {};
const studio = (id = "a") => ({
  activeConnId: id, captureConnectionStatus: capture, reportConnectionError: noop, toast: noop,
  connections: [{ id, name: `Connection ${id}`, user: "DEMO", engine: "oracle", live: true, status: "connected" }],
}) as unknown as ReturnType<typeof useStudio>;
after(async () => { await browser.happyDOM.close(); });

function setup(t: TestContext) {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = (active: boolean, value: ReturnType<typeof useStudio>, children: ReactNode, connectionScoped = true) => act(async () => {
    root.render(<StudioSnapshot value={value}><RetainedTool active={active} connectionScoped={connectionScoped}>{children}</RetainedTool></StudioSnapshot>);
  });
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
    assert.ok(button, `Missing button: ${label}`);
    await act(async () => button.click());
  };
  return { host, root, render, click };
}

test("tool tabs preserve local state, DOM and scroll on navigation, and release them on close", async t => {
  const { host, root, render, click } = setup(t);
  let loads = 0, disposals = 0;
  function Probe() {
    const [filter, setFilter] = useState("");
    useEffect(() => { loads++; return () => { disposals++; }; }, []);
    return <div data-scroll><input aria-label="Filter" readOnly value={filter} /><button onClick={() => setFilter("slow jobs")}>Set filter</button></div>;
  }
  const value = studio();
  await render(true, value, <Probe />);
  await click("Set filter");
  const input = host.querySelector("input")!;
  const scroll = host.querySelector("[data-scroll]")!;
  scroll.scrollTop = 120;
  await render(false, value, <Probe />);
  assert.equal(host.firstElementChild?.hasAttribute("hidden"), true);
  assert.equal(host.firstElementChild?.hasAttribute("inert"), true);
  await render(true, value, <Probe />);
  assert.equal(host.querySelector("input"), input);
  assert.equal(input.value, "slow jobs");
  assert.equal(scroll.scrollTop, 120);
  assert.equal(loads, 1);
  assert.equal(disposals, 0);
  await act(async () => root.render(null));
  assert.equal(disposals, 1);
  await render(true, value, <Probe />);
  assert.equal(loads, 2);
  assert.equal(host.querySelector("input")?.value, "");
});

test("unvisited tools stay unloaded and hidden tools do not follow connection changes", async t => {
  const { host, render } = setup(t);
  const loaded: string[] = [];
  function Probe() {
    const s = useStudio();
    const [filter, setFilter] = useState("");
    useEffect(() => { loaded.push(s.activeConnId); }, [s.activeConnId]);
    return <button onClick={() => setFilter("old connection draft")}>{s.activeConnId}:{filter}</button>;
  }
  await render(false, studio("a"), <Probe />);
  assert.equal(loaded.length, 0);
  await render(true, studio("a"), <Probe />);
  await act(async () => host.querySelector("button")!.click());
  await render(false, studio("b"), <Probe />);
  assert.deepEqual(loaded, ["a"]);
  assert.match(host.textContent!, /a:old connection draft/);
  await render(true, studio("b"), <Probe />);
  assert.deepEqual(loaded, ["a", "b"]);
  assert.equal(host.textContent, "b:");
});

function timers(t: TestContext) {
  const active = new Map<number, () => void>();
  let id = 0;
  t.mock.method(browser, "setInterval", (callback: () => void) => { active.set(++id, callback); return id; });
  t.mock.method(browser, "clearInterval", (handle: number) => { active.delete(handle); });
  return active;
}

test("Job Runs retains its view, details and output, pauses hidden polling and ignores hidden Escape", async t => {
  const { host, render, click } = setup(t);
  const intervals = timers(t);
  let queries = 0, outputs = 0;
  t.mock.method(api, "query", async (_id: string, sql: string) => {
    queries++;
    const live = sql.includes("user_scheduler_running_jobs");
    return { columns: ["LOG_ID", "JOB_NAME", "STATUS", "DURATION_SECONDS", "STARTED_AT"],
      rows: [[live ? 2 : 1, live ? "ACTIVE_JOB" : "SLOW_JOB", live ? "RUNNING" : "FAILED", live ? 20 : 600, "2026-11-23T10:00:00Z"]],
      durationMs: 1, rowsReturned: 1, error: null };
  });
  t.mock.method(api, "jobRunOutput", async () => { outputs++; return { output: "Captured job output", binaryErrors: null, binaryOutput: null }; });
  const value = studio();
  await render(true, value, <JobRunLog />);
  assert.equal(queries, 2);
  await click("Slow jobs");
  assert.match(host.textContent!, /1 matching executions/);
  const auto = host.querySelector("select")!;
  await act(async () => { auto.value = "15"; auto.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  assert.equal(intervals.size, 1);
  await click("Details");
  await click("Load captured output");
  const dialog = host.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent!, /Captured job output/);
  await render(false, value, <JobRunLog />);
  assert.equal(intervals.size, 0);
  await act(async () => { browser.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape" })); });
  await render(true, value, <JobRunLog />);
  assert.equal(host.querySelector('[role="dialog"]'), dialog);
  assert.equal(queries, 2);
  assert.equal(outputs, 1);
  assert.match(host.textContent!, /1 matching executions/);
  assert.equal(host.querySelector('button[aria-pressed="true"]')?.textContent, "Slow jobs");
  assert.equal(intervals.size, 1);
  await act(async () => { [...intervals.values()][0](); });
  assert.equal(queries, 4);
});

test("Performance keeps its mounted request and resumes its timer without reloading on activation", async t => {
  const { render } = setup(t);
  const intervals = timers(t);
  let requests = 0;
  t.mock.method(api, "perf", () => { requests++; return new Promise(() => {}); });
  const value = studio();
  await render(true, value, <PerformanceMonitor />);
  assert.equal(requests, 1);
  assert.equal(intervals.size, 1);
  await render(false, value, <PerformanceMonitor />);
  assert.equal(intervals.size, 0);
  await act(async () => { browser.document.dispatchEvent(new browser.Event("visibilitychange")); });
  assert.equal(requests, 1);
  await render(true, value, <PerformanceMonitor />);
  assert.equal(requests, 1);
  assert.equal(intervals.size, 1);
  await act(async () => { [...intervals.values()][0](); });
  assert.equal(requests, 2);
});



test("workspace tools with explicit connection choices keep their operation state across Explorer connection changes", async t => {
  const { host, render, click } = setup(t);
  let disposed = 0;
  function MigrationProbe() {
    const [phase, setPhase] = useState("setup");
    useEffect(() => () => { disposed++; }, []);
    return <button onClick={() => setPhase("running")}>{phase}</button>;
  }
  await render(true, studio("a"), <MigrationProbe />, false);
  await click("setup");
  await render(false, studio("b"), <MigrationProbe />, false);
  await render(true, studio("b"), <MigrationProbe />, false);
  assert.equal(host.textContent, "running");
  assert.equal(disposed, 0);
});
