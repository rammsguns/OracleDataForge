import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, CalendarClock, FileText, RefreshCw, Search } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type JobRunOutput } from "../utils/api";
import { durationText, filterJobRuns, jobPerformance, JOB_HISTORY_SQL, parseJobRuns, RUNNING_JOBS_SQL, type JobRun } from "../utils/jobRuns";
import { Badge, Btn, EmptyState, Modal, Spinner, inputCls } from "./ui";

const statusTone = (status: string): "ok" | "err" | "warn" | "neutral" =>
  status === "SUCCEEDED" ? "ok" : ["FAILED", "STOPPED", "BROKEN"].includes(status) ? "err" : status === "RUNNING" ? "warn" : "neutral";
const dateText = (value: string) => value ? (Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString()) : "—";

export default function JobRunLog({ initialJob }: { initialJob?: string }) {
  const s = useStudio();
  const conn = s.connections.find(c => c.id === s.activeConnId);
  if (!conn) return <EmptyState icon={<CalendarClock />} title="No connection selected" hint="Pick a live Oracle connection to view scheduler jobs." />;
  if (!conn.live || conn.status !== "connected") return <EmptyState icon={<CalendarClock />} title="Job Runs needs a live connection" hint="Connect to Oracle to read DBMS_SCHEDULER execution details." />;
  // Remount on connection changes so one schema's data and output never leak into another.
  return <JobRuns key={conn.id} connId={conn.id} schema={conn.user?.toUpperCase() || "current"} initialJob={initialJob} />;
}

