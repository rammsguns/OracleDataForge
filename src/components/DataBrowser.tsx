import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Pencil, RefreshCw, Table2, Upload } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type LiveQueryResult } from "../utils/api";
import ResultsGrid from "./ResultsGrid";
import RowEditor from "./RowEditor";
import { Btn, Badge, EmptyState, Spinner } from "./ui";

/** Matches the server's own cap, so the grid's `truncated` flag is the real story. */
const PREVIEW_ROWS = 1000;

/** Quoted so a lowercase or mixed-case object resolves as itself — Oracle would otherwise
 *  uppercase the bare name and answer ORA-00942 for a table the tree lists happily. */
const previewSql = (engine: string | undefined, table: string) =>
  engine === "oracle"
    ? `SELECT * FROM "${table.replace(/"/g, "")}" FETCH FIRST ${PREVIEW_ROWS} ROWS ONLY`
    : `SELECT * FROM \`${table.replace(/`/g, "")}\` LIMIT ${PREVIEW_ROWS}`;

export default function DataBrowser({ table }: { table: string }) {
  const s = useStudio();
  const [loading, setLoading] = useState(true);
  const [liveData, setLiveData] = useState<LiveQueryResult | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  /** "edit" swaps the read-only preview for the ROWID-backed row editor */
  const [mode, setMode] = useState<"view" | "edit">("view");
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  // rows are written one statement at a time, so the same roles that may run a write may edit
  const canEdit = (s.accessRole === "Administrator" || s.accessRole === "Developer") && conn?.engine === "oracle" && !conn.readOnly;

  // A different table in the same slot starts read-only again — switching tabs re-renders
  // this component in place rather than remounting it, so the mode would otherwise carry over.
  // The ref keeps this from firing on the first render, where it would undo the request below.
  const shown = useRef(table);
  useEffect(() => {
    if (shown.current === table) return;
    shown.current = table;
    setMode("view");
  }, [table]);

  // "Edit data…" in the tree opens (or re-focuses) this tab and asks for edit mode; tabs are
  // keyed by kind+payload, so the request cannot ride in the payload without opening a second
  // tab for the same table. Declared after the reset above so it wins when both fire.
  const { editDataRequest, setEditDataRequest } = s;
  useEffect(() => {
    if (editDataRequest !== table || !conn) return; // wait for the connection: canEdit needs it
    setEditDataRequest(null);
    if (canEdit) setMode("edit");
  }, [canEdit, conn, editDataRequest, setEditDataRequest, table]);

  useEffect(() => {
    if (!conn || mode === "edit") return;
    setLoading(true);
    setLiveData(null);
    setLiveError(null);
    let cancelled = false;
    api
      .query(conn.id, previewSql(conn.engine, table))
      .then((r) => {
        if (cancelled) return;
        if (r.error) setLiveError(r.error.message);
        else setLiveData(r);
      })
      .catch((e: Error) => !cancelled && setLiveError(`Backend unreachable: ${e.message}`))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [table, conn?.id, conn?.engine, conn, mode, reloads]);

  const openInWorksheet = useCallback(() => {
    s.setSql(`${previewSql(conn?.engine, table)};`);
    s.openTab("worksheet", "Worksheet 1");
    s.toast("info", "Query loaded in worksheet");
  }, [conn?.engine, s, table]);

  // No connection = nothing to show. This used to fall through to fabricated rows from
  // src/data/mock.ts — complete with a row count and a staged 350 ms "Fetching…" spinner —
  // which is indistinguishable from real data on screen.
  if (!conn) {
    return (
      <EmptyState
        icon={<Table2 />}
        title="No connection selected"
        hint={`Pick a connection in the Explorer to browse ${table}.`}
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-bdrsoft shrink-0 flex-wrap">
        <Table2 size={15} className="text-accent" />
        <span className="font-mono font-semibold text-[13px]">{table}</span>
        <Badge tone="ok">live · {conn.database}</Badge>
        {mode === "edit" && <Badge tone="warn">editing rows</Badge>}
        {mode === "view" && liveData && (
          <span className="text-[12px] text-mute hidden md:inline">
            {liveData.rows.length.toLocaleString()} row{liveData.rows.length === 1 ? "" : "s"}
            {liveData.truncated ? ` (first ${PREVIEW_ROWS.toLocaleString()})` : ""} · {liveData.durationMs} ms
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          {mode === "edit" ? (
            <Btn
              variant="outline"
              // re-read on the way out, so the preview shows the rows as they now stand
              onClick={() => {
                setMode("view");
                setReloads((n) => n + 1);
              }}
              title="Leave edit mode and go back to the read-only preview"
            >
              <Table2 size={12} /> Done editing
            </Btn>
          ) : (
            <>
              <Btn variant="outline" onClick={() => setReloads((n) => n + 1)} disabled={loading} title="Re-run the preview query">
                <RefreshCw size={12} className={loading ? "df-spin" : ""} /> Refresh
              </Btn>
              {/* Administrator/Developer on a writable Oracle connection — the same bar the
                  backend enforces on the row endpoint, so the button is never a dead end */}
              {canEdit && (
                <Btn variant="outline" onClick={() => setMode("edit")} title="Edit, insert and delete rows of this table">
                  <Pencil size={12} /> Edit data
                </Btn>
              )}
              {/* shown when it can actually work: the wizard requires a live, writable connection */}
              {!conn.readOnly && (
                <Btn
                  variant="outline"
                  onClick={() => {
                    s.setSelectedObject(table); // or the wizard defaults to the first table in the schema
                    s.setImportOpen(true);
                  }}
                  title="Import CSV / JSON into this table"
                >
                  <Upload size={12} /> Import
                </Btn>
              )}
              <Btn variant="outline" onClick={openInWorksheet}>
                Query in worksheet
              </Btn>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {mode === "edit" ? (
          <RowEditor table={table} connId={conn.id} />
        ) : loading ? (
          <div className="h-full flex items-center justify-center">
            <Spinner label={`Querying ${table} on ${conn.name}…`} />
          </div>
        ) : liveError ? (
          <div className="p-4 df-fade">
            <div className="border border-err/40 bg-err/8 rounded-lg p-3.5 max-w-2xl">
              <div className="flex items-center gap-2 text-err font-semibold text-[13px]">
                <CircleAlert size={15} /> Could not read {table}
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink font-mono break-words">{liveError}</div>
              <div className="mt-2.5">
                <Btn variant="outline" onClick={() => setReloads((n) => n + 1)}>
                  Retry
                </Btn>
              </div>
            </div>
          </div>
        ) : liveData ? (
          <ResultsGrid columns={liveData.columns} rows={liveData.rows} exportName={table.toLowerCase()} dense truncated={liveData.truncated} />
        ) : (
          <EmptyState icon={<Table2 />} title="No data" hint={`${table} returned no rows.`} />
        )}
      </div>
    </div>
  );
}
