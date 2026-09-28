import { useEffect, useMemo, useState } from "react";
import { RefreshCcw, Search, Users, X } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type OracleSession, type OracleSessionsReport } from "../utils/api";
import { sessionClient } from "../utils/sessionClient";
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
  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [killing, setKilling] = useState(false);

  useEffect(() => {
    setReport(null);
    setSelectedKey(null);
    setError("");
    if (!conn || conn.status !== "connected") return;
    let cancelled = false;
    setLoading(true);
    api.sessions(conn.id)
      .then(data => { if (!cancelled) setReport(data); })
      .catch((cause: Error) => { if (!cancelled) setError(cause.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conn?.id, conn?.status, revision]);

  const rows = useMemo(() => report?.sessions.filter(row =>
    [sessionClient(row), ...Object.values(row)].some(value => String(value ?? "").toLowerCase().includes(filter.toLowerCase()))
  ) ?? [], [report, filter]);
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
      <span className="text-mute hidden sm:inline">Select a row for details</span>
      <label className="ml-auto flex items-center gap-2 text-mute">Connection
        <select aria-label="Session connection" className={inputCls} value={conn?.id ?? ""} onChange={event => s.setActiveConnId(event.target.value)}>
          {!conn && <option value="">Select a connection</option>}
          {s.connections.filter(item => item.live).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <Btn variant="outline" disabled={!conn || conn.status !== "connected" || loading || killing} onClick={() => setRevision(value => value + 1)}><RefreshCcw size={13} /> Refresh</Btn>
    </header>
    {!conn || conn.status !== "connected" ? <EmptyState icon={<Users />} title="Connection is offline" hint="Connect an Oracle database in the Explorer, then open Sessions." /> : <>
      <div className="shrink-0 p-3 border-b border-bdrsoft flex flex-wrap items-center gap-3">
        <label className="relative min-w-56 max-w-sm flex-1"><Search size={13} className="absolute left-2.5 top-2.5 text-mute" /><input className={`${inputCls} pl-8`} aria-label="Filter sessions" placeholder="Filter sessions…" value={filter} onChange={event => setFilter(event.target.value)} /></label>
        {report && <span className="text-mute">{rows.length} of {report.sessions.length} sessions · {report.scope === "all-instances" ? "All instances" : "Current instance"} · {new Date(report.capturedAt).toLocaleTimeString()}</span>}
      </div>
      {loading && <div className="p-4"><Spinner label="Reading sessions…" /></div>}
      {error && <div role="alert" className="m-4 p-3 rounded border border-err/30 text-err">{error}</div>}
      {report && <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <div className="flex-1 min-w-0 overflow-auto">
          {!rows.length ? <p className="p-8 text-center text-mute">{filter ? "No sessions match your filter." : "No user sessions were returned."}</p> :
          <table className="w-full text-left whitespace-nowrap"><thead className="sticky top-0 bg-panel2 z-10"><tr>{["Instance", "SID", "Serial", "User", "Status", "Client", "Machine", "Program", "SQL ID", "Wait event"].map(label => <th key={label} className="px-3 py-2 border-b border-bdr text-mute font-medium">{label}</th>)}</tr></thead>
            <tbody>{rows.map(row => <tr key={keyOf(row)} onClick={() => setSelectedKey(keyOf(row))} tabIndex={0} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(keyOf(row)); } }} aria-selected={keyOf(row) === selectedKey} className={`cursor-pointer border-b border-bdrsoft hover:bg-accentdim ${keyOf(row) === selectedKey ? "bg-accentdim" : ""}`}>
              {[row.instance, row.sid, row.serial, row.username, row.status, sessionClient(row), row.machine, row.program, row.sqlId, row.event].map((value, index) => <td key={index} className="px-3 py-2 max-w-56 truncate font-mono" title={String(value ?? "")}>{value ?? "—"}</td>)}
            </tr>)}</tbody></table>}
        </div>
        {selected && <aside className="w-full lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-bdr overflow-auto bg-panel2" aria-label="Session details">
          <div className="sticky top-0 bg-panel2 border-b border-bdr p-3 flex items-center gap-2"><h3 className="font-semibold">Session details</h3><Badge tone={selected.status === "ACTIVE" ? "ok" : "neutral"}>{selected.status}</Badge><button className="ml-auto text-mute hover:text-ink" aria-label="Close session details" onClick={() => setSelectedKey(null)}><X size={15} /></button></div>
          <dl className="p-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2"><div className="contents"><dt className="text-mute">Client</dt><dd className="font-semibold">{sessionClient(selected)}</dd></div>{detailFields.map(([field, label]) => <div key={field} className="contents"><dt className="text-mute">{label}</dt><dd className="font-mono break-all">{selected[field] ?? (field.startsWith("client") || field === "program" || field === "module" ? "Not reported" : "—")}</dd></div>)}</dl>
          {!report.clientDetailsAvailable && <p className="px-3 pb-3 text-mute">Driver details are unavailable for this database connection.</p>}
          <div className="p-3 border-t border-bdr"><Btn variant="danger" disabled={!canKill} onClick={() => kill(selected)}>Kill session</Btn>{conn.readOnly && <p className="mt-2 text-mute">This connection is read-only.</p>}</div>
        </aside>}
      </div>}
    </>}
  </div>;
}
