import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Connection,
  HistoryEntry,
  ResultSet,
  Tab,
  TabKind,
  Toast,
} from "../types";
import { api, type ExplainResult } from "../utils/api";
import { discardEditsFor } from "../utils/editBuffers";
import { discardTableBuffer } from "../utils/tableBuffers";
import { destructiveCheck, formatSql, isReadOnlySql } from "../utils/sql";

export interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

interface Store {
  theme: "dark" | "light";
  toggleTheme: () => void;

  sidebarOpen: boolean;
  toggleSidebar: () => void;

  connections: Connection[];
  addConnection: (c: Connection) => void;
  updateConnection: (c: Connection) => void;
  removeConnection: (id: string) => void;
  /** close the pooled sessions of a live connection (it stays saved) */
  disconnectConn: (id: string) => Promise<void>;
  /** close and re-open the sessions of a live connection, and make it the active one */
  reconnectConn: (id: string) => Promise<void>;
  /** connection being edited in the wizard, or null when creating a new one */
  editingConn: Connection | null;
  setEditingConn: (c: Connection | null) => void;
  activeConnId: string;
  setActiveConnId: (id: string) => void;

  tabs: Tab[];
  activeTabId: string;
  openTab: (kind: TabKind, title: string, payload?: string) => void;
  closeTab: (id: string) => void;
  setActiveTabId: (id: string) => void;
  /** mark a tab as having unsaved changes (shows a dot; closing asks for confirmation) */
  setTabDirty: (id: string, dirty: boolean) => void;
  /** force schema-dependent views (sidebar tree, Versions tab) to refetch */
  bumpSchema: () => void;
  /**
   * Re-read only these tree groups (Packages, Views…), leaving the rest of the loaded
   * catalog alone. `bumpSchema` drops the whole thing and costs ~17 queries against the
   * dictionary — far too much to repaint a handful of icons after a compile.
   */
  refreshGroups: (labels: string[]) => void;
  /** { labels, seq } — the Sidebar watches `seq` so the same labels can be requested twice */
  groupRefresh: { labels: string[]; seq: number };

  sql: string;
  setSql: (s: string) => void;
  running: boolean;
  result: ResultSet | null;
  runSql: (override?: string) => void;
  doFormat: () => void;
  planVisible: boolean;
  setPlanVisible: (v: boolean) => void;
  /** real execution plan of the current worksheet SQL (null until Explain is run) */
  plan: ExplainResult | null;
  planLoading: boolean;
  /** fetch the live EXPLAIN PLAN for the current worksheet statement */
  runExplain: () => void;
  /** increments when a live DDL statement succeeds — schema views should refetch */
  schemaBump: number;

  history: HistoryEntry[];
  toggleFavorite: (id: string) => void;
  /** clear the query log (favorites are kept — they're the user's saved queries) */
  clearHistory: () => void;

  /** place generated or restored SQL into the active worksheet without executing it */
  insertSql: (sql: string) => void;

  toasts: Toast[];
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;

  confirm: ConfirmState | null;
  askConfirm: (c: ConfirmState) => void;
  closeConfirm: () => void;

  wizardOpen: boolean;
  setWizardOpen: (v: boolean) => void;
  importOpen: boolean;
  setImportOpen: (v: boolean) => void;

  selectedObject: string | null;
  setSelectedObject: (o: string | null) => void;
}

/**
 * The schema statements actually run in: the connected Oracle user. The service
 * name identifies the database service, not a schema.
 */
export function schemaOf(conn?: Connection): string | null {
  if (!conn) return null;
  return conn.user.toUpperCase();
}

const Ctx = createContext<Store | null>(null);

let tabSeq = 10;
let toastSeq = 1;
let histSeq = 100;

const BASE_TABS: Tab[] = [{ id: "t1", kind: "worksheet", title: "Worksheet 1" }];

