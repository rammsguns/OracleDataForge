import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDownToDot, ArrowUpFromDot, CheckCircle2, GitFork, Search, Waypoints } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type DepItem, type DepsReport } from "../utils/api";
import { Badge, Btn, EmptyState, Spinner } from "./ui";

/** Compact color per object type so the lists scan quickly. */
const TYPE_TONE: Record<string, string> = {
  TABLE: "text-accenthi",
  VIEW: "text-ok",
  "MATERIALIZED VIEW": "text-ok",
  PACKAGE: "text-warn",
  "PACKAGE BODY": "text-warn",
  PROCEDURE: "text-[var(--viz-1,#3987e5)]",
  FUNCTION: "text-[var(--viz-1,#3987e5)]",
  TRIGGER: "text-err",
  SYNONYM: "text-mute",
  SEQUENCE: "text-mute",
  TYPE: "text-soft",
  "TYPE BODY": "text-soft",
  INDEX: "text-mute",
};

function DepRow({ d, onDrill, onCompile }: {
  d: DepItem;
  onDrill: (name: string) => void;
  /** present on Oracle read-write connections — offers ALTER … COMPILE for INVALID objects */
  onCompile?: (d: DepItem) => void;
}) {
  const invalid = d.status && d.status !== "VALID";
  return (
    <button
      onClick={() => onDrill(d.name)}
      title={`Analyze dependencies of ${d.name}`}
      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-[12px] hover:bg-panel3 transition-colors group"
    >
      <span className={`text-[10px] font-bold w-24 shrink-0 uppercase tracking-wide ${TYPE_TONE[d.type] ?? "text-mute"}`}>
        {d.type}
      </span>
      <span className="font-mono text-soft group-hover:text-ink truncate">
        {d.owner && d.owner !== "PUBLIC" ? `${d.owner}.` : ""}{d.name}
      </span>
      {invalid && <Badge tone="err">{d.status}</Badge>}
      {invalid && onCompile && (
        <span
          role="button"
          tabIndex={0}
          title={`ALTER ${d.type} ${d.name} COMPILE`}
          className="text-[10px] font-semibold text-accenthi hover:underline shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onCompile(d);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), onCompile(d))}
        >
          Compile
        </span>
      )}
      {d.via && <span className="ml-auto text-[10px] text-mute shrink-0">{d.via}</span>}
    </button>
  );
}

function DepList({ title, icon, hint, items, onDrill, onCompile }: {
  title: string;
  icon: React.ReactNode;
  hint: string;
  items: DepItem[];
  onDrill: (name: string) => void;
  onCompile?: (d: DepItem) => void;
}) {
  return (
    <div className="border border-bdr rounded-lg bg-panel2 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-bdrsoft flex items-center gap-2 text-[12px] font-semibold text-soft shrink-0">
        <span className="text-accenthi">{icon}</span>
        {title}
        <span className="ml-auto text-[10.5px] font-normal text-mute">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-3 text-[11.5px] text-mute">{hint}</p>
      ) : (
        <div className="p-1 overflow-y-auto">
          {items.map((d, i) => <DepRow key={`${d.owner}.${d.name}.${d.type}.${i}`} d={d} onDrill={onDrill} onCompile={onCompile} />)}
        </div>
      )}
    </div>
  );
}

