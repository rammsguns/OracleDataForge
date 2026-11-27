import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Code2,
  Cpu,
  Database,
  Gauge,
  Hammer,
  HardDrive,
  Info,
  LayoutDashboard,
  Lock,
  RefreshCcw,
  ScanSearch,
  ShieldAlert,
  Timer,
  Users,
} from "lucide-react";
import { useStudio } from "../state/store";
import { useTabActive } from "../state/tabActivity";
import { api, type DbaInsights, type DbaReport, type InsightArea, type InsightFinding, type InsightSeverity } from "../utils/api";
import { AREA_LABEL, bySeverity, fmtCount, healthLabel, healthScore } from "../utils/dbaAdvisor";
import { AREA_PANEL, Panel } from "./DbaAdvisorInsights";
import { Badge, Btn, EmptyState, Spinner } from "./ui";

/* Charts follow the dataviz method: single-hue marks, recessive grid, values in
   text tokens, status colors reserved for the advisor severities. */

const SEV_META: Record<InsightSeverity, { tone: "ok" | "warn" | "err"; icon: ReactNode; label: string; color: string }> = {
  good: { tone: "ok", icon: <CircleCheck size={14} />, label: "Healthy", color: "var(--viz-good)" },
  warning: { tone: "warn", icon: <Info size={14} />, label: "Warning", color: "var(--viz-warn)" },
  serious: { tone: "warn", icon: <AlertTriangle size={14} />, label: "Serious", color: "var(--viz-serious)" },
  critical: { tone: "err", icon: <ShieldAlert size={14} />, label: "Critical", color: "var(--viz-critical)" },
};

const METRIC_ICON: Record<string, ReactNode> = {
  "Buffer Cache Hit Ratio": <Database size={13} />,
  "Library Cache Hit Ratio": <Database size={13} />,
  "Soft Parse Ratio": <Code2 size={13} />,
  "Host CPU Utilization (%)": <Cpu size={13} />,
  Executions: <Activity size={13} />,
  "User Commits": <Timer size={13} />,
};

type Tab = "overview" | InsightArea;
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard size={13} /> },
  { id: "sql", label: AREA_LABEL.sql, icon: <Clock size={13} /> },
  { id: "plsql", label: AREA_LABEL.plsql, icon: <Code2 size={13} /> },
  { id: "views", label: AREA_LABEL.views, icon: <ScanSearch size={13} /> },
  { id: "jobs", label: AREA_LABEL.jobs, icon: <Timer size={13} /> },
  { id: "sessions", label: AREA_LABEL.sessions, icon: <Lock size={13} /> },
  { id: "objects", label: AREA_LABEL.objects, icon: <Hammer size={13} /> },
];

/** How many items each area surfaces — shown as a count on its tab. */
function areaCount(i: DbaInsights, a: InsightArea): number {
  switch (a) {
    case "sql": return i.slowSql.filter((q) => q.perExecMs >= 1000).length;
    case "plsql": return i.programs.length;
    case "views": return i.views.filter((v) => v.perExecMs >= 1000).length + i.mviews.length;
    case "jobs": return i.jobs.filter((j) => j.failures > 0).length + i.runningJobs.length;
    case "sessions": return i.activeSessions.length + i.longOps.length;
    case "objects": return i.invalidObjects.length + i.staleStats.length;
  }
}

type Finding = InsightFinding | (Omit<InsightFinding, "area"> & { area?: undefined });

function HealthRing({ score }: { score: number }) {
  const { label, tone } = healthLabel(score);
  const r = 34, c = 2 * Math.PI * r;
  const color = tone === "ok" ? "var(--viz-good)" : tone === "warn" ? "var(--viz-warn)" : "var(--viz-critical)";
  return (
    <div className="flex items-center gap-3.5">
      <svg width="84" height="84" viewBox="0 0 84 84" role="img" aria-label={`Health score ${score} of 100, ${label}`}>
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--viz-grid)" strokeWidth="8" />
        <circle
          cx="42" cy="42" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`} transform="rotate(-90 42 42)"
          style={{ transition: "stroke-dasharray 400ms ease" }}
        />
        <text x="42" y="47" textAnchor="middle" fill="var(--ink)" className="text-[20px] font-bold">{score}</text>
      </svg>
      <div>
        <div className="text-[10.5px] uppercase tracking-wider text-mute font-semibold">Health score</div>
        <div className={`text-[16px] font-bold ${tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-err"}`}>{label}</div>
      </div>
    </div>
  );
}