function JobRuns({ connId, schema, initialJob }: { connId: string; schema: string; initialJob?: string }) {
  const { captureConnectionStatus, reportConnectionError } = useStudio();
  const [history, setHistory] = useState<JobRun[]>([]);
  const [running, setRunning] = useState<JobRun[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState<number | null>(null);
  const [search, setSearch] = useState(initialJob ?? "");
  const [status, setStatus] = useState("all");
  const [hours, setHours] = useState(0);
  const [view, setView] = useState("all");
  const [sort, setSort] = useState("recent");
  const [slowSeconds, setSlowSeconds] = useState(300);
  const [refreshSeconds, setRefreshSeconds] = useState(0);
  const [selected, setSelected] = useState<JobRun | null>(null);
  const [output, setOutput] = useState<JobRunOutput | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [outputLoading, setOutputLoading] = useState(false);
  const requests = useRef(0);
  const outputRequests = useRef(0);
  const busy = useRef(false);

  useEffect(() => setSearch(initialJob ?? ""), [initialJob]);
  useEffect(() => () => { requests.current++; outputRequests.current++; busy.current = false; }, []);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const request = ++requests.current;
    const sessionCurrent = captureConnectionStatus(connId);
    const current = () => request === requests.current && sessionCurrent();
    setLoading(true);
    try {
      const results = await Promise.allSettled([
        api.query(connId, JOB_HISTORY_SQL).then(result => parseJobRuns(result)),
        api.query(connId, RUNNING_JOBS_SQL).then(result => parseJobRuns(result, true)),
      ]);
      if (!current()) return;
      const messages: string[] = [];
      for (const [index, result] of results.entries()) {
        const save = index === 0 ? setHistory : setRunning;
        if (result.status === "fulfilled") save(result.value);
        else {
          save([]);
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          messages.push(`${index === 0 ? "Run history" : "Running jobs"}: ${message}`);
          reportConnectionError(connId, message);
        }
      }
      setErrors(messages);
      setUpdated(Date.now());
    } finally {
      if (request === requests.current) { busy.current = false; setLoading(false); }
    }
  }, [connId, captureConnectionStatus, reportConnectionError]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!refreshSeconds) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [refreshSeconds, load]);

  const all = useMemo(() => [...running, ...history], [running, history]);
  const filtered = useMemo(() => filterJobRuns(view === "performance" ? history : all, { search, status, hours, view, sort, slowSeconds }, updated ?? Date.now()), [all, history, search, status, hours, view, sort, slowSeconds, updated]);
  const performance = useMemo(() => jobPerformance(filtered), [filtered]);
  const completed = filtered.filter(run => !run.live);
  const successful = completed.filter(run => run.status === "SUCCEEDED").length;
  const slow = filtered.filter(run => run.duration != null && run.duration >= slowSeconds).length;
  const durations = completed.flatMap(run => run.duration == null ? [] : [run.duration]);
  const average = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const statuses = [...new Set([...all.map(run => run.status), "RUNNING", "SUCCEEDED", "FAILED", "STOPPED", "BROKEN"])].sort();

  const closeDetails = () => { outputRequests.current++; setSelected(null); setOutput(null); setOutputError(null); setOutputLoading(false); };
  const openDetails = (run: JobRun) => {
    outputRequests.current++;
    setSelected(run); setOutput(null); setOutputError(null); setOutputLoading(false);
  };
  const loadOutput = async () => {
    if (!selected || selected.live || selected.id == null) return;
    const request = ++outputRequests.current;
    const sessionCurrent = captureConnectionStatus(connId);
    const current = () => request === outputRequests.current && sessionCurrent();
    setOutput(null); setOutputError(null); setOutputLoading(true);
    try {
      const result = await api.jobRunOutput(connId, selected.id);
      if (current()) setOutput(result);
    } catch (e) {
      if (current()) { setOutputError((e as Error).message); reportConnectionError(connId, (e as Error).message); }
    } finally { if (request === outputRequests.current) setOutputLoading(false); }
  };

  return <div className="h-full flex flex-col bg-bg min-h-0">
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-bdrsoft bg-panel">
      <CalendarClock size={14} className="text-accent" /><span className="text-[12.5px] font-semibold">Job Runs</span>
      <span className="text-[11px] text-mute">{schema} schema · latest 500 completed + up to 500 running</span>
      <div className="flex-1" />
      <select aria-label="Auto refresh" className={`${inputCls} w-auto`} value={refreshSeconds} onChange={e => setRefreshSeconds(Number(e.target.value))}>
        <option value={0}>Auto refresh off</option>{[15, 30, 60].map(n => <option key={n} value={n}>Every {n}s</option>)}
      </select>
      <Btn variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw size={13} className={loading ? "df-spin" : ""} /> Refresh</Btn>
    </div>
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 p-3">
        {[["Running now", updated && !errors.some(error => error.startsWith("Running jobs:")) ? running.length : "—"], ["Success rate", completed.length ? `${Math.round(successful / completed.length * 100)}%` : "—"], ["Average duration", durationText(average)], ["Slow runs", slow]].map(([label, value]) =>
          <div key={label} className="rounded-lg border border-bdrsoft bg-panel px-3 py-2"><div className="text-[10.5px] text-mute">{label}</div><div className="text-xl font-semibold tabular-nums text-soft">{value}</div><div className="text-[10px] text-mute">{label === "Running now" ? "Latest running-job snapshot" : "Within current filters"}</div></div>)}
      </div>
      <div className="px-3 pb-2 flex flex-wrap gap-1" role="group" aria-label="Job run views">
        {[["all", "All runs"], ["running", "Running"], ["slow", "Slow jobs"], ["performance", "Performance by job"]].map(([id, label]) =>
          <button key={id} type="button" aria-pressed={view === id} onClick={() => { setView(id); setStatus("all"); if (id === "running") setHours(0); if (id === "slow") setSort("duration"); }} className={`rounded-md px-3 py-1.5 text-[12px] ${view === id ? "bg-accentdim text-accenthi" : "text-mute hover:bg-panel2"}`}>{label}</button>)}
      </div>
      <div className="flex flex-wrap items-end gap-2 px-3 pb-3 border-b border-bdrsoft">
        <label className="text-[10.5px] text-mute">Search job, step, error<div className="relative mt-1"><Search size={12} className="absolute left-2 top-2 text-mute" /><input aria-label="Search jobs" value={search} onChange={e => setSearch(e.target.value)} placeholder="Job name or error…" className={`${inputCls} pl-7 w-56`} /></div></label>
        <label className="text-[10.5px] text-mute">Status<select aria-label="Filter run status" value={status} onChange={e => setStatus(e.target.value)} className={`${inputCls} mt-1 w-auto`}><option value="all">All statuses</option>{statuses.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="text-[10.5px] text-mute">Started within<select aria-label="Filter start time" value={hours} onChange={e => setHours(Number(e.target.value))} className={`${inputCls} mt-1 w-auto`}><option value={0}>All loaded runs</option><option value={1}>Last hour</option><option value={24}>Last 24 hours</option><option value={168}>Last 7 days</option><option value={720}>Last 30 days</option></select></label>
        <label className="text-[10.5px] text-mute">Slow ≥ seconds<input aria-label="Slow job threshold in seconds" type="number" min={1} max={31536000} value={slowSeconds} onChange={e => setSlowSeconds(Math.max(1, Math.min(31536000, Number(e.target.value) || 1)))} className={`${inputCls} mt-1 w-28`} /></label>
        {view !== "performance" && <label className="text-[10.5px] text-mute">Sort<select aria-label="Sort job runs" value={sort} onChange={e => setSort(e.target.value)} className={`${inputCls} mt-1 w-auto`}><option value="recent">Newest first</option><option value="duration">Longest duration</option><option value="cpu">Highest CPU time</option><option value="delay">Longest start delay</option></select></label>}
        <Btn onClick={() => { setSearch(""); setStatus("all"); setHours(0); setSlowSeconds(300); setSort("recent"); }}>Reset filters</Btn>
      </div>
      <div className="px-3 py-2 text-[11px] text-mute flex flex-wrap gap-x-4 gap-y-1" aria-live="polite"><span>{filtered.length} matching executions · {performance.length} jobs / steps</span><span>{updated ? `Snapshot checked ${new Date(updated).toLocaleTimeString()}` : "Waiting for first snapshot"}</span><span>Times shown in your local timezone. Metrics use loaded history only.</span></div>
      {loading && <div className="px-3 pb-2"><Spinner label="Reading scheduler jobs…" /></div>}
      {errors.map(message => <div key={message} role="alert" className="mx-3 mb-2 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] text-err">Could not read {message}. Scheduler view access may be required.</div>)}
      {!loading && !filtered.length && <EmptyState icon={<CalendarClock />} title="No matching job runs" hint="Try changing the view or clearing filters. Only recorded runs and currently running scheduler jobs are included." />}
      {!!filtered.length && <div className="overflow-x-auto">
        {view === "performance" ? <table className="w-full min-w-[950px] text-left text-[12px]">
          <thead className="bg-panel text-[10.5px] uppercase text-mute"><tr>{["Job / step", "Runs", "Succeeded", "Failed / stopped", "Success", "Avg duration", "P95 duration", "Max duration", "Avg CPU", "Avg start delay", ""].map((label, i) => <th key={i} className="px-3 py-2">{label}</th>)}</tr></thead>
          <tbody>{performance.map(job => <tr key={JSON.stringify([job.job, job.step])} className="border-b border-bdrsoft hover:bg-panel2">
            <td className="px-3 py-2 font-mono">{job.job}{job.step && <div className="text-mute text-[10px]">{job.step}</div>}</td>
            {[job.count, job.succeeded, job.failed, `${Math.round(job.succeeded / job.count * 100)}%`, durationText(job.average), durationText(job.p95), durationText(job.max), durationText(job.cpu), durationText(job.delay)].map((value, i) => <td key={i} className="px-3 py-2 whitespace-nowrap tabular-nums text-soft">{value}</td>)}
            <td className="px-3 py-2"><Btn onClick={() => { setSearch(job.job); setView("all"); }}>View runs</Btn></td>
          </tr>)}</tbody>
        </table> : <table className="w-full min-w-[1050px] text-left text-[12px]">
          <thead className="bg-panel text-[10.5px] uppercase text-mute"><tr>{["Started / logged", "Job / step", "Status", "Duration / elapsed", "CPU time", "Start delay", "Session / instance", "Error", ""].map((label, i) => <th key={i} className="px-3 py-2">{label}</th>)}</tr></thead>
          <tbody>{filtered.map(run => <tr key={run.key} className="border-b border-bdrsoft hover:bg-panel2 align-top">
            <td className="px-3 py-2 whitespace-nowrap text-mute" title={run.started || run.logged}>{dateText(run.started || run.logged)}</td>
            <td className="px-3 py-2 font-mono text-soft">{run.job}{run.step && <div className="text-[10px] text-mute">{run.step}</div>}</td>
            <td className="px-3 py-2"><Badge tone={statusTone(run.status)}>{run.live && <Activity size={10} />}{run.status}</Badge></td>
            <td className="px-3 py-2 whitespace-nowrap tabular-nums"><span className={run.duration != null && run.duration >= slowSeconds ? "text-warn" : "text-soft"}>{durationText(run.duration)}</span>{run.duration != null && run.duration >= slowSeconds && <div><Badge tone="warn">Slow</Badge></div>}</td>
            <td className="px-3 py-2 whitespace-nowrap tabular-nums text-mute">{durationText(run.cpu)}</td>
            <td className="px-3 py-2 whitespace-nowrap tabular-nums text-mute">{durationText(run.delay == null ? null : Math.max(0, run.delay))}</td>
            <td className="px-3 py-2 text-mute font-mono">{run.session || "—"} / {run.instance || "—"}</td>
            <td className="px-3 py-2 text-err font-mono">{run.error && run.error !== "0" ? run.error : "—"}</td>
            <td className="px-3 py-2"><Btn onClick={() => openDetails(run)}><FileText size={13} /> Details</Btn></td>
          </tr>)}</tbody>
        </table>}
      </div>}
      {view === "performance" && <p className="px-3 py-2 text-[11px] text-mute">Completed runs only. P95 uses the nearest-rank duration; CPU may be unavailable in Oracle. Failed includes failed, stopped, and broken runs. Start delay is time between requested and actual start.</p>}
    </div>
    {selected && <Modal title={`${selected.job} — ${selected.live ? "running snapshot" : "run details"}`} onClose={closeDetails} width={850}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">{[
        ["Status", selected.status], ["Log ID", selected.id ?? "—"], ["Step", selected.step || "—"],
        ["Requested start", dateText(selected.requested)], ["Actual start", dateText(selected.started)], ["Logged", dateText(selected.logged)],
        [selected.live ? "Elapsed at snapshot" : "Duration", durationText(selected.duration)], ["CPU time", durationText(selected.cpu)], ["Start delay", durationText(selected.delay == null ? null : Math.max(0, selected.delay))],
        ["Session", selected.session || "—"], ["Instance", selected.instance || "—"], ["Error code", selected.error || "—"],
      ].map(([label, value]) => <div key={label}><div className="text-[10px] uppercase text-mute">{label}</div><div className="text-[12px] text-soft break-words">{value}</div></div>)}</div>
      <h3 className="text-[11px] font-semibold text-mute mb-1">Oracle details</h3><pre className="whitespace-pre-wrap break-words text-[12px] rounded border border-bdrsoft bg-bg p-3 mb-3">{selected.info || "No additional details recorded."}</pre>
      {selected.live ? <p className="text-[12px] text-mute">This job was running at the last snapshot. Close details and refresh to update elapsed time. Captured output is available after Oracle records the completed run.</p> : <Btn variant="outline" disabled={outputLoading || selected.id == null || !Number.isSafeInteger(selected.id) || selected.id < 0} onClick={() => void loadOutput()}><FileText size={13} /> Load captured output</Btn>}
      {outputLoading && <div className="mt-3"><Spinner label="Reading captured output…" /></div>}
      {outputError && <div role="alert" className="mt-3 text-[12px] text-err">Could not read output — {outputError}</div>}
      {output && <div className="mt-3"><OutputPanels output={output} /></div>}
    </Modal>}
  </div>;
}

function OutputPanels({ output }: { output: JobRunOutput }) {
  const panels = [["Output", output.output], ["Binary errors", output.binaryErrors], ["Binary output", output.binaryOutput]] as const;
  const present = panels.filter(([, content]) => content != null && content !== "");
  if (!present.length) return <div className="text-[12px] text-mute">Oracle did not capture output for this run.</div>;
  return <div className="space-y-3">{present.map(([label, content]) => <section key={label}>
    <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-mute">{label}</h3>
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bdr bg-bg p-2.5 font-mono text-[11.5px] text-soft">{content}</pre>
  </section>)}</div>;
}
