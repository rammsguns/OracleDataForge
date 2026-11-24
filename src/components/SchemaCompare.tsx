import { useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowLeftRight, Download, GitCompareArrows, Plug, Search } from "lucide-react";
import { useStudio } from "../state/store";
import { api } from "../utils/api";
import { compareObjectKey, deploymentScript, type CompareCatalog, type SchemaCompareResult } from "../utils/schemaCompare";
import DiffView from "./DiffView";
import ConnectionPicker from "./ConnectionPicker";
import { Btn, Spinner, inputCls } from "./ui";

const statuses = ["same", "changed", "sourceOnly", "targetOnly", "error"] as const;
const labels = { same: "Identical", changed: "Changed", sourceOnly: "Source only", targetOnly: "Target only", error: "Errors" };
const tones = { same: "text-ok", changed: "text-warn", sourceOnly: "text-accenthi", targetOnly: "text-warn", error: "text-err" };
function download(text: string, name: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const toggle = (set: Set<string>, key: string) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); return next; };

export default function SchemaCompare() {
  const s = useStudio();
  const connections = s.connections.filter(c => c.engine === "oracle" && c.live);
  const [sourceId, setSourceId] = useState(connections[0]?.id ?? "");
  const [targetId, setTargetId] = useState(connections[1]?.id ?? connections[0]?.id ?? "");
  const [sourceSchema, setSourceSchema] = useState("");
  const [targetSchema, setTargetSchema] = useState("");
  const [catalogs, setCatalogs] = useState<[CompareCatalog, CompareCatalog] | null>(null);
  const [types, setTypes] = useState(new Set<string>());
  const [picked, setPicked] = useState(new Set<string>());
  const [search, setSearch] = useState("");
  const [compareData, setCompareData] = useState(false);
  const [includeStorage, setIncludeStorage] = useState(false);
  const [rowLimit, setRowLimit] = useState(1000);
  const [busy, setBusy] = useState<"loading" | "comparing" | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const connectingRef = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SchemaCompareResult | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [detailKey, setDetailKey] = useState("");
  const [status, setStatus] = useState("all");
  const [pane, setPane] = useState<"diff" | "source" | "target" | "data" | "script">("diff");
  const [includeDrops, setIncludeDrops] = useState(false);
  const [includeData, setIncludeData] = useState(false);
  const [resultSearch, setResultSearch] = useState("");

  const objects = useMemo(() => [...new Map((catalogs?.flatMap(c => c.objects) ?? []).map(o => [compareObjectKey(o), o])).values()]
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)), [catalogs]);
  const allTypes = [...new Set(objects.map(o => o.type))];
  const visible = objects.filter(o => types.has(o.type) && `${o.name} ${o.type}`.toLowerCase().includes(search.toLowerCase()));
  const chosen = objects.filter(o => types.has(o.type) && picked.has(compareObjectKey(o)));
  const detail = result?.objects.find(o => o.key === detailKey);
  const script = useMemo(() => result ? deploymentScript(result, selected, includeDrops, includeData) : "", [result, selected, includeDrops, includeData]);
  const sourceKeys = new Set(catalogs?.[0].objects.map(compareObjectKey));
  const targetKeys = new Set(catalogs?.[1].objects.map(compareObjectKey));
  const clearSetup = () => { setCatalogs(null); setResult(null); setError(""); };
  const connect = async (id: string) => {
    if (busy || connectingRef.current || connections.find(c => c.id === id)?.status === "connected") return;
    connectingRef.current = id;
    setConnectingId(id); setError("");
    try { await s.reconnectConn(id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { connectingRef.current = null; setConnectingId(null); }
  };
  const load = async () => {
    if (connectingRef.current) return;
    setBusy("loading"); setError(""); setResult(null); setCatalogs(null);
    try {
      const list = await Promise.all([api.compareCatalog(sourceId, sourceSchema), api.compareCatalog(targetId, targetSchema)]);
      setCatalogs(list as [CompareCatalog, CompareCatalog]);
      const union = [...new Map(list.flatMap(c => c.objects).map(o => [compareObjectKey(o), o])).values()];
      setTypes(new Set(union.map(o => o.type)));
      setPicked(new Set(union.length <= 500 ? union.map(compareObjectKey) : []));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const compare = async () => {
    if (!catalogs || connectingRef.current) return;
    setBusy("comparing"); setError("");
    try {
      const r = await api.schemaCompare(targetId, { sourceId,
        sourceSchema: `"${catalogs[0].schema.replace(/"/g, '""')}"`, targetSchema: `"${catalogs[1].schema.replace(/"/g, '""')}"`,
        objects: chosen, compareData, rowLimit: compareData ? rowLimit : 1000, includeStorage });
      setResult(r); setSelected(new Set(r.objects.filter(o => o.status !== "same" && o.status !== "targetOnly" && o.status !== "error" || o.data?.status === "different").map(o => o.key)));
      setDetailKey(r.objects.find(o => o.status !== "same")?.key ?? r.objects[0]?.key ?? "");
      setPane("diff"); setStatus("all"); setIncludeData(false); setIncludeDrops(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const connPicker = (side: "source" | "target") => {
    const isSource = side === "source";
    const connection = connections.find(c => c.id === (isSource ? sourceId : targetId));
    return <div className="flex-1 min-w-0 basis-72 space-y-2 self-stretch">
      <div className="text-[10px] uppercase tracking-wider text-mute">{isSource ? "Source · desired definition (DEV)" : "Target · deployment destination (PROD)"}</div>
      <ConnectionPicker label={side} connections={connections} value={isSource ? sourceId : targetId} disabled={!!busy || connectingId !== null} onChange={id => {
        (isSource ? setSourceId : setTargetId)(id); (isSource ? setSourceSchema : setTargetSchema)(""); clearSetup();
      }} />
      {connection && connection.status !== "connected" && <div className="flex items-center gap-2">
        <Btn variant="outline" aria-label={`Connect ${side} connection`} disabled={!!busy || connectingId !== null} onClick={() => void connect(connection.id)}>
          {connectingId === connection.id ? <Spinner /> : <Plug size={13} />}{connectingId === connection.id ? "Connecting…" : "Connect"}
        </Btn>
        {connection.status === "error" && connection.lastError && <span role="alert" className="text-[11px] text-err break-words min-w-0">{connection.lastError}</span>}
      </div>}
      <input aria-label={`${side} schema`} placeholder={`Schema (default: ${connection?.user || "connection user"})`} className={`${inputCls} w-full`} value={isSource ? sourceSchema : targetSchema} onChange={e => { (isSource ? setSourceSchema : setTargetSchema)(e.target.value); clearSetup(); }} />
    </div>;
  };
  return <div className="h-full overflow-auto bg-panel text-[12px]">
    <div className="px-5 py-4 border-b border-bdr bg-panel2">
      <h2 className="text-base font-semibold flex items-center gap-2"><GitCompareArrows size={19} className="text-accenthi" />Schema Compare</h2>
      <p className="text-mute mt-1">Compare Oracle schemas, inspect object definitions, and build a deployment script from source to target.</p>
    </div>
    <fieldset disabled={!!busy || connectingId !== null} className="p-5 border-b border-bdr space-y-4 min-w-0">
      <div className="flex gap-4 items-center flex-wrap">{connPicker("source")}
        <div className="flex flex-col items-center gap-1 text-accenthi"><ArrowRight size={22} /><Btn title="Swap source and target" onClick={() => { setSourceId(targetId); setTargetId(sourceId); setSourceSchema(targetSchema); setTargetSchema(sourceSchema); clearSetup(); }}><ArrowLeftRight size={14} /></Btn></div>
        {connPicker("target")}
      </div>
      <div className="flex gap-4 flex-wrap items-center">
        <label className="flex gap-2 items-center"><input type="checkbox" checked={includeStorage} onChange={e => { setIncludeStorage(e.target.checked); setResult(null); }} />Compare storage and tablespaces</label>
        <label className="flex gap-2 items-center"><input type="checkbox" checked={compareData} onChange={e => { setCompareData(e.target.checked); setResult(null); }} />Compare table data</label>
        {compareData && <label>Maximum rows per table per side <input aria-label="Data row limit" className={`${inputCls} w-24 ml-2`} type="number" min={1} max={10000} value={rowLimit} onChange={e => { setRowLimit(Number(e.target.value)); setResult(null); }} /></label>}
        <Btn variant="outline" disabled={!sourceId || !targetId} onClick={() => void load()}>Load objects</Btn>
      </div>
      {compareData && <p className="text-mute">Rows match by primary key. Each database is read at its own consistent snapshot. Tables over the limit or with unsupported columns are reported as incomplete or skipped.</p>}
      <p className="text-mute">Blank schema uses the connection user. Other schemas require dictionary and DBMS_METADATA access. All visible object types are listed; unsupported metadata is reported per object.</p>
    </fieldset>
    {error && <div role="alert" className="m-4 p-3 border border-err/30 bg-err/10 text-err rounded">{error}</div>}
    {busy && <div role="status" className="p-4 flex items-center gap-2 text-accenthi"><Spinner />{busy === "loading" ? "Loading object inventories…" : `Comparing ${chosen.length} objects${compareData ? " and table data" : ""}…`}</div>}
    {catalogs && !result && <div className="p-5 space-y-3">
      <div className="flex flex-wrap gap-2 items-center"><h3 className="font-semibold mr-auto">Object types</h3>
        <Btn onClick={() => setTypes(new Set(allTypes))}>All types</Btn><Btn onClick={() => setTypes(new Set())}>Clear types</Btn>
      </div>
      <div className="flex flex-wrap gap-2">{allTypes.map(type => <label key={type} className={`border rounded px-2 py-1.5 flex gap-2 items-center ${types.has(type) ? "border-accent/50 bg-accentdim" : "border-bdr text-mute"}`}><input type="checkbox" checked={types.has(type)} onChange={() => setTypes(toggle(types, type))} />{type}<span className="text-mute">{objects.filter(o => o.type === type).length}</span></label>)}</div>
      <div className="flex items-center flex-wrap gap-2"><Search size={14} /><input aria-label="Filter objects" className={inputCls} placeholder="Find objects…" value={search} onChange={e => setSearch(e.target.value)} />
        <Btn onClick={() => setPicked(new Set([...picked, ...visible.map(compareObjectKey)]))}>Select visible</Btn>
        <Btn onClick={() => setPicked(new Set([...picked].filter(k => !visible.some(o => compareObjectKey(o) === k))))}>Clear visible</Btn>
        <span className="text-mute ml-auto">{chosen.length} selected · 500 maximum per comparison</span>
        <Btn variant="primary" disabled={!!busy || connectingId !== null || !chosen.length || chosen.length > 500 || (compareData && (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 10000))} onClick={() => void compare()}><GitCompareArrows size={14} />Compare selected</Btn>
      </div>
      <div className="max-h-[45vh] overflow-auto border border-bdr rounded"><table className="w-full text-left"><thead className="sticky top-0 bg-panel2 text-mute"><tr><th className="p-2">Select</th><th>Object</th><th>Type</th><th>Source</th><th>Target</th></tr></thead><tbody>{visible.map(o => {
        const key = compareObjectKey(o);
        return <tr key={key} className="border-t border-bdrsoft hover:bg-panel2"><td className="p-2"><input aria-label={`Select ${o.type} ${o.name}`} type="checkbox" disabled={!!busy} checked={picked.has(key)} onChange={() => setPicked(toggle(picked, key))} /></td><td className="font-mono">{o.name}</td><td className="text-mute">{o.type}</td><td>{sourceKeys.has(key) ? "Present" : "—"}</td><td>{targetKeys.has(key) ? "Present" : "—"}</td></tr>;
      })}</tbody></table>{!visible.length && <p className="p-8 text-center text-mute">No objects match the selected types and filter.</p>}</div>
    </div>}
    {result && <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{result.sourceName} / {result.sourceSchema} → {result.targetName} / {result.targetSchema}</span><span className="text-mute">{new Date(result.comparedAt).toLocaleString()}</span>
        <Btn className="ml-auto" disabled={!!busy} onClick={() => setResult(null)}>Change selection</Btn>
        <Btn onClick={() => download(JSON.stringify(result, null, 2), "schema-compare-report.json", "application/json")}><Download size={13} />Report</Btn>
      </div>
      <div className="flex gap-2 flex-wrap"><Btn variant={status === "all" ? "primary" : "outline"} onClick={() => setStatus("all")}>All {result.objects.length}</Btn>{statuses.map(k => <Btn key={k} variant={status === k ? "primary" : "outline"} onClick={() => setStatus(k)}>{labels[k]} {result.objects.filter(o => o.status === k).length}</Btn>)}</div>
      <div className="flex flex-wrap gap-3 items-center border border-bdr rounded p-3 bg-panel2">
        <label className="flex gap-2 items-center"><input type="checkbox" checked={includeDrops} onChange={e => setIncludeDrops(e.target.checked)} />Include target-only DROP statements</label>
        <label className="flex gap-2 items-center"><input type="checkbox" checked={includeData} onChange={e => setIncludeData(e.target.checked)} />Include data INSERT / UPDATE / DELETE</label>
        <Btn variant="primary" disabled={!selected.size} onClick={() => setPane("script")}>Generate script ({selected.size})</Btn>
        <Btn variant="outline" disabled={!selected.size} onClick={() => download(script, "schema-deployment.sql")}><Download size={13} />Download SQL</Btn>
      </div>
      {(includeDrops || includeData || result.objects.some(o => o.warning)) && <p className="text-warn">Review destructive changes, privileges, dependencies and triggers before deployment. Object ordering is by type; cross-object dependencies and cycles may need manual reordering. No changes have been applied.</p>}
      <div className="flex flex-wrap gap-2 items-center"><input aria-label="Filter comparison results" className={inputCls} placeholder="Find result…" value={resultSearch} onChange={e => setResultSearch(e.target.value)} /><Btn onClick={() => setSelected(new Set(result.objects.filter(o => o.status !== "same" && o.status !== "error" && (includeDrops || o.status !== "targetOnly") || o.data?.status === "different").map(o => o.key)))}>Select differences</Btn><Btn onClick={() => setSelected(new Set())}>Clear selection</Btn></div>
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(340px,2fr)_minmax(400px,3fr)] border border-bdr rounded overflow-hidden min-h-[380px]">
        <div className="overflow-auto max-h-[65vh] border-r border-bdr"><table className="w-full text-left"><thead className="bg-panel2 sticky top-0"><tr><th className="p-2">Use</th><th>Object / type</th><th>Status</th><th>Data</th></tr></thead><tbody>{result.objects.filter(o => (status === "all" || o.status === status) && `${o.name} ${o.type}`.toLowerCase().includes(resultSearch.toLowerCase())).map(o => <tr key={o.key} className={`border-t border-bdrsoft ${detailKey === o.key ? "bg-accentdim" : "hover:bg-panel2"}`}>
          <td className="p-2"><input aria-label={`Deploy ${o.type} ${o.name}`} type="checkbox" checked={selected.has(o.key)} disabled={o.status === "error"} onChange={() => setSelected(toggle(selected, o.key))} /></td>
          <td><button className="text-left py-2" onClick={() => { setDetailKey(o.key); setPane("diff"); }}><span className="block font-mono">{o.name}</span><span className="text-mute text-[10px]">{o.type}</span></button></td>
          <td className={tones[o.status]}>{labels[o.status]}</td><td><button className={o.data?.status === "different" ? "text-warn" : "text-mute"} onClick={() => { setDetailKey(o.key); setPane("data"); }}>{o.data?.status ?? "—"}</button></td>
        </tr>)}</tbody></table></div>
        <div className="flex flex-col min-w-0 max-h-[65vh]">
          <div className="flex gap-1 p-2 border-b border-bdr bg-panel2 flex-wrap">{(["diff", "source", "target", "data", "script"] as const).map(p => <Btn key={p} variant={pane === p ? "primary" : "ghost"} onClick={() => setPane(p)}>{{ diff: "Definition diff", source: "Source DDL", target: "Target DDL", data: "Data differences", script: "Deployment script" }[p]}</Btn>)}</div>
          {pane === "script" ? <pre aria-label="Deployment script" className="p-3 overflow-auto text-[11px] flex-1 whitespace-pre">{script}</pre> : <>
            <div className="px-3 py-2 font-mono border-b border-bdrsoft">{detail?.type} {detail?.name}</div>
            {detail?.warning && <p className="p-3 text-warn bg-warn/5">{detail.warning}</p>}
            {pane === "diff" && detail && <><p className="px-3 py-1 text-mute">− Target definition · + Desired source definition (original schema names shown)</p><DiffView oldSrc={detail.targetDdl} newSrc={detail.sourceDdl} /></>}
            {(pane === "source" || pane === "target") && <pre className="p-3 overflow-auto flex-1 text-[11px]">{(pane === "source" ? detail?.sourceDdl : detail?.targetDdl) || "Object does not exist on this side, or metadata is unavailable."}</pre>}
            {pane === "data" && <div className="p-3 overflow-auto flex-1"><p className="text-mute mb-3">{detail?.data?.message ?? "No table data comparison was performed for this object."}</p>{detail?.data?.samples.map((row, i) => <details key={i} className="border border-bdr rounded mb-2 p-2"><summary className="cursor-pointer font-mono">{row.source && row.target ? "Changed" : row.source ? "Source only" : "Target only"} · {row.key}</summary><pre className="mt-2 text-[11px] whitespace-pre-wrap">{JSON.stringify({ source: row.source, target: row.target }, null, 2)}</pre></details>)}{!!detail?.data?.samples.length && <p className="text-mute">Showing up to 100 row differences. SQL export includes all differences within the configured row limit.</p>}</div>}
          </>}
        </div>
      </div>
    </div>}
    {!catalogs && !busy && <div className="p-12 text-center text-mute"><GitCompareArrows className="mx-auto mb-3 opacity-40" size={36} /><p>Choose source and target connections, then load objects to compare all types or a custom selection.</p></div>}
  </div>;
}
