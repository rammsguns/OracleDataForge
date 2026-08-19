import { useCallback, useRef, useState } from "react";
import {
  AlignLeft,
  CircleAlert,
  Clock,
  Database,
  ExternalLink,
  ListTree,
  Play,
  Rows3,
  Save,
  Terminal,
} from "lucide-react";
import { useStudio } from "../state/store";
import SqlEditor from "./SqlEditor";
import ResultsGrid from "./ResultsGrid";
import ExplainPlan from "./ExplainPlan";
import { Btn, EmptyState, Spinner } from "./ui";
import { download } from "../utils/sql";

export default function SqlWorksheet() {
  const s = useStudio();
  const [editorPct, setEditorPct] = useState(46);
  const [view, setView] = useState<"results" | "plan">("results");
  const dragRef = useRef<HTMLDivElement>(null);

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const container = dragRef.current?.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setEditorPct(Math.min(80, Math.max(15, pct)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const errorLine = s.result?.error?.line ?? null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* worksheet toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-bdrsoft shrink-0 flex-wrap">
        <Btn variant="primary" onClick={() => s.runSql()} title="Run statement (Ctrl+Enter)" disabled={s.running}>
          <Play size={12} fill="currentColor" />
          Run
        </Btn>
        <Btn
          variant="outline"
          onClick={() => {
            setView("plan");
            s.setPlanVisible(true);
            s.runExplain();
          }}
          title="Explain plan (F10)"
        >
          <ListTree size={13} />
          Explain
        </Btn>
        <Btn variant="outline" onClick={s.doFormat} title="Format SQL (Ctrl+Shift+F)">
          <AlignLeft size={13} />
          Format
        </Btn>
        <Btn variant="outline" onClick={() => { download("worksheet.sql", s.sql); s.toast("success", "Script saved as worksheet.sql"); }} title="Save script (Ctrl+S)">
          <Save size={13} />
          Save
        </Btn>
        <div className="ml-auto flex items-center gap-2 text-[11.5px] text-mute">
          <Database size={12} />
          <span>{s.connections.find((c) => c.id === s.activeConnId)?.name ?? "—"}</span>
          <span className="hidden md:inline">·</span>
          <kbd className="hidden md:inline">Ctrl</kbd>
          <span className="hidden md:inline -mx-1">+</span>
          <kbd className="hidden md:inline">Enter</kbd>
        </div>
      </div>

      {/* editor */}
      <div className="flex flex-col flex-1 min-h-0">
        <div style={{ height: `${editorPct}%` }} className="min-h-24">
          <SqlEditor value={s.sql} onChange={s.setSql} errorLine={errorLine} onRun={() => s.runSql()} />
        </div>

        {/* splitter */}
        <div
          ref={dragRef}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize editor / results"
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") setEditorPct((p) => Math.max(15, p - 3));
            if (e.key === "ArrowDown") setEditorPct((p) => Math.min(80, p + 3));
          }}
          className="h-1.5 shrink-0 cursor-row-resize bg-bdrsoft hover:bg-accent/60 transition-colors"
        />

        {/* results area */}
        <div className="flex-1 min-h-0 flex flex-col bg-panel">
          <div className="flex items-center gap-0.5 border-b border-bdrsoft px-2 pt-1 shrink-0">
            {(["results", "plan"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-[12px] font-medium rounded-t-md border border-b-0 transition-colors ${
                  view === v ? "bg-panel2 border-bdr text-ink" : "border-transparent text-mute hover:text-soft"
                }`}
                aria-selected={view === v}
                role="tab"
              >
                {v === "results" ? "Query Result" : "Explain Plan"}
              </button>
            ))}
            {/* execution details */}
            {s.result && !s.running && (
              <div className="ml-auto flex items-center gap-3 pr-2 pb-1 text-[11.5px] text-soft">
                {s.result.error ? (
                  <span className="flex items-center gap-1 text-err font-semibold">
                    <CircleAlert size={12} /> {s.result.error.code}
                  </span>
                ) : (
                  <>
                    <span className="flex items-center gap-1" title="Execution time">
                      <Clock size={11} className="text-accent" />
                      <span className="tabular-nums">{s.result.durationMs} ms</span>
                    </span>
                    <span className="flex items-center gap-1" title="Rows returned">
                      <Rows3 size={11} className="text-accent" />
                      <span className="tabular-nums">{s.result.rowsReturned} rows</span>
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0">
            {s.running ? (
              <div className="h-full flex items-center justify-center">
                <Spinner label="Executing statement…" />
              </div>
            ) : view === "plan" ? (
              <ExplainPlan />
            ) : !s.result ? (
              <EmptyState
                icon={<Terminal />}
                title="No results yet"
                hint="Write a statement and run the worksheet (Ctrl+Enter) to see rows here."
                action={
                  <Btn variant="primary" onClick={() => s.runSql()}>
                    <Play size={12} fill="currentColor" /> Run
                  </Btn>
                }
              />
            ) : s.result.error ? (
              <div className="p-4 df-fade">
                <div className="border border-err/40 bg-err/8 rounded-lg p-3.5 max-w-2xl">
                  <div className="flex items-center gap-2 text-err font-semibold text-[13px]">
                    <CircleAlert size={15} />
                    {s.result.error.code} — statement failed at line {s.result.error.line}
                  </div>
                  <div className="mt-1.5 text-[12.5px] text-ink font-mono">{s.result.error.message}</div>
                  {s.result.error.helpUrl && (
                    <a
                      href={s.result.error.helpUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
                    >
                      <ExternalLink size={11} /> Oracle documentation for {s.result.error.code}
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <ResultsGrid columns={s.result.columns} rows={s.result.rows} exportName="query-results" truncated={s.result.truncated} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
