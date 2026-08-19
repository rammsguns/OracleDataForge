import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Hammer, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import { useStudio } from "../state/store";
import { Badge, Btn, EmptyState, Spinner } from "./ui";
import {
  compileRunKey,
  getCompileRun,
  loadCompileTargets,
  parseCompilePayload,
  startCompileRun,
  subscribeCompileRun,
} from "../utils/compileRuns";

/** Sidebar group label → the tab-kind used to open one of its objects. */
const EDITOR_KINDS: Record<string, string> = {
  Packages: "Package",
  Procedures: "Procedure",
  Functions: "Function",
  Triggers: "Trigger",
  Types: "Type",
  Views: "View",
  "Materialized Views": "Materialized View",
  Synonyms: "Synonym",
};

const fmtSecs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * "Compile invalid objects" for a schema, one tree group, or one object.
 *
 * A tab rather than a modal on purpose: the run can take minutes and cannot be
 * cancelled, so a surface that closes on Escape or a stray backdrop click would be the
 * wrong container for it. It is also a worklist — you open a broken object in the
 * editor, fix it, and come back — and only a tab survives that.
 */
export default function CompileInvalid({ payload }: { payload: string }) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  const ref = useMemo(() => parseCompilePayload(payload), [payload]);
  const key = compileRunKey(s.activeConnId, payload);

  // the run lives in a module-level map (tabs unmount); this just mirrors it into React
  const [, force] = useState(0);
  useEffect(() => subscribeCompileRun(key, () => force((n) => n + 1)), [key]);
  const run = getCompileRun(key);

  // elapsed counter — the only honest progress signal we have (nothing streams)
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run?.status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [run?.status]);

  const preflight = useCallback(() => {
    if (!conn) return;
    void loadCompileTargets(key, conn.id, conn.name, ref);
  }, [conn, key, ref]);

  useEffect(() => {
    if (!getCompileRun(key)) preflight();
  }, [key, preflight]);

  const compile = useCallback(async () => {
    const pending = await startCompileRun(key, false);
    if (!pending) return; // ran (or nothing to do) — the server decided it needed no dialog
    // Show the server's wording verbatim: it classified the operation and counted the
    // objects, so it is the only thing that can describe what is about to happen (D-13).
    s.askConfirm({
      title: pending.confirmation.title,
      body: pending.confirmation.body,
      confirmLabel: pending.confirmation.confirmLabel,
      danger: pending.confirmation.danger,
      onConfirm: () => {
        void startCompileRun(key, true).then(() => {
          const done = getCompileRun(key);
          if (done?.result) {
            const r = done.result;
            s.refreshGroups(r.groups);
            s.toast(
              r.stillInvalid ? "warning" : "success",
              `${r.compiled} compiled, ${r.stillInvalid} still invalid — ${r.passes} pass(es), ${fmtSecs(r.elapsedMs)}`
            );
          } else if (done?.error) {
            s.toast("error", done.error);
          }
        });
      },
    });
  }, [key, s]);

  if (!conn) {
    return <EmptyState icon={<Hammer />} title="No connection selected" hint="Pick a connection in the Explorer to compile its invalid objects." />;
  }
  const report = run?.report;
  const result = run?.result;
  const busy = run?.status === "running";
  const loading = run?.status === "loading";
  const staleConn = run && run.connId !== s.activeConnId;

  const disabledReason = !report
    ? null
    : report.readOnly
      ? "This connection is read-only — ALTER … COMPILE is blocked."
      : report.systemSchema
        ? `${conn.user?.toUpperCase() ?? "This"} is an Oracle-maintained schema — compiling from here is blocked.`
        : report.overCap
          ? `${report.total} objects is over the ${report.cap}-object cap for one request.`
          : report.total === 0
            ? "Nothing to compile."
            : null;

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* toolbar */}
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-bdrsoft bg-panel">
        <Hammer size={14} className="text-accent" />
        <span className="text-[12.5px] font-semibold">{report?.scopeLabel ?? run?.result?.scopeLabel ?? "Compile"}</span>
        {report && (
          <span className="text-[11.5px] text-mute">
            {report.total} to compile
            {report.skipped.length > 0 && ` · ${report.skipped.length} skipped`}
          </span>
        )}
        <div className="flex-1" />
        <Btn onClick={preflight} disabled={busy || loading} title="Re-read the dictionary">
          <RefreshCw size={13} className={loading ? "df-spin" : ""} /> Re-check
        </Btn>
        <Btn
          variant="primary"
          onClick={() => void compile()}
          disabled={busy || loading || !report || !!disabledReason}
          title={disabledReason ?? undefined}
        >
          <Hammer size={13} />
          {result && report && report.total > 0 ? `Compile remaining ${report.total}` : `Compile ${report?.total ?? 0} object(s)`}
        </Btn>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {staleConn && (
          <div className="flex items-center gap-2 text-[11.5px] text-warn bg-warn/10 border border-warn/30 rounded-md px-2.5 py-1.5">
            <AlertTriangle size={13} />
            These results are from <span className="font-semibold">{run?.connName}</span> — the active connection has changed since.
          </div>
        )}

        {run?.error && (
          <div className="flex items-start gap-2 text-[12px] text-err bg-err/10 border border-err/30 rounded-md px-2.5 py-2">
            <ShieldAlert size={14} className="shrink-0 mt-0.5" />
            <span className="whitespace-pre-wrap">{run.error}</span>
          </div>
        )}

        {disabledReason && report && report.total > 0 && (
          <div className="text-[11.5px] text-warn bg-warn/10 border border-warn/30 rounded-md px-2.5 py-1.5">{disabledReason}</div>
        )}

        {loading && !report && <Spinner label="Reading the dictionary…" />}

        {busy && (
          <div className="rounded-md border border-bdr bg-panel px-3 py-3">
            <Spinner
              label={`Compiling ${report?.total ?? 0} object(s) — up to 3 passes. You can switch tabs; the run keeps going.`}
            />
            <div className="text-[11px] text-mute mt-1.5 tabular-nums">{fmtSecs(now - (run?.startedAt ?? now))} elapsed</div>
          </div>
        )}

        {/* result summary */}
        {result && !busy && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="ok">{result.compiled} compiled</Badge>
            {result.stillInvalid > 0 && <Badge tone="err">{result.stillInvalid} still invalid</Badge>}
            {result.newlyInvalid > 0 && <Badge tone="warn">{result.newlyInvalid} other object(s) went invalid</Badge>}
            {result.timedOut && <Badge tone="warn">timed out</Badge>}
            <Badge>
              {result.passes} pass{result.passes === 1 ? "" : "es"} · {fmtSecs(result.elapsedMs)}
            </Badge>
          </div>
        )}

        {result?.note && !busy && (
          <EmptyState icon={<CheckCircle2 />} title="Nothing to compile" hint={result.note} />
        )}

        {/* per-object results, still-invalid first */}
        {result && result.results.length > 0 && !busy && (
          <ObjectTable
            title="Results"
            rows={result.results.map((r) => ({
              key: `${r.type} ${r.name}`,
              ok: r.status === "VALID",
              unknown: r.status === "UNKNOWN",
              type: r.type,
              name: r.name,
              group: r.group,
              detail:
                r.errors.length > 0
                  ? `line ${r.errors[0].line}, col ${r.errors[0].position} · ${r.errors[0].text}`
                  : r.error ?? "",
              attempts: r.attempts,
            }))}
            onOpen={(name, group) => s.openTab("object", `${name} (${EDITOR_KINDS[group] ?? "Object"})`, name)}
          />
        )}

        {/* preflight list (before a run, or when there is nothing to show yet) */}
        {report && !result && !busy && report.total > 0 && (
          <div className="rounded-md border border-bdr overflow-hidden">
            <div className="px-2.5 h-8 flex items-center gap-2 bg-panel2 border-b border-bdrsoft text-[11px] font-semibold text-soft uppercase tracking-wider">
              Will compile, in this order
              <span className="text-mute font-normal normal-case tracking-normal">
                {report.breakdown.map((b) => `${b.count} ${b.type}`).join(", ")}
              </span>
            </div>
            {report.targets.map((t, i) => (
              <div key={`${t.type} ${t.name}`} className="flex items-center gap-2 px-2.5 py-1 text-[12px] border-b border-bdrsoft last:border-0">
                <span className="text-mute tabular-nums w-6 text-right">{i + 1}</span>
                <span className="text-mute w-40 shrink-0">{t.type}</span>
                <span className="font-mono text-ink">{t.name}</span>
              </div>
            ))}
          </div>
        )}

        {report && report.total === 0 && !result && !loading && (
          <EmptyState
            icon={<CheckCircle2 />}
            title="Nothing to compile"
            hint={`The dictionary reports no invalid objects in ${report.scopeLabel}.`}
          />
        )}

        {/* skipped: invalid, but a compile is not what fixes them */}
        {((result?.skipped.length ?? 0) > 0 || (report?.skipped.length ?? 0) > 0) && !busy && (
          <div className="rounded-md border border-bdr overflow-hidden">
            <div className="px-2.5 h-8 flex items-center bg-panel2 border-b border-bdrsoft text-[11px] font-semibold text-soft uppercase tracking-wider">
              Skipped ({(result?.skipped ?? report?.skipped ?? []).length})
            </div>
            {(result?.skipped ?? report?.skipped ?? []).map((sk) => (
              <div key={`${sk.type} ${sk.name}`} className="flex items-start gap-2 px-2.5 py-1.5 text-[12px] border-b border-bdrsoft last:border-0">
                <span className="text-mute w-40 shrink-0">{sk.type}</span>
                <span className="font-mono text-soft w-56 shrink-0 truncate">{sk.name}</span>
                <span className="text-mute">{sk.reason}</span>
              </div>
            ))}
          </div>
        )}

        {report && (
          <div className="text-[11px] text-mute">
            Checked {new Date(report.checkedAt).toLocaleTimeString()} · this is a snapshot, not a live view.
          </div>
        )}
      </div>
    </div>
  );
}

