import { useEffect, useRef, useState } from "react";
import TablespaceOverview from "./TablespaceOverview";
import DbaAuditHistory from "./DbaAuditHistory";
import { storageDestinations } from "../utils/storageDestinations";
import { Database, RefreshCcw } from "lucide-react";
import { useStudio } from "../state/store";
import { api, ConfirmRequiredError, type DbaManagementReport } from "../utils/api";
import { memoryParameters, memorySql, storageChangeSql } from "../utils/dbaSql";
import { Btn, EmptyState, Field, inputCls, Spinner } from "./ui";

export default function DbaStorage({ page }: { page: "Storage" | "Memory" }) {
  const s = useStudio();
  const conn = s.connections.find(c => c.id === s.activeConnId);
  const connected = conn?.live && conn.engine === "oracle" && conn.status === "connected";
  const [report, setReport] = useState<DbaManagementReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, refresh] = useState(0);
  const [action, setAction] = useState("create");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [mb, setMb] = useState("1024");
  const [temporary, setTemporary] = useState(false);
  const [parameter, setParameter] = useState<string>("sga_target");
  const [scope, setScope] = useState("MEMORY");
  const [preview, setPreview] = useState("");
  const [formError, setFormError] = useState("");
  const [autoextend, setAutoextend] = useState(false);
  const [nextMb, setNextMb] = useState("128");
  const [maxMb, setMaxMb] = useState("32767");
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [applying, setApplying] = useState(false);
  const [lastAudit, setLastAudit] = useState("");
  const fileAction = action === "resize" || action === "autoextend";
  const tablespaceOnly = ["drop", "readOnly", "readWrite"].includes(action);
  const change = { action, name, path, mb, temporary, autoextend, nextMb, maxMb, deleteFiles, bigfile: report?.sections.tablespaces?.rows.find(row => row.Name === name)?.Bigfile === "YES" };
  const formRef = useRef<HTMLElement>(null);
  const destinations = storageDestinations(report?.sections.files?.rows ?? [], name, temporary);
  const selectedFile = report?.sections.files?.rows.find(file => file.File === path);
  useEffect(() => { setPath(""); setName(""); setPreview(""); setTypedName(""); setLastAudit(""); }, [conn?.id]);
  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError("");
    if (!connected || !conn) return;
    setLoading(true);
    api.dbaManagement(conn.id, page === "Storage" ? ["tablespaces", "files", "tablespaceUsage"] : ["memory", "sga", "pga"]).then(data => { if (!cancelled) setReport(data); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conn?.id, connected, revision, page]);
  // A preview always corresponds to the current form values.
  useEffect(() => { setPreview(""); setFormError(""); setTypedName(""); }, [page, action, name, path, mb, temporary, parameter, scope, autoextend, nextMb, maxMb, deleteFiles]);

  if (!connected) return <EmptyState icon={<Database />} title="Connect to Oracle to manage your database" hint="Select a connected Oracle connection in the Explorer. DBA Manager reads storage, memory, and resource views for that connection." />;

  const section = (key: string, title: string) => {
    const data = report?.sections[key];
    const columns = Object.keys(data?.rows[0] ?? {});
    return <section key={key} className="border border-bdr rounded-xl p-4 bg-panel">
      <h3 className="font-semibold mb-3">{title}</h3>
      {data?.truncated && <p className="text-xs text-warn mb-2">Showing the first 500 rows.</p>}
      {data?.error ? <div role="alert" className="text-warn text-xs break-words">Unavailable: {data.error}<p className="mt-1 text-mute">Check dictionary-view privileges for this Oracle user.</p></div>
        : !data?.rows.length ? <p className="text-mute text-xs">No rows reported.</p>
        : <div className="overflow-x-auto"><table className="w-full text-xs text-left"><thead><tr>{columns.map(c => <th key={c} className="p-2 border-b border-bdr text-mute whitespace-nowrap">{c}</th>)}</tr></thead><tbody>{data.rows.map((row, i) => <tr key={i} className="border-b border-bdrsoft">{columns.map(c => <td key={c} className="p-2 font-mono whitespace-nowrap">{row[c] ?? "—"}</td>)}</tr>)}</tbody></table></div>}
    </section>;
  };
  const generate = () => {
    try {
      setFormError("");
      if (page === "Storage" && action === "add" && report?.sections.tablespaces?.rows.some(r => r.Name === name && r.Bigfile === "YES")) throw new Error("Bigfile tablespaces contain one file. Resize the existing file instead.");
      if (page === "Memory") {
        const row = report?.sections.memory?.rows.find(r => r.Parameter === parameter);
        if (row?.["System modifiable"] === "FALSE" && scope !== "SPFILE") throw new Error("This static parameter requires SPFILE scope and a database restart.");
      }
      setPreview(page === "Storage" ? storageChangeSql(change) : memorySql(parameter, mb, scope));
    } catch (e) { setPreview(""); setFormError((e as Error).message); }
  };
  const apply = async (confirmed = false) => {
    if (!conn || applying) return;
    setApplying(true); setFormError("");
    try {
      const result = await api.dbaStorage(conn.id, change, typedName, confirmed);
      setLastAudit(result.auditId); setPreview(""); refresh(n => n + 1);
      s.toast("success", "Tablespace change applied and recorded in the audit log.");
    } catch (e) {
      if (e instanceof ConfirmRequiredError) s.askConfirm({ ...e.confirmation, onConfirm: () => { void apply(true); } });
      else { setFormError((e as Error).message); refresh(n => n + 1); }
    } finally { setApplying(false); }
  };
  return <div className="h-full overflow-auto p-4 space-y-4 text-[13px]">
    <header className="flex items-center gap-3"><h2 className="font-semibold">{page === "Storage" ? "Tablespaces & datafiles" : "Memory management"}</h2><Btn className="ml-auto" variant="outline" disabled={loading} onClick={() => refresh(n => n + 1)}><RefreshCcw size={13} /> Refresh</Btn></header>
    {loading && <Spinner label="Reading database configuration…" />}
    {error && <p role="alert" className="text-err">{error}</p>}
    {report && <><p className="text-xs text-mute">Snapshot: {new Date(report.capturedAt).toLocaleString()} · Current connection/container</p>
      {page === "Storage" && <TablespaceOverview report={report} readOnly={!!conn?.readOnly || applying} onManage={(operation, tablespace, file) => {
        setAction(operation); setName(String(tablespace.Name ?? "")); setTemporary(tablespace.Contents === "TEMPORARY");
        setPath(String(file?.File ?? "")); setMb(file ? String(Math.ceil(Number(file["Allocated MiB"]))) : "1024");
        setAutoextend(file?.Autoextend === "YES"); setMaxMb(String(Math.floor(Number(file?.["Max MiB"])) || 32767)); setDeleteFiles(false); setTypedName("");
        setPreview(""); setFormError("");
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        formRef.current?.focus({ preventScroll: true });
      }} />}
      {page === "Memory" && <>{section("memory", "Memory parameters")}{section("sga", "SGA allocation")}{section("pga", "PGA statistics")}</>}
      </>}
    <section ref={formRef} tabIndex={-1} aria-label="Management form" className="border border-bdr rounded-xl p-4 space-y-3">
      <h3 className="font-semibold">{page === "Storage" ? `${action === "create" ? "Create tablespace" : `Edit ${name || "tablespace"}`} · ${conn.name}` : "Change memory parameter"}</h3>
      <p className="text-xs text-mute">{page === "Storage" ? "1. Choose a change and edit its settings. 2. Review SQL. 3. Confirm and apply. Every applied change is logged on the server." : "Prepare a statement, then review and run it in the SQL worksheet."} DDL commits implicitly.</p>
      {conn?.readOnly && <p className="text-warn">This connection is read-only. Changes are disabled.</p>}
      <fieldset disabled={applying || !!conn.readOnly} className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {page === "Storage" ? <>
          <Field label="Change"><select className={inputCls} value={action} onChange={e => { setAction(e.target.value); setPath(""); setDeleteFiles(false); }}><option value="create">Create tablespace</option><option value="add">Add file</option><option value="resize">Resize file</option><option value="autoextend">Change automatic growth</option><option value="readOnly">Make read-only</option><option value="readWrite">Allow writes</option><option value="drop">Delete tablespace…</option></select></Field>
          <Field label="Tablespace">{action === "create" ? <input className={inputCls} value={name} onChange={e => setName(e.target.value)} /> : <select className={inputCls} value={name} onChange={e => { setName(e.target.value); setPath(""); const row = report?.sections.tablespaces?.rows.find(r => r.Name === e.target.value); setTemporary(row?.Contents === "TEMPORARY"); }}><option value="">Select a tablespace…</option>{report?.sections.tablespaces?.rows.map(r => <option key={String(r.Name)} value={String(r.Name)}>{r.Name}</option>)}</select>}</Field>
          {action === "create" && <Field label="File type"><select className={inputCls} value={temporary ? "temp" : "data"} onChange={e => setTemporary(e.target.value === "temp")}><option value="data">Datafile (permanent)</option><option value="temp">Tempfile (temporary)</option></select></Field>}
          {fileAction && <Field label="Existing file"><select className={inputCls} value={path} onChange={e => { setPath(e.target.value); const file = report?.sections.files?.rows.find(r => r.File === e.target.value); setTemporary(file?.Kind === "TEMPFILE"); setMb(String(Math.ceil(Number(file?.["Allocated MiB"])) || 1024)); setAutoextend(file?.Autoextend === "YES"); setMaxMb(String(Math.floor(Number(file?.["Max MiB"])) || 32767)); }}><option value="">Select a file…</option>{report?.sections.files?.rows.filter(r => r.Tablespace === name).map(r => <option key={String(r.File)} value={String(r.File)}>{r.File} · {r["Allocated MiB"]} MiB</option>)}</select></Field>}
          {!fileAction && !tablespaceOnly && <Field label="Database-server file path / ASM destination">
            <input className={inputCls} value={path} onChange={e => setPath(e.target.value)} placeholder={action === "resize" ? "Existing database file" : destinations[0] ?? "Enter a server file path or +DISKGROUP"} />
            {action !== "resize" && <div className="mt-2 space-y-2">
              <select aria-label="Suggested file destination" className={inputCls} value="" disabled={!destinations.length || !!conn?.readOnly} onChange={e => { if (e.target.value) setPath(e.target.value); }}>
                <option value="">{destinations.length ? "Choose a suggested destination…" : "No destinations available"}</option>
                {destinations.map(destination => <option key={destination} value={destination}>{destination}</option>)}
              </select>
              <p className="text-xs text-mute">{destinations.length ? "Based on this database’s existing files, with matching file types first. Filenames use the current tablespace name; ASM disk groups let Oracle name the file. You can edit the selected destination." : "Enter a destination manually; suggestions require existing file information."} Server access and available space must be checked before running.</p>
            </div>}
          </Field>}
          {action === "autoextend" && <><Field label="Automatic growth"><select className={inputCls} value={autoextend ? "on" : "off"} onChange={e => setAutoextend(e.target.value === "on")}><option value="off">Disabled — fixed file size</option><option value="on">Enabled — grow up to a limit</option></select></Field>{autoextend && <><Field label="Grow by (MiB)"><input className={inputCls} type="number" min="1" step="1" value={nextMb} onChange={e => setNextMb(e.target.value)} /></Field><Field label="Maximum file size (MiB)"><input className={inputCls} type="number" min="1" step="1" value={maxMb} onChange={e => setMaxMb(e.target.value)} /></Field></>}</>}
          {action === "drop" && <div className="sm:col-span-2 border border-err rounded-lg p-3 space-y-2"><p className="text-err">Deletes the tablespace and ALL its objects. This cannot be undone.</p><label className="flex gap-2"><input type="checkbox" checked={deleteFiles} onChange={e => setDeleteFiles(e.target.checked)} />Also delete physical datafiles from storage</label><p className="text-xs text-mute">Physical files are kept unless selected above. SYSTEM and SYSAUX are protected.</p></div>}
        </> : <>
          <Field label="Parameter"><select className={inputCls} value={parameter} onChange={e => setParameter(e.target.value)}>{memoryParameters.map(p => <option key={p}>{p}</option>)}</select></Field>
          <Field label="Scope"><select className={inputCls} value={scope} onChange={e => setScope(e.target.value)}><option value="MEMORY">Memory — until restart</option><option value="SPFILE">SPFILE — after restart</option><option value="BOTH">Both — now and after restart</option></select></Field>
        </>}
        {(page === "Memory" || (!tablespaceOnly && action !== "autoextend")) && <Field label={page === "Storage" && action === "resize" ? "New total file size (MiB)" : "Size (MiB)"}><input type="number" min={page === "Memory" ? 0 : 1} step="1" className={inputCls} value={mb} onChange={e => setMb(e.target.value)} /></Field>}
      </fieldset>
      {page === "Storage" && fileAction && selectedFile && <p className="text-xs text-mute">Current file size: {selectedFile["Allocated MiB"]} MiB · Automatic growth: {selectedFile.Autoextend} · Current limit: {selectedFile["Max MiB"]} MiB{action === "resize" && Number(mb) < Number(selectedFile["Allocated MiB"]) ? " · Warning: this will shrink the file." : ""}</p>}
      <p className="text-xs text-mute">{page === "Storage" ? "New files use AUTOEXTEND OFF. Bigfile tablespaces cannot accept additional files. Shrinking a file requires sufficient unused space at its end." : "SPFILE/BOTH requires an SPFILE. Static settings require restart; PDB changes require a PDB-modifiable parameter. Check available host memory and related parameter limits before running."}</p>
      <Btn variant="outline" disabled={!!conn?.readOnly || applying} onClick={generate}>Review SQL</Btn>
      {formError && <p role="alert" className="text-err">{formError}</p>}
      {preview && <><pre className="bg-bg border border-bdr p-3 rounded-lg whitespace-pre-wrap break-all font-mono text-xs">{preview}</pre>{page === "Storage" ? <>{action === "drop" && <Field label={`Type ${name} to enable deletion`}><input className={inputCls} value={typedName} disabled={applying} onChange={e => setTypedName(e.target.value)} autoComplete="off" /></Field>}<Btn variant="primary" disabled={!!conn.readOnly || applying || (action === "drop" && typedName !== name)} onClick={() => { void apply(); }}>{applying ? "Applying…" : "Confirm and apply…"}</Btn></> : <Btn variant="primary" disabled={!!conn?.readOnly} onClick={() => { s.setSql(preview); s.openTab("worksheet", "Worksheet 1"); }}>Open in worksheet</Btn>}</>}
      {lastAudit && <p role="status" className="text-ok text-xs">Change applied. Audit ID: {lastAudit} · Server log: data/dba-audit.jsonl</p>}
    </section>
    <DbaAuditHistory connectionId={conn.id} revision={revision} />
  </div>;
}

