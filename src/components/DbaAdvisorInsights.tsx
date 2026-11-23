import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  FileCode2,
  Hammer,
  ListChecks,
  Lock,
  Play,
  ScanSearch,
  Search,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useStudio } from "../state/store";
import type { DbaInsights, InsightArea, InsightSlowSql } from "../utils/api";
import {
  compileScript,
  ddlScript,
  fmtCount,
  fmtDuration,
  fmtMs,
  fullTextScript,
  gatherStatsScript,
  jobLogScript,
  mviewRefreshScript,
  planScript,
  programSqlScript,
  sessionScript,
  tuningScript,
  viewSqlScript,
} from "../utils/dbaAdvisor";
import { Badge, Btn, inputCls } from "./ui";

/* ---------------- shared building blocks ---------------- */

export function Panel({ title, hint, icon, actions, children }: { title: string; hint?: string; icon?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-panel border border-bdr rounded-xl p-4 min-w-0">
      <div className="flex items-start gap-2 mb-3">
        {icon && <span className="text-accenthi mt-0.5">{icon}</span>}
        <div className="min-w-0">
          <h3 className="text-[12.5px] font-semibold">{title}</h3>
          {hint && <p className="text-[11.5px] text-mute mt-0.5">{hint}</p>}
        </div>
        {actions && <div className="ml-auto flex items-center gap-1.5 shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-mute py-6 text-center">{children}</p>;
}

function NotVisible({ what }: { what: string }) {
  return (
    <div className="border border-warn/40 bg-warn/8 rounded-lg px-3 py-2.5 text-[12px] text-soft">
      {what} isn't visible to this user. Grant <span className="font-mono">SELECT_CATALOG_ROLE</span> (or connect as a DBA) to see it.
    </div>
  );
}

/** Thin magnitude bar — single hue, value relative to the column maximum. */
function MiniBar({ value, max, hot }: { value: number; max: number; hot?: boolean }) {
  const pct = max > 0 ? Math.max((value / max) * 100, 2) : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-[var(--viz-grid)] overflow-hidden" aria-hidden>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: hot ? "var(--viz-serious)" : "var(--viz-1)" }} />
    </div>
  );
}

function Chips<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-1 flex-wrap" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`h-6 px-2 rounded-md text-[11.5px] border transition-colors ${
            value === o.id ? "border-accent/60 bg-accentdim text-accenthi" : "border-bdrsoft text-soft hover:text-ink hover:border-bdr"
          }`}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1 text-mute tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block w-56 max-w-full">
      <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-mute pointer-events-none" />
      <input className={`${inputCls} !h-7 !pl-7 !text-[12px]`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </label>
  );
}

type SortDir = "asc" | "desc";
function useSort<K extends string>(initial: K) {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<SortDir>("desc");
  const toggle = (k: K) => {
    if (k === key) setDir(dir === "desc" ? "asc" : "desc");
    else { setKey(k); setDir("desc"); }
  };
  const apply = <T,>(rows: T[], get: (r: T, k: K) => number | string) =>
    [...rows].sort((a, b) => {
      const x = get(a, key), y = get(b, key);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return dir === "desc" ? -c : c;
    });
  return { key, dir, toggle, apply };
}

function Th<K extends string>({ k, sort, children, right }: { k?: K; sort?: { key: K; dir: SortDir; toggle: (k: K) => void }; children: ReactNode; right?: boolean }) {
  const active = k && sort?.key === k;
  return (
    <th className={`py-1.5 px-1.5 font-semibold ${right ? "text-right" : "text-left"}`} aria-sort={active ? (sort!.dir === "desc" ? "descending" : "ascending") : undefined}>
      {k && sort ? (
        <button type="button" onClick={() => sort.toggle(k)} className={`inline-flex items-center gap-0.5 uppercase tracking-wider hover:text-ink ${active ? "text-accenthi" : ""}`}>
          {children}
          {active && (sort.dir === "desc" ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

const theadCls = "text-[10px] uppercase tracking-wider text-mute border-b border-bdrsoft";
const rowCls = "border-b border-bdrsoft last:border-0 hover:bg-panel2";
const td = "py-1.5 px-1.5";

/** Opens SQL in a fresh worksheet tab so the user can review it before running anything. */
function useWorksheet() {
  const s = useStudio();
  return (sql: string, title: string) => {
    try {
      s.openSqlWorksheet(sql, title);
    } catch (e) {
      s.toast("error", (e as Error).message);
    }
  };
}

/** Objects in the connected schema open in the editor; anything else loads its DDL. */
function useOpenSource() {
  const s = useStudio();
  const ws = useWorksheet();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  const me = conn?.user.toUpperCase();
  return (owner: string, name: string, type: string) => {
    const label = type.charAt(0) + type.slice(1).toLowerCase();
    if (owner === me && type !== "MATERIALIZED VIEW") s.openTab("object", type === "VIEW" ? name : `${name} (${label})`, name);
    else ws(ddlScript(owner, name, type), `DDL: ${name}`);
  };
}

/* ---------------- Slow SQL ---------------- */

type SqlKind = "all" | "SELECT" | "DML" | "PL/SQL";
type SqlSort = "perExecMs" | "elapsedS" | "executions" | "getsPerExec" | "cpuPerExecMs" | "lastActive";
const MIN_MS = [
  { id: "0", label: "Any" },
  { id: "100", label: "≥ 100 ms" },
  { id: "1000", label: "≥ 1 s" },
  { id: "5000", label: "≥ 5 s" },
] as const;

function SqlDetail({ q }: { q: InsightSlowSql }) {
  const ws = useWorksheet();
  const stats: [string, string][] = [
    ["Elapsed / exec", fmtMs(q.perExecMs)],
    ["CPU / exec", fmtMs(q.cpuPerExecMs)],
    ["Wait share", q.perExecMs > 0 ? `${Math.max(0, Math.round((1 - q.cpuPerExecMs / q.perExecMs) * 100))}%` : "—"],
    ["Buffer gets / exec", fmtCount(q.getsPerExec)],
    ["Disk reads / exec", fmtCount(q.readsPerExec)],
    ["Rows / exec", fmtCount(q.rowsPerExec)],
    ["Plan hash", String(q.planHash || "—")],
    ["Last active", q.lastActive || "—"],
  ];
  return (
    <div className="bg-panel2 border-t border-bdrsoft px-3 py-3 space-y-3">
      <pre className="font-mono text-[11.5px] text-soft whitespace-pre-wrap break-words max-h-40 overflow-auto select-text">{q.sqlText}{q.sqlText.length >= 400 ? " …" : ""}</pre>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {stats.map(([k, v]) => (
          <div key={k} className="bg-panel border border-bdrsoft rounded-md px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-mute">{k}</div>
            <div className="text-[12.5px] font-semibold tabular-nums text-ink truncate">{v}</div>
          </div>
        ))}
      </div>
      {q.fullScans.length > 0 && (
        <div className="text-[12px] text-soft flex items-start gap-1.5">
          <ScanSearch size={13} className="text-warn mt-0.5 shrink-0" />
          <span>
            Full table scan of {q.fullScans.map((f) => `${f.owner}.${f.table} (${fmtCount(f.rows)} rows)`).join(", ")}. Check whether the filter columns are indexed.
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Btn variant="outline" onClick={() => ws(planScript(q.sqlId), `Plan: ${q.sqlId}`)}><FileCode2 size={12} /> Execution plan</Btn>
        <Btn variant="outline" onClick={() => ws(fullTextScript(q.sqlId), `SQL: ${q.sqlId}`)}><Code2 size={12} /> Full text</Btn>
        <Btn variant="outline" onClick={() => ws(tuningScript(q.sqlId), `Tune: ${q.sqlId}`)}><Sparkles size={12} /> SQL Tuning Advisor</Btn>
      </div>
    </div>
  );
}

export function SlowSqlPanel({ data }: { data: DbaInsights }) {
  const [kind, setKind] = useState<SqlKind>("all");
  const [minMs, setMinMs] = useState<string>("0");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const sort = useSort<SqlSort>("perExecMs");

  const rows = useMemo(() => {
    const t = term.trim().toLowerCase();
    const filtered = data.slowSql.filter(
      (q) =>
        (kind === "all" || q.kind === kind || (kind === "DML" && q.kind === "OTHER")) &&
        q.perExecMs >= Number(minMs) &&
        (!t || q.sqlText.toLowerCase().includes(t) || q.sqlId.includes(t) || q.schema.toLowerCase().includes(t) || q.module.toLowerCase().includes(t))
    );
    return sort.apply(filtered, (r, k) => r[k]);
  }, [data.slowSql, kind, minMs, term, sort]);
  const count = (k: SqlKind) => data.slowSql.filter((q) => k === "all" || q.kind === k).length;
  const maxPer = Math.max(...rows.map((r) => r.perExecMs), 0);

  if (!data.visible.sql) return <NotVisible what="The cursor cache (V$SQLAREA)" />;
  return (
    <Panel
      title="Slow statements"
      hint="Application SQL in the cursor cache — the top 30 by time per execution plus the top 30 by total time. Click a row for its plan, full text and tuning."
      icon={<Clock size={14} />}
    >
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Chips<SqlKind>
          value={kind}
          onChange={setKind}
          options={[
            { id: "all", label: "All", count: count("all") },
            { id: "SELECT", label: "SELECT", count: count("SELECT") },
            { id: "DML", label: "DML", count: count("DML") },
            { id: "PL/SQL", label: "PL/SQL calls", count: count("PL/SQL") },
          ]}
        />
        <span className="w-px h-5 bg-bdrsoft" />
        <Chips value={minMs} onChange={setMinMs} options={MIN_MS.map((m) => ({ id: m.id, label: m.label }))} />
        <div className="ml-auto"><SearchBox value={term} onChange={setTerm} placeholder="Filter text, SQL ID, schema…" /></div>
      </div>
      {rows.length === 0 ? (
        <Empty>No statements match these filters.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px] min-w-[860px]">
            <thead>
              <tr className={theadCls}>
                <th className="w-5" />
                <Th>SQL ID</Th>
                <Th>Statement</Th>
                <Th k="perExecMs" sort={sort} right>Per exec</Th>
                <Th k="elapsedS" sort={sort} right>Total</Th>
                <Th k="executions" sort={sort} right>Execs</Th>
                <Th k="cpuPerExecMs" sort={sort} right>CPU/exec</Th>
                <Th k="getsPerExec" sort={sort} right>Gets/exec</Th>
                <Th k="lastActive" sort={sort} right>Last active</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => {
                const isOpen = open === q.sqlId;
                return [
                  <tr key={q.sqlId} className={`${rowCls} cursor-pointer`} onClick={() => setOpen(isOpen ? null : q.sqlId)} aria-expanded={isOpen}>
                    <td className={`${td} text-mute`}>{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</td>
                    <td className={`${td} font-mono text-accenthi whitespace-nowrap`}>{q.sqlId}</td>
                    <td className={`${td} max-w-[360px]`}>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Badge tone={q.kind === "SELECT" ? "accent" : "neutral"}>{q.kind}</Badge>
                        {q.fullScans.length > 0 && <span title="Full scan of a large table"><ScanSearch size={12} className="text-warn shrink-0" /></span>}
                        <span className="font-mono text-soft truncate" title={q.sqlText}>{q.sqlText}</span>
                      </div>
                      <div className="text-[10.5px] text-mute mt-0.5 truncate">{q.schema}{q.module ? ` · ${q.module}` : ""}</div>
                    </td>
                    <td className={`${td} text-right w-32`}>
                      <div className={`tabular-nums font-semibold ${q.perExecMs >= 5000 ? "text-err" : q.perExecMs >= 1000 ? "text-warn" : "text-ink"}`}>{fmtMs(q.perExecMs)}</div>
                      <MiniBar value={q.perExecMs} max={maxPer} hot={q.perExecMs >= 1000} />
                    </td>
                    <td className={`${td} text-right tabular-nums text-soft`}>{fmtDuration(q.elapsedS)}</td>
                    <td className={`${td} text-right tabular-nums text-mute`}>{fmtCount(q.executions)}</td>
                    <td className={`${td} text-right tabular-nums text-mute`}>{fmtMs(q.cpuPerExecMs)}</td>
                    <td className={`${td} text-right tabular-nums ${q.getsPerExec >= 100_000 ? "text-warn" : "text-mute"}`}>{fmtCount(q.getsPerExec)}</td>
                    <td className={`${td} text-right tabular-nums text-mute whitespace-nowrap`}>{q.lastActive.slice(5, 16) || "—"}</td>
                  </tr>,
                  isOpen && (
                    <tr key={`${q.sqlId}-d`}>
                      <td colSpan={9} className="p-0"><SqlDetail q={q} /></td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ---------------- PL/SQL ---------------- */

type ProgSort = "elapsedS" | "cpuS" | "executions" | "statements" | "bufferGets";

export function PlsqlPanel({ data }: { data: DbaInsights }) {
  const ws = useWorksheet();
  const openSource = useOpenSource();
  const types = [...new Set(data.programs.map((p) => p.type))].sort();
  const [type, setType] = useState("all");
  const [term, setTerm] = useState("");
  const sort = useSort<ProgSort>("elapsedS");
  const rows = sort.apply(
    data.programs.filter((p) => (type === "all" || p.type === type) && (!term || `${p.owner}.${p.name}`.toLowerCase().includes(term.toLowerCase()))),
    (r, k) => r[k]
  );
  const total = data.programs.reduce((a, p) => a + p.elapsedS, 0);
  const max = Math.max(...rows.map((r) => r.elapsedS), 0);

  if (!data.visible.plsql) return <NotVisible what="The cursor cache (V$SQLAREA)" />;
  return (
    <Panel
      title="Procedures, functions, packages & triggers"
      hint="Ranked by the time spent in SQL they issue (V$SQLAREA.PROGRAM_ID). Functions called from queries show up here too — a slow function in a WHERE clause runs once per row."
      icon={<Code2 size={14} />}
    >
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Chips
          value={type}
          onChange={setType}
          options={[{ id: "all", label: "All", count: data.programs.length }, ...types.map((t) => ({ id: t, label: t.toLowerCase(), count: data.programs.filter((p) => p.type === t).length }))]}
        />
        <div className="ml-auto"><SearchBox value={term} onChange={setTerm} placeholder="Filter by name…" /></div>
      </div>
      {rows.length === 0 ? (
        <Empty>No application PL/SQL has SQL in the cursor cache right now.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px] min-w-[820px]">
            <thead>
              <tr className={theadCls}>
                <Th>Program</Th>
                <Th k="elapsedS" sort={sort} right>SQL time</Th>
                <Th right>Share</Th>
                <Th k="cpuS" sort={sort} right>CPU</Th>
                <Th k="executions" sort={sort} right>SQL execs</Th>
                <Th k="statements" sort={sort} right>Stmts</Th>
                <Th>Hot spot</Th>
                <Th right>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={`${p.owner}.${p.name}.${p.type}`} className={rowCls}>
                  <td className={td}>
                    <div className="font-mono text-ink truncate max-w-[260px]" title={`${p.owner}.${p.name}`}>{p.owner}.{p.name}</div>
                    <div className="text-[10.5px] text-mute">{p.type.toLowerCase()}{p.lastActive ? ` · last ${p.lastActive.slice(5, 16)}` : ""}</div>
                  </td>
                  <td className={`${td} text-right w-32`}>
                    <div className="tabular-nums font-semibold">{fmtDuration(p.elapsedS)}</div>
                    <MiniBar value={p.elapsedS} max={max} />
                  </td>
                  <td className={`${td} text-right tabular-nums text-mute`}>{total > 0 ? `${Math.round((p.elapsedS / total) * 100)}%` : "—"}</td>
                  <td className={`${td} text-right tabular-nums text-mute`}>{fmtDuration(p.cpuS)}</td>
                  <td className={`${td} text-right tabular-nums text-mute`}>{fmtCount(p.executions)}</td>
                  <td className={`${td} text-right tabular-nums text-mute`}>{p.statements}</td>
                  <td className={`${td} whitespace-nowrap`}>
                    {p.topSqlId ? (
                      <button type="button" className="font-mono text-accenthi hover:underline" onClick={() => ws(planScript(p.topSqlId), `Plan: ${p.topSqlId}`)} title="Execution plan of the costliest statement">
                        {p.topSqlId}
                      </button>
                    ) : "—"}
                    {p.topLine !== null && <span className="text-mute"> · line {p.topLine}</span>}
                  </td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    <Btn variant="toolbar" title="Open source" onClick={() => openSource(p.owner, p.name, p.type)}><FileCode2 size={13} /></Btn>
                    <Btn variant="toolbar" title="All statements it issues" onClick={() => ws(programSqlScript(p.owner, p.name), `SQL in ${p.name}`)}><ListChecks size={13} /></Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ---------------- Views ---------------- */

type ViewSort = "elapsedS" | "perExecMs" | "executions" | "bufferGets";

export function ViewsPanel({ data }: { data: DbaInsights }) {
  const ws = useWorksheet();
  const openSource = useOpenSource();
  const sort = useSort<ViewSort>("elapsedS");
  const rows = sort.apply(data.views, (r, k) => r[k]);
  const max = Math.max(...rows.map((r) => r.perExecMs), 0);
  return (
    <div className="space-y-4">
      {!data.visible.views ? (
        <NotVisible what="The cursor cache (V$SQLAREA / V$OBJECT_DEPENDENCY)" />
      ) : (
        <Panel
          title="Views behind expensive queries"
          hint="Cached statements grouped by the views they reference (V$OBJECT_DEPENDENCY). A statement over several views counts toward each."
          icon={<ScanSearch size={14} />}
        >
          {rows.length === 0 ? (
            <Empty>No cached statements reference application views.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px] min-w-[700px]">
                <thead>
                  <tr className={theadCls}>
                    <Th>View</Th>
                    <Th k="perExecMs" sort={sort} right>Avg / exec</Th>
                    <Th k="elapsedS" sort={sort} right>Total</Th>
                    <Th k="executions" sort={sort} right>Execs</Th>
                    <Th k="bufferGets" sort={sort} right>Buffer gets</Th>
                    <Th right>Stmts</Th>
                    <Th right>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <tr key={`${v.owner}.${v.name}`} className={rowCls}>
                      <td className={`${td} font-mono text-ink`}>{v.owner}.{v.name}</td>
                      <td className={`${td} text-right w-32`}>
                        <div className={`tabular-nums font-semibold ${v.perExecMs >= 1000 ? "text-warn" : ""}`}>{fmtMs(v.perExecMs)}</div>
                        <MiniBar value={v.perExecMs} max={max} hot={v.perExecMs >= 1000} />
                      </td>
                      <td className={`${td} text-right tabular-nums text-soft`}>{fmtDuration(v.elapsedS)}</td>
                      <td className={`${td} text-right tabular-nums text-mute`}>{fmtCount(v.executions)}</td>
                      <td className={`${td} text-right tabular-nums text-mute`}>{fmtCount(v.bufferGets)}</td>
                      <td className={`${td} text-right tabular-nums text-mute`}>{v.statements}</td>
                      <td className={`${td} text-right whitespace-nowrap`}>
                        <Btn variant="toolbar" title="Open view definition" onClick={() => openSource(v.owner, v.name, "VIEW")}><FileCode2 size={13} /></Btn>
                        <Btn variant="toolbar" title="Statements using this view" onClick={() => ws(viewSqlScript(v.owner, v.name), `SQL on ${v.name}`)}><ListChecks size={13} /></Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
      <Panel title="Materialized views needing attention" hint="Stale data or an invalid compile state (ALL_MVIEWS)." icon={<Wrench size={14} />}>
        {data.mviews.length === 0 ? (
          <Empty>All materialized views are fresh and valid.</Empty>
        ) : (
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className={theadCls}><Th>Materialized view</Th><Th>Staleness</Th><Th>Compile state</Th><Th>Last refresh</Th><Th right>Actions</Th></tr>
            </thead>
            <tbody>
              {data.mviews.map((m) => (
                <tr key={`${m.owner}.${m.name}`} className={rowCls}>
                  <td className={`${td} font-mono text-ink`}>{m.owner}.{m.name}</td>
                  <td className={td}><Badge tone={m.staleness === "FRESH" ? "ok" : "warn"}>{m.staleness}</Badge></td>
                  <td className={td}><Badge tone={m.compileState === "VALID" ? "ok" : "err"}>{m.compileState}</Badge></td>
                  <td className={`${td} text-mute tabular-nums`}>{m.lastRefresh || "never"}{m.refreshType ? ` · ${m.refreshType.toLowerCase()}` : ""}</td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    <Btn variant="toolbar" title="Refresh script" onClick={() => ws(mviewRefreshScript(m.owner, m.name), `Refresh ${m.name}`)}><Play size={13} /></Btn>
                    <Btn variant="toolbar" title="Definition" onClick={() => ws(ddlScript(m.owner, m.name, "MATERIALIZED VIEW"), `DDL: ${m.name}`)}><FileCode2 size={13} /></Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

/* ---------------- Jobs ---------------- */

type JobSort = "maxS" | "avgS" | "runs" | "failures";

export function JobsPanel({ data }: { data: DbaInsights }) {
  const s = useStudio();
  const ws = useWorksheet();
  const me = s.connections.find((c) => c.id === s.activeConnId)?.user.toUpperCase();
  const sort = useSort<JobSort>("failures");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const rows = sort.apply(
    data.jobs.filter((j) => !onlyProblems || j.failures > 0 || (j.runs >= 3 && j.maxS > j.avgS * 3 && j.maxS >= 60)),
    (r, k) => r[k]
  );
  const max = Math.max(...rows.map((r) => r.maxS), 0);
  const openLog = (owner: string, name: string) =>
    owner === me ? s.openTab("joblog", `${name} (Run Log)`, name) : ws(jobLogScript(owner, name), `Runs: ${name}`);

  if (!data.visible.jobs) return <NotVisible what="Scheduler run history" />;
  return (
    <div className="space-y-4">
      <Panel title="Running now" hint="DBMS_SCHEDULER jobs currently executing." icon={<Play size={14} />}>
        {data.runningJobs.length === 0 ? (
          <Empty>No application jobs are running.</Empty>
        ) : (
          <table className="w-full text-[11.5px]">
            <thead><tr className={theadCls}><Th>Job</Th><Th right>SID</Th><Th right>Elapsed</Th><Th right>CPU</Th></tr></thead>
            <tbody>
              {data.runningJobs.map((j) => (
                <tr key={`${j.owner}.${j.name}`} className={rowCls}>
                  <td className={`${td} font-mono text-ink`}>{j.owner}.{j.name}</td>
                  <td className={`${td} text-right tabular-nums text-mute`}>{j.sid ?? "—"}</td>
                  <td className={`${td} text-right tabular-nums ${j.elapsedS >= 3600 ? "text-warn font-semibold" : ""}`}>{fmtDuration(j.elapsedS)}</td>
                  <td className={`${td} text-right tabular-nums text-mute`}>{fmtDuration(j.cpuS)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel
        title="Run history — last 7 days"
        hint="Failures first, then by longest run. Erratic = the longest run took 3× the average."
        icon={<Clock size={14} />}
        actions={
          <label className="flex items-center gap-1.5 text-[11.5px] text-soft cursor-pointer">
            <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Problems only
          </label>
        }
      >
        {rows.length === 0 ? (
          <Empty>{data.jobs.length ? "No failing or erratic jobs." : "No scheduler runs in the last 7 days."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11.5px] min-w-[760px]">
              <thead>
                <tr className={theadCls}>
                  <Th>Job</Th>
                  <Th k="runs" sort={sort} right>Runs</Th>
                  <Th k="failures" sort={sort} right>Failed</Th>
                  <Th k="avgS" sort={sort} right>Avg</Th>
                  <Th k="maxS" sort={sort} right>Longest</Th>
                  <Th>Last run</Th>
                  <Th right>Log</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => {
                  const erratic = j.runs >= 3 && j.maxS >= 60 && j.maxS > j.avgS * 3;
                  return (
                    <tr key={`${j.owner}.${j.name}`} className={rowCls}>
                      <td className={td}>
                        <div className="font-mono text-ink">{j.owner}.{j.name}</div>
                        {j.lastError && <div className="text-[10.5px] text-err truncate max-w-[340px]" title={j.lastError}>{j.lastError}</div>}
                      </td>
                      <td className={`${td} text-right tabular-nums text-mute`}>{j.runs}</td>
                      <td className={`${td} text-right tabular-nums ${j.failures ? "text-err font-semibold" : "text-mute"}`}>{j.failures}</td>
                      <td className={`${td} text-right tabular-nums text-mute`}>{fmtDuration(j.avgS)}</td>
                      <td className={`${td} text-right w-32`}>
                        <div className={`tabular-nums font-semibold ${erratic ? "text-warn" : ""}`}>{fmtDuration(j.maxS)}</div>
                        <MiniBar value={j.maxS} max={max} hot={erratic} />
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        <Badge tone={j.lastStatus === "SUCCEEDED" ? "ok" : j.lastStatus ? "err" : "neutral"}>{j.lastStatus || "—"}</Badge>
                        <span className="text-mute ml-1.5 tabular-nums">{j.lastStart.slice(5)}</span>
                      </td>
                      <td className={`${td} text-right`}>
                        <Btn variant="toolbar" title="Run log" onClick={() => openLog(j.owner, j.name)}><ListChecks size={13} /></Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ---------------- Sessions & locks ---------------- */

export function SessionsPanel({ data }: { data: DbaInsights }) {
  const ws = useWorksheet();
  const blockers = new Set(data.activeSessions.map((x) => x.blockingSid).filter((x): x is number => x !== null));
  const max = Math.max(...data.activeSessions.map((x) => x.seconds), 0);
  if (!data.visible.sessions) return <NotVisible what="V$SESSION" />;
  return (
    <div className="space-y-4">
      <Panel title="Blocked & long-running calls" hint="Sessions waiting on another session's lock, and active calls running ≥ 5 s." icon={<Lock size={14} />}>
        {data.activeSessions.length === 0 ? (
          <Empty>No blocked sessions and no long-running active calls.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11.5px] min-w-[760px]">
              <thead>
                <tr className={theadCls}><Th>SID</Th><Th>User</Th><Th>SQL ID</Th><Th>Waiting on</Th><Th>Blocked by</Th><Th right>In call</Th><Th right>Inspect</Th></tr>
              </thead>
              <tbody>
                {data.activeSessions.map((x) => (
                  <tr key={`${x.sid}.${x.serial}`} className={rowCls}>
                    <td className={`${td} tabular-nums font-mono`}>
                      {x.sid}
                      {blockers.has(x.sid) && <Badge tone="err">blocker</Badge>}
                    </td>
                    <td className={td}><div className="font-mono text-ink">{x.user}</div>{x.module && <div className="text-[10.5px] text-mute truncate max-w-[180px]">{x.module}</div>}</td>
                    <td className={td}>
                      {x.sqlId ? <button type="button" className="font-mono text-accenthi hover:underline" onClick={() => ws(planScript(x.sqlId), `Plan: ${x.sqlId}`)}>{x.sqlId}</button> : <span className="text-mute">—</span>}
                    </td>
                    <td className={`${td} text-soft truncate max-w-[220px]`} title={`${x.event} (${x.waitClass})`}>{x.event || "—"}</td>
                    <td className={td}>{x.blockingSid !== null ? <Badge tone="err">SID {x.blockingSid}</Badge> : <span className="text-mute">—</span>}</td>
                    <td className={`${td} text-right w-28`}>
                      <div className={`tabular-nums font-semibold ${x.blockingSid !== null || x.seconds >= 600 ? "text-warn" : ""}`}>{fmtDuration(x.seconds)}</div>
                      <MiniBar value={x.seconds} max={max} hot={x.blockingSid !== null} />
                    </td>
                    <td className={`${td} text-right`}>
                      <Btn variant="toolbar" title="Session detail and kill script" onClick={() => ws(sessionScript(x.sid, x.serial), `SID ${x.sid}`)}><ScanSearch size={13} /></Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Long operations in progress" hint="Full scans, sorts, backups and stats gathering that report progress (V$SESSION_LONGOPS)." icon={<Clock size={14} />}>
        {data.longOps.length === 0 ? (
          <Empty>No long operations are in progress.</Empty>
        ) : (
          <div className="space-y-3">
            {data.longOps.map((o, i) => (
              <div key={`${o.sid}-${i}`}>
                <div className="flex items-center justify-between gap-2 text-[11.5px] mb-1">
                  <span className="truncate">
                    <span className="text-ink font-medium">{o.operation}</span>
                    {o.target && <span className="font-mono text-soft"> · {o.target}</span>}
                    <span className="text-mute"> · SID {o.sid} {o.user}</span>
                  </span>
                  <span className="text-mute tabular-nums shrink-0">{o.pct}% · {fmtDuration(o.elapsedS)} elapsed · ~{fmtDuration(o.remainingS)} left</span>
                </div>
                <MiniBar value={o.pct} max={100} />
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ---------------- Object health ---------------- */

export function ObjectsPanel({ data }: { data: DbaInsights }) {
  const s = useStudio();
  const ws = useWorksheet();
  const me = s.connections.find((c) => c.id === s.activeConnId)?.user.toUpperCase();
  const mine = data.invalidObjects.filter((o) => o.owner === me);
  return (
    <div className="grid xl:grid-cols-2 gap-4">
      <Panel
        title="Invalid objects"
        hint="Invalid views and PL/SQL fail or recompile on first use."
        icon={<Hammer size={14} />}
        actions={
          data.invalidObjects.length > 0 && (
            <>
              {mine.length > 0 && <Btn variant="outline" onClick={() => s.openTab("compile", "Compile invalid", "schema")} title="Compile the invalid objects in your schema"><Hammer size={12} /> Compile mine</Btn>}
              <Btn variant="outline" onClick={() => ws(compileScript(data.invalidObjects), "Recompile invalid")} title="Open an ALTER … COMPILE script for all of them"><FileCode2 size={12} /> Script</Btn>
            </>
          )
        }
      >
        {data.invalidObjects.length === 0 ? (
          <Empty>No invalid application objects.</Empty>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full text-[11.5px]">
              <thead className="sticky top-0 bg-panel"><tr className={theadCls}><Th>Object</Th><Th>Type</Th><Th right>Last DDL</Th></tr></thead>
              <tbody>
                {data.invalidObjects.map((o) => (
                  <tr key={`${o.owner}.${o.name}.${o.type}`} className={rowCls}>
                    <td className={`${td} font-mono text-ink truncate max-w-[260px]`} title={`${o.owner}.${o.name}`}>{o.owner}.{o.name}</td>
                    <td className={`${td} text-soft`}>{o.type.toLowerCase()}</td>
                    <td className={`${td} text-right tabular-nums text-mute`}>{o.lastDdl}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel
        title="Stale or missing optimizer statistics"
        hint="Largest tables first. Wrong row estimates are a common cause of sudden plan changes."
        icon={<ScanSearch size={14} />}
        actions={
          data.staleStats.length > 0 && (
            <Btn variant="outline" onClick={() => ws(gatherStatsScript(data.staleStats.slice(0, 20)), "Gather stats")} title="Open a DBMS_STATS script for the 20 largest"><FileCode2 size={12} /> Gather script</Btn>
          )
        }
      >
        {data.staleStats.length === 0 ? (
          <Empty>Optimizer statistics are current.</Empty>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full text-[11.5px]">
              <thead className="sticky top-0 bg-panel"><tr className={theadCls}><Th>Table</Th><Th right>Rows (last known)</Th><Th>Status</Th><Th right>Analyzed</Th></tr></thead>
              <tbody>
                {data.staleStats.map((t) => (
                  <tr key={`${t.owner}.${t.table}`} className={rowCls}>
                    <td className={`${td} font-mono text-ink truncate max-w-[240px]`} title={`${t.owner}.${t.table}`}>{t.owner}.{t.table}</td>
                    <td className={`${td} text-right tabular-nums text-soft`}>{t.rows === null ? "—" : fmtCount(t.rows)}</td>
                    <td className={td}><Badge tone={t.reason === "stale" ? "warn" : "neutral"}>{t.reason}</Badge></td>
                    <td className={`${td} text-right tabular-nums text-mute`}>{t.lastAnalyzed || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

export const AREA_PANEL: Record<InsightArea, (p: { data: DbaInsights }) => ReactNode> = {
  sql: SlowSqlPanel,
  plsql: PlsqlPanel,
  views: ViewsPanel,
  jobs: JobsPanel,
  sessions: SessionsPanel,
  objects: ObjectsPanel,
};
