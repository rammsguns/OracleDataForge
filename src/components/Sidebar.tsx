import { useEffect, useMemo, useState } from "react";
import {
  Braces,
  Cable,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  FolderOpen,
  FunctionSquare,
  GitBranch,
  Hash,
  Inbox,
  Layers,
  Link2,
  ListOrdered,
  Lock,
  Package,
  PanelLeftClose,
  Pencil,
  PlugZap,
  Plus,
  RefreshCcw,
  Unplug,
  Search,
  Share2,
  Sigma,
  Table2,
  Trash2,
  Users,
  Zap,
  Eye,
} from "lucide-react";
import { ENGINE_LABEL, schemaForConnection, type SchemaDef } from "../data/catalog";
import { schemaOf, useStudio } from "../state/store";
import { api } from "../utils/api";
import { NEW_TABLE_SENTINEL } from "../utils/tableDdl";
import { download, toCsv, toJson } from "../utils/sql";
import { ContextMenu, Spinner } from "./ui";
import type { MenuItem } from "../types";

type LiveSchemaState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; schema: SchemaDef; rowCounts: Record<string, number> };

const KIND_ICON: Record<string, React.ReactNode> = {
  database: <Database size={13} />,
  table: <Table2 size={13} />,
  view: <Eye size={13} />,
  procedure: <FileCode2 size={13} />,
  function: <FunctionSquare size={13} />,
  package: <Package size={13} />,
  trigger: <Zap size={13} />,
  sequence: <Hash size={13} />,
  index: <ListOrdered size={13} />,
  synonym: <Link2 size={13} />,
  job: <CalendarClock size={13} />,
  user: <Users size={13} />,
  operator: <Sigma size={13} />,
  queue: <Inbox size={13} />,
  type: <Braces size={13} />,
  dblink: <Cable size={13} />,
  publicdblink: <Cable size={13} />,
  directory: <FolderOpen size={13} />,
  edition: <GitBranch size={13} />,
  xmlschema: <FileCode2 size={13} />,
  analyticview: <Eye size={13} />,
  graph: <Share2 size={13} />,
  recycle: <Trash2 size={13} />,
};

/** Real metadata query seeded into the worksheet when a live (non-table) object is clicked. */
function liveMetaQuery(kind: string, rawName: string): string {
  // values are used as string literals — escaping quotes is what matters
  const n = rawName.replace(/'/g, "''");
  switch (kind) {
    case "procedure":
    case "function":
    case "package":
    case "trigger":
    case "type":
      return `SELECT line, text FROM user_source\nWHERE name = '${n}'\nORDER BY type, line;`;
    case "sequence":
      return `SELECT * FROM user_sequences WHERE sequence_name = '${n}';`;
    case "index":
      return `SELECT * FROM user_indexes WHERE index_name = '${n}';`;
    case "synonym":
      return `SELECT * FROM all_synonyms\nWHERE synonym_name = '${n}' AND owner IN (USER, 'PUBLIC');`;
    case "job":
      return `SELECT * FROM user_scheduler_jobs WHERE job_name = '${n}';`;
    case "user":
      return `SELECT * FROM all_users WHERE username = '${n}';`;
    case "operator":
      return `SELECT * FROM user_operators WHERE operator_name = '${n}';`;
    case "queue":
      return `SELECT * FROM user_queues WHERE name = '${n}';`;
    case "dblink":
      return `SELECT * FROM user_db_links WHERE db_link = '${n}';`;
    case "publicdblink":
      return `SELECT * FROM all_db_links\nWHERE owner = 'PUBLIC' AND db_link = '${n}';`;
    case "directory":
      return `SELECT * FROM all_directories WHERE directory_name = '${n}';`;
    case "edition":
      return `SELECT * FROM all_editions WHERE edition_name = '${n}';`;
    case "xmlschema":
      return `SELECT * FROM user_xml_schemas WHERE schema_url = '${n}';`;
    case "analyticview":
      return `SELECT * FROM user_analytic_views WHERE analytic_view_name = '${n}';`;
    case "graph":
      return `SELECT * FROM user_property_graphs WHERE graph_name = '${n}';`;
    case "recycle":
      return `SELECT object_name, original_name, type, droptime, can_undrop\nFROM user_recyclebin WHERE original_name = '${n}';\n-- To restore: FLASHBACK TABLE ${n} TO BEFORE DROP;`;
    default:
      return `SELECT * FROM user_objects WHERE object_name = '${n}';`;
  }
}

/** Kinds whose source opens in an Object Editor tab on double-click (SQL Developer style). */
const PLSQL_KINDS = new Set(["procedure", "function", "package", "trigger", "type"]);

/**
 * Items rendered per group before "Show more". A dictionary schema has 8,148 views and
 * 19,493 objects; expanding five groups built **103,631 DOM nodes / 56 MB** and pushed
 * editor keystrokes to ~52 ms. Nothing broke, but nobody scrolls a list of 8,148 either
 * — the search box filters all of them in ~13 ms, which is how you actually find one.
 * So the list opens at a usable length and grows on demand, rather than paying for the
 * whole dictionary up front.
 */
const GROUP_PAGE = 200;

/** Multiword kinds whose tab title shouldn't just be capitalised. */
const KIND_LABEL: Record<string, string> = {
  dblink: "DB Link",
  publicdblink: "Public DB Link",
  analyticview: "Analytic View",
  xmlschema: "XML Schema",
  recycle: "Recycle Bin",
  graph: "Graph",
};

/** "package" → "Package", "dblink" → "DB Link" — used in editor tab titles. */
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);

