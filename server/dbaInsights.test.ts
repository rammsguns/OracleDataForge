import test from "node:test";
import assert from "node:assert/strict";
import { buildInsightFindings, readDbaInsights, type DbaInsights } from "./dbaInsights.ts";

const empty = (): Omit<DbaInsights, "findings"> => ({
  sampledAt: "", visible: { sql: true, plsql: true, views: true, jobs: true, sessions: true, objects: true },
  slowSql: [], programs: [], views: [], mviews: [], jobs: [], runningJobs: [], activeSessions: [], longOps: [], invalidObjects: [], staleStats: [],
});

test("no privileges: everything empty, sections not visible, no findings", async () => {
  const r = await readDbaInsights(async () => []);
  assert.equal(r.visible.sql, false);
  assert.equal(r.visible.sessions, false);
  assert.deepEqual(r.slowSql, []);
  assert.deepEqual(r.findings, []);
});

test("system schemas are excluded and statement lists merge without duplicates", async () => {
  const seen: string[] = [];
  const row = { sqlId: "abcdefghijk12", schema: "APP", cmd: 3, execs: 2, elapsedS: 12, perExecMs: 6000, cpuMs: 100, gets: 5, reads: 0, rowsPer: 1, planHash: 1, lastActive: "", module: "", sqlText: "SELECT 1" };
  const r = await readDbaInsights(async (sql) => {
    seen.push(sql);
    if (sql.includes("oracle_maintained")) return [{ u: "CUSTOM_SYS" }];
    if (sql.includes("FROM v$sqlarea WHERE executions")) return [row];
    if (sql.includes("v$sql_plan")) return [{ sqlId: "abcdefghijk12", owner: "APP", tbl: "BIG", numRows: 500000 }];
    if (sql.includes("COUNT(*)")) return [{ x: 1 }];
    return [];
  });
  assert.equal(r.slowSql.length, 1);
  assert.deepEqual(r.slowSql[0].fullScans, [{ owner: "APP", table: "BIG", rows: 500000 }]);
  assert.equal(r.slowSql[0].kind, "SELECT");
  assert.ok(seen.find((q) => q.includes("v$sqlarea WHERE executions"))!.includes("'CUSTOM_SYS'"));
  // every advisor query is tagged so it can exclude itself from the slow-SQL list
  assert.ok(seen.every((q) => q.startsWith("/* DataForge advisor */")));
  assert.ok(r.findings.some((f) => f.area === "sql" && f.severity === "serious"));
  assert.ok(r.findings.some((f) => /Full scans/.test(f.title)));
});

test("unsafe SQL ids are never interpolated into the plan query", async () => {
  const seen: string[] = [];
  await readDbaInsights(async (sql) => {
    seen.push(sql);
    if (sql.includes("FROM v$sqlarea WHERE executions")) return [{ sqlId: "x') OR 1=1 --", cmd: 3, execs: 1 }];
    return [];
  });
  assert.ok(!seen.some((q) => q.includes("v$sql_plan")));
});

test("findings cover jobs, blocking sessions, invalid objects and stale stats", () => {
  const i = empty();
  i.jobs = [
    { owner: "APP", name: "NIGHTLY", runs: 7, failures: 2, avgS: 30, maxS: 400, lastStart: "", lastStatus: "FAILED", lastError: "ORA-1" },
  ];
  i.activeSessions = [{ sid: 10, serial: 1, user: "APP", sqlId: "", seconds: 400, event: "enq: TX - row lock contention", waitClass: "Application", blockingSid: 22, module: "" }];
  i.invalidObjects = [{ owner: "APP", name: "P1", type: "PROCEDURE", lastDdl: "" }];
  i.staleStats = [{ owner: "APP", table: "T", rows: 2_000_000, lastAnalyzed: "2020-01-01", reason: "stale" }];
  const f = buildInsightFindings(i);
  const by = (area: string) => f.filter((x) => x.area === area);
  assert.equal(by("jobs").find((x) => /failed/.test(x.title))?.severity, "serious");
  assert.ok(by("jobs").some((x) => /erratic/.test(x.title)));
  assert.equal(by("sessions")[0].severity, "critical");
  assert.match(by("sessions")[0].title, /SID 22/);
  assert.ok(by("objects").some((x) => /invalid/.test(x.title)));
  assert.ok(by("objects").some((x) => /statistics/.test(x.title)));
});

test("a dominant PL/SQL program and slow views are reported", () => {
  const i = empty();
  i.programs = [
    { owner: "APP", name: "PKG_BILLING", type: "PACKAGE BODY", statements: 4, executions: 10, elapsedS: 900, cpuS: 100, bufferGets: 1, topSqlId: "abc", topLine: 42, lastActive: "" },
    { owner: "APP", name: "F_TAX", type: "FUNCTION", statements: 1, executions: 10, elapsedS: 100, cpuS: 10, bufferGets: 1, topSqlId: "def", topLine: 3, lastActive: "" },
  ];
  i.views = [{ owner: "APP", name: "V_SALES", statements: 2, executions: 4, elapsedS: 20, perExecMs: 5000, bufferGets: 1 }];
  const f = buildInsightFindings(i);
  const prog = f.find((x) => x.area === "plsql")!;
  assert.equal(prog.severity, "serious");
  assert.match(prog.detail, /line 42/);
  assert.ok(f.some((x) => x.area === "views" && /V_SALES/.test(x.detail)));
});