export default function DependencyExplorer({ initialObject }: { initialObject?: string }) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  const [name, setName] = useState(initialObject ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<DepsReport | null>(null);
  const connId = conn?.live ? conn.id : null;
  const ranInitial = useRef(false);

  const analyze = useCallback((objName: string) => {
    const target = objName.trim();
    if (!target || !connId) return;
    setName(target);
    setLoading(true);
    setError(null);
    api.deps(connId, target)
      .then((r) => setReport(r))
      .catch((e: Error) => { setReport(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, [connId]);

  useEffect(() => {
    if (initialObject && connId && !ranInitial.current) {
      ranInitial.current = true;
      analyze(initialObject);
    }
  }, [initialObject, connId, analyze]);

  // ALTER … COMPILE an INVALID object, then refresh the analysis to pick up new statuses
  const canCompile = conn?.engine === "oracle" && !conn.readOnly;
  const compileObj = useCallback((d: DepItem) => {
    if (!connId) return;
    // ALTER … COMPILE changes object state in the live database — confirm before running it
    s.askConfirm({
      title: `Compile ${d.type} ${d.name}?`,
      body: `ALTER ${d.type} ${d.name} COMPILE runs against "${conn?.name ?? "this connection"}". Recompiling can leave dependent objects INVALID until they are recompiled too.`,
      confirmLabel: "Compile",
      onConfirm: () => {
        api.compile(connId, d.name, d.type, true)
          .then((r) => {
            if (r.status === "VALID") s.toast("success", `${r.type} ${r.name} compiled — VALID`);
            else s.toast("warning", `${r.type} ${r.name} is still ${r.status} (${r.errors.length} error(s)) — open it in the Object Editor for details`);
            analyze(name);
          })
          .catch((e: Error) => s.toast("error", `Compile failed: ${e.message}`));
      },
    });
  }, [connId, analyze, name, s, conn]);

  if (!conn?.live) {
    return (
      <EmptyState
        icon={<Waypoints />}
        title="Dependency analysis needs a live connection"
        hint="Select a live Oracle connection in the sidebar — dependencies are read from USER_DEPENDENCIES and the Oracle data dictionary."
      />
    );
  }

  const invalid = report?.impact.filter((i) => i.status && i.status !== "VALID") ?? [];

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bdr bg-bg shrink-0">
        <Waypoints size={14} className="text-accenthi shrink-0" />
        <span className="text-[12px] font-semibold text-soft whitespace-nowrap max-md:hidden">Dependency Explorer</span>
        <div className="relative flex-1 max-w-80">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && analyze(name)}
            placeholder="Object name (table, view, package, procedure…)"
            aria-label="Object name to analyze"
            className="w-full h-7 pl-7.5 pr-2 rounded-md bg-panel2 border border-bdr text-[12px] font-mono placeholder:font-sans placeholder:text-mute focus:border-accent focus:outline-none"
          />
        </div>
        <Btn variant="primary" onClick={() => analyze(name)} disabled={!name.trim() || loading}>
          <GitFork size={12} /> Analyze
        </Btn>
        <span className="ml-auto text-[11px] text-mute truncate max-md:hidden" title={conn.name}>
          {conn.name} · {conn.engine === "oracle" ? "user_dependencies / all_dependencies" : "information_schema"}
        </span>
      </div>

      {loading ? (
        <div className="p-6"><Spinner label={`Reading dependencies of ${name}…`} /></div>
      ) : error ? (
        <div className="m-3 border border-err/30 bg-err/8 rounded-lg px-3 py-2.5 text-[12px] text-soft">
          <span className="text-err font-semibold">Could not analyze</span> — {error}
        </div>
      ) : !report ? (
        <EmptyState
          icon={<Waypoints />}
          title="Who breaks if I change this?"
          hint="Type an object name (or right-click one in the sidebar → View dependencies) to see what it uses, what depends on it, and the full transitive impact before you make a change."
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 df-fade">
          {/* object header + impact verdict */}
          <div className="border border-bdr rounded-lg bg-panel2 px-3.5 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-mono text-[14px] font-semibold text-ink">{report.object?.name ?? name.toUpperCase()}</span>
            {report.object && <Badge tone="accent">{report.object.type}</Badge>}
            {report.object?.status && (
              <Badge tone={report.object.status === "VALID" ? "ok" : "err"}>{report.object.status}</Badge>
            )}
            <span className="ml-auto">
              {report.impact.length === 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-ok font-medium">
                  <CheckCircle2 size={14} /> Safe to change — nothing depends on it
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-warn font-medium">
                  <AlertTriangle size={14} />
                  Changing it can impact {report.impact.length} object{report.impact.length === 1 ? "" : "s"}
                  {invalid.length > 0 && <span className="text-err">({invalid.length} already INVALID)</span>}
                </span>
              )}
            </span>
          </div>

          {/* direct deps, both directions */}
          <div className="grid md:grid-cols-2 gap-3 items-start">
            <DepList
              title="Uses (depends on)"
              icon={<ArrowDownToDot size={13} />}
              hint="This object doesn't reference any other object."
              items={report.uses}
              onDrill={analyze}
              onCompile={canCompile ? compileObj : undefined}
            />
            <DepList
              title="Used by (direct dependents)"
              icon={<ArrowUpFromDot size={13} />}
              hint="Nothing references this object directly."
              items={report.usedBy}
              onDrill={analyze}
              onCompile={canCompile ? compileObj : undefined}
            />
          </div>

          {/* transitive impact tree */}
          {report.impact.length > 0 && (
            <div className="border border-bdr rounded-lg bg-panel2">
              <div className="px-3 py-2 border-b border-bdrsoft flex items-center gap-2 text-[12px] font-semibold text-soft">
                <GitFork size={13} className="text-warn" />
                Full impact (transitive)
                <span className="text-[10.5px] font-normal text-mute">— everything that could break, direct and indirect</span>
              </div>
              <div className="p-1 max-h-96 overflow-y-auto">
                {report.impact.map((d, i) => (
                  <button
                    key={`${d.owner}.${d.name}.${d.type}.${i}`}
                    onClick={() => analyze(d.name)}
                    title={d.path}
                    className="w-full flex items-center gap-2 px-2.5 py-1 rounded-md text-left text-[12px] hover:bg-panel3 transition-colors group"
                  >
                    <span className="shrink-0 text-mute font-mono text-[10px] w-8">L{d.level}</span>
                    <span className="shrink-0 text-bdr" style={{ width: (d.level - 1) * 16 }} aria-hidden />
                    <span className={`text-[10px] font-bold uppercase tracking-wide shrink-0 ${TYPE_TONE[d.type] ?? "text-mute"}`}>{d.type}</span>
                    <span className="font-mono text-soft group-hover:text-ink truncate">
                      {d.owner && d.owner !== "PUBLIC" ? `${d.owner}.` : ""}{d.name}
                    </span>
                    {d.status && d.status !== "VALID" && <Badge tone="err">{d.status}</Badge>}
                    {d.status && d.status !== "VALID" && canCompile && (
                      <span
                        role="button"
                        tabIndex={0}
                        title={`ALTER ${d.type} ${d.name} COMPILE`}
                        className="text-[10px] font-semibold text-accenthi hover:underline shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          compileObj(d);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), compileObj(d))}
                      >
                        Compile
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-mute truncate max-w-72 max-md:hidden">{d.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {report.note && (
            <p className="text-[11px] text-mute leading-relaxed border border-bdrsoft rounded-lg px-3 py-2 bg-panel2/50">
              {report.note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
