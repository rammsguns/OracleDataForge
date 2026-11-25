import { useState } from "react";
import { api } from "../utils/api";
import type { CompareCatalog } from "../utils/schemaCompare";
import { packageExportLog, type PackageInstallPlan } from "../utils/packageInstall";
import { Btn, Spinner, inputCls } from "./ui";

export default function PackageInstall({ sourceId, targetId, catalogs }: { sourceId: string; targetId: string; catalogs: [CompareCatalog, CompareCatalog] }) {
  const [packages, setPackages] = useState(new Set<string>());
  const [search, setSearch] = useState("");
  const [seeds, setSeeds] = useState(new Set<string>());
  const [limit, setLimit] = useState(1000);
  const [plan, setPlan] = useState<PackageInstallPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const change = (current: Set<string>, name: string) => { const next = new Set(current); if (!next.delete(name)) next.add(name); return next; };
  const analyze = async (generate: boolean) => {
    setBusy(true); setError(""); setPreview(false);
    try {
      const result = await api.packageInstall(targetId, { sourceId,
        sourceSchema: `"${catalogs[0].schema.replace(/"/g, '""')}"`, targetSchema: `"${catalogs[1].schema.replace(/"/g, '""')}"`,
        packages: [...packages], rowLimit: limit, ...(generate ? { seedTables: [...seeds] } : {}) });
      setPlan(result);
      if (!generate) setSeeds(new Set());
      setPreview(generate);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const download = () => {
    if (!plan) return;
    const url = URL.createObjectURL(new Blob([plan.script], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = "package-install.sql"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const available = catalogs[0].objects.filter(o => o.type === "PACKAGE");
  const target = new Set(catalogs[1].objects.filter(o => o.type === "PACKAGE").map(o => o.name));
  return <section className="space-y-3 border border-bdr rounded p-4">
    <h3 className="font-semibold">Package install · DEV → PROD</h3>
    <p className="text-mute">Select source packages. Discover transitive dependencies, check their presence on the target, and build a reviewed install script. Existing dependencies are retained without comparing their DDL; selected packages are compared during script generation.</p>
    <fieldset disabled={busy} className="space-y-3">
      <input aria-label="Search source packages" className={inputCls} placeholder="Search source packages…" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="max-h-52 overflow-auto border border-bdr rounded">{available.filter(o => o.name.toLowerCase().includes(search.toLowerCase())).map(o => <label key={o.name} className="flex items-center gap-2 border-b border-bdrsoft p-2">
        <input aria-label={`Install package ${o.name}`} type="checkbox" checked={packages.has(o.name)} onChange={() => { setPackages(change(packages, o.name)); setPlan(null); setPreview(false); setSeeds(new Set()); }} />
        <span className="font-mono">{o.name}</span><span className="ml-auto text-mute">{target.has(o.name) ? "Present on target" : "Missing on target"}</span>
      </label>)}{!available.length && <p className="p-3 text-mute">No source packages are visible in this schema.</p>}</div>
      <Btn variant="primary" disabled={!packages.size || packages.size > 100} onClick={() => void analyze(false)}>Analyze package dependencies ({packages.size})</Btn>
    </fieldset>
    {busy && <Spinner label="Reading selected dependencies, target inventory and PL/SQL usage…" />}
    {error && <p role="alert" className="text-err">{error}</p>}
    {plan && <>
      <p className="font-semibold">Dependencies found: {plan.objects.filter(o => o.type === 'TABLE').length} tables · {plan.objects.filter(o => /VIEW/.test(o.type)).length} views · {plan.objects.filter(o => o.type === 'SEQUENCE').length} sequences · {plan.objects.filter(o => o.type === 'INDEX').length} indexes</p>
      <p className="text-mute">{plan.objects.filter(o => o.status === 'sourceOnly').length} missing objects will be installed. Existing dependencies are retained; their definitions remain available in Object comparison.</p>
      <details><summary className="cursor-pointer font-semibold">Dependency review ({plan.objects.length} objects)</summary>
        <div className="max-h-80 overflow-auto"><table className="w-full text-left"><thead><tr><th>Object</th><th>Target comparison</th><th>Requires</th></tr></thead><tbody>{plan.objects.map(o => <tr key={o.key} className="border-t border-bdrsoft"><td className="p-2 font-mono">{o.type} {o.name}</td><td>{o.status === "sourceOnly" ? "Missing · install" : o.status === "same" ? (o.definitionCompared === false ? "Present · retained (DDL not compared)" : "Present · identical") : o.status === "changed" ? "Present · differs" : o.status}{o.warning && <p className="text-warn">{o.warning}</p>}</td><td>{plan.dependencies.find(d => d.object.name === o.name && d.object.type === o.type)?.requires.map(d => `${d.type} ${d.name}`).join(", ") || "—"}</td></tr>)}</tbody></table></div>
      </details>
      <h4 className="font-semibold">Table INSERT suggestions</h4>
      <p className="text-mute">Suggestions are heuristics from static PL/SQL reads/writes and table names, including status catalogs and blacklists. Review business meaning and sensitive data before selecting. Dynamic SQL may require additional objects. No tables are selected automatically.</p>
      <fieldset disabled={busy} className="space-y-2">
        {plan.suggestions.map(s => <label key={s.table} className="flex items-start gap-2 p-2 border border-bdr rounded">
          <input aria-label={`Export inserts ${s.table}`} type="checkbox" checked={seeds.has(s.table)} onChange={() => { setSeeds(change(seeds, s.table)); setPreview(false); }} />
          <span><span className="font-mono">{s.table}</span>{s.recommended && <span className="text-accenthi ml-2">Suggested reference data</span>}<span className="block text-mute">{s.reasons.join(" ")}</span>{s.evidence.map((e, i) => <code key={i} className="block text-[11px]">{e}</code>)}</span>
        </label>)}
        {!plan.suggestions.length && <p className="text-mute">No local table dependencies found.</p>}
        <p className="text-mute">Include required parent-table data too. Existing target primary keys are preserved; existing rows are never updated or deleted. Tables over the limit or with unsupported columns produce a column-level export error. Virtual columns are recomputed; supported identity IDs and LOB values are preserved.</p>
        <label>Maximum source rows per table <input aria-label="Seed row limit" type="number" className={`${inputCls} w-24 ml-2`} min={1} max={10000} value={limit} onChange={e => { setLimit(Number(e.target.value)); setPreview(false); }} /></label>
        <Btn variant="primary" disabled={!Number.isInteger(limit) || limit < 1 || limit > 10000 || seeds.size > 100} onClick={() => void analyze(true)}>Generate package install script</Btn>
      </fieldset>
      <details><summary className="cursor-pointer text-warn">Review prerequisites and limitations ({plan.warnings.length})</summary><ul className="list-disc pl-5 space-y-1">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>
      {preview && <>
        {plan.commitsSeedData && <p className="text-warn font-semibold">This script explicitly commits seed data to finalize identity sequences and restore ALWAYS identity modes. It preserves the original IDs. Review the script and use a maintenance window.</p>}
        {plan.identityRecoveryScript && <Btn variant="outline" onClick={() => {
          const url = URL.createObjectURL(new Blob([plan.identityRecoveryScript!], {type: 'text/plain'})); const a = document.createElement('a'); a.href = url; a.download = 'package-install-identity-recovery.sql'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Download identity recovery SQL</Btn>}
        {plan.exports.some(e => e.error) && <p role="alert" className="text-err font-semibold">Script incomplete: {plan.exports.filter(e => e.error).length} table export(s) failed. Download the export log, resolve the errors, and regenerate before deployment.</p>}
        {plan.exports.map(e => <div key={e.table} className={e.error ? 'text-err border border-err/30 rounded p-3' : 'text-mute'}>
          <p>{e.table}: {e.error ?? (e.rows + ' source rows scripted')}{e.elapsedMs !== undefined ? ' (' + (e.elapsedMs / 1000).toFixed(1) + ' s)' : ''}</p>
          {e.details && <div className="mt-1 text-[11px]"><p>Stage: {e.details.stage} · {e.details.code}{e.details.row ? ' · Source row ' + e.details.row : ''}</p><p>{e.details.sourceSchema} → {e.details.targetSchema}</p>{e.details.columns.map(c => <p key={c.name}><code>{c.name}</code> ({c.type}): {c.reason}</p>)}<p className="mt-1">Suggested action: {e.details.advice}</p></div>}
          {e.warnings?.map((w, i) => <p key={i} className="text-warn">{w}</p>)}
        </div>)}
        <Btn variant="outline" onClick={() => {
          const log = packageExportLog(plan);
          const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], {type: 'application/json'}));
          const a = document.createElement('a'); a.href = url; a.download = 'package-install-export-log.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Download export log</Btn>
        <p className="text-warn">Review dependency cycles, foreign keys, grants, triggers and compilation errors. DDL commits implicitly. This script has not been executed.</p>
        <Btn variant="outline" onClick={download}>Download package-install.sql</Btn>
        <pre aria-label="Package install script" className="max-h-[65vh] overflow-auto p-3 bg-panel2 border border-bdr rounded text-[11px] whitespace-pre">{plan.script}</pre>
      </>}
    </>}
  </section>;
}
