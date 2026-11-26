import { useEffect, useRef } from "react";
import {
  Activity,
  Clock3,
  Columns3,
  FileCode2,
  Gauge,
  GitCompareArrows,
  GitBranch,
  Hammer,
  History,
  ListChecks,
  Network,
  Play,
  Table2,
  Terminal,
  UserCog,
  Users,
  Waypoints,
  X,
} from "lucide-react";
import { useStudio } from "../state/store";
import type { Tab, TabKind } from "../types";
import SqlWorksheet from "./SqlWorksheet";
import AssistPanel from "./AssistPanel";
import { useHarnessEnabled } from "../utils/useHarnessEnabled";
import DataBrowser from "./DataBrowser";
import ObjectEditor from "./ObjectEditor";
import TableDesigner from "./TableDesigner";
import ErDiagram from "./ErDiagram";
import QueryHistory from "./QueryHistory";
import PerformanceMonitor from "./PerformanceMonitor";
import MigrationAssistant from "./MigrationAssistant";
import SchemaCompare from "./SchemaCompare";
import DbaAdvisor from "./DbaAdvisor";
import DbaManager from "./DbaManager";
import DependencyExplorer from "./DependencyExplorer";
import VersionHistory from "./VersionHistory";
import RoutineRunner from "./RoutineRunner";
import CompileInvalid from "./CompileInvalid";
import JobRunLog from "./JobRunLog";
import UserAdmin from "./UserAdmin";
import PlsqlRepository from "./PlsqlRepository";
import Sessions from "./Sessions";
import RetainedTool from "./RetainedTool";
import ToolConnectionGate from "./ToolConnectionGate";
import { EmptyState } from "./ui";

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
  compare: <GitCompareArrows size={12} />,
  dba: <Gauge size={12} />,
  dbamanager: <Hammer size={12} />,
  sessions: <Users size={12} />,
  deps: <Waypoints size={12} />,
  versions: <History size={12} />,
  compile: <Hammer size={12} />,
  joblog: <ListChecks size={12} />,
  admin: <UserCog size={12} />,
  repository: <GitBranch size={12} />,
};

const LAUNCHERS: { kind: TabKind; title: string; label: string }[] = [
  { kind: "erd", title: "ER Diagram", label: "ER Diagram" },
  { kind: "history", title: "Query History", label: "History" },
  { kind: "perf", title: "Performance", label: "Performance" },
  { kind: "dba", title: "DBA Advisor", label: "DBA Advisor" },
  { kind: "dbamanager", title: "DBA Manager", label: "DBA Manager" },
  { kind: "sessions", title: "Sessions", label: "Sessions" },
  { kind: "deps", title: "Dependencies", label: "Dependencies" },
  { kind: "versions", title: "Version History", label: "Versions" },
  { kind: "migration", title: "Migration", label: "Migration" },
  { kind: "compare", title: "Schema Compare", label: "Schema Compare" },
  { kind: "joblog", title: "Job Run Log", label: "Job Runs" },
  { kind: "admin", title: "Admin", label: "Admin" },
  { kind: "repository", title: "PL/SQL Repository", label: "Repository" },
];

const TOOL_KINDS = new Set<TabKind>([...LAUNCHERS.map(tool => tool.kind), "run", "compile"]);
const CONNECTION_TOOLS = new Set<TabKind>(["run", "erd", "perf", "dba", "dbamanager", "sessions", "deps", "versions", "compile", "joblog"]);
function ToolContent({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "run": return <RoutineRunner routine={tab.payload!} />;
    case "erd": return <ErDiagram />;
    case "history": return <QueryHistory />;
    case "perf": return <PerformanceMonitor />;
    case "migration": return <MigrationAssistant />;
    case "compare": return <SchemaCompare />;
    case "dba": return <DbaAdvisor />;
    case "dbamanager": return <DbaManager />;
    case "sessions": return <Sessions />;
    case "deps": return <DependencyExplorer initialObject={tab.payload} />;
    case "versions": return <VersionHistory />;
    case "compile": return <CompileInvalid payload={tab.payload ?? "schema"} />;
    case "joblog": return <JobRunLog initialJob={tab.payload} />;
    case "admin": return <UserAdmin />;
    case "repository": return <PlsqlRepository />;
    default: return null;
  }
}

