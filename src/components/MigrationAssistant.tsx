import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Copy, Diff, EyeOff, GitCompareArrows, PencilLine, PlusCircle, ShieldAlert, XCircle } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type ApplyStmtResult, type ApplyTableResult, type TableMeta } from "../utils/api";
import { compareTables, type TableComparison } from "../utils/tableCompare";
import { tokenize } from "../utils/sql";
import ObjectCopy from "./ObjectCopy";
import TableDataCopy from "./TableDataCopy";
import { Btn, Badge, Spinner } from "./ui";

const CLS: Record<string, string> = {
  kw: "text-[var(--syn-kw)] font-semibold", fn: "text-[var(--syn-fn)]", str: "text-[var(--syn-str)]",
  num: "text-[var(--syn-num)]", cmt: "text-[var(--syn-cmt)] italic", op: "text-[var(--syn-op)]", ident: "", ws: "",
};

/** Safety cap on source tables compared. High on purpose: a table cut off here cannot be
 *  selected, so every foreign key pointing at it would fail in the target. */
const MAX_TABLES = 5000;
/** Metadata fetches to run at once — matches the server's poolMax of 4 per connection,
 *  so this never queues more requests than the pool can serve at once. */
const CONCURRENCY = 4;

/**
 * The two things you can do between a pair of connections.
 *
 * `compare` is the surgical one: what differs between these two schemas, table by table, as a
 * script you read before it runs. `copy` is the wholesale one: put the source's objects of one
 * type into the target, whether or not anything of that type is there yet. They share this tab,
 * and its source and target pickers, because they are the same question at two different sizes
 * and whoever wants one regularly wants the other.
 */
type Mode = "compare" | "copy" | "data";

type TableStatus = "new" | "changed" | "same";
interface TableResult {
  name: string;
  status: TableStatus;
  cmp: TableComparison;
  /** sequences the table's column defaults call (`SEQ.NEXTVAL`) that the target doesn't have yet */
  missingSequences: string[];
}
interface CompareOutcome {
  results: TableResult[];
  /** CREATE SEQUENCE statements for `missingSequences`, keyed by sequence name */
  sequenceDdl: Record<string, string>;
  /** upper-cased names of every table already in the target */
  targetTables: string[];
  targetOnly: string[];
  truncated: boolean;
}

/** What the last "Apply to target" did — kept on screen so a failure can be read, not just toasted. */
interface ApplyReport {
  at: string;
  source: string;
  target: string;
  total: number;
  applied: number;
  failures: ApplyStmtResult[];
  /** every statement the server attempted, in order */
  results: ApplyStmtResult[];
  /** statements never attempted because the run stopped at the first error */
  notRun: string[];
  skipped: number;
  /** the run gave up at a privilege error — with what to do about it */
  stopped?: ApplyTableResult["stopped"];
}

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** A statement the user chose never to run against a given target (e.g. an index the target cannot hold). */
interface IgnoredStatement {
  sql: string;
  /** why it was ignored — the Oracle error it failed with, when it came from a failed run */
  reason: string;
  at: string;
}
const IGNORED_KEY = "dataforge.migration.ignored";
/** Identity of a statement for the ignore list: whitespace and the trailing `;` do not matter. */
const stmtKey = (sql: string) => oneLine(sql).replace(/;$/, "").trim();

