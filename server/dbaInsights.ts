/**
 * DBA Advisor workload insights: finds slow statements and the database objects behind
 * them (PL/SQL programs, views, scheduler jobs), plus sessions, locks and object health.
 *
 * Every query goes through a tolerant runner that yields [] when a view isn't visible
 * with the current privileges, so a partially-privileged user still gets what they can see.
 * Oracle-maintained schemas (SYS, SYSTEM, …) are excluded so the advice is about the
 * application's own workload.
 */
type Row = Record<string, string | number | null>;
type Query = (sql: string) => Promise<Row[]>;

export type InsightSeverity = "good" | "warning" | "serious" | "critical";
export type InsightArea = "sql" | "plsql" | "views" | "jobs" | "sessions" | "objects";

export interface SlowSql {
  sqlId: string;
  schema: string;
  kind: "SELECT" | "DML" | "PL/SQL" | "OTHER";
  executions: number;
  elapsedS: number;
  perExecMs: number;
  cpuPerExecMs: number;
  getsPerExec: number;
  readsPerExec: number;
  rowsPerExec: number;
  planHash: number;
  lastActive: string;
  module: string;
  sqlText: string;
  /** large tables this statement's cached plan full-scans */
  fullScans: { owner: string; table: string; rows: number }[];
}

export interface ProgramStat {
  owner: string;
  name: string;
  type: string;
  statements: number;
  executions: number;
  elapsedS: number;
  cpuS: number;
  bufferGets: number;
  /** most expensive statement inside the program and the source line that issues it */
  topSqlId: string;
  topLine: number | null;
  lastActive: string;
}

export interface ViewStat {
  owner: string;
  name: string;
  statements: number;
  executions: number;
  elapsedS: number;
  perExecMs: number;
  bufferGets: number;
}

export interface MviewIssue { owner: string; name: string; staleness: string; compileState: string; lastRefresh: string; refreshType: string; }

export interface JobStat {
  owner: string;
  name: string;
  runs: number;
  failures: number;
  avgS: number;
  maxS: number;
  lastStart: string;
  lastStatus: string;
  lastError: string;
}

export interface RunningJob { owner: string; name: string; sid: number | null; elapsedS: number; cpuS: number; }

export interface ActiveSession {
  sid: number;
  serial: number;
  user: string;
  sqlId: string;
  seconds: number;
  event: string;
  waitClass: string;
  blockingSid: number | null;
  module: string;
}

export interface LongOp { sid: number; user: string; operation: string; target: string; pct: number; elapsedS: number; remainingS: number; sqlId: string; }
export interface InvalidObject { owner: string; name: string; type: string; lastDdl: string; }
export interface StaleTable { owner: string; table: string; rows: number | null; lastAnalyzed: string; reason: "stale" | "never analyzed"; }

export interface InsightFinding { severity: InsightSeverity; area: InsightArea; title: string; detail: string; }

export interface DbaInsights {
  sampledAt: string;
  /** which sections could be read — false means the view wasn't visible to this user */
  visible: Record<InsightArea, boolean>;
  slowSql: SlowSql[];
  programs: ProgramStat[];
  views: ViewStat[];
  mviews: MviewIssue[];
  jobs: JobStat[];
  runningJobs: RunningJob[];
  activeSessions: ActiveSession[];
  longOps: LongOp[];
  invalidObjects: InvalidObject[];
  staleStats: StaleTable[];
  findings: InsightFinding[];
}

/** Used when ALL_USERS.ORACLE_MAINTAINED isn't available (pre-12.2). */
export const FALLBACK_SYSTEM_SCHEMAS = [
  "SYS", "SYSTEM", "SYSMAN", "SYSBACKUP", "SYSDG", "SYSKM", "SYSRAC", "AUDSYS", "DBSNMP", "OUTLN",
  "XDB", "MDSYS", "CTXSYS", "ORDSYS", "ORDDATA", "ORDPLUGINS", "OLAPSYS", "WMSYS", "EXFSYS", "LBACSYS",
  "DVSYS", "DVF", "GSMADMIN_INTERNAL", "GSMCATUSER", "GSMUSER", "APPQOSSYS", "OJVMSYS", "DBSFWUSER",
  "REMOTE_SCHEDULER_AGENT", "GGSYS", "ANONYMOUS", "XS$NULL", "MDDATA", "SI_INFORMTN_SCHEMA",
  "C##CLOUD$SERVICE", "C##ADP$SERVICE", "C##OMLIDM", "C##API", "ADBSNMP", "C##DV_ACCT_ADMIN", "C##DV_OWNER",
];