export default function Workspace() {
  const harnessEnabled = useHarnessEnabled();
  const s = useStudio();
  const active = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0];
  const activeTabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active.id]);
  const fullAccess = s.accessRole === "Administrator" || s.accessRole === "Developer";
  const viewerTabs: TabKind[] = ["worksheet", "data", "object", "history", "deps", "versions"];
  const canView = (kind: TabKind) => fullAccess || (s.accessRole === "Viewer" ? viewerTabs.includes(kind) : kind === "data");
  const canUseActive = canView(active.kind);

  return (
    <div className="desktop-workspace flex flex-col h-full min-w-0 bg-panel">
      {harnessEnabled && s.accessRole === "Analyst" && <AssistPanel key={JSON.stringify(s.session)} text="" selection="" connectionId={s.activeConnId} schema="" editorId="analyst-documentation" onApply={() => {}} />}
      {/* Open documents have their own scrollable strip. */}
      <div className="desktop-document-tabs flex items-stretch border-b border-bdr bg-bg shrink-0 overflow-x-auto" role="tablist" aria-label="Workspace tabs">
        {s.tabs.map((t) => (
          <div
            key={t.id}
            ref={t.id === active.id ? activeTabRef : undefined}
            role="tab"
            aria-selected={t.id === active.id}
            tabIndex={0}
            onClick={() => s.setActiveTabId(t.id)}
            onKeyDown={(e) => e.key === "Enter" && s.setActiveTabId(t.id)}
            onAuxClick={(e) => e.button === 1 && s.closeTab(t.id)}
            className={`group flex items-center gap-1.5 px-3 h-7 text-[12px] cursor-pointer border-r border-bdrsoft select-none whitespace-nowrap transition-colors ${
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
              className="ml-1 p-0.5 rounded opacity-60 group-hover:opacity-100 hover:bg-panel3 hover:text-ink transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                s.closeTab(t.id);
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}

      </div>

      {/* tab content */}
      <div className="flex-1 min-h-0" role="tabpanel" aria-label={active.title}>
        {/* Keep open source editors alive when navigating to a worksheet or another
            object. Their source, selection, scroll and search state belong to the
            open tab; closing the tab removes its editor from memory. */}
        {canView("object") && s.tabs.filter((tab) => tab.kind === "object").map((tab) => (
          <div key={tab.id} className="h-full min-h-0" hidden={tab.id !== active.id}>
            <ObjectEditor object={tab.payload!} tabId={tab.id} />
          </div>
        ))}
        {/* Tool state lives as long as its tab. Identity/role changes discard cached
            tool contents, and authorization is always checked against the live store. */}
        {s.tabs.filter(tab => TOOL_KINDS.has(tab.kind) && canView(tab.kind)).map(tab => (
          <RetainedTool key={`${JSON.stringify(s.session)}:${s.accessRole}:${tab.id}`} active={tab.id === active.id} connectionScoped={!["compare", "migration", "dbamanager", "history", "admin", "repository"].includes(tab.kind)}>
            {CONNECTION_TOOLS.has(tab.kind)
              ? <ToolConnectionGate title={tab.title}><ToolContent tab={tab} /></ToolConnectionGate>
              : <ToolContent tab={tab} />}
          </RetainedTool>
        ))}
        {!canUseActive ? <EmptyState icon={<UserCog />} title="Feature unavailable for this role" hint={s.accessRole === "Analyst" ? "Analyst access is limited to browsing table data." : "Choose a feature that your current role can access."} /> : <>
        {active.kind === "worksheet" && <SqlWorksheet key={active.id} />}
        {active.kind === "data" && <DataBrowser table={active.payload!} />}
        {active.kind === "tabledesign" && <TableDesigner key={active.id} table={active.payload!} tabId={active.id} />}
        </>}
      </div>
    </div>
  );
}
