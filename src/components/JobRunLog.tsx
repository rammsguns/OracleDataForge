import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, CircleAlert, FileText, RefreshCw, Search, XCircle } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type JobRunOutput } from "../utils/api";
import { Badge, Btn, EmptyState, Modal, Spinner, inputCls } from "./ui";

type Cell = string | number | null;

interface JobRun {
  id: Cell;
  date: Cell;
  job: Cell;
  status: Cell;
  duration: Cell;
  error: Cell;
  info: Cell;
}

const RUN_LOG_SQL = `SELECT * FROM (
  SELECT log_id, log_date, job_name, status, run_duration, error#, additional_info
  FROM user_scheduler_job_run_details
  ORDER BY log_id DESC
) WHERE ROWNUM <= 500`;

const text = (value: Cell) => value == null ? "" : String(value);
const statusTone = (status: string): "ok" | "err" | "warn" | "neutral" =>
  status === "SUCCEEDED" ? "ok" : status === "FAILED" || status === "STOPPED" ? "err" : status === "RUNNING" ? "warn" : "neutral";

/** Read-only window over the current schema's DBMS_SCHEDULER execution history. */
export default function JobRunLog({ initialJob }: { initialJob?: string }) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobFilter, setJobFilter] = useState(initialJob ?? "");
  const [statusFilter, setStatusFilter] = useState("all");
  const [outputRun, setOutputRun] = useState<JobRun | null>(null);
  const [output, setOutput] = useState<JobRunOutput | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [outputLoading, setOutputLoading] = useState(false);

  useEffect(() => setJobFilter(initialJob ?? ""), [initialJob]);

  const load = useCallback(async () => {
    if (!conn?.live) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.query(conn.id, RUN_LOG_SQL);
      if (result.error) throw new Error(result.error.message);
      const column = (name: string) => result.columns.findIndex((c) => c.toUpperCase() === name);
      const ids = {
        id: column("LOG_ID"), date: column("LOG_DATE"), job: column("JOB_NAME"), status: column("STATUS"),
        duration: column("RUN_DURATION"), error: column("ERROR#"), info: column("ADDITIONAL_INFO"),
      };
      setRuns(result.rows.map((row) => ({
        id: row[ids.id] ?? null, date: row[ids.date] ?? null, job: row[ids.job] ?? null, status: row[ids.status] ?? null,
        duration: row[ids.duration] ?? null, error: row[ids.error] ?? null, info: row[ids.info] ?? null,
      })));
    } catch (e) {
      setRuns([]);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => { void load(); }, [load]);

  const openOutput = async (run: JobRun) => {
    const logId = Number(run.id);
    if (!conn || !Number.isSafeInteger(logId) || logId < 0) {
      s.toast("error", "This scheduler run does not have a usable log ID");
      return;
    }
    setOutputRun(run);
    setOutput(null);
    setOutputError(null);
    setOutputLoading(true);
    try {
      setOutput(await api.jobRunOutput(conn.id, logId));
    } catch (e) {
      setOutputError((e as Error).message);
    } finally {
      setOutputLoading(false);
    }
  };

  const statuses = useMemo(() => [...new Set(runs.map((r) => text(r.status)).filter(Boolean))].sort(), [runs]);
  const filtered = useMemo(() => runs.filter((run) => {
    const job = text(run.job).toLowerCase();
    return (!jobFilter.trim() || job.includes(jobFilter.trim().toLowerCase())) &&
      (statusFilter === "all" || text(run.status) === statusFilter);
  }), [runs, jobFilter, statusFilter]);

  if (!conn) return <EmptyState icon={<CalendarClock />} title="No connection selected" hint="Pick a live Oracle connection to view scheduler job history." />;
  if (!conn.live) return <EmptyState icon={<CalendarClock />} title="Job Run Log needs a live connection" hint="Connect to Oracle to read DBMS_SCHEDULER run details." />;

  return (
    <div className="h-full flex flex-col bg-bg min-h-0">
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-bdrsoft bg-panel">
        <CalendarClock size={14} className="text-accent" />
        <span className="text-[12.5px] font-semibold">Job Run Log</span>
        <span className="text-[11px] text-mute">Latest 500 runs from {conn.user?.toUpperCase() || "current"} schema</span>
        <div className="flex-1" />
        <Btn variant="outline" onClick={() => void load()} disabled={loading} title="Refresh job run history">
          <RefreshCw size={13} className={loading ? "df-spin" : ""} /> Refresh
        </Btn>
      </div>

      <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-bdrsoft">
        <div className="relative w-full sm:w-64">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
          <input value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} placeholder="Filter jobs…" aria-label="Filter jobs" className={`${inputCls} pl-7.5`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter run status" className={`${inputCls} w-auto`}>
          <option value="all">All statuses</option>
          {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        <span className="ml-auto text-[11.5px] text-mute">{filtered.length} run{filtered.length === 1 ? "" : "s"}</span>
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {loading && !runs.length ? <div className="p-3"><Spinner label="Reading scheduler run history…" /></div> : null}
        {error ? (
          <div className="m-3 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] text-err">
            Could not read job run history — {error}. Your Oracle user may not have scheduler run-detail access.
          </div>
        ) : null}
        {!loading && !error && !filtered.length ? (
          <EmptyState icon={<CalendarClock />} title="No job runs found" hint={runs.length ? "Try clearing or changing the filters." : "This schema has no recorded scheduler job runs."} />
        ) : null}
        {filtered.length > 0 && (
          <table className="w-full min-w-[840px] text-left text-[12px]">
            <thead className="sticky top-0 z-10 bg-panel text-[10.5px] uppercase tracking-wider text-mute shadow-[0_1px_0_var(--bdrsoft)]">
              <tr><th className="px-3 py-2 font-semibold">Run time</th><th className="px-3 py-2 font-semibold">Job</th><th className="px-3 py-2 font-semibold">Status</th><th className="px-3 py-2 font-semibold">Duration</th><th className="px-3 py-2 font-semibold">Error</th><th className="px-3 py-2 font-semibold">Details</th><th className="px-3 py-2 font-semibold" aria-label="Output" /></tr>
            </thead>
            <tbody>
              {filtered.map((run) => {
                const status = text(run.status);
                const failed = status === "FAILED" || status === "STOPPED";
                return <tr key={text(run.id)} className="border-b border-bdrsoft hover:bg-panel2 align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-mute tabular-nums">{text(run.date) || "—"}</td>
                  <td className="px-3 py-2 font-mono text-soft">{text(run.job) || "—"}</td>
                  <td className="px-3 py-2"><Badge tone={statusTone(status)}>{status === "SUCCEEDED" ? <CheckCircle2 size={10} /> : failed ? <XCircle size={10} /> : <CircleAlert size={10} />}{status || "UNKNOWN"}</Badge></td>
                  <td className="px-3 py-2 whitespace-nowrap text-mute tabular-nums">{text(run.duration) || "—"}</td>
                  <td className={`px-3 py-2 font-mono ${failed ? "text-err" : "text-mute"}`}>{text(run.error) && text(run.error) !== "0" ? text(run.error) : "—"}</td>
                  <td className="px-3 py-2 max-w-[420px] whitespace-pre-wrap break-words text-mute" title={text(run.info)}>{text(run.info) || "—"}</td>
                  <td className="px-3 py-2"><Btn variant="ghost" onClick={() => void openOutput(run)} title="View captured output"><FileText size={13} /> Output</Btn></td>
                </tr>;
              })}
            </tbody>
          </table>
        )}
      </div>
      {outputRun && (
        <Modal title={`${text(outputRun.job) || "Job"} — run output`} onClose={() => setOutputRun(null)} width={820}>
          {outputLoading && <Spinner label="Reading captured output…" />}
          {outputError && <div className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] text-err">Could not read output — {outputError}</div>}
          {output && <OutputPanels output={output} />}
        </Modal>
      )}
    </div>
  );
}

function OutputPanels({ output }: { output: JobRunOutput }) {
  const panels = [
    ["Output", output.output],
    ["Binary errors", output.binaryErrors],
    ["Binary output", output.binaryOutput],
  ] as const;
  const present = panels.filter(([, content]) => content != null && content !== "");
  if (!present.length) return <div className="text-[12px] text-mute">Oracle did not capture output for this run.</div>;
  return <div className="space-y-3">{present.map(([label, content]) => (
    <section key={label}>
      <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-mute">{label}</h3>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bdr bg-bg p-2.5 font-mono text-[11.5px] text-soft">{content}</pre>
    </section>
  ))}</div>;
}
