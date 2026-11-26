import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, AlignLeft, Database, FileCode2, FilePlus2, FolderOpen, GitBranch, GitCompareArrows, History, Info, Keyboard, Network, PanelLeft, Plus, RefreshCw, Save, Settings2, ShieldCheck, Users } from "lucide-react";
import { useStudio } from "../state/store";
import type { TabKind } from "../types";
import { download } from "../utils/sql";

type Command = { label: string; icon?: ReactNode; shortcut?: string; action: () => void; disabled?: boolean };
type Props = { onAbout: () => void; onShortcuts: () => void; onAccount: () => void };

/** Desktop menus expose existing commands; the store remains the authorization boundary. */
export default function DesktopMenu({ onAbout, onShortcuts, onAccount }: Props) {
  const s = useStudio();
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fullAccess = s.accessRole === "Administrator" || s.accessRole === "Developer";
  const analyst = s.accessRole === "Analyst";
  const active = s.tabs.find(t => t.id === s.activeTabId);
  const newWorksheet = () => s.openTab("worksheet", `Worksheet ${s.tabs.filter(t => t.kind === "worksheet").length + 1}`, `ws-${Date.now()}`);
  const newConnection = () => { s.setEditingConn(null); s.setWizardOpen(true); };
  const save = () => download("worksheet.sql", s.sql);
  const tool = (kind: TabKind, title: string) => () => s.openTab(kind, title);
  const groups: { label: string; items: (Command | null)[] }[] = [
    { label: "File", items: [
      { label: "New SQL Worksheet", icon: <FilePlus2 />, shortcut: "Ctrl+T", action: newWorksheet, disabled: analyst },
      { label: "New Connection…", icon: <Plus />, action: newConnection, disabled: !fullAccess },
      { label: "Open SQL File…", icon: <FolderOpen />, action: () => fileInput.current?.click(), disabled: analyst },
      { label: "Save Worksheet…", icon: <Save />, shortcut: "Ctrl+S", action: save, disabled: active?.kind !== "worksheet" },
      null,
      { label: "Import Connections…", action: () => s.setImportConnsOpen(true), disabled: !fullAccess },
      { label: "Export Connections…", action: () => s.setExportConnsOpen(true), disabled: !fullAccess },
      null, { label: "Close Tab", action: () => s.closeTab(s.activeTabId) },
    ] },
    { label: "Edit", items: [
      { label: "Format SQL", icon: <AlignLeft />, shortcut: "Ctrl+Shift+F", action: s.doFormat, disabled: active?.kind !== "worksheet" },
      { label: "SQL History", icon: <History />, action: tool("history", "Query History"), disabled: analyst },
      null, { label: "Account Settings…", icon: <ShieldCheck />, action: onAccount },
    ] },
    { label: "View", items: [
      { label: `${s.sidebarOpen ? "Hide" : "Show"} Connections`, icon: <PanelLeft />, shortcut: "Ctrl+B", action: s.toggleSidebar },
      { label: "DBA", icon: <Database />, action: tool("dbamanager", "DBA Manager"), disabled: !fullAccess },
      { label: "SQL History", icon: <History />, action: tool("history", "Query History"), disabled: analyst },
      { label: "Dependencies", icon: <Network />, action: tool("deps", "Dependencies"), disabled: analyst },
      null, { label: `Use ${s.theme === "light" ? "Dark" : "Light"} Theme`, action: s.toggleTheme },
    ] },
    { label: "Navigate", items: [
      ...s.tabs.map(tab => ({ label: tab.title, icon: <FileCode2 />, action: () => s.setActiveTabId(tab.id) })),
    ] },
    { label: "Run", items: [
      { label: "Run Statement", icon: <span className="desktop-run">▶</span>, shortcut: "Ctrl+Enter", action: () => s.runSql(), disabled: s.running || active?.kind !== "worksheet" || analyst || !s.activeConnId },
      { label: "Compile Invalid Objects…", icon: <Settings2 />, action: tool("compile", "Compile Invalid Objects"), disabled: !fullAccess },
    ] },
    { label: "Source", items: [
      { label: "PL/SQL Repository", icon: <GitBranch />, action: tool("repository", "PL/SQL Repository"), disabled: !fullAccess },
      { label: "Version History", icon: <History />, action: tool("versions", "Version History"), disabled: analyst },
      { label: "Schema Compare", icon: <GitCompareArrows />, action: tool("compare", "Schema Compare"), disabled: !fullAccess },
    ] },
    { label: "Tools", items: [
      { label: "Database Administration", icon: <Database />, action: tool("dbamanager", "DBA Manager"), disabled: !fullAccess },
      { label: "Monitor Sessions", icon: <Users />, action: tool("sessions", "Sessions"), disabled: !fullAccess },
      { label: "Job Run Log", icon: <History />, action: tool("joblog", "Job Run Log"), disabled: !fullAccess },
      { label: "Performance Monitor", icon: <Activity />, action: tool("perf", "Performance"), disabled: !fullAccess },
      { label: "DBA Advisor", action: tool("dba", "DBA Advisor"), disabled: !fullAccess },
      null,
      { label: "Data Modeler · ER Diagram", icon: <Network />, action: tool("erd", "ER Diagram"), disabled: !fullAccess },
      { label: "Database Migration", icon: <GitCompareArrows />, action: tool("migration", "Migration"), disabled: !fullAccess },
      { label: "Import Data…", action: () => s.setImportOpen(true), disabled: !fullAccess },
      null, { label: "Administration", icon: <ShieldCheck />, action: tool("admin", "Admin"), disabled: s.accessRole !== "Administrator" },
    ] },
    { label: "Window", items: [
      { label: `${s.sidebarOpen ? "Hide" : "Show"} Navigator`, icon: <PanelLeft />, action: s.toggleSidebar },
      ...s.tabs.map(tab => ({ label: `${tab.id === s.activeTabId ? "✓ " : ""}${tab.title}`, action: () => s.setActiveTabId(tab.id) })),
    ] },
    { label: "Help", items: [
      { label: "Keyboard Shortcuts", icon: <Keyboard />, action: onShortcuts },
      { label: "About Oracle DataForge", icon: <Info />, action: onAbout },
    ] },
  ];

  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  const focusItem = (last = false) => requestAnimationFrame(() => {
    const items = root.current?.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]:not(:disabled)');
    (last ? items?.[items.length - 1] : items?.[0])?.focus();
  });
  const dismiss = () => {
    if (open !== null) root.current?.querySelectorAll<HTMLButtonElement>('[role="menubar"] > div > button')[open]?.focus();
    setOpen(null);
  };

  return <div ref={root} className="desktop-chrome" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); dismiss(); }
    if (event.key === "Tab") setOpen(null);
  }}>
    <nav role="menubar" aria-label="Application menu" className="desktop-menubar">
      {groups.map((group, index) => <div key={group.label} className="desktop-menu">
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open === index} aria-controls={`desktop-menu-${index}`}
          onClick={() => setOpen(open === index ? null : index)} onPointerEnter={() => { if (open !== null) setOpen(index); }}
          onKeyDown={event => {
            if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(index); focusItem(event.key === "ArrowUp"); }
            if (["ArrowRight", "ArrowLeft"].includes(event.key)) {
              event.preventDefault();
              const next = (index + (event.key === "ArrowRight" ? 1 : -1) + groups.length) % groups.length;
              if (open !== null) setOpen(next);
              root.current?.querySelectorAll<HTMLButtonElement>('[role="menubar"] > div > button')[next]?.focus();
            }
          }}>{group.label}</button>
        {open === index && <div id={`desktop-menu-${index}`} role="menu" aria-label={group.label} className="desktop-dropdown" onKeyDown={event => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}>
          {group.items.map((item, itemIndex) => item ? <button type="button" role="menuitem" key={itemIndex} disabled={item.disabled} onClick={() => { dismiss(); item.action(); }}>
            <span className="desktop-command-icon">{item.icon}</span><span>{item.label}</span><span className="desktop-shortcut">{item.shortcut}</span>
          </button> : <div role="separator" className="desktop-menu-separator" key={itemIndex} />)}
        </div>}
      </div>)}
    </nav>
    <div role="toolbar" aria-label="Main toolbar" className="desktop-toolbar">
      <button title="New Connection" aria-label="New Connection" onClick={newConnection} disabled={!fullAccess}><Database className="icon-connection" /><Plus className="icon-overlay" /></button>
      <button title="New SQL Worksheet (Ctrl+T)" aria-label="New SQL Worksheet" onClick={newWorksheet} disabled={analyst}><FilePlus2 className="icon-worksheet" /></button>
      <button title="Open SQL File" aria-label="Open SQL File" onClick={() => fileInput.current?.click()} disabled={analyst}><FolderOpen className="icon-folder" /></button>
      <button title="Save Worksheet (Ctrl+S)" aria-label="Save Worksheet" onClick={save} disabled={active?.kind !== "worksheet"}><Save className="icon-save" /></button>
      <span className="desktop-toolbar-separator" />
      <button title="Connections Navigator (Ctrl+B)" aria-label="Connections Navigator" aria-pressed={s.sidebarOpen} onClick={s.toggleSidebar}><PanelLeft className="icon-save" /></button>
      <button title="Refresh database objects" aria-label="Refresh database objects" onClick={s.bumpSchema} disabled={!s.activeConnId}><RefreshCw className="icon-connection" /></button>
      <span className="desktop-toolbar-separator" />
      <button title="SQL History" aria-label="SQL History" onClick={tool("history", "Query History")} disabled={analyst}><History className="icon-worksheet" /></button>
      <button title="DBA Manager" aria-label="DBA Manager" onClick={tool("dbamanager", "DBA Manager")} disabled={!fullAccess}><Database className="icon-dba" /></button>
      <button title="Monitor Sessions" aria-label="Monitor Sessions" onClick={tool("sessions", "Sessions")} disabled={!fullAccess}><Activity className="icon-connection" /></button>
      <span className="desktop-toolbar-caption">Oracle Database Workspace</span>
      <select className="desktop-open-tabs" aria-label="Open tabs" value={s.activeTabId} onChange={event => s.setActiveTabId(event.target.value)}>{s.tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.title}{tab.dirty ? " •" : ""}</option>)}</select>
    </div>
    <input ref={fileInput} type="file" accept=".sql,.pls,.plsql,.pks,.pkb,text/plain" hidden onChange={async event => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try { s.openSqlWorksheet(await file.text(), file.name); }
      catch { s.toast("error", "Could not open the SQL file"); }
    }} />
  </div>;
}
