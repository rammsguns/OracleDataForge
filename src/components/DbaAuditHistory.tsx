import { useEffect, useState } from "react";
import { api } from "../utils/api";

export default function DbaAuditHistory({ connectionId, revision }: { connectionId: string; revision: number }) {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.dbaAudit>>["entries"]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setEntries([]); setError("");
    api.dbaAudit(connectionId).then(result => { if (!cancelled) setEntries(result.entries); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [connectionId, revision]);
  return <section className="border border-bdr rounded-xl p-4 space-y-3">
    <h3 className="font-semibold">Change audit history</h3>
    <p className="text-xs text-mute">Recent records for this connection from the server log. Attempts and outcomes share an audit ID. An attempt without an outcome needs verification in Oracle. Shows up to 100 records from the latest 1 MiB of the log.</p>
    {error && <p role="alert" className="text-err">{error}</p>}
    {!error && !entries.length && <p className="text-mute text-xs">No recent changes recorded.</p>}
    {entries.map((entry, index) => <details key={`${entry.id}-${index}`} className="border-b border-bdrsoft pb-2 text-xs"><summary className="cursor-pointer flex flex-wrap gap-2"><span>{new Date(entry.timestamp).toLocaleString()}</span><strong>{entry.action}</strong><span className="break-all">{entry.target}</span><span className={entry.outcome === "success" ? "text-ok" : "text-warn"}>{entry.outcome}</span><span className="ml-auto">{entry.actor}</span></summary><p className="text-mute mt-2">Audit ID: {entry.id}</p>{entry.sql && <pre className="whitespace-pre-wrap break-all mt-2">{entry.sql}</pre>}{entry.error && <p className="text-err mt-2 break-words">{entry.error}</p>}</details>)}
  </section>;
}
