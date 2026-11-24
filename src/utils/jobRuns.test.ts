import assert from "node:assert/strict";
import test from "node:test";
import { durationText, filterJobRuns, jobPerformance, parseJobRuns, type JobRun, type RunFilters } from "./jobRuns";
import type { LiveQueryResult } from "./api";

const run = (changes: Partial<JobRun> = {}): JobRun => ({
  key: "1", live: false, id: 1, job: "DAILY_LOAD", step: "", status: "SUCCEEDED",
  started: "2026-11-23T10:00:00.000-06:00", logged: "2026-11-23T10:01:00.000-06:00", requested: "",
  duration: 60, cpu: 10, delay: 0, instance: "1", session: "20", error: "0", info: "", ...changes,
});
const filters: RunFilters = { search: "", status: "all", hours: 0, slowSeconds: 300, view: "all", sort: "recent" };
const now = Date.parse("2026-11-23T11:00:00-06:00");

test("scheduler mapping handles reordered columns, absent CPU, timestamps and zero durations", () => {
  const result: LiveQueryResult = { columns: ["JOB_NAME", "DURATION_SECONDS", "CPU_SECONDS", "LOG_ID", "STARTED_AT", "STATUS", "ADDITIONAL_INFO"],
    rows: [["DAILY_LOAD", 0, null, 12, "2026-11-23T10:00:00.000-06:00", "RUNNING", "Unicode details: résumé ✓"]], error: null, durationMs: 1, rowsReturned: 1 };
  const [mapped] = parseJobRuns(result, true);
  assert.equal(mapped.id, 12);
  assert.equal(mapped.live, true);
  assert.equal(mapped.duration, 0);
  assert.equal(mapped.cpu, null);
  assert.equal(mapped.started, result.rows[0][4]);
  assert.equal(mapped.info, "Unicode details: résumé ✓");
  assert.throws(() => parseJobRuns({ ...result, error: { code: "ORA-00942", line: 1, message: "View access denied" } }), /View access denied/);
});

test("filters combine timezone-aware time windows, status and job/error search", () => {
  const rows = [run(), run({ key: "2", status: "FAILED", error: "20001", started: "2026-11-23T16:30:00Z" }),
    run({ key: "3", status: "FAILED", error: "20001", started: "2026-11-21T16:30:00Z" })];
  assert.deepEqual(filterJobRuns(rows, { ...filters, search: " 20001 ", hours: 1, status: "FAILED" }, now).map(r => r.key), ["2"]);
  assert.equal(filterJobRuns(rows, { ...filters, search: "daily_load" }, now).length, 3);
  assert.equal(filterJobRuns([run({ started: "", logged: "" })], { ...filters, hours: 1 }, now).length, 0);
});

test("running and slow views include active elapsed time, with inclusive thresholds and missing-value sorting", () => {
  const rows = [run({ key: "unknown", duration: null }), run({ key: "fast", duration: 0 }),
    run({ key: "slow", duration: 300 }), run({ key: "active", live: true, status: "RUNNING", duration: 600 })];
  assert.deepEqual(filterJobRuns(rows, { ...filters, view: "running" }, now).map(r => r.key), ["active"]);
  assert.deepEqual(filterJobRuns(rows, { ...filters, view: "slow", sort: "duration" }, now).map(r => r.key), ["active", "slow"]);
  assert.deepEqual(filterJobRuns(rows, { ...filters, sort: "duration" }, now).map(r => r.key), ["active", "slow", "fast", "unknown"]);
});

test("performance excludes running jobs and missing metrics, keeps steps separate, and calculates nearest-rank P95", () => {
  const rows = Array.from({ length: 20 }, (_, i) => run({ duration: i + 1, cpu: null, delay: 2 }));
  rows.push(run({ duration: null, cpu: null, delay: null, status: "FAILED" }),
    run({ live: true, status: "RUNNING", duration: 9999 }), run({ step: "STEP_A", duration: 50, status: "STOPPED" }));
  const groups = jobPerformance(rows);
  const parent = groups.find(group => !group.step)!;
  assert.equal(parent.count, 21);
  assert.equal(parent.succeeded, 20);
  assert.equal(parent.failed, 1);
  assert.equal(parent.average, 10.5);
  assert.equal(parent.p95, 19);
  assert.equal(parent.max, 20);
  assert.equal(parent.cpu, null);
  assert.equal(parent.delay, 2);
  assert.equal(groups.find(group => group.step === "STEP_A")?.failed, 1);
  assert.equal(jobPerformance([run({ duration: null, cpu: null, delay: null })])[0].p95, null);
});

test("duration formatting preserves unknown, zero, fractional and multi-day values", () => {
  assert.equal(durationText(null), "—");
  assert.equal(durationText(0), "0s");
  assert.equal(durationText(0.25), "0.25s");
  assert.equal(durationText(90061.5), "1d 1h 1m 1.5s");
  assert.equal(durationText(59.999), "1m");
});

test("performance accounts for every recorded non-success outcome and excludes running snapshots", () => {
  const [stats] = jobPerformance([
    run(), run({ status: "FAILED" }), run({ status: "STOPPED" }),
    run({ status: "CHAIN_STALLED" }), run({ status: "UNKNOWN_OUTCOME" }),
    run({ live: true, status: "RUNNING" }),
  ]);
  assert.equal(stats.count, 5);
  assert.equal(stats.succeeded, 1);
  assert.equal(stats.failed, 4);
  assert.equal(stats.succeeded + stats.failed, stats.count);
});
