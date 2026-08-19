import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CircleAlert,
  CircleCheck,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Info,
  RefreshCcw,
  ShieldAlert,
  Timer,
  Users,
} from "lucide-react";
import { useStudio } from "../state/store";
import { api, type DbaAdvice, type DbaReport } from "../utils/api";
import { Badge, Btn, EmptyState, Spinner } from "./ui";

/* Charts follow the dataviz method: single-hue marks, recessive grid, values in
   text tokens, status colors reserved for the advisor severities. */

const SEV_META: Record<
  DbaAdvice["severity"],
  { tone: "ok" | "warn" | "err"; icon: React.ReactNode; label: string; color: string }
> = {
  good: { tone: "ok", icon: <CircleCheck size={14} />, label: "Healthy", color: "var(--viz-good)" },
  warning: { tone: "warn", icon: <Info size={14} />, label: "Warning", color: "var(--viz-warn)" },
  serious: { tone: "warn", icon: <AlertTriangle size={14} />, label: "Serious", color: "var(--viz-serious)" },
  critical: { tone: "err", icon: <ShieldAlert size={14} />, label: "Critical", color: "var(--viz-critical)" },
};

const METRIC_ICON: Record<string, React.ReactNode> = {
  "Buffer Cache Hit Ratio": <Database size={13} />,
  "Library Cache Hit Ratio": <Database size={13} />,
  "Host CPU Utilization (%)": <Cpu size={13} />,
  "Average Active Sessions": <Activity size={13} />,
  "Executions Per Sec": <Gauge size={13} />,
  "SQL Service Response Time": <Timer size={13} />,
};

function MetricTile({ name, value, unit }: { name: string; value: number; unit: string }) {
  const isRatio = /Ratio|Utilization/.test(name);
  const tone = isRatio
    ? name.includes("CPU")
      ? value > 85 ? "err" : value > 70 ? "warn" : "ok"
      : value < 90 ? "warn" : "ok"
    : "neutral";
  const toneColor = tone === "err" ? "text-err" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ink";
  const display = unit === "%" || isRatio ? `${value}%` : value.toLocaleString();
  return (
    <div className="bg-panel border border-bdr rounded-xl p-3.5 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-mute">
        <span className="text-accenthi">{METRIC_ICON[name] ?? <Gauge size={13} />}</span>
        <span className="truncate" title={name}>{name.replace(" (%)", "")}</span>
      </div>
      <div className={`text-[22px] font-bold leading-tight ${toneColor}`}>{display}</div>
      {!isRatio && unit && <div className="text-[11px] text-mute">{unit}</div>}
    </div>
  );
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="h-2 rounded-full bg-[var(--viz-grid)] overflow-hidden" role="img" aria-label={`${pct}%`}>
      <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: tone }} />
    </div>
  );
}

