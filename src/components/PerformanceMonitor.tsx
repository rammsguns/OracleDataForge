import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, CircleCheck, CircleX, HardDrive, Info, RefreshCcw, Timer, Users } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type PerfReport } from "../utils/api";
import { Badge, Btn, EmptyState, Spinner } from "./ui";

/* Charts follow the dataviz method: single-hue marks with direct labels,
   recessive grid, tooltips on hover, values in text tokens (not series color). */

function LineChart({ points, unit }: { points: { t: string; v: number }[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 620, H = 130, PAD = 8;
  const max = Math.max(...points.map((p) => p.v), 1);
  const x = (i: number) => PAD + (i / Math.max(points.length - 1, 1)) * (W - PAD * 2);
  const y = (v: number) => H - 12 - (v / max) * (H - 26);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(p.v)}`).join(" ");
  const area = `${path} L ${x(points.length - 1)} ${H - 12} L ${x(0)} ${H - 12} Z`;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Metric history">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={PAD} x2={W - PAD} y1={H - 12 - f * (H - 26)} y2={H - 12 - f * (H - 26)} stroke="var(--viz-grid)" strokeWidth={1} />
        ))}
        <path d={area} fill="var(--viz-1)" opacity={0.1} />
        <path d={path} fill="none" stroke="var(--viz-1)" strokeWidth={2} />
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={4} y2={H - 12} stroke="var(--viz-1)" strokeWidth={1} opacity={0.4} />
            <circle cx={x(hover)} cy={y(points[hover].v)} r={3.5} fill="var(--viz-1)" stroke="var(--surface-1, #fff)" strokeWidth={2} />
          </g>
        )}
        {points.map((_, i) => (
          <rect key={i} x={x(i) - (W / points.length) / 2} y={0} width={W / points.length} height={H} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
      </svg>
      {hover !== null && (
        <div className="absolute top-0 right-0 bg-panel border border-bdr rounded-md px-2.5 py-1.5 text-[11px] shadow-lg pointer-events-none">
          <b>{points[hover].t}</b> — {points[hover].v.toLocaleString()} {unit}
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "err" }) {
  const icon = /session|thread/i.test(label) ? <Activity size={13} /> : /storage|uptime/i.test(label) ? <HardDrive size={13} /> : /error|slow|alert/i.test(label) ? <CircleX size={13} /> : <Timer size={13} />;
  return (
    <div className="bg-panel border border-bdr rounded-xl p-3.5 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-mute">
        <span className="text-accenthi">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="text-[22px] font-bold text-ink leading-tight">{value}</div>
      {sub && <div className={`text-[11.5px] ${tone === "err" ? "text-err" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-mute"}`}>{sub}</div>}
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const max = Math.max(...points), min = Math.min(...points);
  const W = 76, H = 22;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${(i / (points.length - 1)) * W} ${H - ((p - min) / (max - min || 1)) * (H - 4) - 2}`).join(" ");
  return <svg width={W} height={H} aria-hidden className="shrink-0"><path d={d} fill="none" stroke="var(--viz-serious)" strokeWidth={1.8} strokeLinecap="round" /></svg>;
}

/* ------------- live (real) dashboard ------------- */

function LivePerf({ connId, connName }: { connId: string; connName: string }) {
  const s = useStudio();
  const [report, setReport] = useState<PerfReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.perf(connId).then(setReport).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [connId]);
  useEffect(() => load(), [load]);

  if (loading && !report) return <div className="h-full flex items-center justify-center"><Spinner label="Reading live performance data…" /></div>;
  if (error)
    return (
      <div className="p-4">
        <div className="border border-err/40 bg-err/8 rounded-lg p-3.5 max-w-2xl">
          <div className="flex items-center gap-2 text-err font-semibold text-[13px]"><CircleX size={15} /> Could not read performance data</div>
          <div className="mt-1.5 text-[12.5px] text-ink font-mono break-words">{error}</div>
          <div className="mt-2"><Btn variant="outline" onClick={load}>Retry</Btn></div>
        </div>
      </div>
    );
  if (!report) return null;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 df-fade">
      <div className="flex items-center gap-2.5 flex-wrap">
        <Activity size={16} className="text-accent" />
        <h2 className="text-[14px] font-semibold">Performance Monitor</h2>
        <Badge tone="ok">live · {report.scope}</Badge>
        <span className="text-[11.5px] text-mute uppercase">{report.engine}</span>
        <Btn variant="outline" className="ml-auto" onClick={load} disabled={loading} title="Re-read live metrics">
          <RefreshCcw size={12} className={loading ? "df-spin" : ""} /> Refresh
        </Btn>
      </div>

      {report.note && (
        <div className="flex items-start gap-2 text-[12px] bg-warn/8 border border-warn/25 rounded-lg px-3 py-2 text-soft">
          <AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" /> {report.note}
        </div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {report.tiles.map((t) => (
          <StatTile key={t.label} {...t} />
        ))}
      </div>

      {report.series && report.series.points.length > 1 && (
        <section className="bg-panel border border-bdr rounded-xl p-4">
          <h3 className="text-[12.5px] font-semibold mb-1">{report.series.label}</h3>
          <p className="text-[11.5px] text-mute mb-2">Live per-minute history from the instance metric views</p>
          <LineChart points={report.series.points} unit={report.series.unit} />
        </section>
      )}

      <div className="grid xl:grid-cols-2 gap-4">
        {/* slow queries */}
        <section className="bg-panel border border-bdr rounded-xl p-4 xl:col-span-2">
          <h3 className="text-[12.5px] font-semibold mb-1">Slowest statements</h3>
          <p className="text-[11.5px] text-mute mb-2">Real statistics {report.engine === "oracle" ? "from V$SQLSTATS" : "from performance_schema"} — click to open in a worksheet</p>
          {report.slowQueries.length === 0 ? (
            <p className="text-[12px] text-mute py-4 text-center">No statement statistics available (performance_schema may be disabled).</p>
          ) : (
            <div className="space-y-2">
              {report.slowQueries.map((q, i) => (
                <button
                  key={i}
                  className="w-full flex items-center gap-3 border border-bdrsoft rounded-lg px-3 py-2 hover:border-accent/50 hover:bg-accentdim text-left transition-colors"
                  onClick={() => {
                    s.setSql(`${q.sql};`);
                    s.openTab("worksheet", "Worksheet 1");
                    s.toast("info", "Statement loaded in worksheet");
                  }}
                  title="Load this statement in a worksheet"
                >
                  <div className="min-w-0 flex-1">
                    <pre className="font-mono text-[11px] text-soft truncate">{q.sql}</pre>
                    <div className="text-[10.5px] text-mute mt-0.5">{q.execs.toLocaleString()} executions · {q.totalS.toLocaleString()}s total</div>
                  </div>
                  <span className={`text-[13px] font-bold tabular-nums w-20 text-right ${q.avgMs > 100 ? "text-warn" : "text-ink"}`}>{q.avgMs.toLocaleString()} ms</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* sessions */}
        <section className="bg-panel border border-bdr rounded-xl p-4">
          <h3 className="text-[12.5px] font-semibold mb-2">Active sessions</h3>
          {report.sessions.length === 0 ? (
            <p className="text-[12px] text-mute py-4 text-center">No sessions.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px] min-w-[420px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-mute border-b border-bdrsoft">
                    <th className="py-1.5 font-semibold">{report.engine === "oracle" ? "SID" : "ID"}</th>
                    <th className="py-1.5 font-semibold">User</th>
                    <th className="py-1.5 font-semibold">{report.engine === "oracle" ? "Event" : "State"}</th>
                    <th className="py-1.5 font-semibold text-right">{report.engine === "oracle" ? "Idle" : "Time"}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.sessions.map((x) => (
                    <tr key={x.id} className="border-b border-bdrsoft hover:bg-panel2">
                      <td className="py-1.5 font-mono tabular-nums">{x.id}</td>
                      <td className="py-1.5 font-mono">{x.user}</td>
                      <td className="py-1.5 text-soft">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${/ACTIVE|Query|Execute/i.test(x.status) ? "bg-ok" : "bg-mute"}`} aria-label={x.status} />
                          <span className="truncate max-w-[180px]" title={x.event}>{x.event}</span>
                        </span>
                      </td>
                      <td className={`py-1.5 text-right tabular-nums ${x.seconds > 60 ? "text-warn font-semibold" : "text-mute"}`}>{x.seconds}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* storage */}
        <section className="bg-panel border border-bdr rounded-xl p-4">
          <h3 className="text-[12.5px] font-semibold mb-1">{report.engine === "oracle" ? "Tablespace usage" : "Largest tables"}</h3>
          <p className="text-[11.5px] text-mute mb-3">{report.engine === "oracle" ? "Used vs allocated per tablespace" : "By data + index size"}</p>
          {report.storage.length === 0 ? (
            <p className="text-[12px] text-mute py-4 text-center">No storage metrics available.</p>
          ) : (
            <div className="space-y-3">
              {report.storage.map((t) => {
                const pct = t.totalMb ? (t.usedMb / t.totalMb) * 100 : null;
                const max = Math.max(...report.storage.map((s) => s.usedMb), 1);
                const barPct = pct ?? (t.usedMb / max) * 100;
                const tone = pct != null && pct > 85 ? "var(--viz-warn)" : "var(--viz-1)";
                return (
                  <div key={t.name}>
                    <div className="flex items-center justify-between text-[11.5px] mb-1">
                      <span className="font-mono text-soft truncate">{t.name}</span>
                      <span className="text-mute tabular-nums">
                        {t.usedMb.toLocaleString()} MB{t.totalMb != null && ` / ${t.totalMb.toLocaleString()} MB · ${pct!.toFixed(0)}%`}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--viz-grid)] overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(barPct, 2)}%`, background: tone }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* activity */}
        <section className="bg-panel border border-bdr rounded-xl p-4">
          <h3 className="text-[12.5px] font-semibold mb-2 flex items-center gap-2"><Users size={13} className="text-accenthi" /> Recent statements</h3>
          {report.activity.length === 0 ? (
            <p className="text-[12px] text-mute py-4 text-center">No recent activity captured.</p>
          ) : (
            <ul className="space-y-1.5">
              {report.activity.map((a, i) => (
                <li key={i} className="flex items-center gap-2.5 text-[12px]">
                  <span className="text-mute tabular-nums w-16 shrink-0">{a.at}</span>
                  <Info size={12} className="text-accenthi shrink-0" />
                  <span className="text-soft font-mono truncate" title={a.text}>{a.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/* The sample dashboard that used to live here was deleted (2026-07-25). It rendered
 * invented sessions, tablespaces, error counts and a 7-day throughput chart whenever
 * there was no active connection � and a fresh browser hit exactly that state, so the
 * first thing a new user saw was fabricated performance data with a banner that still
 * talked about a demo connection that no longer exists. An empty state is the honest
 * answer: there is nothing to monitor until a connection is chosen. */

export default function PerformanceMonitor() {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  if (conn) return <LivePerf connId={conn.id} connName={conn.name} />;
  return (
    <EmptyState
      icon={<Activity />}
      title="No connection selected"
      hint="Pick a connection in the Explorer to read its live sessions, waits and cache metrics."
    />
  );
}
