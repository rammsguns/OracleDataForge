import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  BarChart3,
  CheckCircle2,
  Columns3,
  Eye,
  FileCode2,
  GitCompare,
  GripVertical,
  HardDrive,
  KeyRound,
  Lightbulb,
  ListTree,
  Loader2,
  Lock,
  Move,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Shrink,
  Sparkles,
  Table2,
  Trash2,
  Unlock,
  Wrench,
  XCircle,
} from "lucide-react";
import { useStudio } from "../state/store";
import {
  api,
  type AdvisorFinding,
  type AdvisorFix,
  type ApplyTableResult,
  type MaintenanceAction,
  type StatsAction,
  type StorageAction,
  type StorageCompression,
  type StorageParams,
  type TableAdvisor,
  type TableConstraintMeta,
  type TableIndexMeta,
  type TableMeta,
  type TableStats,
  type TableStorage,
} from "../utils/api";
import { tokenize } from "../utils/sql";
import type { MenuItem } from "../types";
import { Badge, Btn, ContextMenu, EmptyState, inputCls } from "./ui";
import {
  addConstraintDdl,
  cloneModel,
  createIndexDdl,
  createTableDdl,
  dropConstraintDdl,
  dropIndexDdl,
  emptyModel,
  generateDdl,
  metaToModel,
  newColumn,
  NEW_TABLE_SENTINEL,
  ORACLE_TYPES,
  rebuildIndexDdl,
  toggleConstraintDdl,
  typeString,
  TYPE_HAS_LENGTH,
  TYPE_HAS_PRECISION,
  TYPE_HAS_SCALE,
  type DesignColumn,
  type DesignModel,
  type NewConstraint,
  type NewConstraintKind,
  type NewIndex,
} from "../utils/tableDdl";
import { getTableBuffer, setTableBuffer, tableKey, type TableBuffer } from "../utils/tableBuffers";
import { compareTables, type DiffStatus, type ObjectDiff, type TableComparison } from "../utils/tableCompare";
import type { Connection } from "../types";

const CLS: Record<string, string> = {
  kw: "text-[var(--syn-kw)] font-semibold",
  fn: "text-[var(--syn-fn)]",
  str: "text-[var(--syn-str)]",
  num: "text-[var(--syn-num)]",
  cmt: "text-[var(--syn-cmt)] italic",
  op: "text-[var(--syn-op)]",
  ident: "",
  ws: "",
};

function Sql({ sql }: { sql: string }) {
  const tokens = useMemo(() => tokenize(sql), [sql]);
  return (
    <pre className="font-mono text-[12px] leading-5 whitespace-pre overflow-auto p-3 bg-panel2 border border-bdr rounded-lg text-ink">
      {tokens.map((t, i) => (
        <span key={i} className={CLS[t.cls]}>
          {t.text}
        </span>
      ))}
    </pre>
  );
}

/** Order-sensitive signature used for dirty detection. */
const signature = (m: DesignModel) =>
  JSON.stringify({
    c: m.columns.map((c) => [c.origName, c.name, typeString(c), c.nullable, c.pk, c.dataDefault.trim(), c.comment.trim()]),
    tc: m.tableComment.trim(),
  });

const smallInput = "h-7 px-1.5 rounded bg-panel2 border border-bdr text-[12px] text-ink focus:border-accent focus:outline-none font-mono";

type SubView = "design" | "sql" | "preview" | "indexes" | "constraints" | "stats" | "storage" | "advisor" | "compare";

/** A single guarded DDL action (index/constraint create/drop/etc.). */
export interface ActionSpec {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  okMsg: string;
}

