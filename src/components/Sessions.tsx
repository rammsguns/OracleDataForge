import { useEffect, useMemo, useState } from "react";
import { RefreshCcw, Search, Users, X } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type OracleSession, type OracleSessionsReport } from "../utils/api";
import { sessionClient } from "../utils/sessionClient";
import { matchesSessionColumnFilters, matchesSessionThresholds, sampleSessionRates, formatSessionValue, sessionThresholds, type SessionThresholds, sessionGridColumns as gridColumns, type SessionGridColumnKey as GridColumnKey } from "../utils/sessionGrid";
import SessionMetrics from "./SessionMetrics";
import { Badge, Btn, EmptyState, inputCls, Spinner } from "./ui";

const keyOf = (row: OracleSession) => `${row.instance}:${row.sid}:${row.serial}`;
const detailFields: [keyof OracleSession, string][] = [
  ["instance", "Instance"], ["sid", "SID"], ["serial", "Serial"],
  ["username", "Database user"], ["status", "Status"], ["machine", "Machine"],
  ["program", "Program"], ["module", "Module"], ["action", "Action"],
  ["clientDriver", "Driver"], ["clientVersion", "Client version"],
  ["clientConnection", "Connection type"], ["clientOciLibrary", "OCI library"],
  ["osUser", "OS user"], ["process", "Client process"], ["terminal", "Terminal"],
  ["clientInfo", "Client info"], ["clientIdentifier", "Client identifier"],
  ["schemaName", "Current schema"],
  ["serviceName", "Service"], ["logonTime", "Logon time"],
  ["ageSeconds", "Session age (seconds)"], ["activeSeconds", "Active call (seconds)"],
  ["sqlExecStart", "SQL execution started"], ["blockingInstance", "Blocking instance"],
  ["cpuPercent", "CPU (% of one core)"], ["cpuSeconds", "CPU total (seconds)"],
  ["pgaMb", "Current PGA (MiB)"], ["pgaPeakMb", "Peak PGA (MiB)"], ["ugaMb", "Current UGA (MiB)"],
  ["readMbps", "Disk read (MiB/s)"], ["writeMbps", "Disk write (MiB/s)"],
  ["readMb", "Total reads (MiB)"], ["writeMb", "Total writes (MiB)"],
  ["readRequests", "Read requests"], ["writeRequests", "Write requests"],
  ["logicalReads", "Logical reads (blocks)"], ["redoMb", "Redo total (MiB)"],
  ["executions", "Executions"], ["hardParses", "Hard parses"],
  ["lastCallSeconds", "Last call (seconds)"], ["sqlId", "SQL ID"],
  ["previousSqlId", "Previous SQL ID"], ["event", "Wait event"],
  ["waitClass", "Wait class"], ["waitState", "Wait state"], ["blockingSid", "Blocking SID"],
];

