import type { InsightArea, InsightSeverity } from "./api";

/** Penalty each finding takes off a 100-point health score. */
const PENALTY: Record<InsightSeverity, number> = { critical: 25, serious: 12, warning: 4, good: 0 };

export function healthScore(severities: InsightSeverity[]): number {
  return Math.max(0, 100 - severities.reduce((a, sev) => a + PENALTY[sev], 0));
}

export function healthLabel(score: number): { label: string; tone: "ok" | "warn" | "err" } {
  if (score >= 85) return { label: "Healthy", tone: "ok" };
  if (score >= 60) return { label: "Needs attention", tone: "warn" };
  return { label: "At risk", tone: "err" };
}

export const SEVERITY_ORDER: InsightSeverity[] = ["critical", "serious", "warning", "good"];
export const bySeverity = <T extends { severity: InsightSeverity }>(a: T, b: T) =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);

export const AREA_LABEL: Record<InsightArea, string> = {
  sql: "Slow SQL",
  plsql: "PL/SQL",
  views: "Views",
  jobs: "Jobs",
  sessions: "Sessions & locks",
  objects: "Object health",
};

export function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs)) return "—";
  if (secs >= 86400) return `${(secs / 86400).toFixed(1)} d`;
  if (secs >= 3600) return `${(secs / 3600).toFixed(1)} h`;
  if (secs >= 60) return `${(secs / 60).toFixed(1)} min`;
  if (secs >= 1) return `${secs.toFixed(secs < 10 ? 2 : 1)} s`;
  return `${Math.round(secs * 1000)} ms`;
}
export const fmtMs = (ms: number) => fmtDuration(ms / 1000);

export function fmtCount(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return v.toLocaleString();
}

/* ---- worksheet scripts. Values come from the dictionary but are still quoted defensively. ---- */

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const ident = (v: string) => `"${v.replace(/"/g, '""')}"`;

export const planScript = (sqlId: string) =>
  `-- Execution plan(s) of ${sqlId} from the cursor cache\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(${lit(sqlId)}, NULL, 'TYPICAL +PEEKED_BINDS'));`;

export const fullTextScript = (sqlId: string) =>
  `-- Full statement text of ${sqlId}\nSELECT sql_id, parsing_schema_name, sql_fulltext FROM v$sqlarea WHERE sql_id = ${lit(sqlId)};`;

export const tuningScript = (sqlId: string) =>
  `-- SQL Tuning Advisor for ${sqlId} (requires the ADVISOR privilege). Run the whole block, then the report query.
DECLARE
  l_task VARCHAR2(128);
BEGIN
  l_task := DBMS_SQLTUNE.CREATE_TUNING_TASK(sql_id => ${lit(sqlId)}, time_limit => 120, task_name => ${lit(`DF_TUNE_${sqlId}`)});
  DBMS_SQLTUNE.EXECUTE_TUNING_TASK(task_name => l_task);
END;
/
SELECT DBMS_SQLTUNE.REPORT_TUNING_TASK(${lit(`DF_TUNE_${sqlId}`)}) AS report FROM dual;
-- Clean up afterwards: EXEC DBMS_SQLTUNE.DROP_TUNING_TASK(${lit(`DF_TUNE_${sqlId}`)});`;

/** DBMS_METADATA object types differ from ALL_OBJECTS types for package/type bodies. */
const METADATA_TYPE: Record<string, string> = { "PACKAGE BODY": "PACKAGE_BODY", "TYPE BODY": "TYPE_BODY", "MATERIALIZED VIEW": "MATERIALIZED_VIEW" };

export const ddlScript = (owner: string, name: string, type: string) =>
  `-- Source of ${owner}.${name}\nSELECT DBMS_METADATA.GET_DDL(${lit(METADATA_TYPE[type] ?? type)}, ${lit(name)}, ${lit(owner)}) AS ddl FROM dual;`;