export default function TableDesigner({ table, tabId }: { table: string; tabId: string }) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);

  // "create new table" mode: `table` is a sentinel payload, not a real table name
  const isNew = table === NEW_TABLE_SENTINEL;

  // ---- all hooks first (conditional render happens after) ----
  const key = conn ? tableKey(conn.id, table) : "";
  const [buf, setBuf] = useState<TableBuffer | null>(() => {
    if (!key) return null;
    const cached = getTableBuffer(key);
    if (cached) return cached;
    if (isNew) {
      const original = emptyModel();
      const next: TableBuffer = { original, model: cloneModel(original) };
      setTableBuffer(key, next);
      return next;
    }
    return null;
  });
  // latest DB metadata — powers the Indexes/Constraints tabs (kept apart from the editable column buffer)
  const [refMeta, setRefMeta] = useState<TableMeta | null>(null);
  const [loading, setLoading] = useState(!buf);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [view, setView] = useState<SubView>("design");
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyTableResult | null>(null);
  const [stats, setStats] = useState<TableStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [storage, setStorage] = useState<TableStorage | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [advisor, setAdvisor] = useState<TableAdvisor | null>(null);
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [maintMenu, setMaintMenu] = useState<{ x: number; y: number } | null>(null);
  const dragCid = useRef<string | null>(null);

  const connId = conn?.id;
  // Always fetch fresh metadata on mount (for refMeta); seed the column buffer only if none is cached.
  useEffect(() => {
    if (!connId) return;
    // create mode: no table to fetch — seed an empty model once and stay local until "Create table"
    if (isNew) {
      if (!getTableBuffer(key)) {
        const original = emptyModel();
        const next: TableBuffer = { original, model: cloneModel(original) };
        setTableBuffer(key, next);
        setBuf(next);
      }
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (!getTableBuffer(key)) setLoading(true);
    setLoadErr(null);
    api
      .tableMeta(connId, table)
      .then((meta) => {
        if (cancelled) return;
        if (!meta.exists) {
          setLoadErr(meta.error ?? `Table ${table} was not found.`);
          setLoading(false);
          return;
        }
        setRefMeta(meta);
        if (!getTableBuffer(key)) {
          const original = metaToModel(meta);
          const next: TableBuffer = { original, model: cloneModel(original) };
          setTableBuffer(key, next);
          setBuf(next);
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadErr(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connId, table, key, isNew]);

  const plan = useMemo(() => (buf ? generateDdl(buf.original, buf.model) : { statements: [], notes: [], risks: [] }), [buf]);
  const baseDirty = useMemo(() => (buf ? signature(buf.original) !== signature(buf.model) : false), [buf]);
  // in create mode the tab is "dirty" (worth a close-warning) once a name is typed or columns are edited
  const dirty = isNew ? baseDirty || !!buf?.model.table.trim() : baseDirty;

  useEffect(() => {
    if (conn) s.setTabDirty(tabId, dirty);
  }, [dirty, tabId, conn, s]);

  // lazily load statistics the first time the Statistics tab is opened
  useEffect(() => {
    if (view !== "stats" || stats || !connId) return;
    let cancelled = false;
    setStatsLoading(true);
    api
      .tableStats(connId, table)
      .then((st) => { if (!cancelled) setStats(st); })
      .catch(() => { if (!cancelled) setStats(null); })
      .finally(() => { if (!cancelled) setStatsLoading(false); });
    return () => { cancelled = true; };
  }, [view, stats, connId, table]);

  // lazily load storage the first time the Storage tab is opened
  useEffect(() => {
    if (view !== "storage" || storage || !connId) return;
    let cancelled = false;
    setStorageLoading(true);
    api
      .tableStorage(connId, table)
      .then((st) => { if (!cancelled) setStorage(st); })
      .catch(() => { if (!cancelled) setStorage(null); })
      .finally(() => { if (!cancelled) setStorageLoading(false); });
    return () => { cancelled = true; };
  }, [view, storage, connId, table]);

  // lazily run the optimization advisor the first time the Optimize tab is opened
  useEffect(() => {
    if (view !== "advisor" || advisor || !connId) return;
    let cancelled = false;
    setAdvisorLoading(true);
    api
      .tableAdvisor(connId, table)
      .then((a) => { if (!cancelled) setAdvisor(a); })
      .catch(() => { if (!cancelled) setAdvisor(null); })
      .finally(() => { if (!cancelled) setAdvisorLoading(false); });
    return () => { cancelled = true; };
  }, [view, advisor, connId, table]);

  // ---- conditional renders (after every hook) ----
  if (!conn) return <EmptyState icon={<Table2 />} title="No active connection" hint="Select a connection to design its tables." />;
  if (conn.engine !== "oracle")
    return <EmptyState icon={<Table2 />} title="Oracle only" hint="The Table Designer currently supports Oracle connections. Open this table in the Data browser instead." />;
  if (loading)
    return (
      <div className="flex items-center justify-center h-full text-soft text-[12px] gap-2">
        <Loader2 size={14} className="df-spin text-accent" /> Loading {table}…
      </div>
    );
  if (loadErr || !buf) return <EmptyState icon={<Table2 />} title={`Could not open ${table}`} hint={loadErr ?? "No metadata returned."} />;

  const editable = !conn.readOnly;
  const model = buf.model;

  const commit = (next: DesignModel) => {
    setApplyResult(null);
    setBuf((prev) => {
      if (!prev) return prev;
      const updated: TableBuffer = { original: prev.original, model: next };
      setTableBuffer(key, updated);
      return updated;
    });
  };

  const patchCols = (cols: DesignColumn[]) => commit({ ...model, columns: cols });
  const setCol = (cid: string, patch: Partial<DesignColumn>) =>
    patchCols(model.columns.map((c) => (c.cid === cid ? { ...c, ...patch } : c)));
  const togglePk = (cid: string, pk: boolean) =>
    patchCols(model.columns.map((c) => (c.cid === cid ? { ...c, pk, nullable: pk ? false : c.nullable } : c)));
  const removeCol = (cid: string) => patchCols(model.columns.filter((c) => c.cid !== cid));
  const addCol = () => patchCols([...model.columns, newColumn(model.columns.length + 1)]);
  const move = (cid: string, dir: -1 | 1) => {
    const i = model.columns.findIndex((c) => c.cid === cid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= model.columns.length) return;
    const cols = [...model.columns];
    [cols[i], cols[j]] = [cols[j], cols[i]];
    patchCols(cols);
  };
  const dropOn = (targetCid: string) => {
    const from = dragCid.current;
    dragCid.current = null;
    if (!from || from === targetCid) return;
    const cols = model.columns.filter((c) => c.cid !== from);
    const dragged = model.columns.find((c) => c.cid === from);
    const at = cols.findIndex((c) => c.cid === targetCid);
    if (!dragged || at < 0) return;
    cols.splice(at, 0, dragged);
    patchCols(cols);
  };

  const revert = () => {
    commit(cloneModel(buf.original));
    s.toast("info", isNew ? "New-table form reset." : `Reverted ${table} to the current database state.`);
  };

  const reload = async () => {
    if (!connId) return;
    const meta = await api.tableMeta(connId, table);
    const original = metaToModel(meta);
    const next: TableBuffer = { original, model: cloneModel(original) };
    setTableBuffer(key, next);
    setBuf(next);
    if (meta.exists) setRefMeta(meta);
  };

  // refresh only the DB reference data (indexes/constraints), leaving column edits untouched
  const refreshMeta = async () => {
    if (!connId) return;
    const meta = await api.tableMeta(connId, table);
    if (meta.exists) setRefMeta(meta);
  };

  // one guarded DDL statement (index/constraint actions) — confirm → apply → refresh reference data
  const runAction = (stmt: string, spec: ActionSpec) => {
    s.askConfirm({
      title: spec.title,
      body: spec.body,
      confirmLabel: spec.confirmLabel,
      danger: spec.danger,
      onConfirm: async () => {
        setApplying(true);
        try {
          const res = await api.applyTableDdl(conn.id, [stmt], true);
          setApplyResult(res);
          await refreshMeta();
          s.bumpSchema();
          if (res.failed) s.toast("error", res.results.find((r) => !r.ok)?.error ?? "Action failed.");
          else s.toast("success", spec.okMsg);
        } catch (e: unknown) {
          s.toast("error", e instanceof Error ? e.message : "Action failed.");
        } finally {
          setApplying(false);
        }
      },
    });
  };

  const doApply = () => {
    if (!plan.statements.length) {
      s.toast("info", "No pending changes to apply.");
      return;
    }
    const high = plan.risks.filter((r) => r.level === "high");
    s.askConfirm({
      title: `Apply ${plan.statements.length} change${plan.statements.length > 1 ? "s" : ""} to ${table}?`,
      body: high.length
        ? `${plan.statements.length} DDL statement(s) will run against ${conn.name}. ⚠ ${high.length} high-risk operation(s) — review the Preview tab first.`
        : `${plan.statements.length} DDL statement(s) will run against ${conn.name}. Structural changes may briefly lock the table.`,
      confirmLabel: "Apply changes",
      danger: high.length > 0,
      onConfirm: async () => {
        setApplying(true);
        try {
          const res = await api.applyTableDdl(conn.id, plan.statements, true);
          setApplyResult(res);
          await reload();
          s.bumpSchema();
          if (res.failed) s.toast("error", `Applied ${res.applied} of ${plan.statements.length} — one statement failed.`);
          else s.toast("success", `${table} updated — ${res.applied} statement(s) applied.`);
        } catch (e: unknown) {
          s.toast("error", e instanceof Error ? e.message : "Apply failed.");
        } finally {
          setApplying(false);
        }
      },
    });
  };

  const loadStats = async () => {
    if (!connId) return;
    setStatsLoading(true);
    try {
      setStats(await api.tableStats(connId, table));
    } catch {
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  };

  // DBMS_STATS action (gather/delete/lock/unlock) — confirm → run → reload stats
  const runStatsAction = (action: StatsAction, spec: ActionSpec) => {
    s.askConfirm({
      title: spec.title,
      body: spec.body,
      confirmLabel: spec.confirmLabel,
      danger: spec.danger,
      onConfirm: async () => {
        setApplying(true);
        try {
          await api.tableStatsAction(conn.id, table, action, true);
          await loadStats();
          s.bumpSchema();
          s.toast("success", spec.okMsg);
        } catch (e: unknown) {
          s.toast("error", e instanceof Error ? e.message : "Statistics action failed.");
        } finally {
          setApplying(false);
        }
      },
    });
  };

  const loadStorage = async () => {
    if (!connId) return;
    setStorageLoading(true);
    try {
      setStorage(await api.tableStorage(connId, table));
    } catch {
      setStorage(null);
    } finally {
      setStorageLoading(false);
    }
  };

  // storage maintenance action (move/shrink/logging/rebuild) — confirm → run → reload storage + reference data
  const runStorageAction = (action: StorageAction, params: StorageParams, spec: ActionSpec) => {
    s.askConfirm({
      title: spec.title,
      body: spec.body,
      confirmLabel: spec.confirmLabel,
      danger: spec.danger,
      onConfirm: async () => {
        setApplying(true);
        try {
          const res = await api.tableStorageAction(conn.id, table, action, params, true);
          await loadStorage();
          await refreshMeta();
          s.bumpSchema();
          s.toast("success", res.note ? `${spec.okMsg} ${res.note}` : spec.okMsg);
        } catch (e: unknown) {
          s.toast("error", e instanceof Error ? e.message : "Storage action failed.");
        } finally {
          setApplying(false);
        }
      },
    });
  };

  const loadAdvisor = async () => {
    if (!connId) return;
    setAdvisorLoading(true);
    try {
      setAdvisor(await api.tableAdvisor(connId, table));
    } catch {
      setAdvisor(null);
    } finally {
      setAdvisorLoading(false);
    }
  };

  // one-click advisor remediation — routed by fix kind to the existing endpoints, then re-analyze
  const runAdvisorFix = (fix: AdvisorFix, spec: ActionSpec) => {
    s.askConfirm({
      title: spec.title,
      body: spec.body,
      confirmLabel: spec.confirmLabel,
      danger: spec.danger,
      onConfirm: async () => {
        setApplying(true);
        try {
          let failMsg: string | null = null;
          if (fix.kind === "ddl") {
            const res = await api.applyTableDdl(conn.id, fix.statements ?? [], true);
            if (res.failed) failMsg = res.results.find((r) => !r.ok)?.error ?? "Statement failed.";
          } else if (fix.kind === "stats") {
            await api.tableStatsAction(conn.id, table, "gather", true);
          } else {
            await api.tableStorageAction(conn.id, table, "move", { compression: fix.compression }, true);
          }
          await loadAdvisor();
          await refreshMeta();
          // invalidate the stats/storage caches so their tabs refetch after a fix changed them
          setStats(null);
          setStorage(null);
          s.bumpSchema();
          if (failMsg) s.toast("error", failMsg);
          else s.toast("success", spec.okMsg);
        } catch (e: unknown) {
          s.toast("error", e instanceof Error ? e.message : "Fix failed.");
        } finally {
          setApplying(false);
        }
      },
    });
  };

  // ---- create-mode ("New table") DDL run ----
  const validNewName = /^[A-Z][A-Z0-9_$#]*$/.test(model.table.trim());
  const validCols = model.columns.length > 0 && model.columns.every((c) => c.name.trim() && c.baseType.trim());
  const canCreate = isNew && validNewName && validCols;

  const doCreate = () => {
    if (!canCreate) {
      s.toast("info", "Enter a valid table name and make sure every column has a name.");
      return;
    }
    const stmts = plan.statements; // CREATE TABLE + column/table comments
    const created = model.table.trim();
    s.askConfirm({
      title: `Create table ${created}?`,
      body: `${stmts.length} statement(s) will run against ${conn.name} to create ${created} with ${model.columns.length} column(s).`,
      confirmLabel: "Create table",
      onConfirm: async () => {
        setApplying(true);
        try {
          const res = await api.applyTableDdl(conn.id, stmts, true);
          if (res.failed) {
            setApplyResult(res);
            s.toast("error", res.results.find((r) => !r.ok)?.error ?? "Create failed.");
            return;
          }
          setApplyResult(null);
          s.bumpSchema();
          s.toast("success", `Table ${created} created — ${res.applied} statement(s) applied.`);
          // reset the reusable "New table" tab to a fresh model, then open the real designer for the new table
          const fresh = emptyModel();
          const next: TableBuffer = { original: fresh, model: cloneModel(fresh) };
          setTableBuffer(key, next);
          setBuf(next);
          s.setTabDirty(tabId, false);
          s.openTab("tabledesign", `${created} (Table)`, created);
        } catch (e: unknown) {
          s.toast("error", e instanceof Error ? e.message : "Create failed.");
        } finally {
          setApplying(false);
        }
      },
    });
  };

  // apply a comparison's sync script to the TARGET connection (not the one this tab is on)
  const runSyncApply = (targetConnId: string, statements: string[], spec: ActionSpec, onDone: () => void) => {
    s.askConfirm({
      title: spec.title,
      body: spec.body,
      confirmLabel: spec.confirmLabel,
      danger: spec.danger,
      onConfirm: async () => {
        setApplying(true);
        try {
          const res = await api.applyTableDdl(targetConnId, statements, true);
          setApplyResult(res);
          s.bumpSchema();
          if (res.failed) s.toast("error", res.results.find((r) => !r.ok)?.error ?? "Sync failed.");
          else s.toast("success", spec.okMsg);
          onDone();
        } catch (e: unknown) {
          s.toast("error", e instanceof Error ? e.message : "Sync failed.");
        } finally {
          setApplying(false);
        }
      },
    });
  };

  // one-click maintenance — runs a single op through /table/maintenance, then refreshes every cached view
  const runMaintenance = (action: MaintenanceAction, spec: ActionSpec) => {
    s.askConfirm({
      title: spec.title,
      body: spec.body,
      confirmLabel: spec.confirmLabel,
      danger: spec.danger,
      onConfirm: async () => {
        setApplying(true);
        try {
          const res = await api.tableMaintenance(conn.id, table, action, true);
          await refreshMeta();
          setStats(null);
          setStorage(null);
          setAdvisor(null);
          s.bumpSchema();
          s.toast("success", res.note ? `${spec.okMsg} ${res.note}` : spec.okMsg);
        } catch (e: unknown) {
          s.toast("error", e instanceof Error ? e.message : "Maintenance action failed.");
        } finally {
          setApplying(false);
        }
      },
    });
  };

  const maintenanceItems: MenuItem[] = [
    {
      label: "Gather statistics",
      action: () =>
        runMaintenance("gatherStats", {
          title: `Gather statistics for ${table}?`,
          body: `DBMS_STATS.GATHER_TABLE_STATS (cascade to indexes) — can be expensive on large tables.`,
          confirmLabel: "Gather",
          okMsg: `Statistics gathered for ${table}.`,
        }),
    },
    {
      label: "Rebuild all indexes",
      action: () =>
        runMaintenance("rebuildIndexes", {
          title: `Rebuild all indexes on ${table}?`,
          body: `Every index on ${table} will be rebuilt — this can be expensive but fixes UNUSABLE indexes.`,
          confirmLabel: "Rebuild all",
          okMsg: `Indexes on ${table} rebuilt.`,
        }),
    },
    {
      label: "Validate constraints",
      action: () =>
        runMaintenance("validateConstraints", {
          title: `Validate constraints on ${table}?`,
          body: `Enabled but NOT VALIDATED constraints will be validated against existing rows (fails if any row violates one).`,
          confirmLabel: "Validate",
          okMsg: `Constraints validated on ${table}.`,
        }),
    },
    {
      label: "Analyze (validate structure)",
      action: () =>
        runMaintenance("analyze", {
          title: `Analyze ${table}?`,
          body: `ANALYZE TABLE ${table} VALIDATE STRUCTURE CASCADE checks the table and its indexes for block corruption.`,
          confirmLabel: "Analyze",
          okMsg: `${table} analyzed.`,
        }),
    },
    { divider: true },
    {
      label: "Reorganize (Move)",
      danger: true,
      action: () =>
        runMaintenance("reorg", {
          title: `Reorganize ${table}?`,
          body: `ALTER TABLE ${table} MOVE rewrites every row and leaves indexes UNUSABLE — rebuild them afterwards.`,
          confirmLabel: "Reorganize",
          danger: true,
          okMsg: `${table} reorganized.`,
        }),
    },
    {
      label: "Shrink space",
      action: () =>
        runMaintenance("shrink", {
          title: `Shrink space of ${table}?`,
          body: `Enables row movement and runs ALTER TABLE SHRINK SPACE to reclaim unused blocks below the high-water mark.`,
          confirmLabel: "Shrink",
          okMsg: `${table} shrunk — unused space reclaimed.`,
        }),
    },
  ];

  const typeOptions = (current: string) => Array.from(new Set([...ORACLE_TYPES, current.toUpperCase()]));
  const changeCount = plan.statements.length;

  const ALL_TABS: { id: SubView; label: string; icon: React.ReactNode }[] = [
    { id: "design", label: "Design", icon: <Columns3 size={13} /> },
    { id: "sql", label: `Generated SQL${changeCount ? ` (${changeCount})` : ""}`, icon: <FileCode2 size={13} /> },
    { id: "preview", label: "Preview Changes", icon: <Eye size={13} /> },
    { id: "indexes", label: `Indexes${refMeta ? ` (${refMeta.indexes.length})` : ""}`, icon: <ListTree size={13} /> },
    { id: "constraints", label: `Constraints${refMeta ? ` (${refMeta.constraints.length})` : ""}`, icon: <ShieldCheck size={13} /> },
    { id: "stats", label: "Statistics", icon: <BarChart3 size={13} /> },
    { id: "storage", label: "Storage", icon: <HardDrive size={13} /> },
    { id: "advisor", label: `Optimize${advisor && advisor.findings.length ? ` (${advisor.findings.length})` : ""}`, icon: <Sparkles size={13} /> },
    { id: "compare", label: "Compare", icon: <GitCompare size={13} /> },
  ];
  // in create mode only Design + Generated SQL apply (indexes/constraints/stats/storage/advisor need a live table)
  const TABS = isNew ? ALL_TABS.filter((t) => t.id === "design" || t.id === "sql") : ALL_TABS;

  const columnNames = model.columns.map((c) => c.name);

  return (
    <div className="h-full flex flex-col df-fade">
      {/* toolbar */}
      <div className="flex items-center gap-2.5 px-4 h-12 border-b border-bdr shrink-0 flex-wrap">
        <Table2 size={16} className="text-accent" />
        {isNew ? (
          <input
            className="font-mono font-semibold text-[14px] bg-panel2 border border-bdr rounded px-2 h-8 w-56 text-ink focus:border-accent focus:outline-none placeholder:text-mute placeholder:font-normal"
            value={model.table}
            placeholder="NEW_TABLE_NAME"
            aria-label="New table name"
            autoFocus
            onChange={(e) => commit({ ...model, table: e.target.value.toUpperCase().replace(/[^A-Z0-9_$#]/g, "") })}
          />
        ) : (
          <h2 className="font-mono font-semibold text-[14px]">{table}</h2>
        )}
        <Badge tone="accent">TABLE</Badge>
        {isNew && <Badge tone="ok">NEW</Badge>}
        {!editable && <Badge tone="warn">READ-ONLY</Badge>}
        {!isNew && dirty && <Badge tone="warn">{changeCount ? `${changeCount} pending` : "modified"}</Badge>}
        <div className="ml-auto flex gap-1.5">
          {editable && !isNew && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 h-7 text-[12px] font-medium transition-colors select-none border border-bdr text-soft hover:text-ink hover:border-accent/60 hover:bg-accentdim disabled:opacity-40 disabled:pointer-events-none"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMaintMenu({ x: r.right - 200, y: r.bottom + 4 });
              }}
              disabled={applying}
              title="One-click maintenance actions"
            >
              <Wrench size={12} /> Maintenance
            </button>
          )}
          <Btn variant="ghost" onClick={revert} disabled={!dirty} title={isNew ? "Reset the new-table form" : "Discard edits and reload from the database"}>
            <RotateCcw size={12} /> {isNew ? "Reset" : "Revert"}
          </Btn>
          {editable && isNew && (
            <Btn variant="primary" onClick={doCreate} disabled={!canCreate || applying} title={canCreate ? "Run CREATE TABLE against the database" : "Enter a valid name and columns first"}>
              {applying ? <Loader2 size={12} className="df-spin" /> : <Plus size={12} />} Create table
            </Btn>
          )}
          {editable && !isNew && (
            <Btn variant="primary" onClick={doApply} disabled={!changeCount || applying} title="Run the generated DDL against the database">
              {applying ? <Loader2 size={12} className="df-spin" /> : <Play size={12} />} Apply changes
            </Btn>
          )}
        </div>
      </div>

      {/* sub-tabs */}
      <div className="flex items-stretch gap-0.5 px-3 border-b border-bdrsoft shrink-0 bg-bg overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            className={`flex items-center gap-1.5 px-3 h-9 text-[12px] border-b-2 transition-colors shrink-0 whitespace-nowrap ${
              view === t.id ? "border-accent text-ink" : "border-transparent text-mute hover:text-soft"
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {view === "design" && (
          <DesignGrid
            model={model}
            editable={editable}
            typeOptions={typeOptions}
            setCol={setCol}
            togglePk={togglePk}
            removeCol={removeCol}
            addCol={addCol}
            move={move}
            onTableComment={(v) => commit({ ...model, tableComment: v })}
            onDragStart={(cid) => (dragCid.current = cid)}
            onDrop={dropOn}
          />
        )}

        {view === "sql" && (
          <div className="max-w-4xl">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">
              Generated DDL {changeCount ? "" : "— no pending changes"}
            </h3>
            <Sql sql={changeCount ? plan.statements.join("\n") : "-- No pending changes. Edit columns in the Design tab to generate DDL."} />
            {plan.notes.map((n, i) => (
              <p key={i} className="mt-2 text-[12px] text-warn flex items-start gap-1.5">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {n}
              </p>
            ))}
          </div>
        )}

        {view === "preview" && (
          <PreviewChanges original={buf.original} model={model} plan={plan} />
        )}

        {view === "indexes" &&
          (refMeta ? (
            <IndexesPanel
              table={table}
              editable={editable}
              indexes={refMeta.indexes}
              constraints={refMeta.constraints}
              columnNames={columnNames}
              applying={applying}
              runAction={runAction}
            />
          ) : (
            <LoadingRef />
          ))}

        {view === "constraints" &&
          (refMeta ? (
            <ConstraintsPanel
              table={table}
              editable={editable}
              constraints={refMeta.constraints}
              columnNames={columnNames}
              applying={applying}
              runAction={runAction}
            />
          ) : (
            <LoadingRef />
          ))}

        {view === "stats" &&
          (statsLoading && !stats ? (
            <LoadingRef />
          ) : (
            <StatisticsPanel
              table={table}
              editable={editable}
              stats={stats}
              statsLoading={statsLoading}
              applying={applying}
              onRefresh={loadStats}
              runStatsAction={runStatsAction}
            />
          ))}

        {view === "storage" &&
          (storageLoading && !storage ? (
            <LoadingRef />
          ) : (
            <StoragePanel
              table={table}
              editable={editable}
              storage={storage}
              storageLoading={storageLoading}
              applying={applying}
              onRefresh={loadStorage}
              runStorageAction={runStorageAction}
            />
          ))}

        {view === "advisor" &&
          (advisorLoading && !advisor ? (
            <LoadingRef />
          ) : (
            <AdvisorPanel
              table={table}
              editable={editable}
              advisor={advisor}
              advisorLoading={advisorLoading}
              applying={applying}
              onRefresh={loadAdvisor}
              runAdvisorFix={runAdvisorFix}
            />
          ))}

        {view === "compare" && (
          <ComparePanel
            table={table}
            connId={conn.id}
            connections={s.connections}
            applying={applying}
            runSyncApply={runSyncApply}
          />
        )}
      </div>

      {/* apply result panel */}
      {applyResult && (
        <div className="border-t border-bdr shrink-0 max-h-44 overflow-auto p-3 bg-panel2">
          <div className="flex items-center gap-2 mb-2 text-[12px] font-semibold">
            {applyResult.failed ? <XCircle size={14} className="text-err" /> : <CheckCircle2 size={14} className="text-ok" />}
            {applyResult.failed
              ? `Applied ${applyResult.applied} statement(s), then one failed`
              : `All ${applyResult.applied} statement(s) applied`}
          </div>
          <ul className="space-y-1">
            {applyResult.results.map((r, i) => (
              <li key={i} className="text-[11.5px] font-mono flex items-start gap-2">
                {r.ok ? <CheckCircle2 size={12} className="text-ok mt-0.5 shrink-0" /> : <XCircle size={12} className="text-err mt-0.5 shrink-0" />}
                <span className="text-soft break-all">
                  {r.sql}
                  {r.error && <span className="text-err"> — {r.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {maintMenu && <ContextMenu x={maintMenu.x} y={maintMenu.y} items={maintenanceItems} onClose={() => setMaintMenu(null)} />}
    </div>
  );
}

/* ---------------- Design grid ---------------- */

function DesignGrid({
  model,
  editable,
  typeOptions,
  setCol,
  togglePk,
  removeCol,
  addCol,
  move,
  onTableComment,
  onDragStart,
  onDrop,
}: {
  model: DesignModel;
  editable: boolean;
  typeOptions: (current: string) => string[];
  setCol: (cid: string, patch: Partial<DesignColumn>) => void;
  togglePk: (cid: string, pk: boolean) => void;
  removeCol: (cid: string) => void;
  addCol: () => void;
  move: (cid: string, dir: -1 | 1) => void;
  onTableComment: (v: string) => void;
  onDragStart: (cid: string) => void;
  onDrop: (targetCid: string) => void;
}) {
  return (
    <div className="max-w-6xl">
      <div className="border border-bdr rounded-lg overflow-x-auto">
        <table className="w-full text-[12px] min-w-[860px]">
          <thead>
            <tr className="bg-panel3 text-left text-[10.5px] uppercase tracking-wider text-mute">
              <th className="w-8" />
              <th className="px-2 py-2 font-semibold">Column</th>
              <th className="px-2 py-2 font-semibold">Type</th>
              <th className="px-2 py-2 font-semibold text-center" title="Nullable">Null</th>
              <th className="px-2 py-2 font-semibold text-center" title="Primary key">PK</th>
              <th className="px-2 py-2 font-semibold">Default</th>
              <th className="px-2 py-2 font-semibold">Comment</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody>
            {model.columns.map((c, i) => {
              const t = c.baseType.toUpperCase();
              return (
                <tr
                  key={c.cid}
                  className="border-t border-bdrsoft hover:bg-panel2/50"
                  onDragOver={(e) => editable && e.preventDefault()}
                  onDrop={() => editable && onDrop(c.cid)}
                >
                  <td className="text-center">
                    {editable && (
                      <span
                        draggable
                        onDragStart={() => onDragStart(c.cid)}
                        className="inline-flex cursor-grab text-mute hover:text-soft active:cursor-grabbing"
                        title="Drag to reorder"
                      >
                        <GripVertical size={13} />
                      </span>
                    )}
                  </td>
                  <td className="px-1.5 py-1">
                    <input
                      className={`${smallInput} w-full`}
                      value={c.name}
                      disabled={!editable}
                      aria-label={`Column ${i + 1} name`}
                      onChange={(e) => setCol(c.cid, { name: e.target.value.toUpperCase() })}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <div className="flex items-center gap-1">
                      <select
                        className={`${smallInput} w-32`}
                        value={t}
                        disabled={!editable}
                        aria-label={`Column ${i + 1} type`}
                        onChange={(e) => setCol(c.cid, { baseType: e.target.value })}
                      >
                        {typeOptions(c.baseType).map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {TYPE_HAS_LENGTH(t) && (
                        <input
                          className={`${smallInput} w-16`}
                          value={c.length}
                          disabled={!editable}
                          placeholder="len"
                          aria-label={`Column ${i + 1} length`}
                          onChange={(e) => setCol(c.cid, { length: e.target.value.replace(/[^0-9]/g, "") })}
                        />
                      )}
                      {TYPE_HAS_PRECISION(t) && (
                        <input
                          className={`${smallInput} w-12`}
                          value={c.precision}
                          disabled={!editable}
                          placeholder="p"
                          aria-label={`Column ${i + 1} precision`}
                          onChange={(e) => setCol(c.cid, { precision: e.target.value.replace(/[^0-9]/g, "") })}
                        />
                      )}
                      {TYPE_HAS_SCALE(t) && (
                        <input
                          className={`${smallInput} w-12`}
                          value={c.scale}
                          disabled={!editable}
                          placeholder="s"
                          aria-label={`Column ${i + 1} scale`}
                          onChange={(e) => setCol(c.cid, { scale: e.target.value.replace(/[^0-9]/g, "") })}
                        />
                      )}
                    </div>
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      checked={c.nullable}
                      disabled={!editable || c.pk}
                      aria-label={`${c.name} nullable`}
                      onChange={(e) => setCol(c.cid, { nullable: e.target.checked })}
                      className="accent-[var(--accent)]"
                    />
                  </td>
                  <td className="text-center">
                    <button
                      disabled={!editable}
                      aria-label={`${c.name} primary key`}
                      aria-pressed={c.pk}
                      onClick={() => togglePk(c.cid, !c.pk)}
                      className={`p-1 rounded ${c.pk ? "text-warn" : "text-mute hover:text-soft"} disabled:opacity-40`}
                      title={c.pk ? "Primary key member — click to remove" : "Click to make a primary key member"}
                    >
                      <KeyRound size={13} />
                    </button>
                  </td>
                  <td className="px-1.5 py-1">
                    <input
                      className={`${smallInput} w-28`}
                      value={c.dataDefault}
                      disabled={!editable}
                      placeholder="—"
                      aria-label={`Column ${i + 1} default`}
                      onChange={(e) => setCol(c.cid, { dataDefault: e.target.value })}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <input
                      className={`${smallInput} w-40`}
                      value={c.comment}
                      disabled={!editable}
                      placeholder="—"
                      aria-label={`Column ${i + 1} comment`}
                      onChange={(e) => setCol(c.cid, { comment: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <div className="flex items-center justify-end gap-0.5">
                      <button disabled={!editable || i === 0} onClick={() => move(c.cid, -1)} className="p-1 text-mute hover:text-ink rounded disabled:opacity-25" aria-label={`Move ${c.name} up`}>
                        <ArrowUp size={12} />
                      </button>
                      <button disabled={!editable || i === model.columns.length - 1} onClick={() => move(c.cid, 1)} className="p-1 text-mute hover:text-ink rounded disabled:opacity-25" aria-label={`Move ${c.name} down`}>
                        <ArrowDown size={12} />
                      </button>
                      <button disabled={!editable} onClick={() => removeCol(c.cid)} className="p-1 text-mute hover:text-err rounded disabled:opacity-25" aria-label={`Remove ${c.name}`}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {editable && (
          <button
            className="w-full flex items-center gap-1.5 px-3 py-2 text-[12px] text-accenthi hover:bg-accentdim border-t border-bdrsoft"
            onClick={addCol}
          >
            <Plus size={13} /> Add column
          </button>
        )}
      </div>

      <div className="mt-4 max-w-2xl">
        <label className="block text-[11px] font-bold uppercase tracking-wider text-mute mb-1.5">Table comment</label>
        <input
          className={inputCls}
          value={model.tableComment}
          disabled={!editable}
          placeholder="Describe this table…"
          onChange={(e) => onTableComment(e.target.value)}
        />
      </div>
    </div>
  );
}

/* ---------------- Preview Changes ---------------- */

function PreviewChanges({
  original,
  model,
  plan,
}: {
  original: DesignModel;
  model: DesignModel;
  plan: ReturnType<typeof generateDdl>;
}) {
  const riskTone = { low: "ok", medium: "warn", high: "err" } as const;
  return (
    <div className="space-y-5 max-w-6xl">
      <div className="grid gap-4 xl:grid-cols-2">
        <section>
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">Current schema</h3>
          <Sql sql={createTableDdl(original)} />
        </section>
        <section>
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">Target schema</h3>
          <Sql sql={createTableDdl(model)} />
        </section>
      </div>

      <section>
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">
          Statements to execute {plan.statements.length ? `(${plan.statements.length})` : ""}
        </h3>
        {plan.statements.length ? (
          <Sql sql={plan.statements.join("\n")} />
        ) : (
          <p className="text-[12px] text-mute">No changes — the target matches the current schema.</p>
        )}
        {plan.notes.map((n, i) => (
          <p key={i} className="mt-2 text-[12px] text-warn flex items-start gap-1.5">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {n}
          </p>
        ))}
      </section>

      <section>
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">Risk assessment</h3>
        {plan.risks.length ? (
          <ul className="space-y-1.5">
            {plan.risks.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px]">
                <Badge tone={riskTone[r.level]}>{r.level.toUpperCase()}</Badge>
                <span className="text-soft">{r.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-ok flex items-center gap-1.5">
            <CheckCircle2 size={13} /> {plan.statements.length ? "No elevated risks detected in these changes." : "Nothing to assess."}
          </p>
        )}
      </section>
    </div>
  );
}

function LoadingRef() {
  return (
    <div className="flex items-center gap-2 text-soft text-[12px]">
      <Loader2 size={14} className="df-spin text-accent" /> Loading metadata…
    </div>
  );
}

/** Ordered multi-select of column names as toggle chips. */
function ColumnPicker({ columns, selected, onChange, disabled }: { columns: string[]; selected: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const toggle = (c: string) => onChange(selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c]);
  return (
    <div className="flex flex-wrap gap-1">
      {columns.map((c) => {
        const i = selected.indexOf(c);
        const on = i >= 0;
        return (
          <button
            key={c}
            type="button"
            disabled={disabled}
            onClick={() => toggle(c)}
            className={`inline-flex items-center px-2 h-6 rounded text-[11px] font-mono border transition-colors disabled:opacity-40 ${
              on ? "bg-accentdim border-accent text-accenthi" : "border-bdr text-soft hover:border-accent/50"
            }`}
          >
            {on && <span className="mr-1 text-[9px] font-sans opacity-70">{i + 1}</span>}
            {c}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- Indexes tab ---------------- */

const isFkCovered = (fkCols: string[], indexes: TableIndexMeta[]) =>
  indexes.some((ix) => {
    const cols = ix.columns.map((c) => c.replace(/\s+DESC$/i, ""));
    return fkCols.every((c, i) => cols[i] === c);
  });

function IndexesPanel({
  table,
  editable,
  indexes,
  constraints,
  columnNames,
  applying,
  runAction,
}: {
  table: string;
  editable: boolean;
  indexes: TableIndexMeta[];
  constraints: TableConstraintMeta[];
  columnNames: string[];
  applying: boolean;
  runAction: (stmt: string, spec: ActionSpec) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [cols, setCols] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [bitmap, setBitmap] = useState(false);
  const [tablespace, setTablespace] = useState("");

  const suggested = cols.length ? `${table}_${cols.join("_")}_IX`.toUpperCase().slice(0, 30) : "";
  const missing = constraints.filter((c) => c.type === "R" && c.columns.length && !isFkCovered(c.columns, indexes));

  const create = () => {
    const ix: NewIndex = { name: (name.trim() || suggested), columns: cols, unique, bitmap, tablespace };
    runAction(createIndexDdl(table, ix), {
      title: `Create index ${ix.name}?`,
      body: `A ${unique ? "unique " : bitmap ? "bitmap " : ""}index on ${table} (${cols.join(", ")}) will be created.`,
      confirmLabel: "Create index",
      okMsg: `Index ${ix.name} created.`,
    });
    setOpen(false);
    setName("");
    setCols([]);
    setUnique(false);
    setBitmap(false);
    setTablespace("");
  };

  return (
    <div className="max-w-5xl space-y-4">
      {missing.length > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn/5 p-3">
          <div className="text-[12px] font-semibold text-warn flex items-center gap-1.5 mb-1.5">
            <AlertTriangle size={13} /> Missing indexes on foreign keys
          </div>
          <ul className="space-y-1.5">
            {missing.map((c) => {
              const ixName = `${table}_${c.columns.join("_")}_FK_IX`.toUpperCase().slice(0, 30);
              return (
                <li key={c.name} className="flex items-center gap-2 text-[12px]">
                  <span className="text-soft">
                    FK <span className="font-mono">{c.name}</span> ({c.columns.join(", ")}) has no leading index — unindexed FKs can cause lock contention.
                  </span>
                  {editable && (
                    <Btn
                      variant="outline"
                      onClick={() =>
                        runAction(createIndexDdl(table, { name: ixName, columns: c.columns, unique: false, bitmap: false, tablespace: "" }), {
                          title: `Create index ${ixName}?`,
                          body: `An index on ${table} (${c.columns.join(", ")}) will be created to cover FK ${c.name}.`,
                          confirmLabel: "Create index",
                          okMsg: `Index ${ixName} created.`,
                        })
                      }
                    >
                      <Plus size={12} /> Create index
                    </Btn>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute">Indexes ({indexes.length})</h3>
        {editable && (
          <Btn variant="outline" onClick={() => setOpen((v) => !v)} disabled={applying} className="ml-auto">
            <Plus size={12} /> New index
          </Btn>
        )}
      </div>

      {open && editable && (
        <div className="rounded-lg border border-bdr bg-panel2 p-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-[11px] font-semibold text-soft mb-1">Name</span>
              <input className={inputCls} value={name} placeholder={suggested || "index name"} onChange={(e) => setName(e.target.value.toUpperCase())} />
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-soft mb-1">Tablespace (optional)</span>
              <input className={inputCls} value={tablespace} placeholder="default" onChange={(e) => setTablespace(e.target.value.toUpperCase())} />
            </label>
          </div>
          <div>
            <span className="block text-[11px] font-semibold text-soft mb-1">Columns (click in order)</span>
            <ColumnPicker columns={columnNames} selected={cols} onChange={setCols} />
          </div>
          <div className="flex items-center gap-4 text-[12px]">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={unique} onChange={(e) => { setUnique(e.target.checked); if (e.target.checked) setBitmap(false); }} className="accent-[var(--accent)]" /> Unique
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={bitmap} disabled={unique} onChange={(e) => setBitmap(e.target.checked)} className="accent-[var(--accent)]" /> Bitmap
            </label>
            <Btn variant="primary" className="ml-auto" onClick={create} disabled={!cols.length || applying}>
              <Plus size={12} /> Create
            </Btn>
          </div>
        </div>
      )}

      <div className="border border-bdr rounded-lg overflow-x-auto">
        <table className="w-full text-[12px] min-w-[720px]">
          <thead>
            <tr className="bg-panel3 text-left text-[10.5px] uppercase tracking-wider text-mute">
              <th className="px-2.5 py-2 font-semibold">Index</th>
              <th className="px-2.5 py-2 font-semibold">Columns</th>
              <th className="px-2.5 py-2 font-semibold">Type</th>
              <th className="px-2.5 py-2 font-semibold">Status</th>
              <th className="px-2.5 py-2 font-semibold">Tablespace</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {indexes.length === 0 && (
              <tr><td colSpan={6} className="px-2.5 py-4 text-center text-mute">No indexes on this table.</td></tr>
            )}
            {indexes.map((ix) => (
              <tr key={ix.name} className="border-t border-bdrsoft">
                <td className="px-2.5 py-1.5 font-mono">
                  {ix.name}
                  {ix.constraintBacked && <span title="Backs a constraint" className="ml-1.5 inline-flex text-warn"><KeyRound size={11} /></span>}
                </td>
                <td className="px-2.5 py-1.5 font-mono text-soft">{ix.columns.join(", ")}</td>
                <td className="px-2.5 py-1.5">
                  {ix.unique && <Badge tone="accent">UNIQUE</Badge>} <span className="text-mute">{ix.type}</span>
                </td>
                <td className="px-2.5 py-1.5">
                  <Badge tone={ix.status === "VALID" ? "ok" : ix.status === "UNUSABLE" ? "err" : "neutral"}>{ix.status}</Badge>
                </td>
                <td className="px-2.5 py-1.5 text-mute font-mono">{ix.tablespace ?? "—"}</td>
                <td className="px-2 py-1.5">
                  {editable && (
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        className="p-1 text-mute hover:text-accenthi rounded disabled:opacity-30"
                        title="Rebuild index"
                        disabled={applying}
                        onClick={() =>
                          runAction(rebuildIndexDdl(ix.name), {
                            title: `Rebuild index ${ix.name}?`,
                            body: `ALTER INDEX ${ix.name} REBUILD can be expensive on large tables.`,
                            confirmLabel: "Rebuild",
                            okMsg: `Index ${ix.name} rebuilt.`,
                          })
                        }
                      >
                        <RefreshCw size={12} />
                      </button>
                      <button
                        className="p-1 text-mute hover:text-err rounded disabled:opacity-30"
                        title={ix.constraintBacked ? "Backs a constraint — drop it from the Constraints tab" : "Drop index"}
                        disabled={applying || ix.constraintBacked}
                        onClick={() =>
                          runAction(dropIndexDdl(ix.name), {
                            title: `Drop index ${ix.name}?`,
                            body: `DROP INDEX ${ix.name} is permanent.`,
                            confirmLabel: "Drop index",
                            danger: true,
                            okMsg: `Index ${ix.name} dropped.`,
                          })
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Constraints tab ---------------- */

const CON_KINDS: { kind: NewConstraintKind; label: string }[] = [
  { kind: "P", label: "Primary key" },
  { kind: "U", label: "Unique" },
  { kind: "R", label: "Foreign key" },
  { kind: "C", label: "Check" },
];

function ConstraintsPanel({
  table,
  editable,
  constraints,
  columnNames,
  applying,
  runAction,
}: {
  table: string;
  editable: boolean;
  constraints: TableConstraintMeta[];
  columnNames: string[];
  applying: boolean;
  runAction: (stmt: string, spec: ActionSpec) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<NewConstraintKind>("U");
  const [name, setName] = useState("");
  const [cols, setCols] = useState<string[]>([]);
  const [refTable, setRefTable] = useState("");
  const [refCols, setRefCols] = useState("");
  const [checkExpr, setCheckExpr] = useState("");

  const reset = () => { setOpen(false); setName(""); setCols([]); setRefTable(""); setRefCols(""); setCheckExpr(""); };

  const canCreate =
    (kind === "C" && checkExpr.trim()) ||
    (kind === "R" && cols.length && refTable.trim() && refCols.trim()) ||
    ((kind === "P" || kind === "U") && cols.length);

  const create = () => {
    const c: NewConstraint = {
      name, kind, columns: cols, refTable, refColumns: refCols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean), checkExpr,
    };
    const label = CON_KINDS.find((k) => k.kind === kind)!.label;
    runAction(addConstraintDdl(table, c), {
      title: `Add ${label.toLowerCase()} to ${table}?`,
      body: `A ${label.toLowerCase()} constraint will be added to ${table}.`,
      confirmLabel: "Add constraint",
      okMsg: `${label} added to ${table}.`,
    });
    reset();
  };

  const toneFor = (t: string) => (t === "P" ? "warn" : t === "R" ? "accent" : t === "U" ? "ok" : "neutral") as "warn" | "accent" | "ok" | "neutral";

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute">Constraints ({constraints.length})</h3>
        {editable && (
          <Btn variant="outline" onClick={() => setOpen((v) => !v)} disabled={applying} className="ml-auto">
            <Plus size={12} /> Add constraint
          </Btn>
        )}
      </div>

      {open && editable && (
        <div className="rounded-lg border border-bdr bg-panel2 p-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-[11px] font-semibold text-soft mb-1">Type</span>
              <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as NewConstraintKind)}>
                {CON_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-soft mb-1">Name (optional)</span>
              <input className={inputCls} value={name} placeholder="auto" onChange={(e) => setName(e.target.value.toUpperCase())} />
            </label>
          </div>

          {(kind === "P" || kind === "U" || kind === "R") && (
            <div>
              <span className="block text-[11px] font-semibold text-soft mb-1">Columns (click in order)</span>
              <ColumnPicker columns={columnNames} selected={cols} onChange={setCols} />
            </div>
          )}

          {kind === "R" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="block text-[11px] font-semibold text-soft mb-1">References table</span>
                <input className={inputCls} value={refTable} placeholder="PARENT_TABLE" onChange={(e) => setRefTable(e.target.value.toUpperCase())} />
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold text-soft mb-1">Referenced columns (comma-sep)</span>
                <input className={inputCls} value={refCols} placeholder="ID" onChange={(e) => setRefCols(e.target.value.toUpperCase())} />
              </label>
            </div>
          )}

          {kind === "C" && (
            <label className="block">
              <span className="block text-[11px] font-semibold text-soft mb-1">Check expression</span>
              <input className={`${inputCls} font-mono`} value={checkExpr} placeholder="AMOUNT >= 0" onChange={(e) => setCheckExpr(e.target.value)} />
            </label>
          )}

          <div className="flex justify-end">
            <Btn variant="primary" onClick={create} disabled={!canCreate || applying}>
              <Plus size={12} /> Add
            </Btn>
          </div>
        </div>
      )}

      <div className="border border-bdr rounded-lg overflow-x-auto">
        <table className="w-full text-[12px] min-w-[760px]">
          <thead>
            <tr className="bg-panel3 text-left text-[10.5px] uppercase tracking-wider text-mute">
              <th className="px-2.5 py-2 font-semibold">Type</th>
              <th className="px-2.5 py-2 font-semibold">Name</th>
              <th className="px-2.5 py-2 font-semibold">Definition</th>
              <th className="px-2.5 py-2 font-semibold">Status</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {constraints.length === 0 && (
              <tr><td colSpan={5} className="px-2.5 py-4 text-center text-mute">No constraints on this table.</td></tr>
            )}
            {constraints.map((c) => {
              const enabled = c.status === "ENABLED";
              return (
                <tr key={c.name} className="border-t border-bdrsoft align-top">
                  <td className="px-2.5 py-1.5"><Badge tone={toneFor(c.type)}>{c.typeLabel}</Badge></td>
                  <td className="px-2.5 py-1.5 font-mono">{c.name}</td>
                  <td className="px-2.5 py-1.5 font-mono text-soft">
                    {c.type === "C"
                      ? (c.searchCondition ?? "—")
                      : c.type === "R"
                      ? `(${c.columns.join(", ")}) → ${c.refTable}(${c.refColumns.join(", ")})`
                      : c.columns.join(", ")}
                  </td>
                  <td className="px-2.5 py-1.5">
                    <Badge tone={enabled ? "ok" : "warn"}>{c.status}</Badge>
                    {c.validated && <span className="ml-1 text-[10px] text-mute">{c.validated}</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    {editable && (
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          className="p-1 text-mute hover:text-accenthi rounded disabled:opacity-30"
                          title={enabled ? "Disable constraint" : "Enable constraint"}
                          disabled={applying}
                          onClick={() =>
                            runAction(toggleConstraintDdl(table, c.name, !enabled), {
                              title: `${enabled ? "Disable" : "Enable"} ${c.name}?`,
                              body: `Constraint ${c.name} on ${table} will be ${enabled ? "disabled" : "enabled"}.`,
                              confirmLabel: enabled ? "Disable" : "Enable",
                              okMsg: `${c.name} ${enabled ? "disabled" : "enabled"}.`,
                            })
                          }
                        >
                          {enabled ? <Ban size={12} /> : <Power size={12} />}
                        </button>
                        <button
                          className="p-1 text-mute hover:text-err rounded disabled:opacity-30"
                          title="Drop constraint"
                          disabled={applying}
                          onClick={() =>
                            runAction(dropConstraintDdl(table, c.name), {
                              title: `Drop ${c.typeLabel} ${c.name}?`,
                              body: `Dropping ${c.name} removes its enforcement${c.type === "P" || c.type === "U" ? " and its backing index" : ""}.`,
                              confirmLabel: "Drop constraint",
                              danger: true,
                              okMsg: `${c.name} dropped.`,
                            })
                          }
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Statistics tab ---------------- */

const fmtNum = (n: number | null) => (n == null ? "—" : n.toLocaleString("en"));
const fmtDate = (iso: string | null) => {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
};

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-bdr bg-panel2 px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wider text-mute">{label}</div>
      <div className="text-[15px] font-semibold font-mono mt-0.5">{value}</div>
    </div>
  );
}

function StatisticsPanel({
  table,
  editable,
  stats,
  statsLoading,
  applying,
  onRefresh,
  runStatsAction,
}: {
  table: string;
  editable: boolean;
  stats: TableStats | null;
  statsLoading: boolean;
  applying: boolean;
  onRefresh: () => void;
  runStatsAction: (action: StatsAction, spec: ActionSpec) => void;
}) {
  const t = stats?.table ?? null;
  const locked = !!t?.locked;
  const hasStats = !!t && (t.numRows != null || t.lastAnalyzed != null);
  const busy = applying || statsLoading;

  const gather = () =>
    runStatsAction("gather", {
      title: `Gather statistics for ${table}?`,
      body: `DBMS_STATS.GATHER_TABLE_STATS (cascade to indexes) will run — this can be expensive on large tables.`,
      confirmLabel: "Gather",
      okMsg: `Statistics gathered for ${table}.`,
    });

  return (
    <div className="max-w-5xl space-y-4">
      {/* toolbar */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mr-auto">Optimizer statistics</h3>
        <Btn variant="ghost" onClick={onRefresh} disabled={busy} title="Reload statistics">
          <RefreshCw size={12} /> Refresh
        </Btn>
        {editable && (
          <>
            <Btn
              variant="outline"
              onClick={() =>
                runStatsAction(locked ? "unlock" : "lock", {
                  title: `${locked ? "Unlock" : "Lock"} statistics for ${table}?`,
                  body: locked
                    ? `Unlocking lets statistics be gathered again (manually or by the auto job).`
                    : `Locking prevents statistics from being gathered until unlocked.`,
                  confirmLabel: locked ? "Unlock" : "Lock",
                  okMsg: `Statistics ${locked ? "unlocked" : "locked"} for ${table}.`,
                })
              }
              disabled={busy}
            >
              {locked ? <Unlock size={12} /> : <Lock size={12} />} {locked ? "Unlock" : "Lock"}
            </Btn>
            <Btn
              variant="ghost"
              onClick={() =>
                runStatsAction("delete", {
                  title: `Delete statistics for ${table}?`,
                  body: `DBMS_STATS.DELETE_TABLE_STATS removes all statistics — the optimizer falls back to dynamic sampling until they are re-gathered.`,
                  confirmLabel: "Delete stats",
                  danger: true,
                  okMsg: `Statistics deleted for ${table}.`,
                })
              }
              disabled={busy || locked}
              title={locked ? "Unlock statistics first" : "Delete statistics"}
            >
              <Trash2 size={12} /> Delete
            </Btn>
            <Btn variant="primary" onClick={gather} disabled={busy || locked} title={locked ? "Unlock statistics first" : "Gather fresh statistics"}>
              {applying ? <Loader2 size={12} className="df-spin" /> : <BarChart3 size={12} />} Gather statistics
            </Btn>
          </>
        )}
      </div>

      {locked && (
        <div className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-[12px] text-warn flex items-center gap-1.5">
          <Lock size={13} /> Statistics are locked — gather and delete are disabled until you unlock them.
        </div>
      )}

      {t?.stale && !locked && (
        <div className="rounded-lg border border-warn/40 bg-warn/5 p-3 flex items-center gap-2">
          <AlertTriangle size={14} className="text-warn shrink-0" />
          <span className="text-[12px] text-warn">Statistics are stale — the table changed significantly since they were last gathered. Gather to keep the optimizer accurate.</span>
          {editable && (
            <Btn variant="outline" className="ml-auto" onClick={gather} disabled={busy}>
              <BarChart3 size={12} /> Gather now
            </Btn>
          )}
        </div>
      )}

      {!hasStats ? (
        <div className="rounded-lg border border-bdr bg-panel2 p-4 text-[12px] text-mute flex items-center gap-2">
          <AlertTriangle size={14} className="text-mute shrink-0" />
          No statistics have been gathered for {table}.{editable ? " Click “Gather statistics” to collect them." : ""}
        </div>
      ) : (
        <>
          <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-4">
            <StatBox label="Rows" value={fmtNum(t!.numRows)} />
            <StatBox label="Blocks" value={fmtNum(t!.blocks)} />
            <StatBox label="Avg row len" value={t!.avgRowLen == null ? "—" : `${t!.avgRowLen} B`} />
            <StatBox label="Last analyzed" value={fmtDate(t!.lastAnalyzed)} />
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-mute">Status:</span>
            <Badge tone={t!.stale ? "warn" : "ok"}>{t!.stale ? "STALE" : "FRESH"}</Badge>
            {locked && <Badge tone="warn">LOCKED</Badge>}
          </div>

          {stats!.columns.length > 0 && (
            <section>
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">Column statistics</h4>
              <div className="border border-bdr rounded-lg overflow-x-auto">
                <table className="w-full text-[12px] min-w-[560px]">
                  <thead>
                    <tr className="bg-panel3 text-left text-[10.5px] uppercase tracking-wider text-mute">
                      <th className="px-2.5 py-2 font-semibold">Column</th>
                      <th className="px-2.5 py-2 font-semibold text-right">Distinct</th>
                      <th className="px-2.5 py-2 font-semibold text-right">Nulls</th>
                      <th className="px-2.5 py-2 font-semibold">Histogram</th>
                      <th className="px-2.5 py-2 font-semibold">Last analyzed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats!.columns.map((c) => (
                      <tr key={c.name} className="border-t border-bdrsoft">
                        <td className="px-2.5 py-1.5 font-mono">{c.name}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-soft">{fmtNum(c.numDistinct)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-soft">{fmtNum(c.numNulls)}</td>
                        <td className="px-2.5 py-1.5">{c.histogram && c.histogram !== "NONE" ? <Badge tone="accent">{c.histogram}</Badge> : <span className="text-mute">none</span>}</td>
                        <td className="px-2.5 py-1.5 text-mute">{fmtDate(c.lastAnalyzed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {stats!.indexes.length > 0 && (
            <section>
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">Index statistics</h4>
              <div className="border border-bdr rounded-lg overflow-x-auto">
                <table className="w-full text-[12px] min-w-[680px]">
                  <thead>
                    <tr className="bg-panel3 text-left text-[10.5px] uppercase tracking-wider text-mute">
                      <th className="px-2.5 py-2 font-semibold">Index</th>
                      <th className="px-2.5 py-2 font-semibold text-right">Rows</th>
                      <th className="px-2.5 py-2 font-semibold text-right">Distinct keys</th>
                      <th className="px-2.5 py-2 font-semibold text-right">Leaf blocks</th>
                      <th className="px-2.5 py-2 font-semibold text-right">Clustering</th>
                      <th className="px-2.5 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats!.indexes.map((ix) => (
                      <tr key={ix.name} className="border-t border-bdrsoft">
                        <td className="px-2.5 py-1.5 font-mono">{ix.name}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-soft">{fmtNum(ix.numRows)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-soft">{fmtNum(ix.distinctKeys)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-soft">{fmtNum(ix.leafBlocks)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-soft">{fmtNum(ix.clusteringFactor)}</td>
                        <td className="px-2.5 py-1.5"><Badge tone={ix.stale ? "warn" : "ok"}>{ix.stale ? "STALE" : "FRESH"}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- Storage / tablespace tab ---------------- */

const fmtBytes = (n: number | null) => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
};

const COMPRESSION_OPTS: { value: StorageCompression; label: string }[] = [
  { value: "KEEP", label: "Keep current" },
  { value: "NONE", label: "None (uncompressed)" },
  { value: "BASIC", label: "Basic" },
  { value: "ADVANCED", label: "Advanced" },
];

function StoragePanel({
  table,
  editable,
  storage,
  storageLoading,
  applying,
  onRefresh,
  runStorageAction,
}: {
  table: string;
  editable: boolean;
  storage: TableStorage | null;
  storageLoading: boolean;
  applying: boolean;
  onRefresh: () => void;
  runStorageAction: (action: StorageAction, params: StorageParams, spec: ActionSpec) => void;
}) {
  const t = storage?.table ?? null;
  const busy = applying || storageLoading;
  const partitioned = !!t?.partitioned;
  const compressed = t?.compression === "ENABLED";
  const [targetTs, setTargetTs] = useState("");
  const [compression, setCompression] = useState<StorageCompression>("KEEP");
  const unusable = (storage?.indexes ?? []).filter((ix) => ix.status && ix.status !== "VALID" && ix.status !== "N/A");

  if (!t) {
    return (
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mr-auto">Storage &amp; tablespace</h3>
          <Btn variant="ghost" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={12} /> Refresh
          </Btn>
        </div>
        <div className="rounded-lg border border-bdr bg-panel2 p-4 text-[12px] text-mute flex items-center gap-2">
          <AlertTriangle size={14} className="text-mute shrink-0" />
          No storage information is available for {table} (no allocated segment yet).
        </div>
      </div>
    );
  }

  const effectiveTs = targetTs || t.tablespace || "";
  const moveChangesTs = !!targetTs && targetTs !== t.tablespace;
  const moveChangesComp = compression !== "KEEP";
  const canMove = editable && !partitioned && (moveChangesTs || moveChangesComp);

  const compressionLabel = compressed ? t.compressFor ?? "YES" : "None";

  const doMove = () => {
    const parts: string[] = [];
    if (moveChangesTs) parts.push(`to tablespace ${targetTs}`);
    if (moveChangesComp) parts.push(compression === "NONE" ? "removing compression" : `with ${compression.toLowerCase()} compression`);
    runStorageAction(
      "move",
      { tablespace: targetTs || undefined, compression },
      {
        title: `Reorganize ${table}?`,
        body: `ALTER TABLE MOVE ${parts.join(" and ")} rewrites every row (${fmtNum(t.numRows)} est.) and can be expensive. Indexes may be left UNUSABLE — rebuild them afterwards.`,
        confirmLabel: "Move / reorganize",
        danger: true,
        okMsg: `${table} reorganized.`,
      }
    );
    setTargetTs("");
    setCompression("KEEP");
  };

  return (
    <div className="max-w-5xl space-y-4">
      {/* toolbar */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mr-auto">Storage &amp; tablespace</h3>
        <Btn variant="ghost" onClick={onRefresh} disabled={busy} title="Reload storage info">
          <RefreshCw size={12} /> Refresh
        </Btn>
      </div>

      {partitioned && (
        <div className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-[12px] text-warn flex items-center gap-1.5">
          <AlertTriangle size={13} /> This is a partitioned table — reorganization and shrink actions are disabled here (they need per-partition control).
        </div>
      )}

      {/* segment tiles */}
      <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatBox label="Segment size" value={fmtBytes(t.sizeBytes)} />
        <StatBox label="Blocks" value={fmtNum(t.blocks)} />
        <StatBox label="Extents" value={fmtNum(t.extents)} />
        <StatBox label="Tablespace" value={t.tablespace ?? "—"} />
        <StatBox label="Compression" value={compressionLabel} />
        <StatBox label="Logging" value={t.logging == null ? "—" : t.logging ? "LOGGING" : "NOLOGGING"} />
      </div>
      <div className="flex items-center gap-3 text-[12px] text-mute flex-wrap">
        <span>Est. rows: <span className="font-mono text-soft">{fmtNum(t.numRows)}</span></span>
        <span>Avg row: <span className="font-mono text-soft">{t.avgRowLen == null ? "—" : `${t.avgRowLen} B`}</span></span>
        <span>PCTFREE: <span className="font-mono text-soft">{fmtNum(t.pctFree)}</span></span>
        <span>INITRANS: <span className="font-mono text-soft">{fmtNum(t.iniTrans)}</span></span>
      </div>

      {/* reorganize */}
      {editable && !partitioned && (
        <section className="rounded-lg border border-bdr bg-panel2 p-3 space-y-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-mute">Reorganize (ALTER TABLE MOVE)</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-[11px] font-semibold text-soft mb-1">Target tablespace</span>
              <select className={inputCls} value={effectiveTs} onChange={(e) => setTargetTs(e.target.value)}>
                {(storage?.tablespaces ?? []).length === 0 && t.tablespace && <option value={t.tablespace}>{t.tablespace}</option>}
                {(storage?.tablespaces ?? []).map((ts) => (
                  <option key={ts.name} value={ts.name}>
                    {ts.name}
                    {ts.name === t.tablespace ? " (current)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-soft mb-1">Compression</span>
              <select className={inputCls} value={compression} onChange={(e) => setCompression(e.target.value as StorageCompression)}>
                {COMPRESSION_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-[11.5px] text-mute">
              Moves the table segment{moveChangesTs ? ` to ${targetTs}` : ""}
              {moveChangesComp ? `, ${compression === "NONE" ? "uncompressed" : `${compression.toLowerCase()} compression`}` : ""}. Rewrites all rows.
            </p>
            <Btn variant="primary" className="ml-auto" onClick={doMove} disabled={!canMove || busy}>
              <Move size={12} /> Move / reorganize
            </Btn>
          </div>
        </section>
      )}

      {/* maintenance */}
      {editable && !partitioned && (
        <section className="rounded-lg border border-bdr bg-panel2 p-3 space-y-2.5">
          <div className="text-[11px] font-bold uppercase tracking-wider text-mute">Maintenance</div>
          <div className="flex items-center gap-2 flex-wrap">
            <Btn
              variant="outline"
              disabled={busy}
              onClick={() =>
                runStorageAction("shrink", {}, {
                  title: `Shrink space of ${table}?`,
                  body: `Enables row movement and runs ALTER TABLE SHRINK SPACE to reclaim unused blocks below the high-water mark. May move rows.`,
                  confirmLabel: "Shrink space",
                  okMsg: `${table} shrunk — unused space reclaimed.`,
                })
              }
            >
              <Shrink size={12} /> Shrink space
            </Btn>
            <Btn
              variant="outline"
              disabled={busy}
              onClick={() =>
                runStorageAction("logging", { on: !t.logging }, {
                  title: `Set ${table} to ${t.logging ? "NOLOGGING" : "LOGGING"}?`,
                  body: t.logging
                    ? `NOLOGGING skips redo for direct-path operations — faster loads, but those changes aren't recoverable from archived redo until the next backup.`
                    : `LOGGING restores full redo generation for this table.`,
                  confirmLabel: t.logging ? "Set NOLOGGING" : "Set LOGGING",
                  okMsg: `${table} set to ${t.logging ? "NOLOGGING" : "LOGGING"}.`,
                })
              }
            >
              <FileCode2 size={12} /> {t.logging ? "Set NOLOGGING" : "Set LOGGING"}
            </Btn>
          </div>
        </section>
      )}

      {/* index segments */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-mute">Index segments ({storage?.indexes.length ?? 0})</h4>
          {editable && unusable.length > 0 && (
            <Btn
              variant="outline"
              className="ml-auto"
              disabled={busy}
              onClick={() =>
                runStorageAction("rebuildIndexes", {}, {
                  title: `Rebuild all indexes on ${table}?`,
                  body: `Rebuilds every index on ${table} — fixes the ${unusable.length} UNUSABLE index(es) left by a MOVE.`,
                  confirmLabel: "Rebuild all",
                  okMsg: `Indexes on ${table} rebuilt.`,
                })
              }
            >
              <RefreshCw size={12} /> Rebuild all indexes
            </Btn>
          )}
        </div>
        {unusable.length > 0 && (
          <div className="rounded-lg border border-warn/40 bg-warn/5 p-2.5 text-[12px] text-warn flex items-center gap-1.5">
            <AlertTriangle size={13} /> {unusable.length} index(es) are UNUSABLE and must be rebuilt before they'll be used again.
          </div>
        )}
        <div className="border border-bdr rounded-lg overflow-x-auto">
          <table className="w-full text-[12px] min-w-[640px]">
            <thead>
              <tr className="bg-panel3 text-left text-[10.5px] uppercase tracking-wider text-mute">
                <th className="px-2.5 py-2 font-semibold">Index</th>
                <th className="px-2.5 py-2 font-semibold">Tablespace</th>
                <th className="px-2.5 py-2 font-semibold text-right">Size</th>
                <th className="px-2.5 py-2 font-semibold">Status</th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {(storage?.indexes.length ?? 0) === 0 && (
                <tr><td colSpan={5} className="px-2.5 py-4 text-center text-mute">No indexes on this table.</td></tr>
              )}
              {(storage?.indexes ?? []).map((ix) => {
                const bad = ix.status && ix.status !== "VALID" && ix.status !== "N/A";
                return (
                  <tr key={ix.name} className="border-t border-bdrsoft">
                    <td className="px-2.5 py-1.5 font-mono">{ix.name}</td>
                    <td className="px-2.5 py-1.5 font-mono text-mute">{ix.tablespace ?? "—"}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-soft">{fmtBytes(ix.sizeBytes)}</td>
                    <td className="px-2.5 py-1.5"><Badge tone={bad ? "err" : "ok"}>{ix.status || "—"}</Badge></td>
                    <td className="px-2 py-1.5">
                      {editable && (
                        <div className="flex items-center justify-end">
                          <button
                            className="p-1 text-mute hover:text-accenthi rounded disabled:opacity-30"
                            title="Rebuild index"
                            disabled={busy}
                            onClick={() =>
                              runStorageAction("rebuildIndex", { index: ix.name }, {
                                title: `Rebuild index ${ix.name}?`,
                                body: `ALTER INDEX ${ix.name} REBUILD can be expensive on large indexes.`,
                                confirmLabel: "Rebuild",
                                okMsg: `Index ${ix.name} rebuilt.`,
                              })
                            }
                          >
                            <RefreshCw size={12} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ---------------- Optimization advisor tab ---------------- */

const SEVERITY: Record<AdvisorFinding["severity"], { label: string; tone: "err" | "warn" | "accent" | "neutral" }> = {
  high: { label: "HIGH", tone: "err" },
  medium: { label: "MEDIUM", tone: "warn" },
  low: { label: "LOW", tone: "accent" },
  info: { label: "INFO", tone: "neutral" },
};

const CATEGORY_ICON: Record<AdvisorFinding["category"], React.ReactNode> = {
  primaryKey: <KeyRound size={14} />,
  indexes: <ListTree size={14} />,
  statistics: <BarChart3 size={14} />,
  compression: <HardDrive size={14} />,
  partitioning: <Table2 size={14} />,
  chainedRows: <Move size={14} />,
  systemObject: <Lock size={14} />,
};

function AdvisorPanel({
  table,
  editable,
  advisor,
  advisorLoading,
  applying,
  onRefresh,
  runAdvisorFix,
}: {
  table: string;
  editable: boolean;
  advisor: TableAdvisor | null;
  advisorLoading: boolean;
  applying: boolean;
  onRefresh: () => void;
  runAdvisorFix: (fix: AdvisorFix, spec: ActionSpec) => void;
}) {
  const busy = applying || advisorLoading;
  const findings = advisor?.findings ?? [];

  const onFix = (f: AdvisorFinding) => {
    if (!f.fix) return;
    const danger = f.fix.kind === "storage" || (f.fix.statements ?? []).some((st) => /^\s*DROP\b/i.test(st));
    runAdvisorFix(f.fix, {
      title: `${f.fix.label} — ${table}?`,
      body: `${f.detail} ${f.benefit}`,
      confirmLabel: f.fix.label,
      danger,
      okMsg: `${f.fix.label} applied to ${table}.`,
    });
  };

  return (
    <div className="max-w-5xl space-y-4">
      {/* toolbar + summary */}
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mr-auto">Optimization advisor</h3>
        {advisor && (
          <div className="flex items-center gap-1.5">
            {(["high", "medium", "low", "info"] as const).map((sev) =>
              advisor.summary[sev] > 0 ? (
                <Badge key={sev} tone={SEVERITY[sev].tone}>
                  {advisor.summary[sev]} {SEVERITY[sev].label}
                </Badge>
              ) : null
            )}
          </div>
        )}
        <Btn variant="ghost" onClick={onRefresh} disabled={busy} title="Re-run the analysis">
          <RefreshCw size={12} /> Re-analyze
        </Btn>
      </div>

      {!advisor ? (
        <div className="rounded-lg border border-bdr bg-panel2 p-4 text-[12px] text-mute flex items-center gap-2">
          <AlertTriangle size={14} className="text-mute shrink-0" /> Could not analyze {table}.
        </div>
      ) : findings.length === 0 ? (
        <div className="rounded-lg border border-ok/40 bg-ok/5 p-4 text-[12px] text-ok flex items-center gap-2">
          <CheckCircle2 size={16} className="shrink-0" /> No optimization issues found — {table} looks healthy.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {findings.map((f) => {
            const sev = SEVERITY[f.severity];
            return (
              <li key={f.id} className="rounded-lg border border-bdr bg-panel2 p-3">
                <div className="flex items-start gap-2.5">
                  <span className="text-soft mt-0.5 shrink-0">{CATEGORY_ICON[f.category]}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge tone={sev.tone}>{sev.label}</Badge>
                      <span className="text-[13px] font-semibold text-ink">{f.title}</span>
                    </div>
                    <p className="text-[12px] text-soft mt-1.5">{f.detail}</p>
                    <p className="text-[12px] text-mute mt-1 flex items-start gap-1.5">
                      <Lightbulb size={12} className="mt-0.5 shrink-0 text-warn" /> {f.benefit}
                    </p>
                    {f.fix?.statements?.length ? (
                      <pre className="mt-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all p-2 bg-panel3 border border-bdrsoft rounded text-soft">
                        {f.fix.statements.join("\n")}
                      </pre>
                    ) : null}
                  </div>
                  {f.fix ? (
                    editable && (
                      <Btn variant="primary" className="shrink-0" onClick={() => onFix(f)} disabled={busy}>
                        <Wrench size={12} /> {f.fix.label}
                      </Btn>
                    )
                  ) : (
                    <span className="shrink-0 text-[11px] text-mute italic self-center">manual</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {advisor && (
        <p className="text-[11px] text-mute">
          Analyzed {fmtDate(advisor.analyzedAt)}. Read-only checks over schema, statistics and segment metadata — findings are heuristics, review before applying.
        </p>
      )}
    </div>
  );
}

/* ---------------- Compare (schema comparison) tab ---------------- */

const DIFF_TONE: Record<DiffStatus, "ok" | "warn" | "accent" | "err"> = {
  same: "ok",
  changed: "warn",
  sourceOnly: "accent",
  targetOnly: "err",
};
const DIFF_LABEL: Record<DiffStatus, string> = {
  same: "SAME",
  changed: "CHANGED",
  sourceOnly: "ONLY HERE",
  targetOnly: "ONLY IN TARGET",
};

/** Paired list of indexes/constraints matched by definition. */
function DiffList<T>({ title, items }: { title: string; items: ObjectDiff<T>[] }) {
  return (
    <section>
      <h4 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">
        {title} ({items.length})
      </h4>
      {items.length === 0 ? (
        <p className="text-[12px] text-mute">None on either side.</p>
      ) : (
        <ul className="border border-bdr rounded-lg divide-y divide-bdrsoft">
          {items.map((d, i) => (
            <li key={`${d.key}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
              <Badge tone={DIFF_TONE[d.status]}>{DIFF_LABEL[d.status]}</Badge>
              <span className="font-mono text-soft truncate">{d.label}</span>
              {d.renamed && <span className="ml-auto shrink-0 text-[11px] text-mute">named {d.renamed.target} in target</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ComparePanel({
  table,
  connId,
  connections,
  applying,
  runSyncApply,
}: {
  table: string;
  connId: string;
  connections: Connection[];
  applying: boolean;
  runSyncApply: (targetConnId: string, statements: string[], spec: ActionSpec, onDone: () => void) => void;
}) {
  const targets = useMemo(() => connections.filter((c) => c.live && c.engine === "oracle"), [connections]);
  const [targetId, setTargetId] = useState(() => targets.find((c) => c.id !== connId)?.id ?? connId);
  const [targetName, setTargetName] = useState(table);
  const [cmp, setCmp] = useState<TableComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const targetConn = targets.find((c) => c.id === targetId);
  const sameObject = targetId === connId && targetName.trim().toUpperCase() === table.toUpperCase();

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const name = targetName.trim() || table;
      const [src, tgt] = await Promise.all([api.tableMeta(connId, table), api.tableMeta(targetId, name)]);
      if (!src.exists) {
        setErr(src.error ?? `${table} was not found in this connection.`);
        setCmp(null);
        return;
      }
      setCmp(compareTables(src, tgt));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setCmp(null);
    } finally {
      setBusy(false);
    }
  };

  const applySync = () => {
    if (!cmp?.sync.length || !targetConn) return;
    runSyncApply(
      targetId,
      cmp.sync,
      {
        title: `Sync ${targetName || table} on ${targetConn.name}?`,
        body: `${cmp.sync.length} statement(s) will run against ${targetConn.name} to make it match ${table} on this connection. They run in order and stop at the first error.`,
        confirmLabel: "Apply sync",
        danger: cmp.counts.targetOnly > 0,
        okMsg: `${targetName || table} synced on ${targetConn.name}.`,
      },
      run
    );
  };

  return (
    <div className="max-w-5xl space-y-4">
      {/* target picker */}
      <section className="rounded-lg border border-bdr bg-panel2 p-3 space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-mute">
          Compare <span className="font-mono text-soft">{table}</span> against
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="block text-[11px] font-semibold text-soft mb-1">Target connection</span>
            <select
              className={inputCls}
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                setCmp(null);
              }}
            >
              {targets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.id === connId ? " (this connection)" : ""}
                  {c.readOnly ? " — read-only" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold text-soft mb-1">Target table</span>
            <input
              className={`${inputCls} font-mono`}
              value={targetName}
              placeholder={table}
              aria-label="Target table name"
              onChange={(e) => {
                setTargetName(e.target.value.toUpperCase().replace(/[^A-Z0-9_$#]/g, ""));
                setCmp(null);
              }}
            />
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[11.5px] text-mute">The sync script always runs <strong>against the target</strong> — it never changes this table.</p>
          <Btn variant="primary" className="ml-auto" onClick={run} disabled={busy || applying || sameObject || !targets.length}>
            {busy ? <Loader2 size={12} className="df-spin" /> : <GitCompare size={12} />} Compare
          </Btn>
        </div>
        {sameObject && <p className="text-[11.5px] text-warn">That is the same object — pick a different connection or table name.</p>}
      </section>

      {err && (
        <div className="rounded-lg border border-err/40 bg-err/5 p-3 text-[12px] text-err flex items-start gap-1.5">
          <XCircle size={13} className="mt-0.5 shrink-0" /> {err}
        </div>
      )}

      {cmp && (
        <>
          {/* summary */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {cmp.identical ? (
              <span className="text-[12px] text-ok flex items-center gap-1.5">
                <CheckCircle2 size={14} /> Identical — no structural differences.
              </span>
            ) : (
              <>
                {cmp.counts.changed > 0 && <Badge tone="warn">{cmp.counts.changed} CHANGED</Badge>}
                {cmp.counts.sourceOnly > 0 && <Badge tone="accent">{cmp.counts.sourceOnly} ONLY HERE</Badge>}
                {cmp.counts.targetOnly > 0 && <Badge tone="err">{cmp.counts.targetOnly} ONLY IN TARGET</Badge>}
                <Badge tone="ok">{cmp.counts.same} SAME</Badge>
              </>
            )}
            {!cmp.targetExists && <Badge tone="err">TARGET MISSING</Badge>}
          </div>

          {cmp.notes.map((n, i) => (
            <p key={i} className="text-[12px] text-warn flex items-start gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {n}
            </p>
          ))}

          {/* columns */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">Columns ({cmp.columns.length})</h4>
            <div className="border border-bdr rounded-lg overflow-x-auto">
              <table className="w-full text-[12px] min-w-[720px]">
                <thead>
                  <tr className="bg-panel3 text-left text-[10.5px] uppercase tracking-wider text-mute">
                    <th className="px-2.5 py-2 font-semibold">Column</th>
                    <th className="px-2.5 py-2 font-semibold">This connection</th>
                    <th className="px-2.5 py-2 font-semibold">Target</th>
                    <th className="px-2.5 py-2 font-semibold">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.columns.map((c) => (
                    <tr key={c.name} className="border-t border-bdrsoft align-top">
                      <td className="px-2.5 py-1.5 font-mono">{c.name}</td>
                      <td className="px-2.5 py-1.5 font-mono text-soft">
                        {c.source ? `${c.source.dataType}${c.source.nullable ? "" : " NOT NULL"}` : <span className="text-mute">—</span>}
                      </td>
                      <td className="px-2.5 py-1.5 font-mono text-soft">
                        {c.target ? `${c.target.dataType}${c.target.nullable ? "" : " NOT NULL"}` : <span className="text-mute">—</span>}
                      </td>
                      <td className="px-2.5 py-1.5">
                        <Badge tone={DIFF_TONE[c.status]}>{DIFF_LABEL[c.status]}</Badge>
                        {c.changes.length > 0 && <span className="ml-1.5 text-[11px] text-mute">{c.changes.join("; ")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <DiffList title="Indexes" items={cmp.indexes} />
          <DiffList title="Constraints" items={cmp.constraints} />

          {cmp.tableCommentDiff && (
            <p className="text-[12px] text-soft">
              Table comment differs — target: <span className="text-mute">{cmp.tableCommentDiff.target || "(none)"}</span>
            </p>
          )}

          {/* sync script */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-mute">
                Sync script — target ← this table {cmp.sync.length ? `(${cmp.sync.length})` : ""}
              </h4>
              {cmp.sync.length > 0 && (
                <Btn
                  variant="primary"
                  className="ml-auto"
                  onClick={applySync}
                  disabled={applying || busy || !!targetConn?.readOnly}
                  title={targetConn?.readOnly ? "The target connection is read-only" : `Run these statements against ${targetConn?.name}`}
                >
                  <Play size={12} /> Apply to target
                </Btn>
              )}
            </div>
            {cmp.sync.length ? (
              <Sql sql={cmp.sync.join("\n")} />
            ) : (
              <p className="text-[12px] text-ok flex items-center gap-1.5">
                <CheckCircle2 size={13} /> Nothing to sync — the target already matches.
              </p>
            )}
            {targetConn?.readOnly && cmp.sync.length > 0 && (
              <p className="mt-2 text-[11.5px] text-warn">{targetConn.name} is read-only — copy the script to a worksheet on a writable connection instead.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