const n = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const nOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const SQL_ID = /^[0-9a-z]{13}$/;

const COMMAND_KIND: Record<number, SlowSql["kind"]> = { 3: "SELECT", 2: "DML", 6: "DML", 7: "DML", 189: "DML", 47: "PL/SQL" };

/** Seconds from an INTERVAL DAY TO SECOND column, computed in SQL. */
const intervalSecs = (col: string) =>
  `(EXTRACT(DAY FROM ${col})*86400 + EXTRACT(HOUR FROM ${col})*3600 + EXTRACT(MINUTE FROM ${col})*60 + EXTRACT(SECOND FROM ${col}))`;

export async function systemSchemas(q: Query): Promise<string[]> {
  const rows = await q(`SELECT username AS "u" FROM all_users WHERE oracle_maintained = 'Y'`);
  const names = new Set(FALLBACK_SYSTEM_SCHEMAS);
  for (const r of rows) if (r.u) names.add(String(r.u));
  return [...names];
}

/** Prefix on every advisor query so its own statements can be excluded from the slow-SQL list. */
export const ADVISOR_TAG = "/* DataForge advisor */";

export async function readDbaInsights(run: Query): Promise<DbaInsights> {
  const q: Query = (sql) => run(`${ADVISOR_TAG} ${sql}`);
  const sys = await systemSchemas(q);
  const notSys = (col: string) => `${col} NOT IN (${sys.map(lit).join(",")})`;

  // ---- slow statements: top by per-execution time and by total time, merged ----
  const sqlCols = `sql_id AS "sqlId", parsing_schema_name AS "schema", command_type AS "cmd", executions AS "execs",
      ROUND(elapsed_time/1e6, 2) AS "elapsedS",
      ROUND(elapsed_time/GREATEST(executions,1)/1000, 2) AS "perExecMs",
      ROUND(cpu_time/GREATEST(executions,1)/1000, 2) AS "cpuMs",
      ROUND(buffer_gets/GREATEST(executions,1)) AS "gets",
      ROUND(disk_reads/GREATEST(executions,1)) AS "reads",
      ROUND(rows_processed/GREATEST(executions,1)) AS "rowsPer",
      plan_hash_value AS "planHash", TO_CHAR(last_active_time,'YYYY-MM-DD HH24:MI:SS') AS "lastActive",
      NVL(module,'') AS "module",
      SUBSTR(REPLACE(REPLACE(sql_text, CHR(10), ' '), CHR(13), ' '), 1, 400) AS "sqlText"`;
  const sqlWhere = `WHERE executions > 0 AND command_type IN (2,3,6,7,47,189) AND ${notSys("parsing_schema_name")}
      AND sql_text NOT LIKE '%/* DataForge advisor */%'`;
  const [byExec, byTotal] = await Promise.all([
    q(`SELECT ${sqlCols} FROM v$sqlarea ${sqlWhere} ORDER BY elapsed_time/GREATEST(executions,1) DESC FETCH FIRST 30 ROWS ONLY`),
    q(`SELECT ${sqlCols} FROM v$sqlarea ${sqlWhere} ORDER BY elapsed_time DESC FETCH FIRST 30 ROWS ONLY`),
  ]);
  const seen = new Set<string>();
  const slowSql: SlowSql[] = [];
  for (const r of [...byTotal, ...byExec]) {
    const id = s(r.sqlId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    slowSql.push({
      sqlId: id, schema: s(r.schema), kind: COMMAND_KIND[n(r.cmd)] ?? "OTHER", executions: n(r.execs),
      elapsedS: n(r.elapsedS), perExecMs: n(r.perExecMs), cpuPerExecMs: n(r.cpuMs), getsPerExec: n(r.gets),
      readsPerExec: n(r.reads), rowsPerExec: n(r.rowsPer), planHash: n(r.planHash), lastActive: s(r.lastActive),
      module: s(r.module), sqlText: s(r.sqlText), fullScans: [],
    });
  }
  const ids = slowSql.map((x) => x.sqlId).filter((id) => SQL_ID.test(id));
  if (ids.length) {
    const scans = await q(
      `SELECT DISTINCT p.sql_id AS "sqlId", p.object_owner AS "owner", p.object_name AS "tbl", t.num_rows AS "numRows"
       FROM v$sql_plan p JOIN all_tables t ON t.owner = p.object_owner AND t.table_name = p.object_name
       WHERE p.operation = 'TABLE ACCESS' AND p.options LIKE '%FULL%' AND t.num_rows >= 100000
         AND p.sql_id IN (${ids.map(lit).join(",")})`
    );
    for (const sc of scans) {
      const target = slowSql.find((x) => x.sqlId === sc.sqlId);
      if (target && !target.fullScans.some((f) => f.owner === sc.owner && f.table === sc.tbl))
        target.fullScans.push({ owner: s(sc.owner), table: s(sc.tbl), rows: n(sc.numRows) });
    }
  }

  // ---- PL/SQL programs (procedures, functions, packages, triggers) by SQL time they issue ----
  const programRows = await q(
    `SELECT o.owner AS "owner", o.object_name AS "name", o.object_type AS "type",
            COUNT(DISTINCT s.sql_id) AS "stmts", SUM(s.executions) AS "execs",
            ROUND(SUM(s.elapsed_time)/1e6, 2) AS "elapsedS", ROUND(SUM(s.cpu_time)/1e6, 2) AS "cpuS",
            SUM(s.buffer_gets) AS "gets",
            MAX(s.sql_id) KEEP (DENSE_RANK LAST ORDER BY s.elapsed_time) AS "topSqlId",
            MAX(s.program_line#) KEEP (DENSE_RANK LAST ORDER BY s.elapsed_time) AS "topLine",
            TO_CHAR(MAX(s.last_active_time),'YYYY-MM-DD HH24:MI:SS') AS "lastActive"
     FROM v$sqlarea s JOIN all_objects o ON o.object_id = s.program_id
     WHERE s.program_id > 0 AND ${notSys("o.owner")}
     GROUP BY o.owner, o.object_name, o.object_type
     ORDER BY SUM(s.elapsed_time) DESC FETCH FIRST 25 ROWS ONLY`
  );
  const programs: ProgramStat[] = programRows.map((r) => ({
    owner: s(r.owner), name: s(r.name), type: s(r.type), statements: n(r.stmts), executions: n(r.execs),
    elapsedS: n(r.elapsedS), cpuS: n(r.cpuS), bufferGets: n(r.gets), topSqlId: s(r.topSqlId),
    topLine: nOrNull(r.topLine), lastActive: s(r.lastActive),
  }));

  // ---- views referenced by cached statements (TO_TYPE 4 = VIEW) ----
  const viewRows = await q(
    `SELECT d.to_owner AS "owner", d.to_name AS "name", COUNT(DISTINCT s.sql_id) AS "stmts",
            SUM(s.executions) AS "execs", ROUND(SUM(s.elapsed_time)/1e6, 2) AS "elapsedS",
            ROUND(SUM(s.elapsed_time)/GREATEST(SUM(s.executions),1)/1000, 2) AS "perExecMs",
            SUM(s.buffer_gets) AS "gets"
     FROM v$object_dependency d JOIN v$sqlarea s ON s.address = d.from_address AND s.hash_value = d.from_hash
     WHERE d.to_type = 4 AND ${notSys("d.to_owner")} AND s.executions > 0
     GROUP BY d.to_owner, d.to_name
     ORDER BY SUM(s.elapsed_time) DESC FETCH FIRST 25 ROWS ONLY`
  );
  const views: ViewStat[] = viewRows.map((r) => ({
    owner: s(r.owner), name: s(r.name), statements: n(r.stmts), executions: n(r.execs),
    elapsedS: n(r.elapsedS), perExecMs: n(r.perExecMs), bufferGets: n(r.gets),
  }));
  const mviewRows = await q(
    `SELECT owner AS "owner", mview_name AS "name", staleness AS "staleness", compile_state AS "compileState",
            TO_CHAR(last_refresh_date,'YYYY-MM-DD HH24:MI') AS "lastRefresh", last_refresh_type AS "refreshType"
     FROM all_mviews
     WHERE ${notSys("owner")} AND (staleness NOT IN ('FRESH','UNDEFINED') OR compile_state <> 'VALID')
     ORDER BY owner, mview_name FETCH FIRST 30 ROWS ONLY`
  );
  const mviews: MviewIssue[] = mviewRows.map((r) => ({
    owner: s(r.owner), name: s(r.name), staleness: s(r.staleness), compileState: s(r.compileState),
    lastRefresh: s(r.lastRefresh), refreshType: s(r.refreshType),
  }));

  // ---- scheduler jobs: last 7 days of runs, plus whatever is running now ----
  const dur = intervalSecs("run_duration");
  const jobSql = (lastError: string) =>
    `SELECT owner AS "owner", job_name AS "name", COUNT(*) AS "runs",
            SUM(CASE WHEN status <> 'SUCCEEDED' THEN 1 ELSE 0 END) AS "failures",
            ROUND(AVG(${dur}), 1) AS "avgS", ROUND(MAX(${dur}), 1) AS "maxS",
            TO_CHAR(MAX(actual_start_date),'YYYY-MM-DD HH24:MI') AS "lastStart",
            MAX(status) KEEP (DENSE_RANK LAST ORDER BY log_date) AS "lastStatus",
            ${lastError} AS "lastError"
     FROM all_scheduler_job_run_details
     WHERE log_date > SYSTIMESTAMP - INTERVAL '7' DAY AND ${notSys("owner")}
     GROUP BY owner, job_name
     ORDER BY SUM(CASE WHEN status <> 'SUCCEEDED' THEN 1 ELSE 0 END) DESC, MAX(${dur}) DESC NULLS LAST
     FETCH FIRST 30 ROWS ONLY`;
  let jobRows = await q(jobSql(`MAX(DBMS_LOB.SUBSTR(additional_info, 300, 1)) KEEP (DENSE_RANK LAST ORDER BY CASE WHEN status <> 'SUCCEEDED' THEN log_date END NULLS FIRST)`));
  // ADDITIONAL_INFO is VARCHAR2 on some releases and CLOB on others; retry without it if needed.
  if (!jobRows.length) jobRows = await q(jobSql(`NULL`));
  const jobs: JobStat[] = jobRows.map((r) => ({
    owner: s(r.owner), name: s(r.name), runs: n(r.runs), failures: n(r.failures), avgS: n(r.avgS), maxS: n(r.maxS),
    lastStart: s(r.lastStart), lastStatus: s(r.lastStatus), lastError: n(r.failures) > 0 ? s(r.lastError) : "",
  }));
  const runningRows = await q(
    `SELECT owner AS "owner", job_name AS "name", session_id AS "sid",
            ROUND(${intervalSecs("elapsed_time")}) AS "elapsedS", ROUND(NVL(${intervalSecs("cpu_used")},0)) AS "cpuS"
     FROM all_scheduler_running_jobs WHERE ${notSys("owner")} ORDER BY elapsed_time DESC`
  );
  const runningJobs: RunningJob[] = runningRows.map((r) => ({
    owner: s(r.owner), name: s(r.name), sid: nOrNull(r.sid), elapsedS: n(r.elapsedS), cpuS: n(r.cpuS),
  }));

  // ---- sessions: long-running active calls and blocking chains ----
  const sessRows = await q(
    `SELECT sid AS "sid", serial# AS "serial", NVL(username,'(background)') AS "usr", NVL(sql_id,'') AS "sqlId",
            last_call_et AS "secs", NVL(event,'') AS "event", NVL(wait_class,'') AS "waitClass",
            blocking_session AS "blocker", NVL(module,'') AS "module"
     FROM v$session
     WHERE type = 'USER' AND sid <> SYS_CONTEXT('USERENV','SID')
       AND ((status = 'ACTIVE' AND last_call_et >= 5) OR blocking_session IS NOT NULL)
     ORDER BY CASE WHEN blocking_session IS NOT NULL THEN 0 ELSE 1 END, last_call_et DESC
     FETCH FIRST 25 ROWS ONLY`
  );
  const activeSessions: ActiveSession[] = sessRows.map((r) => ({
    sid: n(r.sid), serial: n(r.serial), user: s(r.usr), sqlId: s(r.sqlId), seconds: n(r.secs), event: s(r.event),
    waitClass: s(r.waitClass), blockingSid: nOrNull(r.blocker), module: s(r.module),
  }));
  const longRows = await q(
    `SELECT sid AS "sid", NVL(username,'') AS "usr", opname AS "op", NVL(target,'') AS "target",
            ROUND(sofar/NULLIF(totalwork,0)*100, 1) AS "pct", elapsed_seconds AS "elapsedS",
            time_remaining AS "remainingS", NVL(sql_id,'') AS "sqlId"
     FROM v$session_longops WHERE time_remaining > 0 AND sofar < totalwork
     ORDER BY elapsed_seconds DESC FETCH FIRST 15 ROWS ONLY`
  );
  const longOps: LongOp[] = longRows.map((r) => ({
    sid: n(r.sid), user: s(r.usr), operation: s(r.op), target: s(r.target), pct: n(r.pct),
    elapsedS: n(r.elapsedS), remainingS: n(r.remainingS), sqlId: s(r.sqlId),
  }));

  // ---- object health: invalid code and missing/stale optimizer statistics ----
  const invalidRows = await q(
    `SELECT owner AS "owner", object_name AS "name", object_type AS "type",
            TO_CHAR(last_ddl_time,'YYYY-MM-DD HH24:MI') AS "lastDdl"
     FROM all_objects WHERE status = 'INVALID' AND ${notSys("owner")} AND object_name NOT LIKE 'BIN$%'
     ORDER BY owner, object_type, object_name FETCH FIRST 60 ROWS ONLY`
  );
  const invalidObjects: InvalidObject[] = invalidRows.map((r) => ({ owner: s(r.owner), name: s(r.name), type: s(r.type), lastDdl: s(r.lastDdl) }));
  const staleRows = await q(
    `SELECT owner AS "owner", table_name AS "tbl", num_rows AS "numRows",
            TO_CHAR(last_analyzed,'YYYY-MM-DD') AS "lastAnalyzed", stale_stats AS "stale"
     FROM all_tab_statistics
     WHERE object_type = 'TABLE' AND ${notSys("owner")} AND table_name NOT LIKE 'BIN$%'
       AND (stale_stats = 'YES' OR last_analyzed IS NULL)
     ORDER BY num_rows DESC NULLS LAST FETCH FIRST 40 ROWS ONLY`
  );
  const staleStats: StaleTable[] = staleRows.map((r) => ({
    owner: s(r.owner), table: s(r.tbl), rows: nOrNull(r.numRows), lastAnalyzed: s(r.lastAnalyzed),
    reason: r.lastAnalyzed ? "stale" : "never analyzed",
  }));

  // A COUNT(*) always returns one row when the view is readable, so [] means "not visible".
  const probe = async (view: string) => (await q(`SELECT COUNT(*) AS "x" FROM ${view} WHERE ROWNUM = 1`)).length > 0;
  const [sqlVisible, jobsVisible, sessVisible] = await Promise.all([
    probe("v$sqlarea"),
    probe("all_scheduler_job_run_details"),
    probe("v$session"),
  ]);

  const insights: Omit<DbaInsights, "findings"> = {
    sampledAt: new Date().toISOString(),
    visible: { sql: sqlVisible, plsql: sqlVisible, views: sqlVisible, jobs: jobsVisible, sessions: sessVisible, objects: true },
    slowSql, programs, views, mviews, jobs, runningJobs, activeSessions, longOps, invalidObjects, staleStats,
  };
  return { ...insights, findings: buildInsightFindings(insights) };
}

const fmtS = (secs: number) =>
  secs >= 3600 ? `${(secs / 3600).toFixed(1)} h` : secs >= 60 ? `${(secs / 60).toFixed(1)} min` : `${secs.toFixed(secs < 10 ? 1 : 0)} s`;
const fmtMs = (ms: number) => (ms >= 1000 ? fmtS(ms / 1000) : `${Math.round(ms)} ms`);

/** Thresholds used to turn raw workload numbers into findings — exported for the UI legend and tests. */
export const THRESHOLDS = {
  slowMs: 1000,
  verySlowMs: 5000,
  heavyGets: 100_000,
  slowViewMs: 1000,
  longJobS: 3600,
  blockedSeriousS: 60,
  longCallS: 600,
};

export function buildInsightFindings(i: Omit<DbaInsights, "findings">): InsightFinding[] {
  const out: InsightFinding[] = [];
  const t = THRESHOLDS;

  const slow = i.slowSql.filter((x) => x.perExecMs >= t.slowMs);
  const slowSelects = slow.filter((x) => x.kind === "SELECT");
  if (slowSelects.length) {
    const worst = slowSelects.reduce((a, b) => (b.perExecMs > a.perExecMs ? b : a));
    out.push({
      severity: worst.perExecMs >= t.verySlowMs ? "serious" : "warning", area: "sql",
      title: `${slowSelects.length} slow SELECT${slowSelects.length === 1 ? "" : "s"} (≥ ${fmtMs(t.slowMs)}/exec)`,
      detail: `Slowest is ${worst.sqlId} at ${fmtMs(worst.perExecMs)} per execution (${worst.schema}). Check its execution plan for full scans and missing indexes.`,
    });
  }
  const slowDml = slow.filter((x) => x.kind !== "SELECT");
  if (slowDml.length) {
    const worst = slowDml.reduce((a, b) => (b.perExecMs > a.perExecMs ? b : a));
    out.push({
      severity: worst.perExecMs >= t.verySlowMs ? "serious" : "warning", area: "sql",
      title: `${slowDml.length} slow DML / PL/SQL call${slowDml.length === 1 ? "" : "s"}`,
      detail: `Slowest is ${worst.sqlId} (${worst.kind}) at ${fmtMs(worst.perExecMs)} per execution.`,
    });
  }
  const scanners = i.slowSql.filter((x) => x.fullScans.length > 0);
  if (scanners.length) {
    const tables = [...new Set(scanners.flatMap((x) => x.fullScans.map((f) => `${f.owner}.${f.table}`)))];
    out.push({
      severity: "warning", area: "sql",
      title: `Full scans of large tables in ${scanners.length} top statement${scanners.length === 1 ? "" : "s"}`,
      detail: `Cached plans full-scan ${tables.slice(0, 4).join(", ")}${tables.length > 4 ? ` and ${tables.length - 4} more` : ""} (≥ 100k rows). An index on the filter columns may help.`,
    });
  }
  const heavy = i.slowSql.filter((x) => x.getsPerExec >= t.heavyGets);
  if (heavy.length)
    out.push({
      severity: "warning", area: "sql",
      title: `${heavy.length} statement${heavy.length === 1 ? "" : "s"} reading ≥ ${t.heavyGets.toLocaleString()} blocks/exec`,
      detail: "High logical I/O per execution usually means an inefficient access path or a missing join predicate.",
    });

  const totalProgS = i.programs.reduce((a, p) => a + p.elapsedS, 0);
  const topProg = i.programs[0];
  if (topProg && topProg.elapsedS >= 60 && totalProgS > 0)
    out.push({
      severity: topProg.elapsedS / totalProgS > 0.5 ? "serious" : "warning", area: "plsql",
      title: `${topProg.type.toLowerCase()} ${topProg.owner}.${topProg.name} dominates PL/SQL time`,
      detail: `Its SQL has used ${fmtS(topProg.elapsedS)} (${Math.round((topProg.elapsedS / totalProgS) * 100)}% of PL/SQL-issued SQL time)${topProg.topLine ? `; the costliest statement is at line ${topProg.topLine} (${topProg.topSqlId})` : ""}.`,
    });

  const slowViews = i.views.filter((v) => v.perExecMs >= t.slowViewMs);
  if (slowViews.length)
    out.push({
      severity: "warning", area: "views",
      title: `${slowViews.length} slow view${slowViews.length === 1 ? "" : "s"}`,
      detail: `Queries over ${slowViews.slice(0, 3).map((v) => `${v.owner}.${v.name}`).join(", ")} average ≥ ${fmtMs(t.slowViewMs)} per execution. Consider pushing predicates down, indexing base tables, or a materialized view.`,
    });
  if (i.mviews.length)
    out.push({
      severity: "warning", area: "views",
      title: `${i.mviews.length} materialized view${i.mviews.length === 1 ? "" : "s"} stale or invalid`,
      detail: `${i.mviews.slice(0, 3).map((m) => `${m.owner}.${m.name} (${m.staleness}/${m.compileState})`).join(", ")}. Queries rewritten against them may return old data or skip rewrite.`,
    });

  const failing = i.jobs.filter((j) => j.failures > 0);
  if (failing.length)
    out.push({
      severity: failing.some((j) => j.lastStatus !== "SUCCEEDED") ? "serious" : "warning", area: "jobs",
      title: `${failing.length} scheduler job${failing.length === 1 ? "" : "s"} failed in the last 7 days`,
      detail: failing.slice(0, 3).map((j) => `${j.owner}.${j.name}: ${j.failures}/${j.runs} failed, last ${j.lastStatus || "unknown"}`).join("; ") + ".",
    });
  const erratic = i.jobs.filter((j) => j.runs >= 3 && j.maxS >= 60 && j.maxS > j.avgS * 3);
  if (erratic.length)
    out.push({
      severity: "warning", area: "jobs",
      title: `${erratic.length} job${erratic.length === 1 ? "" : "s"} with erratic run times`,
      detail: erratic.slice(0, 3).map((j) => `${j.owner}.${j.name}: max ${fmtS(j.maxS)} vs avg ${fmtS(j.avgS)}`).join("; ") + ". Look for lock waits or plan changes on the slow runs.",
    });
  const longJobs = i.runningJobs.filter((j) => j.elapsedS >= t.longJobS);
  if (longJobs.length)
    out.push({
      severity: "warning", area: "jobs",
      title: `${longJobs.length} job${longJobs.length === 1 ? "" : "s"} running for over ${fmtS(t.longJobS)}`,
      detail: longJobs.map((j) => `${j.owner}.${j.name} (${fmtS(j.elapsedS)})`).join(", ") + ".",
    });

  const blocked = i.activeSessions.filter((x) => x.blockingSid !== null);
  if (blocked.length) {
    const longest = Math.max(...blocked.map((x) => x.seconds));
    const blockers = [...new Set(blocked.map((x) => x.blockingSid))];
    out.push({
      severity: longest >= t.blockedSeriousS * 5 ? "critical" : longest >= t.blockedSeriousS ? "serious" : "warning", area: "sessions",
      title: `${blocked.length} session${blocked.length === 1 ? "" : "s"} blocked by SID ${blockers.join(", ")}`,
      detail: `Longest wait ${fmtS(longest)} on "${blocked[0].event}". Commit/rollback the blocker or kill it if it's abandoned.`,
    });
  }
  const longCalls = i.activeSessions.filter((x) => x.blockingSid === null && x.seconds >= t.longCallS);
  if (longCalls.length)
    out.push({
      severity: "warning", area: "sessions",
      title: `${longCalls.length} call${longCalls.length === 1 ? "" : "s"} active for over ${fmtS(t.longCallS)}`,
      detail: longCalls.slice(0, 3).map((x) => `SID ${x.sid} ${x.user}${x.sqlId ? ` (${x.sqlId})` : ""} ${fmtS(x.seconds)}`).join("; ") + ".",
    });

  if (i.invalidObjects.length) {
    const byType = i.invalidObjects.reduce<Record<string, number>>((a, o) => ((a[o.type] = (a[o.type] ?? 0) + 1), a), {});
    out.push({
      severity: i.invalidObjects.length >= 10 ? "serious" : "warning", area: "objects",
      title: `${i.invalidObjects.length}${i.invalidObjects.length >= 60 ? "+" : ""} invalid object${i.invalidObjects.length === 1 ? "" : "s"}`,
      detail: `${Object.entries(byType).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}. Callers fail or recompile on first use — recompile them.`,
    });
  }
  const bigStale = i.staleStats.filter((x) => (x.rows ?? 0) >= 100_000 || x.reason === "never analyzed");
  if (bigStale.length)
    out.push({
      severity: "warning", area: "objects",
      title: `${bigStale.length} table${bigStale.length === 1 ? "" : "s"} with stale or missing optimizer statistics`,
      detail: `${bigStale.slice(0, 4).map((x) => `${x.owner}.${x.table}`).join(", ")}. Bad statistics are a common cause of sudden plan regressions.`,
    });

  return out;
}