const CONN_STORAGE_KEY = "dataforge-connections";
/** Colours for connections rehydrated from the backend (the wizard picks its own). */
const CONN_COLORS = ["#4f8ef7", "#f4b13e", "#3fbf7f", "#e0665a", "#a97bf0", "#3fb8c4"];
const HIST_STORAGE_KEY = "dataforge-history";
const HIST_MAX = 200;

/* ---- Panel layout (collapsed state + widths) ---- */

const LAYOUT_STORAGE_KEY = "dataforge-layout";

export interface LayoutPrefs {
  sidebarOpen: boolean;
  sidebarWidth: number;
}

export const LAYOUT_DEFAULTS: LayoutPrefs = {
  sidebarOpen: true,
  sidebarWidth: 264,
};

/** How the workspace was last arranged. Collapsing a panel is a deliberate act to gain
 *  editor width — it would be undone by every reload if we didn't remember it. Widths
 *  ride along in the same key; App.tsx clamps them to each panel's own min/max. */
export function loadLayout(): LayoutPrefs {
  try {
    const j = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}") as Partial<LayoutPrefs>;
    const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
    return {
      sidebarOpen: j.sidebarOpen !== false,
      sidebarWidth: num(j.sidebarWidth, LAYOUT_DEFAULTS.sidebarWidth),
    };
  } catch {
    return LAYOUT_DEFAULTS;
  }
}

/** Merge a change into the stored layout (each caller owns only its own fields). */
export function saveLayout(patch: Partial<LayoutPrefs>) {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ ...loadLayout(), ...patch }));
  } catch {
    /* storage unavailable (private mode) — the layout just won't persist */
  }
}

const INITIAL_SQL = `-- Select a live connection in the sidebar and write your SQL here.
-- Ctrl+Enter runs the statement.
`;

/** User-created connections persisted in the browser (passwords stay server-side).
 *  Only live connections survive a reload — sample/demo connections no longer exist.
 *  They all come back as "idle" (not connected): nothing opens a database session
 *  until the user asks for one, and a stored "connected" would be a lie anyway
 *  because the pools of the previous page do not survive the reload. */
function loadStoredConnections(): Connection[] {
  try {
    const arr = JSON.parse(localStorage.getItem(CONN_STORAGE_KEY) ?? "[]") as Connection[];
    return arr
      .filter((c) => c && typeof c.id === "string" && c.live === true)
      .map((c) => ({ ...c, status: "idle" as const }));
  } catch {
    return [];
  }
}

/** Query history persisted in the browser so runs survive a page reload.
 *  Stores only statement metadata + SQL text (never result rows), newest first,
 *  capped to the most recent HIST_MAX entries. Favorites and tags persist too. */
