import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, CircleAlert, Lock, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useStudio } from "../state/store";
import { api, ConfirmRequiredError, type RowChangeRequest, type RowEditColumn, type TableRowsResult } from "../utils/api";
import type { CellValue } from "../types";
import { Badge, Btn, EmptyState, Spinner } from "./ui";

const PAGE = 25;

/** The text a cell's value starts out as in the editor. Oracle stores '' as NULL, so an
 *  empty box and NULL are genuinely the same thing — there is no third state to preserve. */
const asText = (v: CellValue) => (v === null ? "" : String(v));

const draftOf = (row: CellValue[], columns: RowEditColumn[]) =>
  Object.fromEntries(columns.map((c, i) => [c.name, asText(row[i])]));

const blankDraft = (columns: RowEditColumn[]) =>
  Object.fromEntries(columns.filter((c) => c.editable).map((c) => [c.name, ""]));

/** The values the grid read, sent back with every update and delete so the statement can
 *  check it is still the row it showed — a ROWID alone is reused once its row is deleted. */
const snapshotOf = (row: CellValue[], columns: RowEditColumn[]) =>
  Object.fromEntries(columns.flatMap((c, i) => (c.editable ? [[c.name, row[i]] as const] : [])));

/**
 * Editable view of one table's rows. Row identity is the ROWID the backend returns
 * alongside each row — not the primary key, so a table without one is still editable, and
 * a row whose key columns are being changed is still the row it was.
 */
