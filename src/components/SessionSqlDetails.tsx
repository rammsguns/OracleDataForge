import { useEffect, useState } from "react";
import { api, type OracleSession, type OracleSessionDetails } from "../utils/api";
import { formatSessionValue as fmt } from "../utils/sessionGrid";
import { Btn, Spinner } from "./ui";

export default function SessionSqlDetails({ connId, session, capturedAt }: { connId: string; session: OracleSession; capturedAt: string }) {
  const [data, setData] = useState<OracleSessionDetails | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    setLoading(true);
    api.sessionDetails(connId, session)
      .then(value => { if (!cancelled) setData(value); })
      .catch((cause: Error) => { if (!cancelled) setError(cause.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connId, session.instance, session.sid, session.serial, capturedAt, revision]);
  const unavailable = (message: string) => <p className="p-3 text-mute">{message}</p>;
  return <div className="mx-4 mb-4 space-y-3">
    <div className="flex items-center justify-between gap-2"><span className="text-mute">{data ? `SQL and waits · ${new Date(data.capturedAt).toLocaleTimeString()}` : "SQL and waits"}</span><Btn variant="outline" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh details</Btn></div>
    {loading && <Spinner label="Reading SQL, plan and waits…" />}
    {error && <p role="alert" className="text-err">{error}</p>}
    {data && <>
      <details open className="border border-bdr rounded-xl bg-panel">
        <summary className="p-3 cursor-pointer font-semibold">Active SQL</summary>
        <p className="px-3 text-mute">SQL ID: {fmt(data.sqlId)} · Child cursor: {fmt(data.childNumber)}</p>
        {data.sqlError ? unavailable(`SQL unavailable: ${data.sqlError}`) : data.sqlText
          ? <pre className="m-3 p-3 bg-panel2 rounded font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto">{data.sqlText}</pre>
          : unavailable(data.status !== "ACTIVE" ? "This session is inactive; no active SQL is shown." : "No active SQL text is available in the cursor cache.")}
      </details>
      <details open className="border border-bdr rounded-xl bg-panel">
        <summary className="p-3 cursor-pointer font-semibold">Explain Plan</summary>
        <p className="px-3 pb-2 text-mute">Cached execution plan for the active SQL child cursor. Rows and cost are optimizer estimates.</p>
        {data.planError ? unavailable(`Plan unavailable: ${data.planError}`) : !data.plan.length ? unavailable("No cached execution plan is available for this session’s active SQL.") : <div className="overflow-auto p-3"><table className="w-full text-left whitespace-nowrap"><thead><tr>{["ID", "Operation", "Object", "Rows", "Cost"].map(label => <th key={label} className="p-2 text-mute">{label}</th>)}</tr></thead><tbody>{data.plan.map(step => <tr key={step.id} className="border-t border-bdrsoft"><td className="p-2">{step.id}</td><td className="p-2 font-mono" style={{ paddingLeft: 8 + Math.min(step.depth ?? 0, 40) * 12 }}>{step.operation} {step.options}</td><td className="p-2">{[step.owner, step.object].filter(Boolean).join(".") || "—"}</td><td className="p-2">{fmt(step.rows)}</td><td className="p-2">{fmt(step.cost)}</td></tr>)}</tbody></table>
          {data.plan.filter(step => step.access || step.filter).map(step => <div key={step.id} className="mt-2 font-mono break-all"><strong>{step.id}</strong>{step.access && <p>Access: {step.access}</p>}{step.filter && <p>Filter: {step.filter}</p>}</div>)}
        </div>}
      </details>
      <details open className="border border-bdr rounded-xl bg-panel">
        <summary className="p-3 cursor-pointer font-semibold">Waits</summary>
        <div className="px-3 space-y-1"><p>{data.waitState === "WAITING" ? "Current wait" : "Last wait"}: {fmt(data.event)} · {fmt(data.waitClass)} · {fmt(data.waitState)}</p><p>Wait duration: {fmt(data.waitSeconds)} seconds</p><p>Blocking session: {data.blockingSid == null ? "—" : `${fmt(data.blockingInstance)}:${data.blockingSid}`}</p><p className="text-mute">Top 100 events by total wait time, including idle waits. Totals are since session start.</p></div>
        {data.waitsError ? unavailable(`Wait totals unavailable: ${data.waitsError}`) : !data.waits.length ? unavailable("No wait events were reported.") : <div className="overflow-auto p-3"><table className="w-full text-left whitespace-nowrap"><thead><tr>{["Event", "Class", "Waits", "Total (s)", "Average (ms)"].map(label => <th key={label} className="p-2 text-mute">{label}</th>)}</tr></thead><tbody>{data.waits.map(wait => <tr key={wait.event} className="border-t border-bdrsoft"><td className="p-2">{wait.event}</td><td className="p-2">{wait.waitClass}</td><td className="p-2">{fmt(wait.waits)}</td><td className="p-2">{fmt(wait.timeSeconds)}</td><td className="p-2">{fmt(wait.averageMs)}</td></tr>)}</tbody></table></div>}
      </details>
    </>}
  </div>;
}
