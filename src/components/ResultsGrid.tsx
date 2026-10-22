import { useStudio } from "../state/store";
import HorizontalScrollbar from "./HorizontalScrollbar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  Filter,
  ExternalLink,
  Maximize2,
  Pin,
} from "lucide-react";
import type { CellValue } from "../types";
import { download, toCsv, toJson, toInserts } from "../utils/sql";
import { Btn, Modal } from "./ui";

const PAGE = 10;

/** Long values keep a detail button even when the column is resized. */
const CELL_CLIP = 140;

export default function ResultsGrid({
  columns,
  rows,
  exportName = "results",
  dense,
  exportTable,
  truncated,
  paginate = true,
}: {
  columns: string[];
  rows: CellValue[][];
  exportName?: string;
  dense?: boolean;
  exportTable?: string;
  /** the server stopped at its row cap — say so permanently, not just in a toast */
  truncated?: boolean;
  /** Describe results show the complete column list in one scrollable view. */
  paginate?: boolean;
}) {
  const studio = useStudio();
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertTable, setInsertTable] = useState("");
  const [insertError, setInsertError] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);
  const [columnSearch, setColumnSearch] = useState("");
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [pinned, setPinned] = useState<Set<number>>(new Set());
  const [rowDetail, setRowDetail] = useState<CellValue[] | null>(null);
  useEffect(() => {
    setHidden(new Set()); setPinned(new Set()); setWidths({}); setSort(null); setPage(0); setRowDetail(null);
  }, [columns, rows]);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [colsOpen, setColsOpen] = useState(false);
  /** full value of a clipped cell, opened from the grid */
  const [detail, setDetail] = useState<{ column: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    let out = f ? rows.filter((r) => r.some((c) => c !== null && String(c).toLowerCase().includes(f))) : rows.slice();
    if (sort) {
      out.sort((a, b) => {
        const av = a[sort.col];
        const bv = b[sort.col];
        if (av === null) return 1;
        if (bv === null) return -1;
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
        return String(av).localeCompare(String(bv)) * sort.dir;
      });
    }
    return out;
  }, [rows, filter, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const pageRows = paginate ? filtered.slice(page * PAGE, page * PAGE + PAGE) : filtered;
  const rowOffset = paginate ? page * PAGE : 0;
  const visCols = columns.map((c, i) => ({ name: c, i })).filter((c) => !hidden.has(c.i)).sort((a, b) => Number(pinned.has(b.i)) - Number(pinned.has(a.i)));
  const columnWidth = (i: number) => widths[i] ?? Math.min(260, Math.max(140, columns[i].length * 8 + 60));
  const columnStyle = (i: number) => pinned.has(i) ? { position: "sticky" as const, left: 48 + visCols.slice(0, visCols.findIndex((c) => c.i === i)).reduce((n, c) => n + columnWidth(c.i), 0), zIndex: 2 } : {};


  const fmt = (v: CellValue) => {
    if (v === null) return <span className="text-mute italic">(null)</span>;
    if (typeof v === "number")
      return <span className="tabular-nums">{Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
    return v;
  };

  // Keep the complete value in the cell so resizing can reveal it in full.
  const cellText = (v: CellValue) => (v === null ? "" : String(v));
  const fitColumns = (indices: number[]) => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    const table = gridRef.current?.querySelector("table");
    context.font = table ? getComputedStyle(table).font : "12px monospace";
    const fitted: Record<number, number> = {};
    for (const i of indices) {
      // Include every returned row, regardless of pagination or the current filter.
      let width = context.measureText(columns[i]).width + 76;
      for (const row of rows) {
        const value = row[i];
        const text = value === null ? "(null)" : typeof value === "number"
          ? (Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
          : String(value);
        width = Math.max(width, context.measureText(text).width + 52);
      }
      fitted[i] = Math.max(90, Math.ceil(width));
    }
    setWidths((previous) => ({ ...previous, ...fitted }));
  };


  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 overflow-hidden">
      {/* toolbar */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-bdrsoft shrink-0 flex-wrap">
        <div className="relative">
          <Filter size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-mute" />
          <input
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
            placeholder="Filter rows…"
            aria-label="Filter result rows"
            className="h-6.5 w-44 pl-7 pr-2 rounded bg-panel2 border border-bdr text-[11.5px] placeholder:text-mute focus:border-accent focus:outline-none"
          />
        </div>
        <div className="relative">
          <Btn variant="outline" onClick={() => setColsOpen((v) => !v)} title="Show / hide columns">
            <Columns3 size={12} />
            Columns
          </Btn>
          {colsOpen && (
            <div className="absolute z-40 top-8 left-0 bg-panel border border-bdr rounded-lg shadow-2xl p-2 w-64 max-h-[60vh] overflow-auto df-fade">
              <input aria-label="Search columns" placeholder="Search columns…" value={columnSearch} onChange={(e) => setColumnSearch(e.target.value)} className="w-full rounded border border-bdr bg-panel2 px-2 py-1 text-[12px]" />
              <div className="flex gap-2 py-2 text-[11px]">
                <button onClick={() => setHidden(new Set())} className="hover:text-accent">Show all</button>
                <button onClick={() => setHidden(new Set(columns.map((_, i) => i)))} className="hover:text-accent">Hide all</button>
              </div>
              {columns.map((c, i) => ({ c, i })).filter(({ c }) => c.toLowerCase().includes(columnSearch.toLowerCase())).map(({ c, i }) => (
                <label key={i} className="flex items-center gap-2 px-1.5 py-1 text-[12px] font-mono hover:bg-panel2 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!hidden.has(i)}
                    onChange={() =>
                      setHidden((h) => {
                        const n = new Set(h);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                    className="accent-[var(--accent)]"
                  />
                  {c}
                </label>
              ))}
            </div>
          )}
        </div>
        <Btn variant="outline" title="Fit visible columns to the longest value across all returned rows" onClick={() => fitColumns(visCols.map(({ i }) => i))}>
          <Columns3 size={12} /> Fit columns
        </Btn>
        <div className="ml-auto flex items-center gap-1.5">
          <Btn variant="outline" title="Export all returned rows as INSERT statements" disabled={!rows.length || !columns.length} onClick={() => { setInsertTable(exportTable ?? ""); setInsertError(""); setInsertOpen(true); }}>
            <Download size={12} /> INSERT
          </Btn>
          <Btn variant="outline" title="Export as CSV" onClick={() => download(`${exportName}.csv`, toCsv(columns, filtered), "text/csv")}>
            <Download size={12} /> CSV
          </Btn>
          <Btn variant="outline" title="Export as JSON" onClick={() => download(`${exportName}.json`, toJson(columns, filtered), "application/json")}>
            <Download size={12} /> JSON
          </Btn>
        </div>
      </div>

      {/* grid */}
      <div ref={gridRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0" onClick={() => colsOpen && setColsOpen(false)}>
        <table className="border-separate border-spacing-0 table-fixed text-[12px] font-mono" style={{ width: 48 + visCols.reduce((n, c) => n + columnWidth(c.i), 0) }}>
          <colgroup><col style={{ width: 48 }} />{visCols.map(({ i }) => <col key={i} style={{ width: columnWidth(i) }} />)}</colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th style={{ position: "sticky", left: 0, zIndex: 3 }} className="bg-panel3 border-b border-r border-bdr px-2 py-1.5 text-left text-[10px] text-mute w-10 font-semibold">#</th>
              {visCols.map(({ name, i }) => (
                <th
                  key={i}
                  style={columnStyle(i)}
                  className="bg-panel3 border-b border-r border-bdrsoft px-2.5 py-1.5 text-left text-[11px] font-bold text-soft cursor-pointer hover:text-ink select-none whitespace-nowrap"
                  onClick={() => setSort((s) => (s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 }))}
                  title={`Sort by ${name}`}
                  aria-sort={sort?.col === i ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                >
                  <div className="relative flex items-center gap-1">
                    <button type="button" title={pinned.has(i) ? `Unpin ${name}` : `Pin ${name}`} aria-label={pinned.has(i) ? `Unpin ${name}` : `Pin ${name}`} aria-pressed={pinned.has(i)} onClick={(e) => { e.stopPropagation(); setPinned((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next; }); }} className={pinned.has(i) ? "text-accent shrink-0" : "text-mute shrink-0"}><Pin size={11} /></button>
                    <span className="truncate" title={name}>{name}</span>
                    <div role="separator" aria-orientation="vertical" aria-label={`Resize ${name}`} title="Drag to resize; double-click or press Enter to fit contents" tabIndex={0} onDoubleClick={(e) => { e.stopPropagation(); fitColumns([i]); }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); fitColumns([i]); } if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidths((prev) => ({ ...prev, [i]: Math.max(90, columnWidth(i) + (e.key === "ArrowRight" ? 20 : -20)) })); } }} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) { const th = e.currentTarget.closest("th")!; setWidths((prev) => ({ ...prev, [i]: Math.max(90, e.clientX - th.getBoundingClientRect().left) })); } }} className="absolute -right-2.5 top-0 bottom-0 w-2 cursor-col-resize touch-none hover:bg-accent" />
                    {sort?.col === i && (sort.dir === 1 ? <ArrowUp size={11} className="text-accent" /> : <ArrowDown size={11} className="text-accent" />)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, ri) => (
              <tr key={ri} className="hover:bg-accentdim/60 group">
                <td style={{ position: "sticky", left: 0, zIndex: 3 }} className="border-b border-r border-bdrsoft px-2 text-[10px] text-mute bg-panel"><button className="underline hover:text-accent" title="Open row details" aria-label={`View details for row ${rowOffset + ri + 1}`} onClick={() => setRowDetail(r)}>{rowOffset + ri + 1}</button></td>
                {visCols.map(({ i }) => {
                  const raw = cellText(r[i]);
                  const long = raw.length > CELL_CLIP;
                  return (
                    <td
                      key={i}
                      style={columnStyle(i)}
                      title={raw}
                      onDoubleClick={() => { setCopied(false); setDetail({ column: columns[i], value: raw }); }}
                      className={`border-b border-r border-bdrsoft px-2.5 bg-panel whitespace-nowrap text-ink overflow-hidden text-ellipsis ${dense ? "py-0.5" : "py-1"}`}
                    >
                      {long ? (
                        <span className="inline-flex items-center gap-1.5 max-w-full">
                          <span className="overflow-hidden text-ellipsis">{raw}</span>
                          <button
                            type="button"
                            onClick={() => {
                              setCopied(false);
                              setDetail({ column: columns[i], value: raw });
                            }}
                            className="shrink-0 p-0.5 rounded text-mute hover:text-accent hover:bg-panel3"
                            title={`Show the full ${columns[i]} value (${raw.length.toLocaleString()} characters)`}
                            aria-label={`Show the full ${columns[i]} value`}
                          >
                            <Maximize2 size={11} />
                          </button>
                        </span>
                      ) : (
                        fmt(r[i])
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={visCols.length + 1} className="text-center py-8 text-mute text-[12px] font-sans">
                  {/* an empty result is not a filtered-out result — saying so sent people
                      hunting for a filter they never typed */}
                  {filter.trim() ? "No rows match the current filter." : "The query returned no rows."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <HorizontalScrollbar target={gridRef} contentKey={visCols.map(({ i }) => `${i}:${columnWidth(i)}`).join(",")} />

      {/* pagination */}
      <div className="flex items-center gap-2 px-2.5 py-1 border-t border-bdrsoft text-[11.5px] text-soft shrink-0">
        <span className="tabular-nums">
          {filtered.length.toLocaleString()} row{filtered.length === 1 ? "" : "s"}
          {filter && ` (filtered from ${rows.length.toLocaleString()})`}
          {/* without this the footer reads "1,000 rows", indistinguishable from a
              statement that really returned 1,000 — the toast is long gone by then */}
          {truncated && (
            <span
              className="text-warn"
              title={`The statement returns more rows; the server stopped at ${rows.length.toLocaleString()}. Narrow it with a WHERE clause, or aggregate, to see the rest.`}
            >
              {" "}
              · showing first {rows.length.toLocaleString()} (truncated)
            </span>
          )}
        </span>
        {paginate && <div className="ml-auto flex items-center gap-1">
          <button
            className="p-1 rounded hover:bg-panel3 disabled:opacity-30"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {page + 1} / {pages}
          </span>
          <button
            className="p-1 rounded hover:bg-panel3 disabled:opacity-30"
            disabled={page >= pages - 1}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </button>
        </div>}
      </div>

      {insertOpen && (
        <Modal title="Export INSERT statements" onClose={() => setInsertOpen(false)} width={480}>
          <div className="p-4 space-y-3">
            <label className="block text-[12px]">Destination table
              <input autoFocus aria-label="Destination table" placeholder="SCHEMA.TABLE_NAME" value={insertTable} onChange={(e) => setInsertTable(e.target.value)} className="mt-1 w-full rounded border border-bdr bg-panel2 px-2 py-1 font-mono" />
            </label>
            <p className="text-[12px] text-mute">Exports all {rows.length.toLocaleString()} returned rows and all columns, including rows hidden by the filter.</p>
            {truncated && <p className="text-[12px] text-warn">The result was truncated by the server. Only the returned rows can be exported.</p>}
            <p className="text-[12px] text-mute">Text values are quoted as text. Date and other typed columns may need conversion before running the script.</p>
            {insertError && <p role="alert" className="text-[12px] text-warn">{insertError}</p>}
            <div className="flex gap-2 flex-wrap">
            <Btn variant="outline" onClick={async () => {
              try {
                const sql = toInserts(columns, rows, insertTable);
                let copied = false;
                try {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(sql);
                    copied = true;
                  }
                } catch { /* Try the selection-based fallback for LAN HTTP access. */ }
                if (!copied) {
                  const field = document.createElement("textarea");
                  field.value = sql;
                  field.style.cssText = "position:fixed;left:-9999px;top:0";
                  const focused = document.activeElement;
                  document.body.appendChild(field);
                  try {
                    field.select();
                    copied = document.execCommand("copy");
                  } finally {
                    field.remove();
                    if (focused instanceof HTMLElement) focused.focus();
                  }
                }
                if (!copied) throw new Error("Clipboard access was blocked. Use Download SQL or open in a worksheet to copy the script.");
                setInsertError("");
                studio.toast("success", "INSERT statements copied to clipboard");
              } catch (error) { setInsertError(error instanceof Error ? error.message : "Could not copy to clipboard."); }
            }}><Copy size={12} /> Copy</Btn>
            <Btn variant="outline" disabled={!["Administrator", "Developer", "Viewer"].includes(studio.accessRole)} onClick={() => {
              try {
                studio.openSqlWorksheet(toInserts(columns, rows, insertTable), "INSERT export");
                setInsertOpen(false);
              } catch (error) { setInsertError(error instanceof Error ? error.message : "Could not open worksheet."); }
            }}><ExternalLink size={12} /> Open in new worksheet</Btn>
            <Btn variant="outline" onClick={() => {
              try {
                const sql = toInserts(columns, rows, insertTable);
                download(`${exportName}.sql`, sql, "application/sql");
                setInsertOpen(false);
              } catch (error) { setInsertError(error instanceof Error ? error.message : "Export failed."); }
            }}> <Download size={12} /> Download SQL</Btn>
            </div>
          </div>
        </Modal>
      )}
      {rowDetail && (
        <Modal title="Row details" onClose={() => setRowDetail(null)} width={760}>
          <div className="p-4 max-h-[65vh] overflow-auto">
            <dl className="space-y-3">{columns.map((column, i) => <div key={i} className="border-b border-bdrsoft pb-2"><dt className="font-mono text-[12px] text-accent break-all">{column}</dt><dd className="mt-1 font-mono text-[12px] whitespace-pre-wrap break-all">{rowDetail[i] === null ? "(null)" : String(rowDetail[i])}</dd></div>)}</dl>
          </div>
        </Modal>
      )}
      {detail && (
        <Modal title={detail.column} onClose={() => setDetail(null)} width={760}>
          <div className="px-4 py-3 flex flex-col gap-2 min-h-0">
            <div className="flex items-center gap-2 text-[11.5px] text-mute">
              <span className="font-mono text-soft">{detail.column}</span>
              <span>· {detail.value.length.toLocaleString()} characters</span>
              <Btn
                variant="outline"
                className="ml-auto"
                onClick={() => {
                  // the embedded preview pane denies clipboard-write; report instead of failing silently
                  navigator.clipboard?.writeText(detail.value).then(
                    () => setCopied(true),
                    () => setCopied(false)
                  );
                }}
                title="Copy the full value"
              >
                <Copy size={12} /> {copied ? "Copied" : "Copy"}
              </Btn>
            </div>
            <pre className="flex-1 min-h-0 max-h-[60vh] overflow-auto bg-panel2 border border-bdr rounded-lg p-3 text-[11.5px] font-mono whitespace-pre-wrap break-all text-ink">
              {detail.value}
            </pre>
          </div>
        </Modal>
      )}
    </div>
  );
}