/** `DROP <keyword> <name>` per object kind. Kinds missing here need a PL/SQL call
 *  (jobs, queues, XML schemas) or a name we don't have (a mview log is dropped by its
 *  master table), so they get no Drop entry instead of a statement that can't run. */
const DROP_BY_KIND: Record<string, string> = {
  table: "TABLE",
  view: "VIEW",
  procedure: "PROCEDURE",
  function: "FUNCTION",
  package: "PACKAGE",
  trigger: "TRIGGER",
  sequence: "SEQUENCE",
  index: "INDEX",
  synonym: "SYNONYM",
  type: "TYPE",
  operator: "OPERATOR",
  directory: "DIRECTORY",
  analyticview: "ANALYTIC VIEW",
  dblink: "DATABASE LINK",
  publicdblink: "PUBLIC DATABASE LINK",
  user: "USER",
  database: "DATABASE",
};

/** The tree reuses one kind for several groups — the label tells them apart. */
const DROP_BY_LABEL: Record<string, string> = {
  "Materialized Views": "MATERIALIZED VIEW",
  "Public Synonyms": "PUBLIC SYNONYM",
};
const NO_DROP_LABELS = new Set(["Queues Tables", "Materialized View Logs", "Recycle Bin"]);

const dropKeyword = (kind: string, label: string): string | null =>
  NO_DROP_LABELS.has(label) ? null : DROP_BY_LABEL[label] ?? DROP_BY_KIND[kind] ?? null;