/** Ignore lists are kept per target connection name, so they survive reloads and backend restarts. */
function loadIgnored(): Record<string, IgnoredStatement[]> {
  try {
    const v = JSON.parse(localStorage.getItem(IGNORED_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The whole run as plain text — what "Copy log" and "Download log" hand over. */
function logText(r: ApplyReport): string {
  const n = (i: number) => String(i + 1).padStart(4, "0");
  const lines = [
    `# Oracle DataForge migration log`,
    `# ${r.source} -> ${r.target}`,
    `# ${r.at}`,
    `# ${r.applied}/${r.total} applied, ${r.failures.length} failed, ${r.skipped} not run`,
    ...(r.stopped ? [`# STOPPED on insufficient privileges: ${oneLine(r.stopped.sql).slice(0, 200)}`, `# Fix: ${r.stopped.advice}${r.stopped.fix ? ` ${r.stopped.fix}` : ""}`] : []),
    "",
  ];
  r.results.forEach((x, i) => {
    lines.push(`[${n(i)}] ${x.ok ? "OK  " : "FAIL"} ${String(x.ms ?? 0).padStart(6)} ms  ${oneLine(x.sql)}`);
    if (!x.ok) lines.push(`       ${x.error ?? "error"}`);
  });
  r.notRun.forEach((sql, i) => lines.push(`[${n(r.results.length + i)}] SKIP            ${oneLine(sql)}`));
  return lines.join("\n") + "\n";
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Sequence names called by `SEQ.NEXTVAL` in a column default (a schema qualifier is dropped). */
const sequencesIn = (defaults: (string | null | undefined)[]): string[] => {
  const out = new Set<string>();
  for (const d of defaults) {
    for (const m of (d ?? "").matchAll(/(?:"?[A-Za-z0-9_$#]+"?\s*\.\s*)?"?([A-Za-z0-9_$#]+)"?\s*\.\s*NEXTVAL\b/gi)) out.add(m[1].toUpperCase());
  }
  return [...out];
};

const sequenceStatements = (picked: TableResult[], ddl: Record<string, string>) =>
  [...new Set(picked.flatMap((r) => r.missingSequences))].map((q) => ddl[q]).filter((d): d is string => !!d);

const isForeignKey = (sql: string) => /^\s*ALTER\s+TABLE\b[\s\S]*\bFOREIGN\s+KEY\b/i.test(sql);

export default function MigrationAssistant() {
  const s = useStudio();
  const oracleConns = useMemo(() => s.connections.filter((c) => c.engine === "oracle"), [s.connections]);

  const [mode, setMode] = useState<Mode>("compare");
  const [sourceId, setSourceId] = useState(() => oracleConns[0]?.id ?? "");
  const [targetId, setTargetId] = useState(() => oracleConns[1]?.id ?? oracleConns[0]?.id ?? "");
  const [phase, setPhase] = useState<"setup" | "comparing" | "results">("setup");
  const [outcome, setOutcome] = useState<CompareOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [filter, setFilter] = useState("");
  const [continueOnError, setContinueOnError] = useState(true);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [showFullLog, setShowFullLog] = useState(false);
  const [ignoredAll, setIgnoredAll] = useState<Record<string, IgnoredStatement[]>>(loadIgnored);
  const [showIgnored, setShowIgnored] = useState(false);
  // Copy objects can un-ignore a statement from its side; pick that up instead of overwriting it
  useEffect(() => {
    const sync = () => setIgnoredAll(loadIgnored());
    window.addEventListener(IGNORED_KEY, sync);
    return () => window.removeEventListener(IGNORED_KEY, sync);
  }, []);

  const sourceName = oracleConns.find((c) => c.id === sourceId)?.name ?? "—";
  const targetName = oracleConns.find((c) => c.id === targetId)?.name ?? "—";

  const ignored = useMemo(() => ignoredAll[targetName] ?? [], [ignoredAll, targetName]);
  const setIgnored = (next: IgnoredStatement[]) =>
    setIgnoredAll((all) => {
      const out = { ...all, [targetName]: next };
      if (!next.length) delete out[targetName];
      try { localStorage.setItem(IGNORED_KEY, JSON.stringify(out)); } catch { /* session-only if storage is unavailable */ }
      return out;
    });
  const ignore = (items: { sql: string; reason: string }[]) => {
    const have = new Set(ignored.map((x) => stmtKey(x.sql)));
    const add = items.filter((x) => !have.has(stmtKey(x.sql)) && have.add(stmtKey(x.sql)));
    if (!add.length) return;
    setIgnored([...ignored, ...add.map((x) => ({ sql: stmtKey(x.sql), reason: oneLine(x.reason), at: new Date().toISOString() }))]);
    s.toast("info", `${add.length} statement(s) will be ignored for ${targetName}`);
  };

  // Ignored statements are taken out of every table's script; a table left with nothing to run
  // counts as in sync, so it stops showing up as a difference on every compare.
  const results = useMemo(() => {
    if (!outcome) return [] as TableResult[];
    if (!ignored.length) return outcome.results;
    const skip = new Set(ignored.map((x) => stmtKey(x.sql)));
    return outcome.results.map((r) => {
      const sync = r.cmp.sync.filter((x) => !skip.has(stmtKey(x)));
      if (sync.length === r.cmp.sync.length) return r;
      return { ...r, cmp: { ...r.cmp, sync }, status: sync.length ? r.status : ("same" as TableStatus) };
    });
  }, [outcome, ignored]);
  /** ignored statements the current compare would otherwise have run */
  const ignoredActive = useMemo(() => {
    const live = new Set((outcome?.results ?? []).flatMap((r) => r.cmp.sync.map(stmtKey)));
    return ignored.filter((x) => live.has(stmtKey(x.sql))).length;
  }, [outcome, ignored]);

  const actionable = results.filter((r) => r.status !== "same");
  const needle = filter.trim().toUpperCase();
  const visible = needle ? actionable.filter((r) => r.name.toUpperCase().includes(needle)) : actionable;
  const inSync = results.filter((r) => r.status === "same").length;

  const script = useMemo(() => {
    if (!outcome) return "";
    const picked = actionable.filter((r) => selected.has(r.name));
    if (!picked.length) return "";
    const header = `-- Migration: ${sourceName} -> ${targetName}\n-- Generated by Oracle DataForge on ${new Date().toISOString().slice(0, 10)}\n-- ${picked.length} of ${actionable.length} object(s) selected\n`;
    const body = picked
      .map((r) => `-- Table: ${r.name} (${r.status === "new" ? "create in target" : "structural drift"})\n${r.cmp.sync.filter((x) => !isForeignKey(x)).join("\n")}`)
      .join("\n\n");
    const seqs = sequenceStatements(picked, outcome.sequenceDdl);
    const fks = picked.flatMap((r) => r.cmp.sync.filter(isForeignKey));
    return `${header}${seqs.length ? `\n-- Sequences (referenced by column defaults)\n${seqs.join("\n")}\n` : ""}\n${body}${fks.length ? `\n\n-- Foreign keys (after all tables exist)\n${fks.join("\n")}` : ""}`;
  }, [outcome, actionable, selected, sourceName, targetName]);

  /** Problems worth knowing before Apply: things the selected script depends on but will not find. */
  const warnings = useMemo(() => {
    if (!outcome) return [] as string[];
    const out: string[] = [];
    const picked = actionable.filter((r) => selected.has(r.name));
    const available = new Set([...outcome.targetTables, ...picked.filter((r) => r.status === "new").map((r) => r.name.toUpperCase())]);
    const orphans = new Map<string, string[]>();
    for (const r of picked) {
      for (const d of r.cmp.constraints) {
        const ref = d.status === "sourceOnly" && d.source?.type === "R" ? (d.source.refTable ?? "").toUpperCase() : "";
        if (ref && !available.has(ref)) orphans.set(ref, [...(orphans.get(ref) ?? []), r.name]);
      }
    }
    for (const [ref, users] of orphans) {
      out.push(`${ref} is not in the target and not selected — foreign key(s) from ${users.slice(0, 4).join(", ")}${users.length > 4 ? "…" : ""} will fail. Select ${ref} too.`);
    }
    const noDdl = [...new Set(picked.flatMap((r) => r.missingSequences))].filter((q) => !outcome.sequenceDdl[q]);
    if (noDdl.length) out.push(`Sequence(s) ${noDdl.join(", ")} are used by column defaults but could not be read from the source — create them in the target first.`);
    for (const r of picked) if (r.status !== "new") out.push(...r.cmp.notes.filter((n) => !/not synced\)\.$/.test(n)));
    return out;
  }, [outcome, actionable, selected]);

  const runCompare = async (keepReport = false) => {
    if (!keepReport) setReport(null);
    setError(null);
    setPhase("comparing");
    setOutcome(null);
    try {
      const [srcSchema, tgtSchema] = await Promise.all([api.schema(sourceId), api.schema(targetId)]);
      const targetSequences = new Set(
        (tgtSchema.extras ?? []).filter((g) => g.kind === "sequence").flatMap((g) => g.items.map((i) => i.toUpperCase()))
      );
      const targetTables = new Set(tgtSchema.tables.map((t) => t.name.toUpperCase()));
      const allSource = srcSchema.tables.map((t) => t.name);
      const truncated = allSource.length > MAX_TABLES;
      const sourceTables = allSource.slice(0, MAX_TABLES);

      setProgress({ done: 0, total: sourceTables.length });
      const results = await mapLimit(sourceTables, CONCURRENCY, async (name): Promise<TableResult> => {
        // A table the target does not have needs no round trip to learn that.
        const [srcMeta, tgtMeta] = await Promise.all([
          api.tableMeta(sourceId, name),
          targetTables.has(name.toUpperCase())
            ? api.tableMeta(targetId, name)
            : Promise.resolve<TableMeta>({ name, engine: "oracle", exists: false, columns: [], primaryKey: null, tableComment: null, indexes: [], constraints: [] }),
        ]);
        const cmp = compareTables(srcMeta, tgtMeta);
        const status: TableStatus = !tgtMeta.exists ? "new" : cmp.identical ? "same" : "changed";
        // Only columns that are being created need their sequence to exist before the DDL runs.
        const needed = !tgtMeta.exists ? srcMeta.columns : cmp.columns.filter((c) => c.status === "sourceOnly" || c.status === "changed").map((c) => c.source!);
        const missingSequences = status === "same" ? [] : sequencesIn(needed.map((c) => c.dataDefault)).filter((q) => !targetSequences.has(q));
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        return { name, status, cmp, missingSequences };
      });

      const sequenceDdl: Record<string, string> = {};
      for (const q of new Set(results.flatMap((r) => r.missingSequences))) {
        try {
          const src = (await api.source(sourceId, q, "SEQUENCE")).source ?? "";
          const owner = srcSchema.schemaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const ddl = src
            .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")
            .replace(new RegExp(`"?${owner}"?\\.`, "gi"), "")
            .trim();
          if (ddl) sequenceDdl[q] = /;\s*$/.test(ddl) ? ddl : `${ddl};`;
        } catch { /* left out: the migration then fails on that default, naming the sequence */ }
      }

      const sourceSet = new Set(sourceTables.map((t) => t.toUpperCase()));
      const targetOnly = tgtSchema.tables.map((t) => t.name).filter((n) => !sourceSet.has(n.toUpperCase()));

      setOutcome({ results, sequenceDdl, targetTables: [...targetTables], targetOnly, truncated });
      setSelected(new Set(results.filter((r) => r.status !== "same").map((r) => r.name)));
      setPhase("results");
    } catch (e) {
      setError((e as Error).message);
      setPhase("setup");
    } finally {
      setProgress(null);
    }
  };

  const toggle = (name: string) =>
    setSelected((sel) => {
      const n = new Set(sel);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  // Foreign keys run last so a parent table created later in the batch already exists (ORA-00942).
  const pickedStatements = () => {
    const picked = actionable.filter((r) => selected.has(r.name));
    const all = picked.flatMap((r) => r.cmp.sync);
    return [...sequenceStatements(picked, outcome?.sequenceDdl ?? {}), ...all.filter((x) => !isForeignKey(x)), ...all.filter(isForeignKey)];
  };

  const apply = () => {
    const statements = pickedStatements();
    const creates = actionable.filter((r) => selected.has(r.name) && r.status === "new").length;
    const drops = actionable.filter((r) => selected.has(r.name)).reduce((n, r) => n + r.cmp.sync.filter((x) => /\bDROP\b/i.test(x)).length, 0);
    s.askConfirm({
      title: `Apply migration to ${targetName}?`,
      body:
        `${statements.length} statement(s) across ${selected.size} table(s) will run against ${targetName}.` +
        (creates ? ` ${creates} new table(s) will be created.` : "") +
        (continueOnError ? " Failed statements will be skipped and reported; the rest still run." : " The run stops at the first error.") +
        (drops ? ` ⚠ Includes ${drops} column/index DROP(s) that permanently remove data or objects.` : " No destructive statements selected."),
      confirmLabel: "Apply migration",
      danger: drops > 0,
      onConfirm: async () => {
        setApplying(true);
        try {
          const res = await api.applyTableDdl(targetId, statements, true, continueOnError);
          const failures = res.results.filter((r) => !r.ok);
          setShowFullLog(false);
          setReport({
            at: new Date().toISOString(), source: sourceName, target: targetName,
            total: statements.length, applied: res.applied, failures, results: res.results,
            notRun: statements.slice(res.results.length), skipped: statements.length - res.results.length,
            stopped: res.stopped,
          });
          if (res.stopped) {
            s.toast("error", `Migration stopped after ${res.applied}/${statements.length}: insufficient privileges — see how to fix it in the report`);
          } else if (res.failed) {
            s.toast("error", continueOnError
              ? `Migration finished with ${failures.length} failed statement(s) — ${res.applied}/${statements.length} applied`
              : `Migration stopped after ${res.applied}/${statements.length}: ${failures[0]?.error ?? "error"}`);
          } else {
            s.toast("success", `Migration applied to ${targetName} — ${res.applied} statement(s)`);
          }
          // DDL auto-commits, so even a failed run changed the target: refresh it and re-diff, so
          // a retry only carries what is still missing instead of re-running what already applied.
          if (res.applied > 0) {
            if (targetId === s.activeConnId) s.bumpSchema();
            await runCompare(true);
          }
        } catch (e) {
          s.toast("error", `Apply failed: ${(e as Error).message}`);
        } finally {
          setApplying(false);
        }
      },
    });
  };

  if (oracleConns.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-center text-mute text-[12.5px]">
        Schema comparison needs a live Oracle connection. Create one in the sidebar first.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 df-fade">
      <div className="flex items-center gap-2 mb-2">
        <GitCompareArrows size={16} className="text-accent" />
        <h2 className="text-[14px] font-semibold">Schema compare &amp; migration</h2>
      </div>

      {/* what to do between the two connections */}
      <div className="inline-flex rounded-md border border-bdr overflow-hidden mb-3" role="tablist" aria-label="Migration mode">
        {([
          { id: "compare", label: "Compare tables", icon: <Diff size={12} /> },
          { id: "copy", label: "Copy objects", icon: <Copy size={12} /> },
          { id: "data", label: "Copy table data", icon: <Copy size={12} /> },
        ] as const).map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            onClick={() => setMode(m.id)}
            className={`flex items-center gap-1.5 px-3 h-7 text-[12px] font-medium transition-colors ${
              mode === m.id ? "bg-accent text-white" : "text-soft hover:text-ink hover:bg-panel3"
            }`}
          >
            {m.icon}
            {m.label}
          </button>
        ))}
      </div>

      {mode === "compare" && (
        <p className="text-[11.5px] text-mute mb-4">
          Compares every table in the source schema against the target and builds an ordered script that brings the target in line — Oracle connections, tables only (columns, indexes, constraints, comments).
        </p>
      )}

      {/* source/target picker — shared by both modes */}
      <div className="flex items-end gap-3 flex-wrap mb-4">
        <label className="block">
          <div className="text-[11px] font-semibold text-soft mb-1 uppercase tracking-wider">Source (reference)</div>
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Source connection" className="h-8 px-2 rounded-md bg-panel2 border border-bdr text-[12.5px] focus:border-accent focus:outline-none min-w-56">
            {oracleConns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <ArrowRight size={16} className="text-mute mb-2" />
        <label className="block">
          <div className="text-[11px] font-semibold text-soft mb-1 uppercase tracking-wider">Target (to be updated)</div>
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label="Target connection" className="h-8 px-2 rounded-md bg-panel2 border border-bdr text-[12.5px] focus:border-accent focus:outline-none min-w-56">
            {oracleConns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {mode === "compare" && (
          <Btn variant="primary" onClick={() => runCompare()} className="mb-0.5" disabled={phase === "comparing" || sourceId === targetId} title={sourceId === targetId ? "Pick two different connections" : "Compare schemas"}>
            <Diff size={13} /> Compare schemas
          </Btn>
        )}
      </div>

      {sourceId === targetId && (
        <div className="border border-warn/40 bg-warn/8 rounded-lg p-3 text-[12.5px] text-ink mb-4">
          Source and target are the same connection — pick two different ones.
        </div>
      )}

      {mode === "copy" && sourceId !== targetId && <ObjectCopy key={`${sourceId}>${targetId}`} sourceId={sourceId} targetId={targetId} />}
      {mode === "data" && <TableDataCopy key={`${sourceId}>${targetId}`} sourceId={sourceId} targetId={targetId} />}

      {mode === "compare" && error && (
        <div className="border border-err/40 bg-err/8 rounded-lg p-3 text-[12.5px] text-ink mb-4">
          <span className="text-err font-semibold">Compare failed:</span> {error}
        </div>
      )}

      {mode === "compare" && phase === "comparing" && (
        <div className="py-16 flex justify-center">
          <Spinner label={`Comparing tables in ${sourceName} against ${targetName}…${progress?.total ? ` ${progress.done}/${progress.total}` : ""}`} />
        </div>
      )}

      {mode === "compare" && phase === "results" && outcome && (
        <div className="df-fade">
          {report && (
            <div className={`border rounded-lg p-3 mb-4 text-[12.5px] ${report.failures.length ? "border-err/40 bg-err/8" : "border-ok/40 bg-ok/8"}`}>
              <div className="flex items-start gap-2">
                {report.failures.length ? <XCircle size={15} className="text-err shrink-0 mt-0.5" /> : <CheckCircle2 size={15} className="text-ok shrink-0 mt-0.5" />}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-ink">
                    Last apply: {report.applied}/{report.total} statement(s) applied
                    {report.failures.length ? ` · ${report.failures.length} failed` : ""}
                    {report.skipped ? ` · ${report.skipped} not run` : ""}
                  </div>
                  <div className="mt-2 flex gap-2 flex-wrap">
                    <Btn variant="outline" onClick={() => setShowFullLog((v) => !v)}>{showFullLog ? "Hide full log" : "Show full log"}</Btn>
                    <Btn variant="outline" onClick={() => { navigator.clipboard?.writeText(logText(report)).then(() => s.toast("success", "Migration log copied"), () => s.toast("error", "Could not copy — use Download log")); }}>Copy log</Btn>
                    <Btn variant="outline" onClick={() => {
                      const url = URL.createObjectURL(new Blob([logText(report)], { type: "text/plain" }));
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `migration-${report.at.replace(/[:.]/g, "-")}.log`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}>Download log</Btn>
                    {report.failures.length > 0 && (
                      <Btn variant="outline" onClick={() => {
                        s.setSql(report.failures.map((f) => `-- ${oneLine(f.error ?? "error")}\n${f.sql};`).join("\n\n"));
                        s.openTab("worksheet", "Worksheet 1");
                        s.toast("info", "Failed statements loaded in worksheet");
                      }}>Open failed in worksheet</Btn>
                    )}
                    {report.failures.some((f) => !ignored.some((x) => stmtKey(x.sql) === stmtKey(f.sql))) && (
                      <Btn variant="outline" onClick={() => ignore(report.failures.map((f) => ({ sql: f.sql, reason: f.error ?? "error" })))} title="Never run these statements against this target again">Ignore all failed</Btn>
                    )}
                  </div>
                  {report.stopped && (
                    <div className="mt-2 border border-err/40 bg-panel2 rounded-lg p-3 flex items-start gap-2.5">
                      <ShieldAlert size={15} className="text-err shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <div className="font-semibold text-ink">Stopped at the first privilege error — the remaining statements were not run</div>
                        <div className="text-[11.5px] text-err mt-0.5 break-words">{report.stopped.error}</div>
                        <div className="text-[12px] text-ink mt-2"><b>How to fix:</b> {report.stopped.advice}</div>
                        {report.stopped.fix && (
                          <div className="mt-2 flex items-center gap-2 flex-wrap">
                            <pre className="font-mono text-[12px] bg-panel3 border border-bdr rounded px-2 py-1">{report.stopped.fix}</pre>
                            <Btn variant="outline" onClick={() => { navigator.clipboard?.writeText(report.stopped!.fix!).then(() => s.toast("success", "Grant copied"), () => s.toast("error", "Could not copy")); }}>Copy</Btn>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {showFullLog && (
                    <pre className="mt-2 font-mono text-[11px] leading-5 whitespace-pre overflow-auto p-2 bg-panel2 border border-bdr rounded max-h-72">{logText(report)}</pre>
                  )}
                  {report.failures.length > 0 && (
                    <>
                      <ul className="mt-2 space-y-2 max-h-56 overflow-auto">
                        {report.failures.map((f, i) => (
                          <li key={i} className="min-w-0">
                            <pre className="font-mono text-[11.5px] whitespace-pre-wrap break-words bg-panel2 border border-bdr rounded px-2 py-1 max-h-24 overflow-auto">{f.sql}</pre>
                            <div className="flex items-start gap-2 mt-0.5">
                              <div className="text-err text-[11.5px] flex-1 min-w-0">{f.error}</div>
                              {ignored.some((x) => stmtKey(x.sql) === stmtKey(f.sql))
                                ? <span className="text-mute text-[11px] shrink-0">Ignored</span>
                                : <Btn variant="outline" onClick={() => ignore([{ sql: f.sql, reason: f.error ?? "error" }])} title="Never run this statement against this target again">Ignore always</Btn>}
                            </div>
                          </li>
                        ))}
                      </ul>
                      <div className="text-mute text-[11.5px] mt-2">The list below was re-compared, so it now holds only what is still missing in the target.</div>
                    </>
                  )}
                </div>
                <Btn onClick={() => setReport(null)} aria-label="Dismiss apply report">Dismiss</Btn>
              </div>
            </div>
          )}
          {ignored.length > 0 && (
            <div className="border border-bdr rounded-lg p-3 mb-4 text-[12.5px]">
              <div className="flex items-center gap-2 flex-wrap">
                <EyeOff size={14} className="text-mute shrink-0" />
                <span className="text-ink">
                  <b>{ignored.length}</b> statement(s) always ignored for {targetName}
                  <span className="text-mute"> · {ignoredActive} left out of this compare</span>
                </span>
                <span className="flex-1" />
                <Btn variant="outline" onClick={() => setShowIgnored((v) => !v)}>{showIgnored ? "Hide ignored" : "Show ignored"}</Btn>
                {showIgnored && <Btn variant="outline" onClick={() => setIgnored([])}>Stop ignoring all</Btn>}
              </div>
              {showIgnored && (
                <ul className="mt-2 space-y-2 max-h-72 overflow-auto">
                  {ignored.map((x) => (
                    <li key={x.sql} className="min-w-0">
                      <pre className="font-mono text-[11.5px] whitespace-pre-wrap break-words bg-panel2 border border-bdr rounded px-2 py-1 max-h-24 overflow-auto">{x.sql}</pre>
                      <div className="flex items-start gap-2 mt-0.5">
                        <div className="text-mute text-[11.5px] flex-1 min-w-0">{x.reason} · ignored {x.at.slice(0, 10)}</div>
                        <Btn variant="outline" onClick={() => setIgnored(ignored.filter((y) => y.sql !== x.sql))}>Stop ignoring</Btn>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {actionable.length === 0 ? (
            <div className="border border-ok/40 bg-ok/8 rounded-lg p-4 flex items-start gap-2.5">
              <CheckCircle2 size={16} className="text-ok shrink-0 mt-0.5" />
              <div className="text-[12.5px]">
                <div className="font-semibold text-ink">{ignoredActive ? "Schemas are in sync, apart from what you chose to ignore." : "Schemas are structurally in sync."}</div>
                <div className="text-mute mt-0.5">{inSync} table(s) compared, no differences found.{outcome.targetOnly.length ? ` ${outcome.targetOnly.length} table(s) exist only in the target (left untouched).` : ""}</div>
              </div>
            </div>
          ) : (
            <div className="grid xl:grid-cols-2 gap-4">
              {/* differences */}
              <section>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">
                  {actionable.length} table(s) differ — select which to migrate{inSync ? ` · ${inSync} in sync` : ""}
                </h3>
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter tables…"
                    aria-label="Filter tables"
                    className="h-7 px-2 rounded-md bg-panel2 border border-bdr text-[12px] focus:border-accent focus:outline-none flex-1 min-w-40"
                  />
                  <Btn variant="outline" onClick={() => setSelected((sel) => new Set([...sel, ...visible.map((r) => r.name)]))}>Select {needle ? "shown" : "all"}</Btn>
                  <Btn variant="outline" onClick={() => setSelected((sel) => { const hide = new Set(visible.map((r) => r.name)); return new Set([...sel].filter((n) => !hide.has(n))); })}>Clear {needle ? "shown" : "all"}</Btn>
                  <span className="text-[11px] text-mute">{selected.size} selected</span>
                </div>
                <div className="space-y-2 max-h-[560px] overflow-auto pr-1">
                  {visible.length === 0 && <p className="text-[12px] text-mute">No table matches “{filter}”.</p>}
                  {visible.map((r) => (
                    <label key={r.name} className={`flex items-start gap-2.5 border rounded-lg p-3 cursor-pointer transition-colors ${selected.has(r.name) ? "border-accent/60 bg-accentdim" : "border-bdr hover:border-accent/40"}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(r.name)}
                        onChange={() => toggle(r.name)}
                        className="mt-0.5 accent-[var(--accent)]"
                        aria-label={`Include ${r.name} in migration`}
                      />
                      {r.status === "new" ? <PlusCircle size={14} className="text-ok shrink-0 mt-0.5" /> : <PencilLine size={14} className="text-warn shrink-0 mt-0.5" />}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-[12.5px] font-semibold">{r.name}</span>
                          <Badge tone={r.status === "new" ? "ok" : "warn"}>{r.status === "new" ? "Missing in target" : "Definition drift"}</Badge>
                          <span className="text-[11px] text-mute">{r.cmp.sync.length} statement(s)</span>
                        </div>
                        <div className="text-[11.5px] text-mute mt-0.5">
                          {r.status === "new"
                            ? `Create ${r.name} in the target (${r.cmp.columns.length} columns).`
                            : diffSummary(r.cmp)}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
                {outcome.truncated && (
                  <p className="text-[11px] text-warn mt-2">Only the first {MAX_TABLES} source tables were compared.</p>
                )}
                {outcome.targetOnly.length > 0 && (
                  <p className="text-[11px] text-mute mt-2">
                    {outcome.targetOnly.length} table(s) exist only in the target and are left untouched (drop them from the worksheet if intended): <span className="font-mono">{outcome.targetOnly.slice(0, 8).join(", ")}{outcome.targetOnly.length > 8 ? "…" : ""}</span>
                  </p>
                )}
              </section>

              {/* generated script */}
              <section className="min-w-0">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">Generated migration script</h3>
                <pre className="font-mono text-[11.5px] leading-5 whitespace-pre overflow-auto p-3 bg-panel2 border border-bdr rounded-lg max-h-[420px]">
                  {script
                    ? tokenize(script).map((t, i) => <span key={i} className={CLS[t.cls]}>{t.text}</span>)
                    : <span className="text-mute italic">Select one or more tables to build the script.</span>}
                </pre>
                {warnings.length > 0 && (
                  <div className="mt-3 border border-warn/40 bg-warn/8 rounded-lg p-3 text-[11.5px] text-ink">
                    <div className="flex items-center gap-1.5 font-semibold mb-1"><AlertTriangle size={13} className="text-warn" /> {warnings.length} thing(s) to check before applying</div>
                    <ul className="list-disc pl-4 space-y-0.5 max-h-40 overflow-auto">
                      {warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                )}
                <label className="mt-3 flex items-center gap-2 text-[12px] text-soft cursor-pointer">
                  <input type="checkbox" checked={continueOnError} onChange={(e) => setContinueOnError(e.target.checked)} className="accent-[var(--accent)]" />
                  Continue past errors (skip failed statements and report them at the end)
                </label>
                <div className="mt-3 flex gap-2 flex-wrap items-center">
                  <Btn variant="primary" onClick={apply} disabled={selected.size === 0 || applying}>
                    {applying ? "Applying…" : "Apply to target"}
                  </Btn>
                  <Btn
                    variant="outline"
                    onClick={() => { s.setSql(script); s.openTab("worksheet", "Worksheet 1"); s.toast("info", "Migration script loaded in worksheet"); }}
                    disabled={!script}
                  >
                    Open in worksheet
                  </Btn>
                </div>
              </section>
            </div>
          )}
        </div>
      )}

      {mode === "compare" && phase === "setup" && !error && (
        <div className="border border-dashed border-bdr rounded-xl p-10 text-center text-mute text-[12.5px]">
          Pick a source and target Oracle connection, then run <b className="text-soft">Compare schemas</b> to see structural differences and generate an ordered migration script.
        </div>
      )}
    </div>
  );
}

/** Short human summary of a changed table's diffs. */
function diffSummary(cmp: TableComparison): string {
  const parts: string[] = [];
  const colAdd = cmp.columns.filter((c) => c.status === "sourceOnly").length;
  const colDrop = cmp.columns.filter((c) => c.status === "targetOnly").length;
  const colMod = cmp.columns.filter((c) => c.status === "changed").length;
  if (colAdd) parts.push(`+${colAdd} col`);
  if (colDrop) parts.push(`-${colDrop} col`);
  if (colMod) parts.push(`~${colMod} col`);
  const ixAdd = cmp.indexes.filter((i) => i.status === "sourceOnly").length;
  const ixDrop = cmp.indexes.filter((i) => i.status === "targetOnly").length;
  if (ixAdd || ixDrop) parts.push(`${ixAdd + ixDrop} index`);
  const conAdd = cmp.constraints.filter((c) => c.status === "sourceOnly").length;
  const conDrop = cmp.constraints.filter((c) => c.status === "targetOnly").length;
  if (conAdd || conDrop) parts.push(`${conAdd + conDrop} constraint`);
  if (cmp.tableCommentDiff) parts.push("comment");
  return parts.length ? parts.join(", ") : "structural drift";
}
