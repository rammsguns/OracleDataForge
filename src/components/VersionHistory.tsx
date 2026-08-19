import { useCallback, useEffect, useState } from "react";
import { FileCode2, GitCommitVertical, History, RefreshCcw, RotateCcw, ScrollText } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type ChangeLogEntry, type VersionFile, type VersionSummary } from "../utils/api";
import DiffView from "./DiffView";
import { Badge, EmptyState, Spinner } from "./ui";

const ACTION_TONE: Record<string, "ok" | "warn" | "err"> = {
  CREATE: "ok",
  REPLACE: "warn",
  DROP: "err",
};

const fmtAt = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
};

/* ---------- main tab ---------- */

export default function VersionHistory() {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  const connId = conn?.live ? conn.id : null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [objects, setObjects] = useState<VersionSummary[]>([]);
  const [log, setLog] = useState<ChangeLogEntry[]>([]);
  const [selected, setSelected] = useState<{ name: string; type: string } | null>(null);
  const [detail, setDetail] = useState<VersionFile | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [versionIdx, setVersionIdx] = useState(0); // index into detail.versions, newest = last
  const [view, setView] = useState<"source" | "diff">("source");

  const refresh = useCallback(() => {
    if (!connId) return;
    setLoading(true);
    setError(null);
    Promise.all([api.versions(connId), api.changelog(connId)])
      .then(([v, l]) => {
        setObjects(v.objects);
        setLog(l.entries);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [connId]);

  // load on open and after any DDL ran elsewhere in the app
  useEffect(() => { refresh(); }, [refresh, s.schemaBump]);

  const openObject = useCallback((name: string, type: string) => {
    if (!connId) return;
    setSelected({ name, type });
    setDetail(null);
    setDetailLoading(true);
    api.versionsOf(connId, name, type)
      .then((vf) => {
        setDetail(vf);
        setVersionIdx(vf.versions.length - 1);
        setView("source");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setDetailLoading(false));
  }, [connId]);

  if (!conn?.live) {
    return (
      <EmptyState
        icon={<History />}
        title="Version history needs a live connection"
        hint="Select a live Oracle connection in the sidebar. Procedures, functions, packages and triggers are versioned automatically every time you run a CREATE OR REPLACE statement."
      />
    );
  }

  const cur = detail?.versions[versionIdx];
  const prev = versionIdx > 0 ? detail?.versions[versionIdx - 1] : undefined;

  // Restore = seed the worksheet with this version as a runnable statement; nothing executes
  // here — running it goes through the normal guards and captures a NEW version (by design).
  const restore = () => {
    if (!cur || !detail) return;
    const src = cur.source.trim();
    // Oracle user_source snapshots start at the type keyword (no CREATE prefix); fallback
    // captures may already be full CREATE statements, so do not double the prefix.
    const stmt = /^create\b/i.test(src) ? src : `CREATE OR REPLACE ${src}`;
    s.insertSql(stmt);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* toolbar */}
      <div className="px-3 py-2 border-b border-bdrsoft flex items-center gap-2 shrink-0">
        <History size={14} className="text-accenthi" />
        <span className="text-[12.5px] font-semibold">Version History</span>
        <span className="text-[10.5px] text-mute">
          code objects (procedures, functions, packages, triggers) are versioned automatically on every CREATE — data is not
        </span>
        <button
          aria-label="Refresh versions"
          title="Refresh"
          onClick={refresh}
          className="ml-auto p-1 rounded text-mute hover:text-accenthi hover:bg-panel3 transition-colors"
        >
          <RefreshCcw size={13} className={loading ? "df-spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-2 border border-err/30 bg-err/8 rounded-lg px-2.5 py-2 text-[11.5px] text-soft shrink-0">
          <span className="text-err font-semibold">Could not load versions</span> — {error}
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-[280px_1fr] gap-3 p-3">
        {/* left: objects + change log */}
        <div className="flex flex-col gap-3 min-h-0">
          <div className="border border-bdr rounded-lg bg-panel2 flex flex-col min-h-0 flex-1">
            <div className="px-3 py-2 border-b border-bdrsoft flex items-center gap-2 text-[12px] font-semibold text-soft shrink-0">
              <FileCode2 size={13} className="text-accenthi" /> Versioned objects
              <span className="ml-auto text-[10.5px] font-normal text-mute">{objects.length}</span>
            </div>
            {loading && objects.length === 0 ? (
              <div className="p-3"><Spinner label="Loading…" /></div>
            ) : objects.length === 0 ? (
              <p className="px-3 py-3 text-[11.5px] text-mute leading-snug">
                Nothing versioned yet. Run a <span className="font-mono">CREATE OR REPLACE PROCEDURE/FUNCTION…</span> in the worksheet and it will appear here as v1.
              </p>
            ) : (
              <div className="p-1 overflow-y-auto">
                {objects.map((o) => (
                  <button
                    key={`${o.type}.${o.name}`}
                    onClick={() => openObject(o.name, o.type)}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-[12px] transition-colors ${
                      selected?.name === o.name && selected?.type === o.type ? "bg-accentdim text-ink" : "hover:bg-panel3 text-soft"
                    }`}
                    title={`${o.type} ${o.name} — ${o.versionCount} version(s)`}
                  >
                    <span className="text-[9.5px] font-bold w-20 shrink-0 uppercase tracking-wide text-warn">{o.type}</span>
                    <span className="font-mono truncate">{o.name}</span>
                    <span className="ml-auto text-[10px] text-mute shrink-0">v{o.latestVersion}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="border border-bdr rounded-lg bg-panel2 flex flex-col min-h-0 flex-1">
            <div className="px-3 py-2 border-b border-bdrsoft flex items-center gap-2 text-[12px] font-semibold text-soft shrink-0">
              <ScrollText size={13} className="text-accenthi" /> Change log
              <span className="ml-auto text-[10.5px] font-normal text-mute">{log.length}</span>
            </div>
            {log.length === 0 ? (
              <p className="px-3 py-3 text-[11.5px] text-mute">No code changes recorded on this connection yet.</p>
            ) : (
              <div className="p-1 overflow-y-auto">
                {log.map((e, i) => (
                  <button
                    key={`${e.at}.${e.name}.${i}`}
                    onClick={() => e.action !== "DROP" && openObject(e.name, e.type)}
                    className="w-full px-2.5 py-1.5 rounded-md text-left hover:bg-panel3 transition-colors"
                    title={`${e.action} ${e.type} ${e.name}${e.version ? ` (v${e.version})` : ""}`}
                  >
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <Badge tone={ACTION_TONE[e.action] ?? "ok"}>{e.action}</Badge>
                      <span className="font-mono text-soft truncate">{e.name}</span>
                      {e.version != null && <span className="ml-auto text-[10px] text-mute shrink-0">v{e.version}</span>}
                    </div>
                    <div className="text-[10px] text-mute mt-0.5">{e.type.toLowerCase()} · {fmtAt(e.at)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* right: selected object detail */}
        <div className="border border-bdr rounded-lg bg-panel2 flex flex-col min-h-0">
          {!selected ? (
            <EmptyState
              icon={<GitCommitVertical />}
              title="Pick an object"
              hint="Select a versioned object (or a change-log entry) to browse its versions, view any snapshot's source, and diff it against the previous version."
            />
          ) : detailLoading || !detail ? (
            <div className="p-4"><Spinner label={`Loading ${selected.name}…`} /></div>
          ) : (
            <>
              <div className="px-3 py-2 border-b border-bdrsoft flex items-center gap-2 shrink-0 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wide text-warn">{detail.type}</span>
                <span className="font-mono text-[13px] text-ink">{detail.name}</span>
                <span className="text-[10.5px] text-mute">{detail.versions.length} version(s)</span>
                <div className="ml-auto flex items-center gap-1">
                  {(["source", "diff"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      disabled={v === "diff" && !prev}
                      aria-pressed={view === v}
                      className={`px-2 py-0.5 rounded text-[11px] transition-colors disabled:opacity-40 ${
                        view === v ? "bg-accentdim text-accenthi font-semibold" : "text-mute hover:text-soft"
                      }`}
                      title={v === "diff" ? "Diff against the previous version" : "Full source of the selected version"}
                    >
                      {v === "source" ? "Source" : "Diff vs previous"}
                    </button>
                  ))}
                </div>
              </div>
              {/* version picker */}
              <div className="px-3 py-1.5 border-b border-bdrsoft flex items-center gap-1.5 overflow-x-auto shrink-0">
                {[...detail.versions].reverse().map((v) => {
                  const idx = detail.versions.indexOf(v);
                  return (
                    <button
                      key={v.version}
                      onClick={() => setVersionIdx(idx)}
                      aria-pressed={idx === versionIdx}
                      className={`px-2 py-0.5 rounded-full text-[11px] font-mono whitespace-nowrap transition-colors ${
                        idx === versionIdx ? "bg-accent text-white" : "bg-panel3 text-mute hover:text-soft"
                      }`}
                      title={`${v.action} · ${fmtAt(v.at)}`}
                    >
                      v{v.version}
                    </button>
                  );
                })}
                {cur && (
                  <span className="ml-auto flex items-center gap-2 whitespace-nowrap">
                    <span className="text-[10.5px] text-mute">{cur.action} · {fmtAt(cur.at)}</span>
                    <button
                      onClick={restore}
                      className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-soft border border-bdr hover:border-accent/60 hover:text-accenthi hover:bg-accentdim transition-colors"
                      title={`Load v${cur.version} into the worksheet as a runnable statement — review, then run it yourself (running creates a new version)`}
                    >
                      <RotateCcw size={11} /> Restore v{cur.version}
                    </button>
                  </span>
                )}
              </div>
              {view === "diff" && prev && cur ? (
                <DiffView oldSrc={prev.source} newSrc={cur.source} />
              ) : (
                <pre className="min-h-0 flex-1 overflow-auto m-0 p-3 font-mono text-[11.5px] leading-relaxed text-soft whitespace-pre-wrap">
                  {cur?.source ?? ""}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
