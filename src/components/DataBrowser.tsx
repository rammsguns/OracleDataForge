import { useCallback, useEffect, useState } from "react";
import { CircleAlert, RefreshCw, Table2, Upload } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type LiveQueryResult } from "../utils/api";
import ResultsGrid from "./ResultsGrid";
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
  const conn = s.connections.find((c) => c.id === s.activeConnId);

  useEffect(() => {
    if (!conn) return;
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
  }, [table, conn?.id, conn?.engine, conn, reloads]);

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
        {liveData && (
          <span className="text-[12px] text-mute hidden md:inline">
            {liveData.rows.length.toLocaleString()} row{liveData.rows.length === 1 ? "" : "s"}
            {liveData.truncated ? ` (first ${PREVIEW_ROWS.toLocaleString()})` : ""} · {liveData.durationMs} ms
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          <Btn variant="outline" onClick={() => setReloads((n) => n + 1)} disabled={loading} title="Re-run the preview query">
            <RefreshCw size={12} className={loading ? "df-spin" : ""} /> Refresh
          </Btn>
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
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {loading ? (
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