export const programSqlScript = (owner: string, name: string) =>
  `-- Statements issued by ${owner}.${name}, costliest first, with the source line that issues each
SELECT s.sql_id, s.program_line#, s.executions,
       ROUND(s.elapsed_time/1e6, 2) AS elapsed_s,
       ROUND(s.elapsed_time/GREATEST(s.executions,1)/1000, 2) AS ms_per_exec,
       s.buffer_gets, SUBSTR(s.sql_text, 1, 200) AS sql_text
FROM v$sqlarea s JOIN all_objects o ON o.object_id = s.program_id
WHERE o.owner = ${lit(owner)} AND o.object_name = ${lit(name)}
ORDER BY s.elapsed_time DESC;`;

export const viewSqlScript = (owner: string, name: string) =>
  `-- Cached statements that reference ${owner}.${name}
SELECT s.sql_id, s.executions, ROUND(s.elapsed_time/1e6, 2) AS elapsed_s,
       ROUND(s.elapsed_time/GREATEST(s.executions,1)/1000, 2) AS ms_per_exec,
       SUBSTR(s.sql_text, 1, 200) AS sql_text
FROM v$object_dependency d JOIN v$sqlarea s ON s.address = d.from_address AND s.hash_value = d.from_hash
WHERE d.to_owner = ${lit(owner)} AND d.to_name = ${lit(name)}
ORDER BY s.elapsed_time DESC;`;

export const mviewRefreshScript = (owner: string, name: string) =>
  `-- Complete refresh of ${owner}.${name} (use method => 'F' for a fast refresh when a log exists)\nBEGIN\n  DBMS_MVIEW.REFRESH(${lit(`${owner}.${name}`)}, method => 'C');\nEND;\n/`;

export const jobLogScript = (owner: string, name: string) =>
  `-- Run history of ${owner}.${name}
SELECT log_id, TO_CHAR(actual_start_date,'YYYY-MM-DD HH24:MI:SS') AS started, run_duration, status, error#, additional_info
FROM all_scheduler_job_run_details
WHERE owner = ${lit(owner)} AND job_name = ${lit(name)}
ORDER BY log_date DESC FETCH FIRST 100 ROWS ONLY;`;

export const sessionScript = (sid: number, serial: number) =>
  `-- What SID ${sid} is doing, and what blocks it
SELECT s.sid, s.serial#, s.username, s.status, s.sql_id, s.event, s.wait_class, s.seconds_in_wait,
       s.blocking_session, s.module, s.machine, s.program, q.sql_fulltext
FROM v$session s LEFT JOIN v$sqlarea q ON q.sql_id = s.sql_id
WHERE s.sid = ${Math.trunc(sid)};

-- Review before running: ends the session and rolls back its open transaction.
-- ALTER SYSTEM KILL SESSION '${Math.trunc(sid)},${Math.trunc(serial)}' IMMEDIATE;`;

const COMPILE_TYPE: Record<string, string> = {
  "PACKAGE BODY": "PACKAGE", "TYPE BODY": "TYPE", "MATERIALIZED VIEW": "MATERIALIZED VIEW",
};
export const compileScript = (objects: { owner: string; name: string; type: string }[]) =>
  ["-- Recompile invalid objects (re-run until nothing new compiles: dependencies resolve in waves)",
    ...objects.map((o) => {
      const body = o.type === "PACKAGE BODY" || o.type === "TYPE BODY";
      return `ALTER ${COMPILE_TYPE[o.type] ?? o.type} ${ident(o.owner)}.${ident(o.name)} COMPILE${body ? " BODY" : ""};`;
    }),
  ].join("\n");

export const gatherStatsScript = (tables: { owner: string; table: string }[]) =>
  ["-- Gather optimizer statistics (AUTO_SAMPLE_SIZE, cascades to indexes)",
    "BEGIN",
    ...tables.map((t) => `  DBMS_STATS.GATHER_TABLE_STATS(ownname => ${lit(t.owner)}, tabname => ${lit(t.table)}, cascade => TRUE);`),
    "END;",
    "/",
  ].join("\n");