export default function DbaAdvisor() {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  const isOracleLive = !!conn?.live && conn.engine === "oracle";
  const [report, setReport] = useState<DbaReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isOracleLive || !conn) return;
    setLoading(true);
    setError(null);
    api
      .dba(conn.id)
      .then(setReport)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [conn, isOracleLive]);

  useEffect(() => {
    load();
  }, [load]);

  if (!isOracleLive) {
    return (
      <EmptyState
        icon={<Gauge />}
        title="Connect to a live Oracle database"
        hint="The DBA Performance Advisor reads Oracle's dynamic performance views (V$SYSMETRIC, V$SYSTEM_EVENT, V$SQLSTATS…). Select a live Oracle connection to see real instance metrics and tuning advice."
        action={<Btn variant="outline" onClick={() => s.setWizardOpen(true)}>New Oracle connection</Btn>}
      />
    );
  }

  const advScore = report?.advice.reduce(
    (acc, a) => {
      acc[a.severity]++;
      return acc;
    },
    { good: 0, warning: 0, serious: 0, critical: 0 } as Record<DbaAdvice["severity"], number>
  );

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 df-fade">
      {/* header */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <Gauge size={16} className="text-accent" />
        <h2 className="text-[14px] font-semibold">DBA Performance Advisor</h2>
        {report?.instance && (
          <span className="text-[12px] text-mute">
            {report.instance.dbName} · {report.instance.name} · {report.instance.version} · {report.instance.status}/{report.instance.openMode}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {report?.instance && (
            <span className="text-[11px] text-mute" title="Instance start time">up since {report.instance.startup}</span>
          )}
          <Btn variant="outline" onClick={load} disabled={loading} title="Re-read the performance views">
            <RefreshCcw size={12} className={loading ? "df-spin" : ""} /> Refresh
          </Btn>
        </div>
      </div>

      {loading && !report ? (
        <div className="py-20 flex justify-center">
          <Spinner label="Reading dynamic performance views…" />
        </div>
      ) : error ? (
        <div className="border border-err/40 bg-err/8 rounded-lg p-3.5 max-w-2xl">
          <div className="flex items-center gap-2 text-err font-semibold text-[13px]">
            <CircleAlert size={15} /> Could not read performance data
          </div>
          <div className="mt-1.5 text-[12.5px] text-ink font-mono break-words">{error}</div>
        </div>
      ) : report && !report.available ? (
        <div className="border border-warn/40 bg-warn/8 rounded-lg p-3.5 max-w-2xl">
          <div className="flex items-center gap-2 text-warn font-semibold text-[13px]">
            <ShieldAlert size={15} /> Insufficient privileges
          </div>
          <div className="mt-1.5 text-[12.5px] text-soft">{report.privilegeHint}</div>
        </div>
      ) : report ? (
        <>
          {/* advisor findings — the headline */}
          <section className="bg-panel border border-bdr rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2.5">
              <ShieldAlert size={14} className="text-accenthi" />
              <h3 className="text-[12.5px] font-semibold">Advisor findings</h3>
              {advScore && (
                <div className="ml-auto flex items-center gap-1.5">
                  {advScore.critical > 0 && <Badge tone="err">{advScore.critical} critical</Badge>}
                  {advScore.serious > 0 && <Badge tone="warn">{advScore.serious} serious</Badge>}
                  {advScore.warning > 0 && <Badge tone="warn">{advScore.warning} warning</Badge>}
                  {advScore.critical + advScore.serious + advScore.warning === 0 && <Badge tone="ok">all healthy</Badge>}
                </div>
              )}
            </div>
            <ul className="space-y-2">
              {report.advice.map((a, i) => {
                const m = SEV_META[a.severity];
                return (
                  <li key={i} className="flex items-start gap-2.5 border border-bdrsoft rounded-lg px-3 py-2">
                    <span style={{ color: m.color }} className="mt-0.5 shrink-0">{m.icon}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] font-semibold text-ink">{a.title}</span>
                        <Badge tone={m.tone}>{m.label}</Badge>
                      </div>
                      <div className="text-[12px] text-soft mt-0.5">{a.detail}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* metric tiles */}
          {report.metrics.length > 0 && (
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              {report.metrics.map((m) => (
                <MetricTile key={m.name} {...m} />
              ))}
            </div>
          )}

          <div className="grid xl:grid-cols-2 gap-4">
            {/* wait events */}
            <section className="bg-panel border border-bdr rounded-xl p-4">
              <h3 className="text-[12.5px] font-semibold mb-1">Top wait events</h3>
              <p className="text-[11.5px] text-mute mb-3">Non-idle waits since instance startup, by time waited</p>
              {report.waitEvents.length === 0 ? (
                <p className="text-[12px] text-mute py-4 text-center">No non-idle waits recorded.</p>
              ) : (
                <div className="space-y-2.5">
                  {report.waitEvents.slice(0, 8).map((w) => {
                    const max = report.waitEvents[0].timeS || 1;
                    const hot = ["Concurrency", "Contention", "Cluster"].includes(w.waitClass);
                    return (
                      <div key={w.event}>
                        <div className="flex items-center justify-between text-[11.5px] mb-1 gap-2">
                          <span className="font-mono text-soft truncate" title={`${w.event} (${w.waitClass})`}>{w.event}</span>
                          <span className="text-mute tabular-nums shrink-0">{w.timeS.toLocaleString()}s · {w.waits.toLocaleString()} waits</span>
                        </div>
                        <Bar pct={(w.timeS / max) * 100} tone={hot ? "var(--viz-serious)" : "var(--viz-1)"} />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* tablespaces */}
            <section className="bg-panel border border-bdr rounded-xl p-4">
              <h3 className="text-[12.5px] font-semibold mb-1">Tablespace usage</h3>
              <p className="text-[11.5px] text-mute mb-3">Space used vs allocated (from DBA_TABLESPACE_USAGE_METRICS)</p>
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
            </section>

            {/* top SQL */}
            <section className="bg-panel border border-bdr rounded-xl p-4 xl:col-span-2">
              <h3 className="text-[12.5px] font-semibold mb-1">Top SQL by elapsed time</h3>
              <p className="text-[11.5px] text-mute mb-2">From V$SQLSTATS — click a row to load the statement in a worksheet</p>
              {report.topSql.length === 0 ? (
                <p className="text-[12px] text-mute py-4 text-center">No SQL statistics available.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11.5px] min-w-[640px]">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wider text-mute border-b border-bdrsoft">
                        <th className="py-1.5 font-semibold">SQL ID</th>
                        <th className="py-1.5 font-semibold">Statement</th>
                        <th className="py-1.5 font-semibold text-right">Elapsed</th>
                        <th className="py-1.5 font-semibold text-right">Execs</th>
                        <th className="py-1.5 font-semibold text-right">ms/exec</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.topSql.map((q) => (
                        <tr
                          key={q.sqlId}
                          className="border-b border-bdrsoft hover:bg-accentdim cursor-pointer"
                          onClick={() => {
                            s.setSql(`-- ${q.sqlId} · ${q.elapsedS}s over ${q.executions} execs\nSELECT sql_fulltext FROM v$sqlstats WHERE sql_id = '${q.sqlId}';`);
                            s.openTab("worksheet", "Worksheet 1");
                            s.toast("info", `Loaded lookup for ${q.sqlId} — run it for the full text`);
                          }}
                          title="Load this SQL's full text in a worksheet"
                        >
                          <td className="py-1.5 font-mono text-accenthi">{q.sqlId}</td>
                          <td className="py-1.5 font-mono text-soft max-w-[380px] truncate" title={q.sqlText}>{q.sqlText}</td>
                          <td className="py-1.5 text-right tabular-nums font-semibold">{q.elapsedS.toLocaleString()}s</td>
                          <td className="py-1.5 text-right tabular-nums text-mute">{q.executions.toLocaleString()}</td>
                          <td className={`py-1.5 text-right tabular-nums ${q.perExecMs > 100 ? "text-warn font-semibold" : "text-mute"}`}>{q.perExecMs.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* sessions */}
            <section className="bg-panel border border-bdr rounded-xl p-4">
              <h3 className="text-[12.5px] font-semibold mb-2 flex items-center gap-2">
                <Users size={13} className="text-accenthi" /> Sessions
              </h3>
              <div className="flex gap-3 mb-3">
                <div className="flex-1 bg-panel2 border border-bdrsoft rounded-lg p-2.5 text-center">
                  <div className="text-[20px] font-bold text-ok tabular-nums">{report.sessions.active}</div>
                  <div className="text-[10.5px] text-mute uppercase tracking-wider">Active</div>
                </div>
                <div className="flex-1 bg-panel2 border border-bdrsoft rounded-lg p-2.5 text-center">
                  <div className="text-[20px] font-bold text-mute tabular-nums">{report.sessions.inactive}</div>
                  <div className="text-[10.5px] text-mute uppercase tracking-wider">Inactive</div>
                </div>
                <div className="flex-1 bg-panel2 border border-bdrsoft rounded-lg p-2.5 text-center">
                  <div className="text-[20px] font-bold text-ink tabular-nums">{report.sessions.total}</div>
                  <div className="text-[10.5px] text-mute uppercase tracking-wider">Total</div>
                </div>
              </div>
              {report.sessions.users.length > 0 && (
                <table className="w-full text-[11.5px]">
                  <tbody>
                    {report.sessions.users.map((u) => (
                      <tr key={u.user} className="border-b border-bdrsoft last:border-0">
                        <td className="py-1 font-mono text-soft">{u.user}</td>
                        <td className="py-1 text-right tabular-nums text-mute">{u.cnt} session{u.cnt === 1 ? "" : "s"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* memory */}
            <section className="bg-panel border border-bdr rounded-xl p-4">
              <h3 className="text-[12.5px] font-semibold mb-2 flex items-center gap-2">
                <HardDrive size={13} className="text-accenthi" /> Memory (SGA / PGA)
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-[10.5px] font-bold uppercase tracking-wider text-mute mb-1.5">SGA components</div>
                  <table className="w-full text-[11.5px]">
                    <tbody>
                      {report.sga.map((x) => (
                        <tr key={x.name} className="border-b border-bdrsoft last:border-0">
                          <td className="py-1 text-soft">{x.name.replace(" Size", "")}</td>
                          <td className="py-1 text-right tabular-nums text-mute">{x.mb.toLocaleString()} MB</td>
                        </tr>
                      ))}
                      {report.sga.length === 0 && <tr><td className="py-2 text-mute">—</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="text-[10.5px] font-bold uppercase tracking-wider text-mute mb-1.5">PGA</div>
                  <table className="w-full text-[11.5px]">
                    <tbody>
                      {report.pga.map((x) => (
                        <tr key={x.name} className="border-b border-bdrsoft last:border-0">
                          <td className="py-1 text-soft">{x.name.replace("total ", "").replace(" parameter", "")}</td>
                          <td className="py-1 text-right tabular-nums text-mute">{x.mb.toLocaleString()} MB</td>
                        </tr>
                      ))}
                      {report.pga.length === 0 && <tr><td className="py-2 text-mute">—</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