function loadStoredHistory(): HistoryEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(HIST_STORAGE_KEY) ?? "[]") as HistoryEntry[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.id === "string" && typeof e.sql === "string")
      .map((e) => ({ ...e, favorite: !!e.favorite, tags: Array.isArray(e.tags) ? e.tags : [] }))
      .slice(0, HIST_MAX);
  } catch {
    return [];
  }
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [sidebarOpen, setSidebarOpen] = useState(() => loadLayout().sidebarOpen);
  const [connections, setConnections] = useState<Connection[]>(loadStoredConnections);
  const [activeConnId, setActiveConnId] = useState(() => loadStoredConnections()[0]?.id ?? "");
  const [tabs, setTabs] = useState<Tab[]>(BASE_TABS);
  const [activeTabId, setActiveTabId] = useState("t1");
  const [sql, setSql] = useState(INITIAL_SQL);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ResultSet | null>(null);
  const [planVisible, setPlanVisible] = useState(false);
  const [plan, setPlan] = useState<ExplainResult | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [schemaBump, setSchemaBump] = useState(0);
  const [groupRefresh, setGroupRefresh] = useState<{ labels: string[]; seq: number }>({ labels: [], seq: 0 });
  const [history, setHistory] = useState<HistoryEntry[]>(loadStoredHistory);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<Connection | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedObject, setSelectedObject] = useState<string | null>(null);

  const sqlRef = useRef(sql);
  sqlRef.current = sql;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeConnRef = useRef<Connection | undefined>(undefined);
  activeConnRef.current = connections.find((c) => c.id === activeConnId);
  const connectionsRef = useRef<Connection[]>(connections);
  connectionsRef.current = connections;

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  // remember which side panels the user collapsed (see loadLayout)
  useEffect(() => {
    saveLayout({ sidebarOpen });
  }, [sidebarOpen]);

  // keep user-created connections across page reloads
  useEffect(() => {
    try {
      localStorage.setItem(CONN_STORAGE_KEY, JSON.stringify(connections));
    } catch {
      /* storage unavailable (private mode) — connections just won't persist */
    }
  }, [connections]);

  // Reconcile with the backend registry once on load. localStorage paints instantly (no
  // flash of an empty list) but it is per-browser: a different browser, profile or machine
  // used to show "No connections yet" while the server still held them. The registry is the
  // owner of *which* connections exist; localStorage only keeps the per-browser colour.
  // Nothing here opens a session — everything comes back `idle`, as on any reload.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { connections: stored } = await api.list();
        if (cancelled) return;
        setConnections((prev) => {
          const byId = new Map(prev.map((c) => [c.id, c]));
          return stored.map((s, i) => {
            const old = byId.get(s.id);
            return {
              id: s.id,
              name: s.name,
              engine: s.engine as Connection["engine"],
              host: s.host,
              port: s.port,
              user: s.user,
              database: s.database,
              readOnly: s.readOnly,
              live: true,
              status: "idle" as const,
              // keep the colour this browser already showed, so the list doesn't reshuffle
              color: old?.color ?? CONN_COLORS[i % CONN_COLORS.length],
            };
          });
        });
        // Point the active connection at something that exists. It is seeded from
        // localStorage, so a fresh browser (or one whose connection was deleted elsewhere)
        // held "" or a dead id — and every `activeConn` lookup then came back undefined,
        // which the panels used to read as "not live" and answer with sample data.
        setActiveConnId((cur) => (stored.some((c) => c.id === cur) ? cur : stored[0]?.id ?? ""));
      } catch {
        /* backend unreachable — keep whatever localStorage had rather than blanking the list */
      }
    })();
    return () => {
      cancelled = true;
    };
    // once, on mount: the registry only changes through this app's own create/edit/delete,
    // which already update `connections` directly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep query history across page reloads (capped to the most recent HIST_MAX)
  useEffect(() => {
    try {
      localStorage.setItem(HIST_STORAGE_KEY, JSON.stringify(history.slice(0, HIST_MAX)));
    } catch {
      /* storage unavailable or quota exceeded — history just won't persist */
    }
  }, [history]);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = toastSeq++;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const openTab = useCallback((kind: TabKind, title: string, payload?: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.kind === kind && t.payload === payload);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const id = `t${tabSeq++}`;
      setActiveTabId(id);
      return [...prev, { id, kind, title, payload }];
    });
  }, []);

  const doCloseTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        setActiveTabId("t1");
        return BASE_TABS;
      }
      setActiveTabId((cur) => (cur === id ? next[Math.max(0, idx - 1)].id : cur));
      return next;
    });
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      const t = tabsRef.current.find((x) => x.id === id);
      if (t?.dirty) {
        setConfirm({
          title: `Close ${t.title}?`,
          body: "This tab has edits that were not compiled. Closing it discards those changes.",
          confirmLabel: "Discard & close",
          danger: true,
          onConfirm: () => {
            if (t.kind === "object" && t.payload) discardEditsFor(t.payload);
            if (t.kind === "tabledesign" && t.payload) discardTableBuffer(t.payload);
            doCloseTab(id);
          },
        });
        return;
      }
      doCloseTab(id);
    },
    [doCloseTab]
  );

  const setTabDirty = useCallback((id: string, dirty: boolean) => {
    setTabs((prev) =>
      prev.some((t) => t.id === id && (t.dirty ?? false) !== dirty)
        ? prev.map((t) => (t.id === id ? { ...t, dirty } : t))
        : prev
    );
  }, []);

  const bumpSchema = useCallback(() => setSchemaBump((b) => b + 1), []);
  const refreshGroups = useCallback((labels: string[]) => {
    if (!labels.length) return;
    setGroupRefresh((g) => ({ labels, seq: g.seq + 1 }));
  }, []);

  const setConnStatus = useCallback((id: string, status: Connection["status"]) => {
    setConnections((prev) => (prev.some((c) => c.id === id && c.status !== status) ? prev.map((c) => (c.id === id ? { ...c, status } : c)) : prev));
  }, []);

  const pushHistory = useCallback((statement: string, durationMs: number, rows: number, ok: boolean) => {
    const entry: HistoryEntry = {
      // timestamp + counter keeps ids unique across reloads (persisted ids could otherwise collide)
      id: `h${Date.now().toString(36)}${(histSeq++).toString(36)}`,
      sql: statement.trim(),
      ranAt: new Date().toISOString().slice(0, 10) + " " + new Date().toTimeString().slice(0, 5),
      durationMs,
      rows,
      status: ok ? "ok" : "error",
      favorite: false,
      tags: [],
    };
    setHistory((h) => [entry, ...h].slice(0, HIST_MAX));
  }, []);

  const reallyRun = useCallback(
    (statement: string, confirmed = false) => {
      const conn = activeConnRef.current;
      // every connection is live now — nothing selected means nothing to run against
      if (!conn?.live) {
        setResult({
          columns: [], rows: [], durationMs: 0, rowsReturned: 0, statement,
          error: {
            message: "No live connection selected — create or select a connection in the sidebar first.",
            line: 1,
            code: "NO-CONNECTION",
          },
        });
        toast("warning", "No connection selected");
        return;
      }
      setRunning(true);
      setPlanVisible(false);
      api
        .query(conn.id, statement, confirmed)
        .then((res) => {
          // the write guard held this statement back: nothing ran, so don't touch the
          // result grid or history — just ask, using the backend's own wording
          if (res.confirmation) {
            const g = res.confirmation;
            setConfirm({
              title: g.title,
              body: g.body,
              confirmLabel: g.confirmLabel,
              danger: g.danger,
              onConfirm: () => reallyRun(statement, true),
            });
            return;
          }
          setResult({ ...res, statement });
          // the statement reached the database, so a session is open again —
          // running a query is the one implicit way a connection gets connected
          setConnStatus(conn.id, "connected");
          pushHistory(statement, res.durationMs, res.rowsReturned, !res.error);
          if (res.error) toast("error", `${res.error.code}: execution failed`);
          else {
            toast(
              "success",
              `${res.rowsReturned} row(s) in ${res.durationMs} ms${res.truncated ? " (showing first 1,000)" : ""}`
            );
            // DDL changes the catalog — nudge the explorer to refetch the schema
            if (/^\s*(create|drop|alter|truncate|rename|flashback|purge|grant|revoke)\b/i.test(statement)) {
              setSchemaBump((b) => b + 1);
            }
            // the backend auto-versions code objects — surface what it recorded
            const v = res.versioned;
            if (v) {
              if (v.action === "UNCHANGED") toast("info", `${v.type} ${v.name} unchanged — still v${v.version}`);
              else if (v.action === "DROP") toast("info", `${v.type} ${v.name} dropped — logged in change history`);
              else toast("info", `${v.type} ${v.name} saved as v${v.version} in version history`);
            }
          }
        })
        .catch((err: Error) => {
          setResult({
            columns: [], rows: [], durationMs: 0, rowsReturned: 0, statement,
            error: { message: err.message, line: 1, code: "BACKEND" },
          });
          toast("error", "Backend unreachable — is the API server running?");
        })
        .finally(() => setRunning(false));
    },
    [toast, pushHistory, setConnStatus]
  );

  const runSql = useCallback(
    (override?: string) => {
      const statement = override ?? sqlRef.current;
      // read-only connection: block writes before they go anywhere (the backend enforces
      // this too — this is just instant feedback with no round trip)
      if (statement.trim() && !isReadOnlySql(statement) && activeConnRef.current?.readOnly) {
        const d = destructiveCheck(statement);
        setResult({
          columns: [], rows: [], durationMs: 0, rowsReturned: 0, statement,
          error: {
            message: `This connection is read-only — ${d ? `${d.verb} on ${d.target}` : "this statement"} was blocked. Edit the connection to disable read-only mode if you need to make changes.`,
            line: 1,
            code: "READ-ONLY",
          },
        });
        toast("warning", `Blocked: "${activeConnRef.current.name}" is read-only`);
        return;
      }
      // everything else goes to the backend unacknowledged: it runs reads, and answers
      // writes with a confirmation for the dialog above (see reallyRun)
      reallyRun(statement);
    },
    [reallyRun, toast]
  );

  const doFormat = useCallback(() => {
    setSql((s) => formatSql(s));
    toast("info", "SQL formatted");
  }, [toast]);

  const runExplain = useCallback(() => {
    const conn = activeConnRef.current;
    const statement = sqlRef.current.trim();
    if (!conn?.live) {
      setPlan({
        engine: "oracle", plan: null, totalCost: 0,
        error: { message: "No live connection selected — create or select a connection in the sidebar first.", code: "NO-CONNECTION", line: 1 },
      });
      toast("warning", "No connection selected");
      return;
    }
    if (!statement) {
      setPlan({ engine: "oracle", plan: null, totalCost: 0, error: { message: "Nothing to explain — the worksheet is empty.", code: "DF-0001", line: 1 } });
      return;
    }
    setPlanLoading(true);
    api
      .explain(conn.id, statement)
      .then((res) => {
        setPlan(res);
        // running EXPLAIN opens a session, same as running a query
        setConnStatus(conn.id, "connected");
        if (res.error) toast("error", `${res.error.code}: could not build plan`);
      })
      .catch((err: Error) => {
        setPlan({ engine: "oracle", plan: null, totalCost: 0, error: { message: err.message, code: "BACKEND", line: 1 } });
        toast("error", "Backend unreachable — is the API server running?");
      })
      .finally(() => setPlanLoading(false));
  }, [toast, setConnStatus]);

  const insertSql = useCallback(
    (nextSql: string) => {
      setSql(nextSql);
      setActiveTabId((current) => tabs.find((tab) => tab.kind === "worksheet")?.id ?? current);
      toast("info", "SQL inserted into worksheet — review before running");
    },
    [tabs, toast]
  );

  const addConnection = useCallback(
    (c: Connection) => {
      setConnections((prev) => [...prev, c]);
      setActiveConnId(c.id); // a freshly created connection becomes the active one
      toast("success", `Connection "${c.name}" saved`);
    },
    [toast]
  );

  const updateConnection = useCallback(
    (c: Connection) => {
      // the backend recycled the pools on PUT, so the connection is closed again
      setConnections((prev) => prev.map((x) => (x.id === c.id ? { ...c, status: "idle" } : x)));
      setSchemaBump((b) => b + 1); // cached schemas may point at the old target
      toast("success", `Connection "${c.name}" updated — connect again to browse it`);
    },
    [toast]
  );

  const removeConnection = useCallback(
    (id: string) => {
      setConnections((prev) => {
        const conn = prev.find((c) => c.id === id);
        if (conn?.live) api.remove(id).catch(() => {}); // backend forgets the credentials too
        const next = prev.filter((c) => c.id !== id);
        setActiveConnId((cur) => (cur === id ? next[0]?.id ?? "" : cur));
        return next;
      });
      toast("info", "Connection removed");
    },
    [toast]
  );

  // "idle" is what the sidebar reads as disconnected: the pool is closed and the
  // schema tree stops browsing until the connection is opened again.
  const disconnectConn = useCallback(
    async (id: string) => {
      const conn = connectionsRef.current.find((c) => c.id === id);
      if (!conn?.live) return;
      try {
        const r = await api.disconnect(id);
        setConnStatus(id, "idle");
        setSchemaBump((b) => b + 1); // drop the cached catalog of the closed session
        toast("info", r.wasOpen ? `"${conn.name}" disconnected` : `"${conn.name}" had no open session`);
      } catch (e) {
        toast("error", `Could not disconnect "${conn.name}": ${(e as Error).message}`);
      }
    },
    [setConnStatus, toast]
  );

  const reconnectConn = useCallback(
    async (id: string) => {
      const conn = connectionsRef.current.find((c) => c.id === id);
      if (!conn?.live) return;
      try {
        const r = await api.reconnect(id);
        if (!r.ok) {
          setConnStatus(id, "error");
          toast("error", `${conn.name}: ${r.error}`);
          return;
        }
        setConnStatus(id, "connected");
        setActiveConnId(id); // reconnecting is also how you connect — focus it
        setSchemaBump((b) => b + 1); // re-read the catalog through the new session
        toast("success", `"${conn.name}" connected — ${r.version} (${r.ms} ms)`);
      } catch (e) {
        setConnStatus(id, "error");
        toast("error", `Could not reconnect "${conn.name}": ${(e as Error).message}`);
      }
    },
    [setConnStatus, toast]
  );

  const toggleFavorite = useCallback((id: string) => {
    setHistory((h) => h.map((e) => (e.id === id ? { ...e, favorite: !e.favorite } : e)));
  }, []);

  const clearHistory = useCallback(() => {
    setHistory((h) => {
      // keep favorites — they are the user's saved queries, not just a log
      const kept = h.filter((e) => e.favorite);
      toast("info", kept.length ? `History cleared — ${kept.length} favorite(s) kept` : "Query history cleared");
      return kept;
    });
  }, [toast]);

  const value = useMemo<Store>(
    () => ({
      theme,
      toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
      sidebarOpen,
      toggleSidebar: () => setSidebarOpen((v) => !v),
      connections,
      addConnection,
      updateConnection,
      removeConnection,
      disconnectConn,
      reconnectConn,
      editingConn,
      setEditingConn,
      activeConnId,
      setActiveConnId,
      tabs,
      activeTabId,
      openTab,
      closeTab,
      setActiveTabId,
      setTabDirty,
      bumpSchema,
      refreshGroups,
      groupRefresh,
      sql,
      setSql,
      running,
      result,
      runSql,
      doFormat,
      planVisible,
      setPlanVisible,
      plan,
      planLoading,
      runExplain,
      schemaBump,
      history,
      toggleFavorite,
      clearHistory,
      insertSql,
      toasts,
      toast,
      dismissToast,
      confirm,
      askConfirm: setConfirm,
      closeConfirm: () => setConfirm(null),
      wizardOpen,
      setWizardOpen,
      importOpen,
      setImportOpen,
      selectedObject,
      setSelectedObject,
    }),
    [theme, sidebarOpen, connections, addConnection, updateConnection, removeConnection, disconnectConn, reconnectConn, editingConn, activeConnId, tabs, activeTabId, openTab, closeTab, setTabDirty, bumpSchema, refreshGroups, groupRefresh, sql, running, result, runSql, doFormat, planVisible, plan, planLoading, runExplain, schemaBump, history, toggleFavorite, clearHistory, insertSql, toasts, toast, dismissToast, confirm, wizardOpen, importOpen, selectedObject]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStudio(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStudio outside provider");
  return s;
}
