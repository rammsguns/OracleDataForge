import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  Filter,
  Maximize2,
} from "lucide-react";
import type { CellValue } from "../types";
import { download, toCsv, toJson } from "../utils/sql";
import { Btn, Modal } from "./ui";

const PAGE = 10;

/** Longer than this and the cell is shown clipped, with the full value one click away.
 *  Without a cap a single wide value (a 23ai VECTOR, a long CLOB) stretches the table
 *  to tens of thousands of pixels and every other column becomes unreachable. */
const CELL_CLIP = 140;

export default function ResultsGrid({
  columns,
  rows,
  exportName = "results",
  dense,
  truncated,
}: {
  columns: string[];
  rows: CellValue[][];
  exportName?: string;
  dense?: boolean;
  /** the server stopped at its row cap — say so permanently, not just in a toast */
  truncated?: boolean;
}) {
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
  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const visCols = columns.map((c, i) => ({ name: c, i })).filter((c) => !hidden.has(c.i));

  const fmt = (v: CellValue) => {
    if (v === null) return <span className="text-mute italic">(null)</span>;
    if (typeof v === "number")
      return <span className="tabular-nums">{Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
    return v;
  };

  /** Values past CELL_CLIP are clipped in place and get an expand affordance — the row
   *  stays readable and the other columns stay reachable. Export is unaffected: CSV/JSON
   *  are built from `filtered`, never from what the cell renders. */
  const cellText = (v: CellValue) => (v === null ? "" : String(v));

  return (
    <div className="flex flex-col h-full min-h-0">
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
            <div className="absolute z-40 top-8 left-0 bg-panel border border-bdr rounded-lg shadow-2xl p-2 min-w-44 df-fade">
              {columns.map((c, i) => (
                <label key={c} className="flex items-center gap-2 px-1.5 py-1 text-[12px] font-mono hover:bg-panel2 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!hidden.has(i)}
                    onChange={() =>
                      setHidden((h) => {
                        const n = new Set(h);
                        if (n.has(i)) n.delete(i);
                        else if (n.size < columns.length - 1) n.add(i);
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
        <div className="ml-auto flex items-center gap-1.5">
          <Btn variant="outline" title="Export as CSV" onClick={() => download(`${exportName}.csv`, toCsv(columns, filtered), "text/csv")}>
            <Download size={12} /> CSV
          </Btn>
          <Btn variant="outline" title="Export as JSON" onClick={() => download(`${exportName}.json`, toJson(columns, filtered), "application/json")}>
            <Download size={12} /> JSON
          </Btn>
        </div>
      </div>

      {/* grid */}
      <div className="flex-1 overflow-auto min-h-0" onClick={() => colsOpen && setColsOpen(false)}>
        <table className="w-full border-collapse text-[12px] font-mono">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="bg-panel3 border-b border-r border-bdr px-2 py-1.5 text-left text-[10px] text-mute w-10 font-semibold">#</th>
              {visCols.map(({ name, i }) => (
                <th
                  key={name}
                  className="bg-panel3 border-b border-r border-bdrsoft px-2.5 py-1.5 text-left text-[11px] font-bold text-soft cursor-pointer hover:text-ink select-none whitespace-nowrap"
                  onClick={() => setSort((s) => (s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 }))}
                  title={`Sort by ${name}`}
                  aria-sort={sort?.col === i ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                >
                  <span className="inline-flex items-center gap-1">
                    {name}
                    {sort?.col === i && (sort.dir === 1 ? <ArrowUp size={11} className="text-accent" /> : <ArrowDown size={11} className="text-accent" />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, ri) => (
              <tr key={ri} className="hover:bg-accentdim/60 group">
                <td className="border-b border-r border-bdrsoft px-2 text-[10px] text-mute bg-panel">{page * PAGE + ri + 1}</td>
                {visCols.map(({ i }) => {
                  const raw = cellText(r[i]);
                  const long = raw.length > CELL_CLIP;
                  return (
                    <td
                      key={i}
                      className={`border-b border-r border-bdrsoft px-2.5 whitespace-nowrap text-ink max-w-[26rem] overflow-hidden text-ellipsis ${dense ? "py-0.5" : "py-1"}`}
                    >
                      {long ? (
                        <span className="inline-flex items-center gap-1.5 max-w-full">
                          <span className="overflow-hidden text-ellipsis">{raw.slice(0, CELL_CLIP)}…</span>
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
        <div className="ml-auto flex items-center gap-1">
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
        </div>
      </div>

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
