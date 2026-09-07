import { useEffect, useState } from "react";
import { Activity, ArchiveRestore, CalendarClock, ChevronDown, ChevronRight, ChevronsDownUp, Database, FileCode2, Folder, FolderOpen, Gauge, HardDrive, ListFilter, Plus, RefreshCcw, Search, Settings2, ShieldCheck, SlidersHorizontal, Terminal } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type DbaManagementReport } from "../utils/api";
import { dbaModules, type DbaPage } from "../utils/dbaModules";
import DbaStorage from "./DbaStorage";
import DbaAdvisor from "./DbaAdvisor";
import PerformanceMonitor from "./PerformanceMonitor";
import { Badge, Btn, EmptyState, inputCls, Spinner } from "./ui";

const icons = [Settings2, Database, ArchiveRestore, Activity, ArchiveRestore, SlidersHorizontal, FileCode2, CalendarClock, ShieldCheck, HardDrive, Gauge];

function CatalogPage({ connectionId, page }: { connectionId: string; page: DbaPage }) {
  const [report, setReport] = useState<DbaManagementReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setReport(null);
    api.dbaManagement(connectionId, page.sections!.map(([key]) => key))
      .then(data => { if (!cancelled) setReport(data); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connectionId, page, revision]);
  return <div className="p-4 space-y-4">
    <div className="flex items-center gap-3 flex-wrap">
      <label className="flex items-center gap-2 min-w-48"><ListFilter size={14} className="text-mute" /><input aria-label="Filter rows" className={inputCls} placeholder="Filter loaded rows…" value={filter} onChange={e => setFilter(e.target.value)} /></label>
      {report && <span className="text-[11px] text-mute">Read at {new Date(report.capturedAt).toLocaleTimeString()}</span>}
      <Btn className="ml-auto" variant="outline" disabled={loading} onClick={() => refresh(n => n + 1)}><RefreshCcw size={13} /> Refresh</Btn>
    </div>
    {loading && <Spinner label={`Reading ${page.label.toLowerCase()}…`} />}
    {error && <div role="alert" className="border border-err/30 rounded-lg p-4 text-err text-xs">{error}</div>}
    {report && page.sections!.map(([key, title]) => {
      const data = report.sections[key];
      const columns = Object.keys(data?.rows[0] ?? {});
      const rows = data?.rows.filter(row => Object.values(row).some(value => String(value ?? "").toLowerCase().includes(filter.toLowerCase()))) ?? [];
      return <section key={key} className="border border-bdr rounded-lg overflow-hidden">
        <div className="px-3 py-2.5 bg-panel2 flex gap-2 items-center"><h3 className="font-semibold text-xs">{title}</h3><span className="ml-auto text-[11px] text-mute">{data?.error ? "Unavailable" : `${rows.length} rows`}</span></div>
        {data?.error ? <div role="alert" className="p-4 text-xs space-y-2"><p className="text-warn break-words">{data.error}</p><p className="text-mute">This view may require additional Oracle privileges or may not be supported by this database version/container.</p></div>
          : !rows.length ? <p className="p-8 text-center text-xs text-mute">{filter ? "No loaded rows match your filter." : "Oracle returned no rows for this view."}</p>
          : <div className="overflow-auto max-h-[60vh]"><table className="w-full text-xs text-left"><thead className="sticky top-0 bg-panel2"><tr>{columns.map(column => <th key={column} className="px-3 py-2 text-mute font-medium border-b border-bdr whitespace-nowrap">{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} className="border-b border-bdrsoft last:border-0 even:bg-panel2/40 hover:bg-accentdim">{columns.map(column => <td key={column} className="px-3 py-2 whitespace-nowrap font-mono max-w-[40rem] truncate" title={String(row[column] ?? "")} >{row[column] ?? "—"}</td>)}</tr>)}</tbody></table></div>}
        {data?.truncated && <p className="p-3 text-xs text-warn border-t border-bdr">Showing the first 500 rows. Filtering applies to these loaded rows only.</p>}
      </section>;
    })}
  </div>;
}