function ObjectTable({
  title,
  rows,
  onOpen,
}: {
  title: string;
  rows: { key: string; ok: boolean; unknown: boolean; type: string; name: string; group: string; detail: string; attempts: number }[];
  onOpen: (name: string, group: string) => void;
}) {
  return (
    <div className="rounded-md border border-bdr overflow-hidden">
      <div className="px-2.5 h-8 flex items-center bg-panel2 border-b border-bdrsoft text-[11px] font-semibold text-soft uppercase tracking-wider">
        {title}
      </div>
      {rows.map((r) => (
        <button
          key={r.key}
          onClick={() => onOpen(r.name, r.group)}
          className="w-full text-left flex items-start gap-2 px-2.5 py-1.5 text-[12px] border-b border-bdrsoft last:border-0 hover:bg-panel3 transition-colors"
          title={`Open ${r.name} in the editor`}
        >
          {r.ok ? (
            <CheckCircle2 size={13} className="text-ok shrink-0 mt-0.5" />
          ) : r.unknown ? (
            <AlertTriangle size={13} className="text-warn shrink-0 mt-0.5" />
          ) : (
            <XCircle size={13} className="text-err shrink-0 mt-0.5" />
          )}
          <span className="text-mute w-36 shrink-0">{r.type}</span>
          <span className="font-mono text-ink w-56 shrink-0 truncate">{r.name}</span>
          <span className={`flex-1 ${r.ok ? "text-mute" : "text-err"}`}>{r.detail}</span>
          {r.attempts > 1 && <span className="text-mute shrink-0">{r.attempts} attempts</span>}
        </button>
      ))}
    </div>
  );
}
