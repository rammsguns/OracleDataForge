import { useRef, useState } from "react";
import type { DbaManagementReport } from "../utils/api";
import { formatStorage, tablespaceCapacity, type StorageRow } from "../utils/tablespaceCapacity";
import { Btn, inputCls } from "./ui";
import HorizontalScrollbar from "./HorizontalScrollbar";

export default function TablespaceOverview({ report, readOnly, onManage, onInspect }: { report: DbaManagementReport; readOnly: boolean; onManage: (operation: string, tablespace: StorageRow, file?: StorageRow) => void; onInspect: (tablespace: StorageRow) => void }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState("");
  const [sort, setSort] = useState("urgency");
  const tableRef = useRef<HTMLDivElement>(null);
  const rows = (report.sections.tablespaces?.rows ?? []).map(row => {
    const fileSizes = report.sections.tablespaceFileSizes?.rows.find(size => size.Name === row.Name);
    const fileSize = fileSizes?.["Allocated MiB"];
    const configuredLimit = fileSizes?.["Configured limit MiB"];
    return { row, allocated: fileSize == null ? null : Number(fileSize), configuredLimit: configuredLimit == null ? null : Number(configuredLimit), ...tablespaceCapacity(report.sections.tablespaceUsage?.rows.find(m => m.Name === row.Name)) };
  });
  const visible = rows.filter(item => String(item.row.Name).toLowerCase().includes(search.toLowerCase()) && (filter === "all" || (filter === "attention" ? item.health !== "Healthy" : item.row.Contents === filter || item.health === filter))).sort((a, b) => {
    const byName = String(a.row.Name).localeCompare(String(b.row.Name));
    if (sort === "name") return byName;
    const key = sort.startsWith("used") ? "used" : sort.startsWith("unused") ? "remaining" : sort.startsWith("total") ? "capacity" : "percent";
    const first = a[key];
    const second = b[key];
    if (first === null) return second === null ? byName : 1;
    if (second === null) return -1;
    const ascending = sort.endsWith("Asc");
    return (ascending ? first - second : second - first) || byName;
  });
  const active = visible.find(item => item.row.Name === selected) ?? visible[0];
  const files = report.sections.files?.rows.filter(file => file.Tablespace === active?.row.Name) ?? [];
  const color = (health: string) => health === "Critical" ? "text-err" : health === "Warning" ? "text-warn" : health === "Healthy" ? "text-ok" : "text-mute";
  return <div className="space-y-4">
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{["Critical", "Warning", "Healthy", "Unknown"].map(health => <button key={health} className={`text-left rounded-xl border border-bdr bg-panel p-4 ${color(health)}`} onClick={() => setFilter(health)}><div className="text-2xl font-semibold">{rows.filter(item => item.health === health).length}</div><div className="text-xs mt-1">{health === "Unknown" ? "Usage unavailable" : health}</div></button>)}</div>
    <section className="rounded-xl border border-bdr bg-panel p-4 space-y-3">
      <div className="flex flex-wrap gap-2 items-center"><h3 className="font-semibold mr-auto">Tablespace capacity</h3><Btn variant="outline" disabled={readOnly} onClick={() => onManage("create", {})}>Create tablespace</Btn></div>
      <p className="text-xs text-mute">Current size is allocated file space; configured limit is the sum of file autoextend limits. Changing the limit does not resize a file. Growth capacity and remaining capacity come from Oracle usage metrics and can be constrained by available storage. Warning: ≥85% used · Critical: ≥95% used.</p>
      <div className="flex flex-wrap gap-2"><input aria-label="Search tablespaces" placeholder="Search tablespaces…" className={`${inputCls} flex-1 min-w-40 sm:!w-auto`} value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Filter tablespaces" className={`${inputCls} sm:!w-auto`} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All tablespaces</option><option value="attention">Needs attention</option>{["Critical", "Warning", "Healthy", "Unknown"].map(health => <option key={health} value={health}>{health}</option>)}<option value="PERMANENT">Permanent</option><option value="TEMPORARY">Temporary</option><option value="UNDO">Undo</option></select><select aria-label="Sort tablespaces" className={`${inputCls} sm:!w-auto`} value={sort} onChange={e => setSort(e.target.value)}><option value="urgency">Most urgent first</option><option value="usedDesc">Most used space</option><option value="usedAsc">Least used space</option><option value="unusedDesc">Most unused space</option><option value="unusedAsc">Least unused space</option><option value="totalDesc">Largest total capacity</option><option value="totalAsc">Smallest total capacity</option><option value="name">Name</option></select></div>
      {["tablespaces", "tablespaceUsage", "tablespaceFileSizes"].map(key => report.sections[key]?.error && <p key={key} role="alert" className="text-warn text-xs break-words">{key === "tablespaces" ? "Tablespaces" : key === "tablespaceUsage" ? "Usage metrics" : "Current file sizes"} unavailable: {report.sections[key].error}</p>)}
      {["tablespaces", "tablespaceUsage", "tablespaceFileSizes"].some(key => report.sections[key]?.truncated) && <p className="text-warn text-xs">Partial snapshot: only the first 500 rows were returned. Counts and filters cover loaded tablespaces only.</p>}
      <div className="min-w-0 border border-bdrsoft rounded-md overflow-hidden"><div ref={tableRef} className="sessions-scroll max-h-[60vh] overflow-auto"><table className="w-full min-w-max text-xs text-left"><thead className="text-mute sticky top-0 bg-panel z-10"><tr>{["Tablespace", "Health", "Capacity used", "Current size", "Configured limit", "Remaining", "Used / growth capacity"].map(label => <th key={label} className="p-3 border-b border-bdr whitespace-nowrap">{label}</th>)}</tr></thead><tbody>{visible.map(item => <tr key={String(item.row.Name)} className={`border-b border-bdrsoft ${active?.row.Name === item.row.Name ? "bg-bg" : ""}`}><td className="p-3"><button className="font-semibold underline underline-offset-4 text-left" aria-label={`Manage ${item.row.Name}`} onClick={() => { setSelected(String(item.row.Name)); if (!readOnly) { const firstFile = report.sections.files?.rows.find(file => file.Tablespace === item.row.Name); onManage(firstFile ? "resize" : "add", item.row, firstFile); } }}>{item.row.Name}</button><button className="ml-3 text-soft underline underline-offset-4" onClick={() => { setSelected(String(item.row.Name)); onInspect(item.row); }}>View objects</button><div className="text-mute mt-1">{item.row.Contents} · {item.row.Status}</div></td><td className={`p-3 font-semibold ${color(item.health)}`}>{item.health}</td><td className="p-3 min-w-40"><div className="flex justify-between mb-1"><span>{item.percent === null ? "Unavailable" : `${item.percent.toFixed(1)}%`}</span></div><div className="h-2 rounded-full bg-bg overflow-hidden" role={item.percent === null ? undefined : "meter"} aria-label={`${item.row.Name} capacity used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.percent === null ? undefined : Math.min(100, item.percent)}><div className={`h-full ${item.health === "Critical" ? "bg-err" : item.health === "Warning" ? "bg-warn" : "bg-ok"}`} style={{ width: `${Math.min(100, item.percent ?? 0)}%` }} /></div></td><td className="p-3 whitespace-nowrap font-semibold">{formatStorage(item.allocated)}</td><td className="p-3 whitespace-nowrap">{formatStorage(item.configuredLimit)}</td><td className={`p-3 whitespace-nowrap font-semibold ${color(item.health)}`}>{formatStorage(item.remaining)}</td><td className="p-3 whitespace-nowrap">{formatStorage(item.used)} / {formatStorage(item.capacity)}</td></tr>)}</tbody></table></div><HorizontalScrollbar target={tableRef} contentKey={visible.length} /></div>
      {!visible.length && <p className="text-mute py-4">No tablespaces match this view.</p>}
      <p className="text-xs text-mute">Click a tablespace name to edit it, or View objects to inspect allocated segments. Undo usage includes expired undo; temporary usage varies with workload. Metrics are an Oracle snapshot.</p>
    </section>
    {active && <section className="rounded-xl border border-bdr bg-panel p-4 space-y-3"><div className="flex items-center flex-wrap gap-3"><h3 className="font-semibold">{active.row.Name} — files</h3><span className="text-xs text-mute">{active.row.Bigfile === "YES" ? "Bigfile · resize the existing file" : "Smallfile"}</span><Btn className="ml-auto" variant="outline" disabled={readOnly || active.row.Bigfile === "YES"} onClick={() => onManage("add", active.row)}>Add file</Btn></div>
      <div className="flex flex-wrap gap-2"><Btn variant="outline" disabled={readOnly || active.row.Contents !== "PERMANENT"} onClick={() => onManage(active.row.Status === "READ ONLY" ? "readWrite" : "readOnly", active.row)}>{active.row.Status === "READ ONLY" ? "Allow writes" : "Make read-only"}</Btn><Btn variant="danger" disabled={readOnly || ["SYSTEM", "SYSAUX"].includes(String(active.row.Name).toUpperCase())} onClick={() => onManage("drop", active.row)}>Delete tablespace…</Btn></div>
      {report.sections.files?.error && <p role="alert" className="text-warn text-xs break-words">Files unavailable: {report.sections.files.error}</p>}
      {report.sections.files?.truncated && <p className="text-warn text-xs">File list is limited to the first 500 files; some files may be missing.</p>}
      {files.map(file => <div key={String(file.File)} className="border border-bdr rounded-lg p-3 flex flex-wrap items-center gap-3"><div className="flex-1 min-w-0"><div className="font-mono text-xs break-all">{file.File}</div><div className="text-xs text-mute mt-2">{file.Kind} · Allocated {formatStorage(Number(file["Allocated MiB"]))} · Autoextend {file.Autoextend}{file.Autoextend === "YES" ? ` · File limit ${formatStorage(Number(file["Max MiB"]))}` : ""}</div></div><Btn variant="outline" disabled={readOnly} onClick={() => onManage("resize", active.row, file)}>Resize file</Btn><Btn variant="outline" disabled={readOnly} onClick={() => onManage("autoextend", active.row, file)}>Automatic growth</Btn></div>)}
      {!files.length && !report.sections.files?.error && <p className="text-mute text-xs">No files returned for this tablespace.</p>}
    </section>}
  </div>;
}