function MetricTile({ name, value, unit }: { name: string; value: number; unit: string }) {
  const isRatio = /Ratio|Utilization/.test(name);
  const tone = isRatio
    ? name.includes("CPU")
      ? value > 85 ? "err" : value > 70 ? "warn" : "ok"
      : value < 90 ? "warn" : "ok"
    : "neutral";
  const toneColor = tone === "err" ? "text-err" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ink";
  const display = unit === "%" || isRatio ? `${value}%` : fmtCount(value);
  return (
    <div className="bg-panel border border-bdr rounded-xl p-3 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-mute">
        <span className="text-accenthi">{METRIC_ICON[name] ?? <Gauge size={13} />}</span>
        <span className="truncate" title={name}>{name.replace(" (%)", "")}</span>
      </div>
      <div className={`text-[20px] font-bold leading-tight tabular-nums ${toneColor}`}>{display}</div>
      {isRatio ? (
        <div className="h-1 rounded-full bg-[var(--viz-grid)] overflow-hidden" aria-hidden>
          <div className="h-full rounded-full bg-[var(--viz-1)]" style={{ width: `${Math.min(value, 100)}%` }} />
        </div>
      ) : (
        unit && <div className="text-[11px] text-mute">{unit}</div>
      )}
    </div>
  );
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="h-2 rounded-full bg-[var(--viz-grid)] overflow-hidden" role="img" aria-label={`${Math.round(pct)}%`}>
      <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: tone }} />
    </div>
  );
}