export default function RowEditor({ table, connId }: { table: string; connId: string }) {
  const s = useStudio();
  const [data, setData] = useState<TableRowsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  /** the row being edited, keyed by ROWID so paging or a refresh cannot move it under us */
  const [editing, setEditing] = useState<{ rowId: string; draft: Record<string, string> } | null>(null);
  const [adding, setAdding] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setEditing(null);
    setAdding(null);
    try {
      setData(await api.tableRows(connId, table));
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [connId, table]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = data?.columns ?? [];
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const clampedPage = Math.min(page, pages - 1);
  const first = clampedPage * PAGE;
  const pageRows = rows.slice(first, first + PAGE);

  /**
   * One row change, through the backend's write guard: the first call is deliberately
   * unacknowledged, so the server answers with the wording for the dialog instead of
   * running anything, and only the user's confirmation sends it again with `confirm`.
   */
  const apply = useCallback(
    async (req: RowChangeRequest, confirmed = false): Promise<void> => {
      setBusy(true);
      try {
        const r = await api.changeTableRow(connId, req, confirmed);
        setData((prev) => {
          if (!prev) return prev;
          const next = { ...prev, rows: prev.rows.slice(), rowIds: prev.rowIds.slice() };
          if (r.action === "delete") {
            const i = next.rowIds.indexOf(req.rowId ?? "");
            if (i >= 0) {
              next.rows.splice(i, 1);
              next.rowIds.splice(i, 1);
            }
          } else if (r.row) {
            const i = req.rowId ? next.rowIds.indexOf(req.rowId) : -1;
            if (i >= 0) {
              next.rows[i] = r.row;
              if (r.rowId) next.rowIds[i] = r.rowId;
            } else {
              next.rows.push(r.row);
              next.rowIds.push(r.rowId ?? "");
            }
          }
          return next;
        });
        if (r.action === "insert") {
          setAdding(null);
          // the new row is appended, so land on the page that actually shows it
          setPage(Math.max(0, Math.ceil((rows.length + 1) / PAGE) - 1));
        } else {
          setEditing(null);
        }
        s.toast("success", r.action === "delete" ? "Row deleted" : r.action === "insert" ? "Row inserted" : "Row saved");
      } catch (e) {
        if (e instanceof ConfirmRequiredError) {
          const cf = e.confirmation;
          s.askConfirm({
            title: cf.title,
            body: cf.body,
            confirmLabel: cf.confirmLabel,
            danger: cf.danger,
            onConfirm: () => void apply(req, true),
          });
        } else {
          s.toast("error", (e as Error).message);
        }
      } finally {
        setBusy(false);
      }
    },
    [connId, rows.length, s]
  );

  /** Only the columns the user actually changed — an untouched row saves nothing. */
  const saveEdit = useCallback(() => {
    if (!editing || !data) return;
    const i = data.rowIds.indexOf(editing.rowId);
    if (i < 0) {
      s.toast("warning", "That row is no longer in the grid — refresh and try again");
      return;
    }
    const original = data.rows[i];
    const values: Record<string, string | null> = {};
    columns.forEach((c, ci) => {
      if (!c.editable) return;
      const now = editing.draft[c.name] ?? "";
      if (now !== asText(original[ci])) values[c.name] = now === "" ? null : now;
    });
    if (!Object.keys(values).length) {
      setEditing(null);
      s.toast("info", "Nothing changed");
      return;
    }
    void apply({ table: data.table, action: "update", rowId: editing.rowId, values, original: snapshotOf(original, columns) });
  }, [apply, columns, data, editing, s]);

  const saveNew = useCallback(() => {
    if (!adding || !data) return;
    const values: Record<string, string> = {};
    // only the boxes that were filled in: naming a column and binding NULL overrides its
    // DEFAULT and makes a GENERATED BY DEFAULT identity column fail with ORA-01400, while a
    // column left out of the INSERT is NULL anyway when it has no default
    for (const [name, text] of Object.entries(adding)) if (text !== "") values[name] = text;
    void apply({ table: data.table, action: "insert", values });
  }, [adding, apply, data]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner label={`Reading ${table}…`} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 df-fade">
        <div className="border border-err/40 bg-err/8 rounded-lg p-3.5 max-w-2xl">
          <div className="flex items-center gap-2 text-err font-semibold text-[13px]">
            <CircleAlert size={15} /> Could not open {table} for editing
          </div>
          <div className="mt-1.5 text-[12.5px] text-ink font-mono break-words">{error}</div>
          <div className="mt-2.5">
            <Btn variant="outline" onClick={() => void load()}>
              Retry
            </Btn>
          </div>
        </div>
      </div>
    );
  }

  if (!data.writable) {
    return (
      <EmptyState
        icon={<Lock />}
        title={`${table} cannot be edited here`}
        hint={data.reason ?? "No column of this object holds a type the data grid can write back."}
      />
    );
  }

  const cellCls = "px-2 py-1 border-b border-bdrsoft align-top";
  const inputCls =
    "w-full min-w-24 h-6.5 px-1.5 rounded bg-panel2 border border-bdr text-[11.5px] font-mono text-ink placeholder:text-mute focus:border-accent focus:outline-none";

  const editorInputs = (draft: Record<string, string>, set: (name: string, v: string) => void) =>
    columns.map((c) =>
      c.editable ? (
        <td key={c.name} className={cellCls}>
          <input
            value={draft[c.name] ?? ""}
            maxLength={c.maxLength}
            onChange={(e) => set(c.name, e.target.value)}
            placeholder={c.nullable ? "(null)" : "(not null)"}
            aria-label={`${c.name} (${c.dataType})`}
            className={inputCls}
          />
        </td>
      ) : (
        <td key={c.name} className={`${cellCls} text-mute italic text-[11.5px]`} title={c.reason}>
          not editable
        </td>
      )
    );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* toolbar */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-bdrsoft shrink-0 flex-wrap">
        <Btn
          variant="outline"
          onClick={() => {
            setEditing(null);
            setAdding(blankDraft(columns));
          }}
          disabled={busy || adding !== null}
          title="Insert a new row"
        >
          <Plus size={12} /> Add row
        </Btn>
        <Btn variant="outline" onClick={() => void load()} disabled={busy} title="Re-read the rows from the database">
          <RefreshCw size={12} className={busy ? "df-spin" : ""} /> Refresh
        </Btn>
        <span className="text-[11.5px] text-mute">
          {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}
          {data.truncated ? ` (first ${rows.length.toLocaleString()} only)` : ""}
        </span>
        {data.truncated && <Badge tone="warn">truncated</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          <Btn variant="outline" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={clampedPage === 0}>
            <ChevronLeft size={12} />
          </Btn>
          <span className="text-[11.5px] text-mute tabular-nums">
            {clampedPage + 1} / {pages}
          </span>
          <Btn variant="outline" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={clampedPage >= pages - 1}>
            <ChevronRight size={12} />
          </Btn>
        </div>
      </div>

      {/* every save commits immediately — say so once, up front, not in a toast after the fact */}
      <div className="px-2.5 py-1 text-[11px] text-mute border-b border-bdrsoft shrink-0">
        Each change is one statement against the live database, committed as soon as you confirm it. Rows are matched on ROWID.
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr>
              <th className="px-2 py-1.5 text-left border-b border-bdr w-20" />
              {columns.map((c) => (
                <th key={c.name} className="px-2 py-1.5 text-left border-b border-bdr font-mono font-semibold whitespace-nowrap" title={c.reason}>
                  {c.name}
                  {c.pk && <span className="ml-1 text-accent" title="primary key">PK</span>}
                  <span className="ml-1.5 font-normal text-mute text-[10.5px]">{c.dataType}</span>
                  {!c.editable && <Lock size={10} className="inline ml-1 text-mute" />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {adding && (
              <tr className="bg-accent/5">
                <td className={cellCls}>
                  <div className="flex gap-1">
                    <Btn variant="outline" onClick={saveNew} disabled={busy} title="Insert this row">
                      <Check size={12} />
                    </Btn>
                    <Btn variant="outline" onClick={() => setAdding(null)} disabled={busy} title="Discard">
                      <X size={12} />
                    </Btn>
                  </div>
                </td>
                {editorInputs(adding, (name, v) => setAdding((d) => ({ ...(d ?? {}), [name]: v })))}
              </tr>
            )}
            {pageRows.map((row, i) => {
              const rowId = data.rowIds[first + i];
              const isEditing = editing?.rowId === rowId;
              return (
                <tr key={rowId} className={isEditing ? "bg-accent/5" : "hover:bg-panel2/60"}>
                  <td className={cellCls}>
                    <div className="flex gap-1">
                      {isEditing ? (
                        <>
                          <Btn variant="outline" onClick={saveEdit} disabled={busy} title="Save this row">
                            <Check size={12} />
                          </Btn>
                          <Btn variant="outline" onClick={() => setEditing(null)} disabled={busy} title="Discard changes">
                            <X size={12} />
                          </Btn>
                        </>
                      ) : (
                        <>
                          <Btn
                            variant="outline"
                            onClick={() => {
                              setAdding(null);
                              setEditing({ rowId, draft: draftOf(row, columns) });
                            }}
                            disabled={busy}
                            title="Edit this row"
                          >
                            <Pencil size={12} />
                          </Btn>
                          <Btn
                            variant="outline"
                            onClick={() => void apply({ table: data.table, action: "delete", rowId, original: snapshotOf(row, columns) })}
                            disabled={busy}
                            title="Delete this row"
                          >
                            <Trash2 size={12} className="text-err" />
                          </Btn>
                        </>
                      )}
                    </div>
                  </td>
                  {isEditing
                    ? editorInputs(editing.draft, (name, v) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, [name]: v } } : e)))
                    : columns.map((c, ci) => (
                        <td key={c.name} className={`${cellCls} font-mono max-w-96 truncate`} title={row[ci] === null ? "(null)" : String(row[ci])}>
                          {row[ci] === null ? <span className="text-mute italic">(null)</span> : String(row[ci])}
                        </td>
                      ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && !adding && (
          <div className="py-10">
            <EmptyState icon={<Plus />} title={`${table} has no rows`} hint="Use “Add row” to insert the first one." />
          </div>
        )}
      </div>
    </div>
  );
}
