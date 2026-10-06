import { useEffect, useState } from "react";
import { api, type TablespaceObjectsPage } from "../utils/api";
import { formatStorage } from "../utils/tablespaceCapacity";
import { Btn, inputCls } from "./ui";

export default function TablespaceObjects({ connectionId, tablespace }: { connectionId: string; tablespace: string }) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<TablespaceObjectsPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { setSearch(""); setOffset(0); }, [connectionId, tablespace]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setPage(null);
    const timer = setTimeout(() => {
      api.tablespaceObjects(connectionId, tablespace, search.trim(), offset)
        .then(result => { if (!cancelled) setPage(result); })
        .catch((cause: Error) => { if (!cancelled) setError(cause.message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, search ? 250 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [connectionId, tablespace, search, offset]);
  return <div className="space-y-3">
    <p className="text-xs text-mute">Allocated segment space in {tablespace}. Partitions, indexes, and LOB segments appear separately. Sizes are allocated space, not the amount of row data.</p>
    <input className={inputCls} aria-label="Search objects in tablespace" placeholder="Search owner, object, or segment type…" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} />
    {loading && <p role="status" className="text-xs text-mute">Loading objects…</p>}
    {error && <p role="alert" className="text-xs text-err">{error}</p>}
    {page && <><div className="overflow-x-auto"><table className="w-full text-xs text-left"><thead><tr>{["Owner", "Object / segment", "Type", "Partition", "Allocated size"].map(label => <th key={label} className="p-2 border-b border-bdr text-mute whitespace-nowrap">{label}</th>)}</tr></thead><tbody>{page.rows.map((row, index) => <tr key={`${row.owner}:${row.name}:${row.type}:${row.partition}:${index}`} className="border-b border-bdrsoft"><td className="p-2 font-mono">{row.owner}</td><td className="p-2 font-mono break-all">{row.name}</td><td className="p-2">{row.type}</td><td className="p-2 font-mono">{row.partition ?? "—"}</td><td className="p-2 whitespace-nowrap text-right">{formatStorage(row.sizeMiB)}</td></tr>)}</tbody></table></div>
      {!page.rows.length && <p className="text-xs text-mute">No allocated segments match this search.</p>}
      <div className="flex items-center gap-2"><Btn variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</Btn><span className="text-xs text-mute">{page.rows.length ? `${offset + 1}–${offset + page.rows.length}` : "0"}</span><Btn variant="outline" disabled={!page.hasMore} onClick={() => setOffset(offset + 100)}>Next</Btn></div>
    </>}
  </div>;
}
