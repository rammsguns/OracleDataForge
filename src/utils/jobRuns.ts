import type { LiveQueryResult } from "./api";

// Convert Oracle intervals on the server: driver interval serialization varies by version.
const seconds = (column: string) => `(EXTRACT(DAY FROM ${column}) * 86400 + EXTRACT(HOUR FROM ${column}) * 3600 + EXTRACT(MINUTE FROM ${column}) * 60 + EXTRACT(SECOND FROM ${column}))`;
const timestamp = (column: string) => `TO_CHAR(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')`;
export const JOB_HISTORY_SQL = `SELECT * FROM (
  SELECT log_id, job_name, job_subname, status,
    ${timestamp("log_date")} AS logged_at, ${timestamp("actual_start_date")} AS started_at,
    ${timestamp("req_start_date")} AS requested_at,
    ${seconds("run_duration")} AS duration_seconds, ${seconds("cpu_used")} AS cpu_seconds,
    ${seconds("(actual_start_date - req_start_date)")} AS delay_seconds,
    instance_id, session_id, error# AS error_code, additional_info
  FROM user_scheduler_job_run_details ORDER BY log_id DESC
) WHERE ROWNUM <= 500`;
export const RUNNING_JOBS_SQL = `SELECT * FROM (
  SELECT log_id, job_name, job_subname, 'RUNNING' AS status,
    ${timestamp("(SYSTIMESTAMP - elapsed_time)")} AS started_at,
    ${seconds("elapsed_time")} AS duration_seconds, ${seconds("cpu_used")} AS cpu_seconds,
    running_instance AS instance_id, session_id
  FROM user_scheduler_running_jobs ORDER BY elapsed_time DESC NULLS LAST, job_name, session_id
) WHERE ROWNUM <= 500`;

export interface JobRun {
  key: string;
  live: boolean;
  id: number | null;
  job: string;
  step: string;
  status: string;
  logged: string;
  started: string;
  requested: string;
  duration: number | null;
  cpu: number | null;
  delay: number | null;
  instance: string;
  session: string;
  error: string;
  info: string;
}

export function parseJobRuns(result: LiveQueryResult, live = false): JobRun[] {
  if (result.error) throw new Error(result.error.message);
  const columns = new Map(result.columns.map((column, index) => [column.toUpperCase(), index]));
  return result.rows.map((row, index) => {
    const value = (name: string) => row[columns.get(name) ?? -1];
    const text = (name: string) => String(value(name) ?? "");
    const number = (name: string) => {
      const raw = value(name);
      if (raw == null || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    return {
      key: `${live ? "live" : "history"}:${text("LOG_ID")}:${text("SESSION_ID")}:${index}`, live,
      id: number("LOG_ID"), job: text("JOB_NAME"), step: text("JOB_SUBNAME"), status: text("STATUS"),
      logged: text("LOGGED_AT"), started: text("STARTED_AT"), requested: text("REQUESTED_AT"),
      duration: number("DURATION_SECONDS"), cpu: number("CPU_SECONDS"), delay: number("DELAY_SECONDS"),
      instance: text("INSTANCE_ID"), session: text("SESSION_ID"), error: text("ERROR_CODE"), info: text("ADDITIONAL_INFO"),
    };
  });
}

export function durationText(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "−" : "";
  let remaining = Math.round(Math.abs(seconds) * 100) / 100;
  const parts: string[] = [];
  for (const [size, unit] of [[86400, "d"], [3600, "h"], [60, "m"]] as const) {
    const n = Math.floor(remaining / size);
    if (n) parts.push(`${n}${unit}`);
    remaining = Math.round((remaining % size) * 100) / 100;
  }
  if (remaining || !parts.length) parts.push(`${remaining}s`);
  return sign + parts.join(" ");
}

export interface RunFilters { search: string; status: string; hours: number; slowSeconds: number; view: string; sort: string }
export function filterJobRuns(runs: JobRun[], filters: RunFilters, now: number): JobRun[] {
  const search = filters.search.trim().toLowerCase();
  const date = (run: JobRun) => Date.parse(run.started || run.logged) || 0;
  return runs.filter(run =>
    (!search || `${run.job} ${run.step} ${run.error} ${run.info}`.toLowerCase().includes(search)) &&
    (filters.status === "all" || run.status === filters.status) &&
    (!filters.hours || date(run) >= now - filters.hours * 3600000) &&
    (filters.view !== "running" || run.live) &&
    (filters.view !== "slow" || (run.duration != null && run.duration >= filters.slowSeconds))
  ).sort((a, b) => filters.sort === "duration" ? (b.duration ?? -Infinity) - (a.duration ?? -Infinity)
    : filters.sort === "cpu" ? (b.cpu ?? -Infinity) - (a.cpu ?? -Infinity)
    : filters.sort === "delay" ? (b.delay ?? -Infinity) - (a.delay ?? -Infinity) : date(b) - date(a));
}

export function jobPerformance(runs: JobRun[]) {
  // Chain steps have different workloads; do not mix them into their parent job's baseline.
  const groups = new Map<string, JobRun[]>();
  for (const run of runs.filter(run => !run.live)) {
    const key = JSON.stringify([run.job, run.step]);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map(group => {
    const durations = group.flatMap(run => run.duration == null ? [] : [run.duration]).sort((a, b) => a - b);
    const cpus = group.flatMap(run => run.cpu == null ? [] : [run.cpu]);
    const delays = group.flatMap(run => run.delay == null ? [] : [Math.max(0, run.delay)]);
    const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return { job: group[0].job, step: group[0].step, count: group.length,
      succeeded: group.filter(run => run.status === "SUCCEEDED").length,
      failed: group.filter(run => run.status === "FAILED" || run.status === "STOPPED" || run.status === "BROKEN").length,
      average: avg(durations), p95: durations[Math.ceil(durations.length * .95) - 1] ?? null,
      max: durations.at(-1) ?? null, cpu: avg(cpus), delay: avg(delays) };
  }).sort((a, b) => (b.max ?? -Infinity) - (a.max ?? -Infinity) || a.job.localeCompare(b.job));
}