/** Dictionary names are plain uppercase identifiers; quote anything else. */
const identFor = (name: string): string =>
  /^[A-Z][A-Z0-9_$#]*$/.test(name) ? name : `"${name.replace(/"/g, "")}"`;

const STATUS_DOT: Record<string, string> = {
  connected: "bg-ok shadow-[0_0_6px_var(--ok)]",
  idle: "bg-mute",
  error: "bg-err",
};

/** Fetched schema trees, kept outside the component. The Explorer unmounts every time it is
 *  collapsed (App.tsx swaps it for a rail), and re-querying the whole catalog just because the
 *  user reclaimed some editor width would be a pointless round trip — on a large schema, a slow
 *  one. Invalidation is unchanged: `schemaBump` (DDL, connect/disconnect, edited connection)
 *  and the Refresh button both clear it. */
const schemaCache: Record<string, LiveSchemaState> = {};
/** the `schemaBump` the cache was filled at (the store starts at 0) */
let cachedBump = 0;

export default function Sidebar() {
  const s = useStudio();
  const [search, setSearch] = useState("");
  const [connsOpen, setConnsOpen] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ Tables: true });
  /** how many items each group is currently rendering (see GROUP_PAGE) */
  const [shown, setShown] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** id of the connection currently opening/closing its session (blocks double clicks) */
  const [connBusy, setConnBusy] = useState<string | null>(null);
  /** label of the group being re-read on its own (one at a time — they share a session) */
  const [groupBusy, setGroupBusy] = useState<string | null>(null);

  const q = search.trim().toLowerCase();
  const activeConn = s.connections.find((c) => c.id === s.activeConnId);
  const [liveSchemas, setLiveSchemas] = useState<Record<string, LiveSchemaState>>(() => ({ ...schemaCache }));

  // mirror into the module cache so the tree survives collapsing the panel. "loading" is
  // deliberately not cached: its promise dies with this component, so a panel collapsed
  // mid-fetch would come back to a spinner nothing can resolve.
  useEffect(() => {
    for (const k of Object.keys(schemaCache)) delete schemaCache[k];
    for (const [k, v] of Object.entries(liveSchemas)) if (v.status !== "loading") schemaCache[k] = v;
  }, [liveSchemas]);

  // a different schema starts from a short list again, rather than inheriting how far
  // the previous one had been expanded
  useEffect(() => setShown({}), [s.activeConnId]);

  // fetch the real schema when a live connection becomes active
  useEffect(() => {
    const c = activeConn;
    // "idle" = disconnected on purpose — don't re-open a pool behind the user's back
    if (!c?.live || c.status === "idle" || liveSchemas[c.id]) return;
    setLiveSchemas((m) => ({ ...m, [c.id]: { status: "loading" } }));
    api
      .schema(c.id)
      .then((r) =>
        setLiveSchemas((m) => ({
          ...m,
          [c.id]: {
            status: "ready",
            schema: {
              schemaName: r.schemaName,
              groups: [
                { label: "Tables", kind: "table", items: r.tables.map((t) => t.name), invalid: r.invalidTables },
                { label: "Views", kind: "view", items: r.views, invalid: r.invalidViews },
                ...(r.extras ?? []),
              ],
            },
            rowCounts: Object.fromEntries(r.tables.map((t) => [t.name, t.rowCount])),
          },
        }))
      )
      .catch((e: Error) =>
        setLiveSchemas((m) => ({ ...m, [c.id]: { status: "error", message: e.message } }))
      );
  }, [activeConn, liveSchemas]);

  const refreshSchema = (connId: string) =>
    setLiveSchemas((m) => {
      const n = { ...m };
      delete n[connId];
      return n;
    });

  /**
   * Re-read one group (Procedures, Packages, …) and splice it back into the loaded tree.
   * After compiling one package, re-reading the whole dictionary catalog to see a single
   * icon change is the wrong trade — this touches one type and leaves the rest untouched,
   * including how far each other group had been expanded.
   */
  const refreshGroupAsync = async (connId: string, label: string, quiet = false) => {
    try {
      const g = await api.schemaGroup(connId, label);
      setLiveSchemas((m) => {
        const cur = m[connId];
        if (cur?.status !== "ready") return m; // the tree was dropped while we were reading
        return {
          ...m,
          [connId]: {
            ...cur,
            schema: {
              ...cur.schema,
              groups: cur.schema.groups.map((x) =>
                x.label === label ? { ...x, items: g.items, invalid: g.invalid } : x
              ),
            },
            rowCounts: g.rowCounts ? { ...cur.rowCounts, ...g.rowCounts } : cur.rowCounts,
          },
        };
      });
      const bad = g.invalid?.length ?? 0;
      if (!quiet) s.toast("success", `${label} refreshed — ${g.items.length} object(s)${bad ? `, ${bad} invalid` : ""}`);
    } catch (e) {
      if (!quiet) s.toast("error", `Could not refresh ${label} — ${(e as Error).message}`);
    }
  };

  const refreshGroup = (connId: string, label: string) => {
    if (groupBusy) return;
    setGroupBusy(label);
    void refreshGroupAsync(connId, label).finally(() => setGroupBusy(null));
  };

  /**
   * Targeted refresh requested from elsewhere (a compile run reports which groups it
   * touched). Serial on purpose — the groups share one pooled session, which is the same
   * reason the per-group Refresh button allows only one at a time.
   */
  useEffect(() => {
    const { labels } = s.groupRefresh;
    const connId = s.activeConnId;
    if (!labels.length || !connId) return;
    let cancelled = false;
    setGroupBusy(labels[0]);
    void (async () => {
      for (const label of labels) {
        if (cancelled) return;
        setGroupBusy(label);
        await refreshGroupAsync(connId, label, true);
      }
      if (!cancelled) setGroupBusy(null);
    })();
    return () => { cancelled = true; };
    // keyed on seq so asking for the same groups twice still runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.groupRefresh.seq]);

  /** Runs a connect/disconnect action, keeping the row's buttons busy until it settles. */
  const runConnAction = (id: string, fn: (id: string) => Promise<void>) => {
    if (connBusy) return;
    setConnBusy(id);
    void fn(id).finally(() => setConnBusy(null));
  };

  // successful DDL or an edited connection bumps this counter — drop all cached schemas.
  // Compared against the module-level `cachedBump` rather than "> 0": this effect also runs on
  // every *mount*, and the panel now mounts again each time it is expanded, so a plain
  // "bump > 0" would wipe the cache on expand and refetch the whole catalog.
  useEffect(() => {
    if (s.schemaBump !== cachedBump) {
      cachedBump = s.schemaBump;
      setLiveSchemas({});
    }
  }, [s.schemaBump]);

  const liveState = activeConn?.live ? liveSchemas[activeConn.id] : undefined;
  const schema: SchemaDef =
    liveState?.status === "ready" ? liveState.schema : schemaForConnection(activeConn);
  const liveRowCounts = liveState?.status === "ready" ? liveState.rowCounts : undefined;
  const browsed = schemaOf(activeConn) ?? schema.schemaName;
  const schemaLabel = !activeConn ? "no connection" : `${browsed} schema`;
  const filteredConns = useMemo(
    () => s.connections.filter((c) => !q || c.name.toLowerCase().includes(q)),
    [s.connections, q]
  );
  const filteredGroups = useMemo(
    () =>
      schema.groups
        .map((g) => ({
          ...g,
          items: g.items.filter((i) => !q || i.toLowerCase().includes(q)),
          // null (not an empty Set) when the group reports no validity — the icons must stay
          // neutral there, since "nothing is invalid" and "we didn't check" are different claims
          invalidSet: g.invalid ? new Set(g.invalid) : null,
        }))
        // empty categories stay visible (like SQL Developer) except while searching
        .filter((g) => (q ? g.items.length > 0 : true)),
    [schema, q]
  );

  // Object Editor tab — reused by kind+payload, so re-opening focuses the existing tab
  const openObjectEditor = (name: string, kind: string) =>
    s.openTab("object", kind === "table" || kind === "view" ? name : `${name} (${kindLabel(kind)})`, name);

  // Live Table Designer (Oracle only) — visual column editor + DDL diff + apply
  const canDesignTable = !!activeConn?.live;
  const canCreateTable = canDesignTable && !activeConn?.readOnly;
  const openTableDesigner = (name: string) => s.openTab("tabledesign", `${name} (Table)`, name);
  const openNewTable = () => s.openTab("tabledesign", "New table", NEW_TABLE_SENTINEL);

  // Run/Test tab (Oracle only): procedures, functions and packages are the runnable kinds
  const canRunRoutine = !!activeConn?.live;
  const openRoutineRunner = (name: string) => s.openTab("run", `${name} (Run)`, name);

  // Compile tab (Oracle only). Read-only connections still get in: the tab is a preview
  // first, and it explains why the button is off instead of hiding the feature.
  const canCompileGroup = !!activeConn?.live;
  const COMPILABLE_KINDS = new Set(["package", "procedure", "function", "trigger", "type", "view", "synonym"]);

  /**
   * Really export the object's rows. This used to be `toast("… export queued — check
   * Downloads")` and no file was ever written, which is worse than not offering it.
   *
   * It reads through /query, so it inherits the server's 1,000-row cap — the toast says
   * so rather than letting a 7,528-row table quietly become a 1,000-row file.
   */
  const exportObject = async (name: string, format: "csv" | "json") => {
    if (!activeConn) return;
    const quoted = `"${name.replace(/"/g, "")}"`;
    s.toast("info", `Reading ${name}…`);
    try {
      const r = await api.query(activeConn.id, `SELECT * FROM ${quoted}`);
      if (r.error) {
        s.toast("error", `Export failed — ${r.error.message}`);
        return;
      }
      const body = format === "csv" ? toCsv(r.columns, r.rows) : toJson(r.columns, r.rows);
      download(`${name.toLowerCase()}.${format}`, body, format === "csv" ? "text/csv" : "application/json");
      s.toast(
        r.truncated ? "warning" : "success",
        r.truncated
          ? `${name}.${format} — first ${r.rows.length.toLocaleString()} rows only (the query cap). Use the worksheet with a WHERE clause for the rest.`
          : `${name}.${format} — ${r.rows.length.toLocaleString()} row(s)`
      );
    } catch (e) {
      s.toast("error", `Export failed — ${(e as Error).message}`);
    }
  };

  const objectMenu = (name: string, kind: string, groupLabel: string): MenuItem[] => {
    const isTable = kind === "table";
    const designable = isTable && canDesignTable;
    const runnable = canRunRoutine && (kind === "procedure" || kind === "function" || kind === "package");
    const dropKw = dropKeyword(kind, groupLabel);
    return [
      ...(isTable || kind === "view"
        ? [{ label: "Open Data", action: () => s.openTab("data", name, name) }]
        : []),
      ...(designable ? [{ label: "Design table…", action: () => openTableDesigner(name) }] : []),
      ...(runnable ? [{ label: "Run / Test…", action: () => openRoutineRunner(name) }] : []),
      ...(canCompileGroup && COMPILABLE_KINDS.has(kind)
        ? [{ label: "Compile…", action: () => s.openTab("compile", `Compile: ${name}`, `object:${name}`) }]
        : []),
      { label: "Edit…", action: () => (designable ? openTableDesigner(name) : openObjectEditor(name, kind)) },
      { label: "Inspect DDL", action: () => openObjectEditor(name, kind) },
      ...(activeConn?.live
        ? [{ label: "View dependencies…", action: () => s.openTab("deps", `Deps: ${name}`, name) }]
        : []),
      { divider: true },
      ...(isTable || kind === "view"
        ? [
            ...(isTable && !activeConn?.readOnly
              ? [{ label: "Import data…", action: () => { s.setSelectedObject(name); s.setImportOpen(true); } }]
              : []),
            { label: "Export as CSV", action: () => void exportObject(name, "csv") },
            { label: "Export as JSON", action: () => void exportObject(name, "json") },
          ]
        : []),
      // dropping is not done from here: the statement is loaded into the worksheet so the
      // user reviews and runs it, which routes through the real destructive-SQL confirm
      // and the read-only guard instead of a dialog that drops behind their back
      ...(dropKw
        ? [
            { divider: true },
            {
              label: `Drop ${kind}…`,
              danger: true,
              action: () => s.insertSql(`DROP ${dropKw} ${identFor(name)};`),
            },
          ]
        : []),
    ];
  };

  return (
    <div className="h-full flex flex-col bg-panel border-r border-bdr min-w-0">
      {/* search + collapse */}
      <div className="p-2.5 border-b border-bdrsoft flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search connections & objects…"
            aria-label="Search connections and schema objects"
            className="w-full h-7.5 pl-8 pr-2 rounded-md bg-panel2 border border-bdr text-[12px] placeholder:text-mute focus:border-accent focus:outline-none"
          />
        </div>
        <button
          onClick={s.toggleSidebar}
          title="Collapse explorer (Ctrl+B)"
          aria-label="Collapse explorer panel"
          className="shrink-0 p-1.5 rounded-md text-mute hover:text-ink hover:bg-panel3 transition-colors"
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {/* connections */}
        <button
          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-mute hover:text-soft"
          onClick={() => setConnsOpen((v) => !v)}
          aria-expanded={connsOpen}
        >
          {connsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Connections
          <span
            role="button"
            tabIndex={0}
            aria-label="New connection"
            title="New connection"
            className="ml-auto p-0.5 rounded hover:bg-panel3 hover:text-accent"
            onClick={(e) => {
              e.stopPropagation();
              s.setWizardOpen(true);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), s.setWizardOpen(true))}
          >
            <Plus size={13} />
          </span>
        </button>
        {connsOpen && s.connections.length === 0 && (
          <p className="px-6 py-2 text-[11.5px] text-mute leading-snug">
            No connections yet — click <Plus size={11} className="inline -mt-0.5" /> above to create a live Oracle connection.
          </p>
        )}
        {connsOpen &&
          filteredConns.map((c) => {
            const startEdit = () => {
              s.setEditingConn(c);
              s.setWizardOpen(true);
            };
            const offline = c.status === "idle";
            const busy = connBusy === c.id;
            const doReconnect = () => runConnAction(c.id, s.reconnectConn);
            const doDisconnect = () => runConnAction(c.id, s.disconnectConn);
            const askRemove = () =>
              s.askConfirm({
                title: `Remove "${c.name}"?`,
                body: c.live
                  ? "The saved connection and its stored credentials will be deleted from this app. The database itself is not affected."
                  : "The saved connection will be removed from this app.",
                confirmLabel: "Remove",
                danger: true,
                onConfirm: () => s.removeConnection(c.id),
              });
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  s.setActiveConnId(c.id);
                  // the real driver message was toasted when the attempt failed — don't invent a code here
                  if (c.status === "error") s.toast("error", `${c.name} is not connected — use Reconnect to try again.`);
                }}
                onKeyDown={(e) => e.key === "Enter" && s.setActiveConnId(c.id)}
                className={`group w-full flex items-center gap-2 pl-6 pr-2.5 py-1.5 text-[12px] cursor-pointer transition-colors ${
                  s.activeConnId === c.id ? "bg-accentdim text-ink border-l-2 border-accent" : "text-soft hover:bg-panel2 border-l-2 border-transparent"
                }`}
                title={`${ENGINE_LABEL[c.engine]} — ${c.host}:${c.port} as ${c.user}${c.readOnly ? " · READ-ONLY" : ""}${offline ? " · NOT CONNECTED" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      ...(c.live
                        ? [
                            { label: offline ? "Connect" : "Reconnect", action: doReconnect },
                            ...(offline ? [] : [{ label: "Disconnect", action: doDisconnect }]),
                          ]
                        : [{ label: "Connect", action: () => s.setActiveConnId(c.id) }]),
                      // opens the tab; it previews what is broken and asks before compiling
                      ...(c.engine === "oracle" && c.live
                        ? [{
                            label: "Compile invalid objects…",
                            action: () => { s.setActiveConnId(c.id); s.openTab("compile", `Compile: ${c.name}`, "schema"); },
                          }]
                        : []),
                      { divider: true },
                      { label: "Edit connection…", action: startEdit },
                      { divider: true },
                      { label: "Remove connection…", danger: true, action: askRemove },
                    ],
                  });
                }}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[c.status]}`} aria-label={c.status} />
                <Database size={13} className="shrink-0" style={{ color: c.color }} />
                <span className="truncate">{c.name}</span>
                {c.readOnly && (
                  <Lock size={11} className="shrink-0 text-warn" aria-label="Read-only connection" />
                )}
                <span className="ml-auto flex items-center gap-0.5 shrink-0">
                  {c.live && (
                    <button
                      aria-label={`${offline ? "Connect" : "Reconnect"} ${c.name}`}
                      title={
                        offline
                          ? "Connect — opens a new session"
                          : "Reconnect — closes the pooled sessions and opens a new one"
                      }
                      disabled={busy}
                      className={`p-1 rounded text-mute hover:text-ok hover:bg-panel3 disabled:opacity-40 transition-opacity ${
                        offline ? "text-ok" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        doReconnect();
                      }}
                    >
                      <PlugZap size={12} />
                    </button>
                  )}
                  {c.live && !offline && (
                    <button
                      aria-label={`Disconnect ${c.name}`}
                      title="Disconnect — closes the pooled sessions (the connection stays saved)"
                      disabled={busy}
                      className="p-1 rounded text-mute hover:text-warn hover:bg-panel3 disabled:opacity-40 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        doDisconnect();
                      }}
                    >
                      <Unplug size={12} />
                    </button>
                  )}
                  <button
                    aria-label={`Edit connection ${c.name}`}
                    title="Edit connection"
                    className="p-1 rounded text-mute hover:text-accenthi hover:bg-panel3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit();
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    aria-label={`Remove connection ${c.name}`}
                    title="Remove connection"
                    className="p-1 rounded text-mute hover:text-err hover:bg-panel3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      askRemove();
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                  <span className="text-[10px] text-mute uppercase group-hover:hidden">{ENGINE_LABEL[c.engine]}</span>
                </span>
              </div>
            );
          })}

        {/* schema tree (follows the active connection) */}
        <div className="mt-2 px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-mute flex items-center gap-1.5">
          <Layers size={12} />
          {/* the schema being browsed — the Oracle user, not the service name (FREEPDB1 is the PDB) */}
          <span
            className="truncate"
            title={
              activeConn?.engine === "oracle" && activeConn.database
                ? `Service ${activeConn.database} on ${activeConn.host}:${activeConn.port}`
                : undefined
            }
          >
            {schemaLabel}
          </span>
          {activeConn?.live ? (
            <span className="ml-auto flex items-center gap-1">
              <button
                aria-label="Refresh schema"
                title="Refresh schema (re-reads the data dictionary)"
                onClick={() => refreshSchema(activeConn.id)}
                disabled={liveState?.status === "loading"}
                className="p-0.5 rounded hover:bg-panel3 hover:text-accenthi disabled:opacity-50 transition-colors"
              >
                <RefreshCcw size={12} className={liveState?.status === "loading" ? "df-spin" : ""} />
              </button>
              <span className="text-[9px] font-bold bg-ok/15 text-ok rounded px-1 py-0.5 normal-case" title="Real database, reached through the local backend">
                live
              </span>
            </span>
          ) : null}
        </div>
        {!activeConn ? (
          <p className="mx-2.5 my-1.5 border border-bdr rounded-lg px-2.5 py-2 text-[11.5px] text-mute leading-snug">
            Nothing to browse — create or select a connection above.
          </p>
        ) : activeConn.live && activeConn.status === "idle" ? (
          <div className="mx-2.5 my-1.5 border border-bdr rounded-lg px-2.5 py-2 text-[11.5px] text-mute leading-snug">
            <span className="text-soft font-semibold">Not connected</span> — connections don't open a session on their own.
            <button
              className="mt-1.5 flex items-center gap-1 text-accenthi hover:underline text-[11.5px] disabled:opacity-50"
              disabled={connBusy === activeConn.id}
              onClick={() => runConnAction(activeConn.id, s.reconnectConn)}
            >
              <PlugZap size={12} /> Connect
            </button>
          </div>
        ) : activeConn?.status === "error" ? (
          <div className="mx-2.5 my-1.5 border border-err/30 bg-err/8 rounded-lg px-2.5 py-2 text-[11.5px] text-soft">
            <span className="text-err font-semibold">Connection failed</span> — can't browse{" "}
            <span className="font-mono">{schema.schemaName}</span>. Check host/port and retry.
          </div>
        ) : liveState?.status === "loading" ? (
          <div className="px-3 py-3">
            <Spinner label="Reading schema…" />
          </div>
        ) : liveState?.status === "error" ? (
          <div className="mx-2.5 my-1.5 border border-err/30 bg-err/8 rounded-lg px-2.5 py-2 text-[11.5px] text-soft">
            <div>
              <span className="text-err font-semibold">Could not read schema</span> — {liveState.message}
            </div>
            <button
              className="mt-1.5 text-accenthi hover:underline text-[11.5px]"
              onClick={() =>
                setLiveSchemas((m) => {
                  const n = { ...m };
                  delete n[activeConn!.id];
                  return n;
                })
              }
            >
              Retry
            </button>
          </div>
        ) : liveState?.status === "ready" &&
          schema.groups.some((g) => g.kind === "database") &&
          filteredGroups.every((g) => g.items.length === 0) &&
          !q ? (
          <div className="mx-2.5 my-1.5 border border-bdr rounded-lg px-2.5 py-2 text-[11.5px] text-soft">
            No user databases yet. Run{" "}
            <button
              className="font-mono text-accenthi hover:underline"
              onClick={() => {
                s.setSql("CREATE DATABASE my_first_db;");
                s.openTab("worksheet", "Worksheet 1");
                s.toast("info", "Statement loaded — edit the name and run it");
              }}
            >
              CREATE DATABASE …;
            </button>{" "}
            in the worksheet, then refresh below.
            <button
              className="block mt-1.5 text-accenthi hover:underline text-[11.5px]"
              onClick={() =>
                setLiveSchemas((m) => {
                  const n = { ...m };
                  delete n[activeConn!.id];
                  return n;
                })
              }
            >
              Refresh schema
            </button>
          </div>
        ) : (
        filteredGroups.map((g) => {
          const open = openGroups[g.label] ?? (!!q || g.label === "Databases");
          const limit = shown[g.label] ?? GROUP_PAGE;
          const visible = g.items.length > limit ? g.items.slice(0, limit) : g.items;
          const rest = g.items.length - visible.length;
          const badInGroup = g.invalidSet ? g.items.filter((i) => g.invalidSet!.has(i)).length : 0;
          const busy = groupBusy === g.label;
          return (
            <div key={g.label} className="group/grp">
              <div className="flex items-center pr-1.5">
                <button
                  className="flex-1 min-w-0 flex items-center gap-1.5 pl-4 pr-1 py-1 text-[12px] font-semibold text-soft hover:text-ink"
                  onClick={() => setOpenGroups((o) => ({ ...o, [g.label]: !open }))}
                  aria-expanded={open}
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="text-accenthi">{KIND_ICON[g.kind]}</span>
                  {g.label}
                  <span className="ml-auto flex items-center gap-1 text-[10px] font-normal">
                    <span className="text-mute">{g.items.length}</span>
                  </span>
                </button>
                {/* Worth seeing without expanding the group — that's the point of the colors —
                    and worth acting on from the same place. Lives outside the toggle button
                    because a button inside a button is invalid HTML. */}
                {badInGroup > 0 && (
                  canCompileGroup ? (
                    <button
                      className="ml-1 px-1 rounded text-[10px] text-err hover:bg-err/15 shrink-0"
                      title={`${badInGroup} invalid object(s) in ${g.label} — click to compile them`}
                      onClick={() => s.openTab("compile", `Compile: ${g.label}`, `group:${g.label}`)}
                    >
                      {badInGroup} invalid
                    </button>
                  ) : (
                    <span className="ml-1 px-1 text-[10px] text-err shrink-0" title={`${badInGroup} invalid object(s) in ${g.label}`}>
                      {badInGroup} invalid
                    </span>
                  )
                )}
                {activeConn?.live && liveState?.status === "ready" && (
                  <button
                    // an expanded group is the one being worked on — keep its refresh in plain
                    // sight there, and out of the way on the two dozen collapsed ones
                    className={`ml-1 p-0.5 rounded text-mute hover:text-accenthi hover:bg-panel3 disabled:opacity-50 shrink-0 transition-opacity ${
                      open || busy ? "opacity-100" : "opacity-0 group-hover/grp:opacity-100 focus-visible:opacity-100"
                    }`}
                    title={`Refresh ${g.label} — re-reads only this type`}
                    aria-label={`Refresh ${g.label}`}
                    disabled={!!groupBusy}
                    onClick={() => refreshGroup(activeConn.id, g.label)}
                  >
                    <RefreshCcw size={11} className={busy ? "df-spin" : ""} />
                  </button>
                )}
                {g.label === "Tables" && g.kind === "table" && canCreateTable && (
                  <button
                    className="ml-1 p-0.5 rounded text-mute hover:text-accenthi hover:bg-accentdim transition-colors shrink-0"
                    title="New table…"
                    aria-label="New table"
                    onClick={openNewTable}
                  >
                    <Plus size={13} />
                  </button>
                )}
              </div>
              {open &&
                visible.map((name) => {
                  const rowCount = liveRowCounts?.[name];
                  const bad = g.invalidSet?.has(name) ?? false;
                  const hint =
                    g.kind === "database"
                      ? name
                      : g.kind === "table" && canDesignTable
                        ? `${name} — double-click to design the table`
                        : PLSQL_KINDS.has(g.kind)
                          ? `${name} — double-click to open the source`
                          : `${name} — double-click to see its DDL`;
                  return (
                    <button
                      key={name}
                      className="w-full flex items-center gap-2 pl-10 pr-2.5 py-[3px] text-[12px] text-soft hover:bg-panel2 hover:text-ink font-mono transition-colors"
                      title={
                        bad
                          ? `${hint}\n${g.kind === "index" ? "UNUSABLE or INVALID" : "INVALID"} — the database reports this object as broken`
                          : hint
                      }
                      onClick={() => {
                        if (g.kind === "database") {
                          s.setSql(`SHOW TABLES IN \`${name.replace(/`/g, "")}\`;`);
                          s.openTab("worksheet", "Worksheet 1");
                          s.toast("info", `Query for ${name} loaded — run it, or recreate the connection with this database to browse it`);
                        } else if (g.kind === "table" || g.kind === "view") {
                          s.openTab("data", name, name);
                        } else if (PLSQL_KINDS.has(g.kind)) {
                          // single click only selects — double-click opens the source (SQL Developer style)
                          s.setSelectedObject(name);
                        } else if (activeConn?.live) {
                          // live object: seed a real metadata/source query instead of the mock editor
                          s.setSql(liveMetaQuery(g.kind, name));
                          s.openTab("worksheet", "Worksheet 1");
                          s.toast("info", `Metadata query for ${name} loaded — run it (Ctrl+Enter)`);
                        } else {
                          s.openTab("object", name, name);
                        }
                      }}
                      onDoubleClick={() => {
                        if (g.kind === "table" && canDesignTable) openTableDesigner(name);
                        // every other kind opens its real DDL (DBMS_METADATA)
                        else if (activeConn?.live) openObjectEditor(name, g.kind);
                      }}
                      onContextMenu={(e) => {
                        if (g.kind === "database") return;
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, items: objectMenu(name, g.kind, g.label) });
                      }}
                    >
                      {/* same icon, three states: green = the dictionary says VALID, red = INVALID
                          or UNUSABLE, muted = this group has no validity to report */}
                      <span
                        className={bad ? "text-err" : g.invalidSet ? "text-ok" : "text-mute"}
                        {...(bad ? { role: "img", "aria-label": "invalid" } : {})}
                      >
                        {KIND_ICON[g.kind]}
                      </span>
                      <span className="truncate">{name}</span>
                      {rowCount != null && <span className="ml-auto text-[10px] text-mute font-sans">{Intl.NumberFormat("en", { notation: "compact" }).format(rowCount)}</span>}
                    </button>
                  );
                })}
              {open && rest > 0 && (
                <div className="pl-10 pr-2.5 py-1 text-[11px] text-mute font-sans flex items-center gap-2 flex-wrap">
                  <button
                    className="text-accenthi hover:underline"
                    onClick={() => setShown((m) => ({ ...m, [g.label]: limit + GROUP_PAGE }))}
                  >
                    Show {Math.min(GROUP_PAGE, rest).toLocaleString()} more
                  </button>
                  <span>
                    {rest.toLocaleString()} not shown — search above to find one by name
                  </span>
                </div>
              )}
            </div>
          );
        })
        )}
      </div>

      <div className="border-t border-bdrsoft px-3 py-2 text-[11px] text-mute">
        Right-click an object for actions
      </div>

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
