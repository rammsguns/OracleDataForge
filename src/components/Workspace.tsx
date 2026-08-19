import {
  Activity,
  Clock3,
  Columns3,
  FileCode2,
  Gauge,
  GitCompareArrows,
  Hammer,
  History,
  Network,
  Play,
  Plus,
  Table2,
  Terminal,
  Waypoints,
  X,
} from "lucide-react";
import { useStudio } from "../state/store";
import type { TabKind } from "../types";
import SqlWorksheet from "./SqlWorksheet";
import DataBrowser from "./DataBrowser";
import ObjectEditor from "./ObjectEditor";
import TableDesigner from "./TableDesigner";
import ErDiagram from "./ErDiagram";
import QueryHistory from "./QueryHistory";
import PerformanceMonitor from "./PerformanceMonitor";
import MigrationAssistant from "./MigrationAssistant";
import DbaAdvisor from "./DbaAdvisor";
import DependencyExplorer from "./DependencyExplorer";
import VersionHistory from "./VersionHistory";
import RoutineRunner from "./RoutineRunner";
import CompileInvalid from "./CompileInvalid";

const TAB_ICON: Record<TabKind, React.ReactNode> = {
  worksheet: <Terminal size={12} />,
  data: <Table2 size={12} />,
  object: <FileCode2 size={12} />,
  run: <Play size={12} />,
  tabledesign: <Columns3 size={12} />,
  erd: <Network size={12} />,
  history: <Clock3 size={12} />,
  perf: <Activity size={12} />,
  migration: <GitCompareArrows size={12} />,
  dba: <Gauge size={12} />,
  deps: <Waypoints size={12} />,
  versions: <History size={12} />,
  compile: <Hammer size={12} />,
};

const LAUNCHERS: { kind: TabKind; title: string; label: string }[] = [
  { kind: "erd", title: "ER Diagram", label: "ER Diagram" },
  { kind: "history", title: "Query History", label: "History" },
  { kind: "perf", title: "Performance", label: "Performance" },
  { kind: "dba", title: "DBA Advisor", label: "DBA Advisor" },
  { kind: "deps", title: "Dependencies", label: "Dependencies" },
  { kind: "versions", title: "Version History", label: "Versions" },
  { kind: "migration", title: "Migration", label: "Migration" },
];

export default function Workspace() {
  const s = useStudio();
  const active = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0];

  return (
    <div className="flex flex-col h-full min-w-0 bg-panel">
      {/* tab bar */}
      <div className="flex items-stretch border-b border-bdr bg-bg shrink-0 overflow-x-auto" role="tablist" aria-label="Workspace tabs">
        {s.tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === active.id}
            tabIndex={0}
            onClick={() => s.setActiveTabId(t.id)}
            onKeyDown={(e) => e.key === "Enter" && s.setActiveTabId(t.id)}
            onAuxClick={(e) => e.button === 1 && s.closeTab(t.id)}
            className={`group flex items-center gap-1.5 px-3 h-9 text-[12px] cursor-pointer border-r border-bdrsoft select-none whitespace-nowrap transition-colors ${
              t.id === active.id
                ? "bg-panel text-ink border-t-2 border-t-[var(--accent)]"
                : "text-mute hover:text-soft hover:bg-panel/60 border-t-2 border-t-transparent"
            }`}
          >
            <span className={t.id === active.id ? "text-accenthi" : ""}>{TAB_ICON[t.kind]}</span>
            <span className={t.kind === "data" || t.kind === "object" || t.kind === "tabledesign" || t.kind === "run" ? "font-mono" : ""}>{t.title}</span>
            {t.dirty && <span className="w-1.5 h-1.5 rounded-full bg-warn shrink-0" title="Unsaved changes" aria-label="Unsaved changes" />}
            <button
              aria-label={`Close ${t.title}`}
              className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-panel3 hover:text-ink transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                s.closeTab(t.id);
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        {/* quick launchers */}
        <div className="flex items-center gap-0.5 px-2 ml-auto">
          {LAUNCHERS.map((l) => (
            <button
              key={l.kind}
              onClick={() => s.openTab(l.kind, l.title)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-mute hover:text-accenthi hover:bg-accentdim transition-colors whitespace-nowrap"
              title={`Open ${l.title}`}
            >
              {TAB_ICON[l.kind]}
              <span className="max-lg:hidden">{l.label}</span>
            </button>
          ))}
          <button
            onClick={() => s.openTab("worksheet", `Worksheet ${s.tabs.filter((t) => t.kind === "worksheet").length + 1}`, `ws-${Date.now()}`)}
            className="p-1.5 rounded text-mute hover:text-accenthi hover:bg-accentdim transition-colors"
            title="New worksheet (Ctrl+T)"
            aria-label="New worksheet"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* tab content */}
      <div className="flex-1 min-h-0" role="tabpanel" aria-label={active.title}>
        {active.kind === "worksheet" && <SqlWorksheet />}
        {active.kind === "data" && <DataBrowser table={active.payload!} />}
        {active.kind === "object" && <ObjectEditor object={active.payload!} tabId={active.id} />}
        {active.kind === "run" && <RoutineRunner key={active.id} routine={active.payload!} />}
        {active.kind === "tabledesign" && <TableDesigner key={active.id} table={active.payload!} tabId={active.id} />}
        {active.kind === "erd" && <ErDiagram />}
        {active.kind === "history" && <QueryHistory />}
        {active.kind === "perf" && <PerformanceMonitor />}
        {active.kind === "migration" && <MigrationAssistant />}
        {active.kind === "dba" && <DbaAdvisor />}
        {active.kind === "deps" && <DependencyExplorer key={active.id} initialObject={active.payload} />}
        {active.kind === "versions" && <VersionHistory key={active.id} />}
        {active.kind === "compile" && <CompileInvalid key={active.id} payload={active.payload ?? "schema"} />}
      </div>
    </div>
  );
}