function FindingList({ findings, onOpen }: { findings: Finding[]; onOpen: (a: InsightArea) => void }) {
  return (
    <ul className="space-y-2">
      {findings.map((a, i) => {
        const m = SEV_META[a.severity];
        return (
          <li key={i} className="flex items-start gap-2.5 border border-bdrsoft rounded-lg px-3 py-2 border-l-[3px]" style={{ borderLeftColor: m.color }}>
            <span style={{ color: m.color }} className="mt-0.5 shrink-0">{m.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12.5px] font-semibold text-ink">{a.title}</span>
                <Badge tone={m.tone}>{m.label}</Badge>
                {a.area && <span className="text-[10.5px] text-mute uppercase tracking-wider">{AREA_LABEL[a.area]}</span>}
              </div>
              <div className="text-[12px] text-soft mt-0.5">{a.detail}</div>
            </div>
            {a.area && (
              <Btn variant="ghost" className="shrink-0" onClick={() => onOpen(a.area!)} title={`Open ${AREA_LABEL[a.area]}`}>
                Investigate <ArrowRight size={12} />
              </Btn>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Overview({ report, insights, findings, onOpen }: { report: DbaReport; insights: DbaInsights | null; findings: Finding[]; onOpen: (t: Tab) => void }) {
  const top = insights?.slowSql.slice().sort((a, b) => b.perExecMs - a.perExecMs).slice(0, 5) ?? [];
  return (
    <>
      <Panel title="Advisor findings" hint="Instance health plus workload analysis, most severe first." icon={<ShieldAlert size={14} />}>
        <FindingList findings={findings} onOpen={onOpen} />
      </Panel>

      {report.metrics.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {report.metrics.map((m) => <MetricTile key={m.name} {...m} />)}
        </div>
      )}

      <div className="grid xl:grid-cols-2 gap-4">
        <Panel
          title="Slowest statements"
          hint="Highest time per execution in the cursor cache"
          icon={<Clock size={14} />}
          actions={<Btn variant="ghost" onClick={() => onOpen("sql")}>All slow SQL <ArrowRight size={12} /></Btn>}
        >
          {!insights ? (
            <div className="py-6 flex justify-center"><Spinner label="Analyzing workload…" /></div>
          ) : top.length === 0 ? (
            <p className="text-[12px] text-mute py-4 text-center">No application SQL in the cursor cache.</p>
          ) : (
            <div className="space-y-2.5">
              {top.map((q) => (
                <button key={q.sqlId} type="button" onClick={() => onOpen("sql")} className="block w-full text-left group">
                  <div className="flex items-center justify-between text-[11.5px] mb-1 gap-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-accenthi shrink-0">{q.sqlId}</span>
                      <span className="font-mono text-soft truncate group-hover:text-ink" title={q.sqlText}>{q.sqlText}</span>
                    </span>
                    <span className={`tabular-nums shrink-0 font-semibold ${q.perExecMs >= 1000 ? "text-warn" : "text-mute"}`}>
                      {q.perExecMs >= 1000 ? `${(q.perExecMs / 1000).toFixed(1)} s` : `${Math.round(q.perExecMs)} ms`}
                    </span>
                  </div>
                  <Bar pct={(q.perExecMs / (top[0].perExecMs || 1)) * 100} tone={q.perExecMs >= 1000 ? "var(--viz-serious)" : "var(--viz-1)"} />
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Top wait events" hint="Non-idle waits since instance startup, by time waited" icon={<Activity size={14} />}>
          {report.waitEvents.length === 0 ? (
            <p className="text-[12px] text-mute py-4 text-center">No non-idle waits recorded.</p>
          ) : (
            <div className="space-y-2.5">
              {report.waitEvents.slice(0, 6).map((w) => {
                const max = report.waitEvents[0].timeS || 1;
                const hot = ["Concurrency", "Contention", "Cluster", "Application"].includes(w.waitClass);
                return (
                  <div key={w.event}>
                    <div className="flex items-center justify-between text-[11.5px] mb-1 gap-2">
                      <span className="font-mono text-soft truncate" title={`${w.event} (${w.waitClass})`}>{w.event}</span>
                      <span className="text-mute tabular-nums shrink-0">{w.timeS.toLocaleString()}s · {w.waitClass}</span>
                    </div>
                    <Bar pct={(w.timeS / max) * 100} tone={hot ? "var(--viz-serious)" : "var(--viz-1)"} />
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Tablespace usage" hint="Space used vs allocated (DBA_TABLESPACE_USAGE_METRICS)" icon={<HardDrive size={14} />}>
          {report.tablespaces.length === 0 ? (
            <p className="text-[12px] text-mute py-4 text-center">No tablespace metrics available.</p>
          ) : (
            <div className="space-y-3">
              {report.tablespaces.map((t) => {
                const tone = t.pct > 90 ? "var(--viz-critical)" : t.pct > 80 ? "var(--viz-serious)" : "var(--viz-1)";
                return (
                  <div key={t.name}>
                    <div className="flex items-center justify-between text-[11.5px] mb-1">
                      <span className="font-mono text-soft">{t.name}</span>
                      <span className="text-mute tabular-nums">
                        {t.usedMb.toLocaleString()} / {t.totalMb.toLocaleString()} MB · {t.pct}%
                        {t.pct > 80 && <AlertTriangle size={11} className="inline ml-1 text-warn" aria-label="High usage" />}
                      </span>
                    </div>
                    <Bar pct={t.pct} tone={tone} />
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel
          title="Sessions & memory"
          icon={<Users size={14} />}
          actions={<Btn variant="ghost" onClick={() => onOpen("sessions")}>Locks & long calls <ArrowRight size={12} /></Btn>}
        >
          <div className="flex gap-2 mb-3">
            {([
              ["Active", report.sessions.active, "text-ok"],
              ["Inactive", report.sessions.inactive, "text-mute"],
              ["Total", report.sessions.total, "text-ink"],
              ["Blocked", insights?.activeSessions.filter((x) => x.blockingSid !== null).length ?? 0, "text-err"],
            ] as const).map(([label, v, cls]) => (
              <div key={label} className="flex-1 bg-panel2 border border-bdrsoft rounded-lg p-2 text-center">
                <div className={`text-[18px] font-bold tabular-nums ${label === "Blocked" && v === 0 ? "text-mute" : cls}`}>{v}</div>
                <div className="text-[10px] text-mute uppercase tracking-wider">{label}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-mute mb-1.5">Top users</div>
              <table className="w-full text-[11.5px]">
                <tbody>
                  {report.sessions.users.map((u) => (
                    <tr key={u.user} className="border-b border-bdrsoft last:border-0">
                      <td className="py-1 font-mono text-soft truncate max-w-[120px]">{u.user}</td>
                      <td className="py-1 text-right tabular-nums text-mute">{u.cnt}</td>
                    </tr>
                  ))}
                  {report.sessions.users.length === 0 && <tr><td className="py-2 text-mute">—</td></tr>}
                </tbody>
              </table>
            </div>
            <div>
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-mute mb-1.5">SGA / PGA</div>
              <table className="w-full text-[11.5px]">
                <tbody>
                  {[...report.sga.map((x) => ({ ...x, name: x.name.replace(" Size", "") })), ...report.pga.map((x) => ({ ...x, name: `PGA ${x.name.replace("total PGA ", "").replace(" parameter", "")}` }))].map((x) => (
                    <tr key={x.name} className="border-b border-bdrsoft last:border-0">
                      <td className="py-1 text-soft truncate max-w-[140px]">{x.name}</td>
                      <td className="py-1 text-right tabular-nums text-mute whitespace-nowrap">{x.mb.toLocaleString()} MB</td>
                    </tr>
                  ))}
                  {report.sga.length + report.pga.length === 0 && <tr><td className="py-2 text-mute">—</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}

export default function DbaAdvisor() {
  const active = useTabActive();
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  const isOracleLive = !!conn?.live && conn.engine === "oracle";
  const [report, setReport] = useState<DbaReport | null>(null);
  const [insights, setInsights] = useState<DbaInsights | null>(null);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [auto, setAuto] = useState(true);
  const [sampledAt, setSampledAt] = useState<Date | null>(null);
  const requestId = useRef(0);

  const load = useCallback(() => {
    if (!isOracleLive || !conn) return;
    const current = ++requestId.current;
    const fresh = () => current === requestId.current;
    setLoading(true);
    setError(null);
    const base = api.dba(conn.id).then((d) => { if (fresh()) setReport(d); }).catch((e: Error) => { if (fresh()) setError(e.message); });
    const deep = api
      .dbaInsights(conn.id)
      .then((d) => { if (fresh()) { setInsights(d); setInsightError(null); } })
      .catch((e: Error) => { if (fresh()) setInsightError(e.message); });
    Promise.all([base, deep]).finally(() => { if (fresh()) { setLoading(false); setSampledAt(new Date()); } });
  }, [conn?.id, isOracleLive]);

  useEffect(() => {
    load();
    return () => { requestId.current++; };
  }, [load]);
  useEffect(() => {
    if (!active || !isOracleLive || !auto) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [isOracleLive, auto, load, active]);

  const findings = useMemo<Finding[]>(() => {
    const instance = (report?.advice ?? []).filter((a) => a.severity !== "good");
    const all: Finding[] = [...instance, ...(insights?.findings ?? [])].sort(bySeverity);
    if (all.length === 0 && report?.instance)
      return [{ severity: "good", title: "No performance issues detected", detail: "Cache ratios, CPU, tablespace headroom, wait profile, workload, jobs and object health are all within thresholds." }];
    return all;
  }, [report, insights]);
  const score = healthScore(findings.map((f) => f.severity));
  const counts = findings.reduce((acc, f) => ((acc[f.severity] = (acc[f.severity] ?? 0) + 1), acc), {} as Partial<Record<InsightSeverity, number>>);

  if (!isOracleLive) {
    return (
      <EmptyState
        icon={<Gauge />}
        title="Connect to a live Oracle database"
        hint="The DBA Performance Advisor reads Oracle's dynamic performance views (V$SQLAREA, V$SYSTEM_EVENT, V$SESSION…) and the scheduler and object dictionaries. Select a live Oracle connection to analyze it."
        action={<Btn variant="outline" onClick={() => s.setWizardOpen(true)}>New Oracle connection</Btn>}
      />
    );
  }

  const Body = tab !== "overview" && insights ? AREA_PANEL[tab] : null;

  return (
    <div className="h-full overflow-y-auto df-fade">
      {/* header */}
      <div className="px-4 pt-4 pb-3 flex items-center gap-2.5 flex-wrap">
        <Gauge size={16} className="text-accent" />
        <h2 className="text-[14px] font-semibold">DBA Performance Advisor</h2>
        {report?.instance && (
          <span className="text-[12px] text-mute">
            {report.instance.dbName} · {report.instance.name} · {report.instance.version} · {report.instance.status}/{report.instance.openMode}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          {report?.instance && <span className="text-[11px] text-mute" title="Instance start time">up since {report.instance.startup}</span>}
          {sampledAt && <span className="text-[11px] text-mute" title="Last sample">sampled {sampledAt.toLocaleTimeString()}</span>}
          <label className="flex items-center gap-1.5 text-[11.5px] text-soft cursor-pointer" title="Re-sample every 60 seconds while visible">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto
          </label>
          <Btn variant="outline" onClick={load} disabled={loading} title="Re-read the performance views">
            <RefreshCcw size={12} className={loading ? "df-spin" : ""} /> Refresh
          </Btn>
        </div>
      </div>

      {loading && !report ? (
        <div className="py-20 flex justify-center"><Spinner label="Reading dynamic performance views…" /></div>
      ) : error ? (
        <div className="mx-4 border border-err/40 bg-err/8 rounded-lg p-3.5 max-w-2xl">
          <div className="flex items-center gap-2 text-err font-semibold text-[13px]"><CircleAlert size={15} /> Could not read performance data</div>
          <div className="mt-1.5 text-[12.5px] text-ink font-mono break-words">{error}</div>
        </div>
      ) : report && !report.available ? (
        <div className="mx-4 border border-warn/40 bg-warn/8 rounded-lg p-3.5 max-w-2xl">
          <div className="flex items-center gap-2 text-warn font-semibold text-[13px]"><ShieldAlert size={15} /> Insufficient privileges</div>
          <div className="mt-1.5 text-[12.5px] text-soft">{report.privilegeHint}</div>
        </div>
      ) : report ? (
        <>
          {/* hero: score + severity counts + area summary */}
          <div className="px-4">
            <div className="bg-panel border border-bdr rounded-xl p-4 flex flex-wrap items-center gap-x-8 gap-y-4">
              <HealthRing score={score} />
              <div className="flex gap-2">
                {(["critical", "serious", "warning"] as const).map((sev) => (
                  <div key={sev} className="min-w-[78px] bg-panel2 border border-bdrsoft rounded-lg px-3 py-2">
                    <div className="text-[20px] font-bold tabular-nums leading-tight" style={{ color: counts[sev] ? SEV_META[sev].color : undefined }}>{counts[sev] ?? 0}</div>
                    <div className="text-[10px] uppercase tracking-wider text-mute">{SEV_META[sev].label}</div>
                  </div>
                ))}
              </div>
              <div className="flex-1 min-w-[280px] grid grid-cols-3 gap-2">
                {TABS.filter((t): t is { id: InsightArea; label: string; icon: ReactNode } => t.id !== "overview").map((t) => {
                  const worst = findings.filter((f) => f.area === t.id).sort(bySeverity)[0];
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTab(t.id)}
                      className="flex items-center gap-2 text-left px-2.5 py-1.5 rounded-lg border border-bdrsoft hover:border-accent/50 hover:bg-accentdim transition-colors min-w-0"
                    >
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: worst ? SEV_META[worst.severity].color : "var(--viz-good)" }} aria-hidden />
                      <span className="text-[11.5px] text-soft truncate">{t.label}</span>
                      <span className="ml-auto text-[11.5px] tabular-nums text-mute">{insights ? areaCount(insights, t.id) : "…"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* tabs */}
          <div className="sticky top-0 z-10 bg-[var(--bg)] px-4 pt-3 border-b border-bdrsoft">
            <div className="flex items-center gap-1 overflow-x-auto" role="tablist">
              {TABS.map((t) => {
                const n = t.id !== "overview" && insights ? areaCount(insights, t.id) : null;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 h-8 text-[12px] whitespace-nowrap border-b-2 -mb-px transition-colors ${
                      tab === t.id ? "border-accent text-ink font-semibold" : "border-transparent text-mute hover:text-soft"
                    }`}
                  >
                    {t.icon} {t.label}
                    {n ? <span className="text-[10.5px] tabular-nums px-1.5 rounded-full bg-panel3 text-soft">{n}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="p-4 space-y-4">
            {insightError && (
              <div className="border border-warn/40 bg-warn/8 rounded-lg px-3 py-2.5 text-[12px] text-soft">
                Workload analysis failed: <span className="font-mono">{insightError}</span>
              </div>
            )}
            {tab === "overview" ? (
              <Overview report={report} insights={insights} findings={findings} onOpen={setTab} />
            ) : Body && insights ? (
              <Body data={insights} />
            ) : (
              <div className="py-16 flex justify-center"><Spinner label="Analyzing workload…" /></div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
