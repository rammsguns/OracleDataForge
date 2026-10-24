import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlignLeft,
  Maximize2,
  Minimize2,
  CircleAlert,
  Clock,
  Database,
  ExternalLink,
  ListTree,
  Play,
  Rows3,
  RefreshCw,
  Save,
  Terminal,
} from "lucide-react";
import { useStudio } from "../state/store";
import SqlEditor from "./SqlEditor";
import AssistPanel from "./AssistPanel";
import { useHarnessEnabled } from "../utils/useHarnessEnabled";
import ResultsGrid from "./ResultsGrid";
import ExplainPlan from "./ExplainPlan";
import { Btn, EmptyState, Spinner } from "./ui";
import { download } from "../utils/sql";

export default function SqlWorksheet() {
  const s = useStudio();
  const harnessEnabled = useHarnessEnabled();
  const [assistOpen, setAssistOpen] = useState(false);
  const [selection, setSelection] = useState({start: 0, end: 0, source: s.sql});
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectingRef = useRef(false);
  const activeConnection = s.connections.find((c) => c.id === s.activeConnId);
  const worksheetBusy = s.running || s.transactionBusy || reconnecting;
  const runSql = () => {
    if (!reconnectingRef.current) s.runSql();
  };
  const reconnect = async () => {
    if (reconnectingRef.current || s.running || s.transactionBusy || !activeConnection?.live) return;
    reconnectingRef.current = true;
    setReconnecting(true);
    try {
      await s.reconnectConn(activeConnection.id);
    } finally {
      reconnectingRef.current = false;
      setReconnecting(false);
    }
  };
  const [expanded, setExpanded] = useState(false);
  const [editorPct, setEditorPct] = useState(46);
  const [view, setView] = useState<"results" | "plan" | "output">("results");
  const dragRef = useRef<HTMLDivElement>(null);
  const connectionInitialized = useRef(false);
  useEffect(() => {
    if (connectionInitialized.current || s.running || s.transactionBusy) return;
    const active = s.connections.find((c) => c.id === s.activeConnId);
    const connected = active?.status === "connected" ? active : s.connections.find((c) => c.status === "connected");
    if (!connected) return;
    connectionInitialized.current = true;
    if (connected.id !== s.activeConnId) s.setActiveConnId(connected.id);
  }, [s.connections, s.activeConnId, s.setActiveConnId, s.running, s.transactionBusy]);

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

  const statementOffset = s.result?.statement ? s.sql.indexOf(s.result.statement) : -1;
  const errorLine = s.result?.error && statementOffset >= 0
    ? s.result.error.line + s.sql.slice(0, statementOffset).split("\n").length - 1
    : null;

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 overflow-hidden">
      {/* worksheet toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-bdrsoft shrink-0 flex-wrap">
        <Btn variant="primary" onClick={runSql} title="Run selected statements in order or statement at cursor (Ctrl+Enter)" disabled={worksheetBusy}>
          <Play size={12} fill="currentColor" />
          Run
        </Btn>
        <Btn
          variant="outline"
          disabled={worksheetBusy}
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
        {harnessEnabled && <Btn variant="outline" onClick={() => setAssistOpen(open => !open)}>Assist</Btn>}
        <Btn variant="outline" onClick={s.doFormat} title="Format SQL (Ctrl+Shift+F)">
          <AlignLeft size={13} />
          Format
        </Btn>
        <Btn variant="outline" onClick={() => { download("worksheet.sql", s.sql); s.toast("success", "Script saved as worksheet.sql"); }} title="Save script (Ctrl+S)">
          <Save size={13} />
          Save
        </Btn>
        <label className="flex items-center gap-1.5 text-[11px] text-mute" title="Automatically restore open worksheets and SQL from this browser after refresh or restart">
          <input type="checkbox" checked={s.reopenWorksheets} onChange={(e) => s.setReopenWorksheets(e.target.checked)} />
          Reopen worksheets on startup
        </label>
        <span className={`text-[10.5px] ${s.worksheetSaveError ? "text-err" : "text-mute"}`} role={s.worksheetSaveError ? "alert" : undefined}>
          {s.worksheetSaveError ? "Autosave unavailable — use Save to download SQL" : "Autosave on · this browser"}
        </span>
        <div className="ml-2 flex items-center gap-2 text-[11.5px] text-mute">
          <Database size={12} />
          <select
            aria-label="Worksheet connection"
            title="Connection used for worksheet SQL and transactions"
            value={s.activeConnId}
            disabled={worksheetBusy || !s.connections.length}
            onChange={(e) => {
              connectionInitialized.current = true;
              s.setActiveConnId(e.target.value);
            }}
            className="max-w-64 rounded border border-bdr bg-panel px-2 py-1 text-[12px] text-ink disabled:opacity-50"
          >
            {!s.connections.some((c) => c.id === s.activeConnId) && <option value="">Select connection</option>}
            {s.connections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === "connected" ? " (connected)" : ""}</option>)}
          </select>
          <Btn
            variant="outline"
            onClick={reconnect}
            disabled={worksheetBusy || !activeConnection?.live}
            title="Reconnect the selected connection. Uncommitted changes will be rolled back; your worksheet SQL is kept."
          >
            {reconnecting ? <Spinner /> : <RefreshCw size={13} />}
            {reconnecting ? "Reconnecting…" : "Reconnect"}
          </Btn>
        </div>
        <div className="ml-auto hidden md:flex items-center gap-2 text-[11.5px] text-mute">
          <kbd className="hidden md:inline">Ctrl</kbd>
          <span className="hidden md:inline -mx-1">+</span>
          <kbd className="hidden md:inline">Enter</kbd>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-1 border-b border-bdrsoft text-[12px]">
        <button type="button" role="switch" aria-checked={s.autoCommit} onClick={s.toggleAutoCommit}
          disabled={worksheetBusy || !s.activeConnId || !['Administrator', 'Developer'].includes(s.accessRole) || activeConnection?.readOnly}
          className="rounded border border-bdr px-2 py-1 hover:bg-panel3 disabled:opacity-50">Auto-commit: {s.autoCommit ? 'On' : 'Off'}</button>
        {!s.autoCommit && <>
          <Btn variant="outline" disabled={worksheetBusy} onClick={() => s.finishTransaction('COMMIT')}>Commit</Btn>
          <Btn variant="outline" disabled={worksheetBusy} onClick={() => s.finishTransaction('ROLLBACK')}>Rollback</Btn>
        </>}
        <span className="text-mute">Shared with table edits · DDL commits implicitly; explicit COMMIT still applies.</span>
        {!s.autoCommit && <span className="text-warn">Manual sessions roll back on disconnect or after 30 minutes idle.</span>}
      </div>

      {assistOpen && <AssistPanel key={`${s.activeTabId}:${s.activeConnId}:${JSON.stringify(s.session)}`} text={s.sql}
        selection={selection.source === s.sql ? s.sql.slice(selection.start, selection.end) : ""}
        connectionId={s.activeConnId} schema={activeConnection?.user.toUpperCase() ?? ""}
        editorId={s.activeTabId} onApply={s.setSql} />}
      {/* editor */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        <div hidden={expanded} style={{ height: `${editorPct}%` }} className="min-h-24 min-w-0 shrink-0 overflow-hidden">
          <SqlEditor value={s.sql} onChange={s.setSql} errorLine={errorLine} onSelectionChange={(start, end) => { s.setSqlSelection(start, end); setSelection({start, end, source: s.sql}); }} onRun={runSql} />
        </div>

        {/* splitter */}
        <div
          hidden={expanded}
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
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col bg-panel">
          <div className="flex items-center gap-0.5 border-b border-bdrsoft px-2 pt-1 shrink-0">
            {(["results", "plan", "output"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-[12px] font-medium rounded-t-md border border-b-0 transition-colors ${
                  view === v ? "bg-panel2 border-bdr text-ink" : "border-transparent text-mute hover:text-soft"
                }`}
                aria-selected={view === v}
                role="tab"
              >
                {v === "results" ? "Query Result" : v === "plan" ? "Explain Plan" : `DBMS Output${s.result?.dbmsOutput?.length ? ` (${s.result.dbmsOutput.length})` : ""}`}
              </button>
            ))}
            <button type="button" className="ml-2 flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-panel3" onClick={() => setExpanded((v) => !v)} aria-label={expanded ? "Restore editor" : "Expand results"} title={expanded ? "Restore editor" : "Expand results"}>
              {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}<span className="hidden sm:inline">{expanded ? "Restore" : "Expand"}</span>
            </button>
            {view === "results" && s.result && (
              <Btn
                variant="outline"
                title="Rerun the statement shown in the query result"
                disabled={worksheetBusy || !activeConnection?.live || !s.result.statement.trim()}
                onClick={() => {
                  if (!reconnectingRef.current && s.result?.statement) s.runSql(s.result.statement);
                }}
              >
                <RefreshCw size={12} className={s.running ? "animate-spin" : ""} /> Refresh
              </Btn>
            )}
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

          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            {s.running ? (
              <div className="h-full flex items-center justify-center">
                <Spinner label="Executing statement…" />
              </div>
            ) : view === "plan" ? (
              <ExplainPlan />
            ) : view === "output" ? (
              <div className="h-full overflow-auto p-4">
                {s.result?.dbmsOutputTruncated && <p className="text-[11.5px] text-warn mb-2">Output truncated to the first 1,000 lines.</p>}
                {s.result?.dbmsOutput?.length ? (
                  <pre className="font-mono text-[12px] text-ink whitespace-pre-wrap break-words select-text">{s.result.dbmsOutput.join("\n")}</pre>
                ) : <p className="text-[12px] text-mute">DBMS_OUTPUT is enabled automatically. Run code containing DBMS_OUTPUT.PUT_LINE(...) to see messages here.</p>}
              </div>
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
                    {s.result.error.code} — statement failed at line {errorLine ?? s.result.error.line}
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
              <ResultsGrid columns={s.result.columns} rows={s.result.rows} exportName="query-results" truncated={s.result.truncated} paginate={s.result.resultKind !== "describe"} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