export default function Sessions() {
  const s = useStudio();
  const conn = s.connections.find(c => c.id === s.activeConnId);
  const [report, setReport] = useState<OracleSessionsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [refreshSeconds, setRefreshSeconds] = useState(30);
  const [filter, setFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<Partial<Record<GridColumnKey, string>>>({});
  const [thresholds, setThresholds] = useState<SessionThresholds>({});
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<GridColumnKey>("instance");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [killing, setKilling] = useState(false);

  useEffect(() => {
    setReport(null);
    setSelectedKey(null);
    setError("");
  }, [conn?.id]);
  useEffect(() => {
    if (!conn || conn.status !== "connected") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api.sessions(conn.id)
      .then(data => { if (!cancelled) setReport(previous => ({
        ...data,
        sessions: sampleSessionRates(data.sessions, previous?.sessions ?? [],
          previous ? (Date.parse(data.capturedAt)-Date.parse(previous.capturedAt))/1000 : 0),
      })); })
      .catch((cause: Error) => { if (!cancelled) setError(cause.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conn?.id, conn?.status, revision]);
  useEffect(() => {
    if (!conn || conn.status !== "connected" || killing || refreshSeconds < 1) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !loading) setRevision(value => value + 1);
    }, refreshSeconds * 1_000);
    const onVisible = () => { if (document.visibilityState === "visible" && !loading) setRevision(value => value + 1); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [conn?.id, conn?.status, killing, loading, refreshSeconds]);

  const rows = useMemo(() => {
    const search = filter.trim().toLowerCase();
    const sortColumn = gridColumns.find(column => column.key === sortKey)!;
    return (report?.sessions ?? []).filter(row =>
      (!search || [sessionClient(row), ...Object.values(row)].some(value => String(value ?? "").toLowerCase().includes(search))) &&
      matchesSessionColumnFilters(row, columnFilters) && matchesSessionThresholds(row, thresholds) &&
      (!blockedOnly || row.blockingSid != null)
    ).sort((a, b) => {
      const left = sortColumn.value(a);
      const right = sortColumn.value(b);
      if (left == null) return right == null ? keyOf(a).localeCompare(keyOf(b)) : 1;
      if (right == null) return -1;
      const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
      return (sortDirection === "asc" ? order : -order) || keyOf(a).localeCompare(keyOf(b));
    });
  }, [report, filter, columnFilters, thresholds, blockedOnly, sortKey, sortDirection]);
  const hasFilter = blockedOnly || Object.values(thresholds).some(value => !!value?.trim()) || !!filter.trim() || Object.values(columnFilters).some(value => !!value?.trim());
  const selected = report?.sessions.find(row => keyOf(row) === selectedKey);
  const canKill = !!selected && !!conn && !conn.readOnly && !killing;

  const kill = (row: OracleSession) => {
    if (!conn) return;
    s.askConfirm({
      title: `Kill session ${row.sid},${row.serial}?`,
      body: `Terminate ${row.username ?? "this user"}'s session on ${conn.name}, instance ${row.instance}. Its active work may be rolled back and its client will be disconnected.`,
      confirmLabel: "Kill session",
      danger: true,
      onConfirm: () => {
        setKilling(true);
        void api.killSession(conn.id, row)
          .then(() => {
            s.toast("success", `Session ${row.sid},${row.serial} killed`);
            setSelectedKey(null);
            setRevision(value => value + 1);
          })
          .catch((cause: Error) => s.toast("error", cause.message))
          .finally(() => setKilling(false));
      },
    });
  };

  return <div className="h-full flex flex-col min-h-0 bg-panel text-[12px]">
    <header className="shrink-0 p-3 border-b border-bdr flex flex-wrap items-center gap-2 bg-panel2">
      <Users size={17} className="text-accenthi" />
      <h2 className="font-semibold text-sm">Sessions</h2>
      <span className="text-mute hidden sm:inline">Select a row for session performance</span>
      <label className="ml-auto flex items-center gap-2 text-mute">Connection
        <select aria-label="Session connection" className={inputCls} value={conn?.id ?? ""} onChange={event => s.setActiveConnId(event.target.value)}>
          {!conn && <option value="">Select a connection</option>}
          {s.connections.filter(item => item.live).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <Btn variant="outline" disabled={!conn || conn.status !== "connected" || loading || killing} onClick={() => setRevision(value => value + 1)}><RefreshCcw size={13} /> Refresh</Btn>
      <label className="flex items-center gap-2 text-mute">Auto refresh (seconds)
        <input type="number" min="0" max="3600" step="1" className={`${inputCls} w-20`} aria-label="Auto refresh interval in seconds" title="Set to 0 to turn off auto refresh" value={refreshSeconds} onChange={event => setRefreshSeconds(Math.min(3600, Math.max(0, Number(event.target.value) || 0)))} />
        <span className="text-[11px]">0 = off</span>
      </label>
    </header>
    {!conn || conn.status !== "connected" ? <EmptyState icon={<Users />} title="Connection is offline" hint="Connect an Oracle database in the Explorer, then open Sessions." /> : <>
      <div className="shrink-0 p-3 border-b border-bdrsoft flex flex-wrap items-center gap-3">
        <label className="relative min-w-56 max-w-sm flex-1"><Search size={13} className="absolute left-2.5 top-2.5 text-mute" /><input className={`${inputCls} pl-8`} aria-label="Filter sessions" placeholder="Filter sessions…" value={filter} onChange={event => setFilter(event.target.value)} /></label>
        {report && <span className="text-mute">{rows.length} of {report.sessions.length} sessions · {report.scope === "all-instances" ? "All instances" : "Current instance"} · {new Date(report.capturedAt).toLocaleTimeString()}</span>}
      </div>
      <div className="shrink-0 p-3 border-b border-bdrsoft bg-panel2">
        <div className="flex flex-wrap items-end gap-2">
          {sessionThresholds.map(({key, label}) => <label key={key} className="text-mute text-[11px]">{label}
            <input type="number" min="0" step="any" className={`${inputCls} block !w-32 mt-1`} aria-label={label} placeholder="Any" value={thresholds[key] ?? ""} onChange={event => setThresholds(current => ({...current, [key]: event.target.value}))} />
          </label>)}
          <label className="flex items-center gap-2 py-2"><input type="checkbox" checked={blockedOnly} onChange={event => setBlockedOnly(event.target.checked)} />Blocked only</label>
          <Btn variant="outline" onClick={() => {setFilter(""); setColumnFilters({}); setThresholds({}); setBlockedOnly(false);}}>Clear filters</Btn>
        </div>
        <p className="text-mute mt-2">Filters combine. Active call is time in the current active state, including waits. CPU and I/O rates need two refreshes; CPU counters can update at call completion. Totals are since session start. PGA is private Oracle memory; UGA may overlap PGA.</p>
        {report?.resourceDetailsAvailable === false && <p className="text-warn mt-2">Resource statistics are unavailable with this connection’s view permissions. Session duration and blocking filters remain available.</p>}
      </div>
      {loading && <div className="p-4"><Spinner label="Reading sessions…" /></div>}
      {error && <div role="alert" className="m-4 p-3 rounded border border-err/30 text-err">{error}</div>}
      {report && <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <div className="sessions-scroll flex-1 min-w-0 overflow-auto">
          <table className="w-full text-left whitespace-nowrap"><thead className="sticky top-0 bg-panel2 z-10"><tr>{gridColumns.map(column => <th key={column.key} className="px-3 py-2 border-b border-bdr text-mute font-medium" aria-sort={sortKey === column.key ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}><button type="button" className="hover:text-ink" aria-label={`Sort by ${column.label}`} onClick={() => { setSortDirection(sortKey === column.key && sortDirection === "asc" ? "desc" : "asc"); setSortKey(column.key); }}>{column.label}{sortKey === column.key ? (sortDirection === "asc" ? " ↑" : " ↓") : ""}</button></th>)}</tr><tr>{gridColumns.map(column => <th key={column.key} className="px-2 py-1 border-b border-bdr"><input className={`${inputCls} min-w-24 !w-full`} aria-label={`Filter ${column.label}`} placeholder={`Filter ${column.label.toLowerCase()}…`} value={columnFilters[column.key] ?? ""} onChange={event => setColumnFilters(current => ({ ...current, [column.key]: event.target.value }))} /></th>)}</tr></thead>
            <tbody>{rows.map(row => <tr key={keyOf(row)} onClick={() => setSelectedKey(keyOf(row))} tabIndex={0} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(keyOf(row)); } }} aria-selected={keyOf(row) === selectedKey} className={`cursor-pointer border-b border-bdrsoft hover:bg-accentdim ${keyOf(row) === selectedKey ? "bg-accentdim" : ""}`}>
              {gridColumns.map(column => <td key={column.key} className="px-3 py-2 max-w-56 truncate font-mono" title={String(column.value(row) ?? "")}>{formatSessionValue(column.value(row))}</td>)}
            </tr>)}</tbody></table>
          {!rows.length && <p className="p-8 text-center text-mute">{hasFilter ? "No sessions match your filters." : "No user sessions were returned."}</p>}
        </div>
        {selected && <aside className="w-full lg:w-1/2 xl:w-[58%] min-h-0 flex-1 lg:flex-none shrink-0 border-t lg:border-t-0 lg:border-l border-bdr overflow-auto bg-panel2" aria-label="Session performance and details">
          <div className="sticky top-0 bg-panel2 border-b border-bdr p-3 flex items-center gap-2"><h3 className="font-semibold">Session performance</h3><Badge tone={selected.status === "ACTIVE" ? "ok" : "neutral"}>{selected.status}</Badge><button className="ml-auto text-mute hover:text-ink" aria-label="Close session details" onClick={() => setSelectedKey(null)}><X size={15} /></button></div>
          <SessionMetrics session={selected} capturedAt={report.capturedAt} available={report.resourceDetailsAvailable} />
          <details className="mx-4 mb-4 border border-bdr rounded-xl bg-panel">
            <summary className="p-3 cursor-pointer font-semibold">Connection & session details</summary>
          <dl className="p-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2"><div className="contents"><dt className="text-mute">Client</dt><dd className="font-semibold">{sessionClient(selected)}</dd></div>{detailFields.map(([field, label]) => <div key={field} className="contents"><dt className="text-mute">{label}</dt><dd className="font-mono break-all">{formatSessionValue(selected[field] ?? (field.startsWith("client") || field === "program" || field === "module" ? "Not reported" : "—"))}</dd></div>)}</dl>
          {!report.clientDetailsAvailable && <p className="px-3 pb-3 text-mute">Driver details are unavailable for this database connection.</p>}
          </details>
          <div className="p-3 border-t border-bdr"><Btn variant="danger" disabled={!canKill} onClick={() => kill(selected)}>Kill session</Btn>{conn.readOnly && <p className="mt-2 text-mute">This connection is read-only.</p>}</div>
        </aside>}
      </div>}
    </>}
  </div>;
}