export default function DbaManager() {
  const s = useStudio();
  const connections = s.connections.filter(c => c.live && c.engine === "oracle");
  const conn = connections.find(c => c.id === s.activeConnId);
  const [selected, setSelected] = useState("instance");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ status: true });
  const [collapsedConnections, setCollapsedConnections] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const module = dbaModules.find(m => m.pages.some(p => p.id === selected))!;
  const page = module.pages.find(p => p.id === selected)!;
  const connected = conn?.status === "connected";
  return <div className="h-full flex flex-col min-h-0 bg-panel text-[13px]">
    <header className="h-11 shrink-0 px-3 flex items-center gap-2 border-b border-bdr bg-panel2"><Database size={16} className="text-accenthi" /><h2 className="font-semibold">DBA Manager</h2><span className="text-mute text-xs hidden md:inline">Database administration</span><div className="ml-auto">{conn && <Badge tone={connected ? "ok" : "neutral"}>{conn.name} · {connected ? "Connected" : "Offline"}</Badge>}</div></header>
    <div className="flex flex-1 min-h-0 min-w-0">
      <aside className="w-64 min-w-52 max-w-[45%] shrink-0 border-r border-bdr bg-bg flex flex-col" aria-label="DBA navigation">
        <div className="h-10 px-3 flex items-center border-b border-bdrsoft gap-1"><span className="text-[11px] uppercase tracking-wider font-semibold text-mute mr-auto">Connections</span><Btn variant="toolbar" title="New Oracle connection" onClick={() => s.setWizardOpen(true)}><Plus size={14} /></Btn><Btn variant="toolbar" title="Collapse all modules" onClick={() => { setExpanded({}); setCollapsedConnections(Object.fromEntries(connections.map(c => [c.id, true]))); }}><ChevronsDownUp size={14} /></Btn></div>
        <label className="m-2 flex items-center gap-2 rounded-md border border-bdr bg-panel px-2"><Search size={13} className="text-mute shrink-0" /><input className="w-full bg-transparent outline-none text-xs py-2" aria-label="Find DBA module" placeholder="Find a module…" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <nav className="flex-1 overflow-auto pb-3" aria-label="DBA connections and modules">
          {!connections.length && <p className="px-3 py-4 text-xs text-mute">Add an Oracle connection to begin.</p>}
          {connections.map(c => {
            const open = c.id === conn?.id && !collapsedConnections[c.id];
            return <div key={c.id}>
              <button className={`w-full flex items-center gap-1.5 text-left px-2 py-2 text-xs ${c.id === conn?.id ? "text-accenthi bg-accentdim" : "text-soft hover:bg-panel2"}`} aria-expanded={open} onClick={() => { s.setActiveConnId(c.id); setCollapsedConnections(previous => ({ ...previous, [c.id]: c.id === conn?.id ? open : false })); }}>
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Database size={14} /><span className="truncate font-semibold" title={c.name}>{c.name}</span><span className={`ml-auto w-1.5 h-1.5 rounded-full shrink-0 ${c.status === "connected" ? "bg-ok" : "bg-mute"}`} />
              </button>
              {open && dbaModules.filter(m => `${m.label} ${m.pages.map(p => p.label).join(" ")}`.toLowerCase().includes(search.toLowerCase())).map(m => {
                const Icon = icons[dbaModules.indexOf(m)];
                const isExpanded = !!search || expanded[m.id];
                return <div key={m.id} className="ml-4 border-l border-bdrsoft">
                  <button className={`w-full flex items-center gap-1.5 text-left px-2 py-1.5 text-xs hover:bg-panel2 ${m.id === module.id ? "text-ink" : "text-soft"}`} aria-expanded={!!isExpanded} onClick={() => setExpanded(previous => ({ ...previous, [m.id]: !isExpanded }))}>
                    {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<Icon size={13} className="text-accenthi shrink-0" /><span>{m.label}</span>
                  </button>
                  {isExpanded && m.pages.map(p => <button key={p.id} aria-current={p.id === selected ? "page" : undefined} onClick={() => setSelected(p.id)} className={`w-full text-left flex items-center gap-2 pl-8 pr-2 py-1.5 text-[11.5px] ${p.id === selected ? "bg-accentdim text-accenthi border-r-2 border-accent font-medium" : "text-mute hover:bg-panel2 hover:text-ink"}`}>{p.id === selected ? <FolderOpen size={12} className="shrink-0" /> : <Folder size={12} className="shrink-0" />}{p.label}</button>)}
                </div>;
              })}
              {open && search && !dbaModules.some(m => `${m.label} ${m.pages.map(p => p.label).join(" ")}`.toLowerCase().includes(search.toLowerCase())) && <p className="p-4 text-xs text-mute">No matching modules.</p>}
            </div>;
          })}
        </nav>
        <div className="px-3 py-2 border-t border-bdrsoft text-[10px] text-mute">11 modules · Current connection/container</div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="p-4 border-b border-bdrsoft shrink-0"><div className="text-[10px] text-mute uppercase tracking-wider mb-1">{module.label}</div><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">{page.label}</h3>{conn?.readOnly && <Badge tone="warn">Read-only</Badge>}<Btn className="ml-auto" variant="outline" onClick={() => s.openTab("worksheet", "Worksheet 1")}><Terminal size={13} /> Worksheet</Btn></div><p className="text-xs text-mute mt-1">{page.description}</p></div>
        <div className="flex-1 min-h-0 overflow-auto">
          {!connected ? <EmptyState icon={<Database />} title={conn ? "Connection is offline" : "Select an Oracle connection"} hint="Connect through the Explorer to read DBA views. Modules use the selected Oracle user's privileges." action={<Btn variant="outline" onClick={() => s.setWizardOpen(true)}>New connection</Btn>} />
            : page.view === "storage" || page.view === "memory" ? <DbaStorage key={`${conn.id}:${page.id}`} page={page.view === "storage" ? "Storage" : "Memory"} />
            : page.view === "performance" ? <PerformanceMonitor key={conn.id} />
            : page.view === "advisor" ? <DbaAdvisor key={conn.id} />
            : <CatalogPage key={`${conn.id}:${page.id}`} connectionId={conn.id} page={page} />}
        </div>
      </main>
    </div>
  </div>;
}
