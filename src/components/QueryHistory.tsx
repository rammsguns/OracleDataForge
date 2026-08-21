import { useMemo, useState } from "react";
import { CircleCheck, CircleX, Clock3, Play, Search, Star, Tag, Trash2 } from "lucide-react";
import { useStudio } from "../state/store";
import { Btn, Badge, EmptyState } from "./ui";

export default function QueryHistory() {
  const s = useStudio();
  const [q, setQ] = useState("");
  const [onlyFav, setOnlyFav] = useState(false);

  const entries = useMemo(
    () =>
      s.history.filter(
        (e) =>
          (!onlyFav || e.favorite) &&
          (!q.trim() || e.sql.toLowerCase().includes(q.toLowerCase()) || e.tags.some((t) => t.includes(q.toLowerCase())))
      ),
    [s.history, q, onlyFav]
  );

  const load = (sql: string) => {
    s.setSql(sql);
    s.openTab("worksheet", "Worksheet 1");
    s.toast("info", "Statement loaded into worksheet");
  };

  return (
    <div className="h-full grid min-h-0">
      {/* history list */}
      <div className="flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-bdrsoft shrink-0">
          <div className="relative flex-1 max-w-72">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search history & tags…"
              aria-label="Search query history"
              className="w-full h-7 pl-7.5 pr-2 rounded-md bg-panel2 border border-bdr text-[12px] placeholder:text-mute focus:border-accent focus:outline-none"
            />
          </div>
          <Btn variant={onlyFav ? "primary" : "outline"} onClick={() => setOnlyFav((v) => !v)} title="Show favorites only">
            <Star size={12} fill={onlyFav ? "currentColor" : "none"} /> Favorites
          </Btn>
          <Btn
            variant="outline"
            onClick={() => {
              const clearable = s.history.filter((e) => !e.favorite).length;
              if (!clearable) {
                s.toast("info", "Nothing to clear — no non-favorite entries");
                return;
              }
              s.askConfirm({
                title: "Clear query history?",
                body: `This removes ${clearable} history entr${clearable === 1 ? "y" : "ies"} from this browser. Favorites are kept. This can't be undone.`,
                confirmLabel: "Clear history",
                danger: true,
                onConfirm: () => s.clearHistory(),
              });
            }}
            title="Clear history (keeps favorites)"
          >
            <Trash2 size={12} /> Clear
          </Btn>
          <span className="ml-auto text-[11.5px] text-mute">{entries.length} entries</span>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {entries.length === 0 ? (
            <EmptyState icon={<Clock3 />} title="No matching history" hint="Statements you run appear here automatically with duration and row counts." />
          ) : (
            entries.map((e) => (
              <div key={e.id} className="group border-b border-bdrsoft px-3 py-2.5 hover:bg-panel2 transition-colors">
                <div className="flex items-center gap-2 mb-1.5">
                  {e.status === "ok" ? <CircleCheck size={13} className="text-ok" aria-label="Succeeded" /> : <CircleX size={13} className="text-err" aria-label="Failed" />}
                  <span className="text-[11px] text-mute tabular-nums">{e.ranAt}</span>
                  <span className="text-[11px] text-mute tabular-nums">· {e.durationMs} ms · {e.rows} rows</span>
                  {e.tags.map((t) => (
                    <Badge key={t} tone="accent">
                      <Tag size={9} />
                      {t}
                    </Badge>
                  ))}
                  <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      className={`p-1 rounded hover:bg-panel3 ${e.favorite ? "text-warn" : "text-mute"}`}
                      onClick={() => s.toggleFavorite(e.id)}
                      aria-label={e.favorite ? "Remove favorite" : "Add favorite"}
                      title="Toggle favorite"
                    >
                      <Star size={13} fill={e.favorite ? "currentColor" : "none"} />
                    </button>
                    <button className="p-1 rounded hover:bg-panel3 text-mute hover:text-accent" onClick={() => load(e.sql)} aria-label="Load into worksheet" title="Load into worksheet">
                      <Play size={13} />
                    </button>
                  </div>
                  {e.favorite && <Star size={12} fill="currentColor" className="text-warn group-hover:hidden" />}
                </div>
                <pre className="font-mono text-[11.5px] text-soft whitespace-pre-wrap break-all line-clamp-2 cursor-pointer" onClick={() => load(e.sql)} title="Click to load into worksheet">
                  {e.sql}
                </pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
