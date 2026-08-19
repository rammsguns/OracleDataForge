import { useCallback, useEffect, useRef, useState } from "react";
import { Download, KeyRound, Link2, Network, RefreshCcw } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type ErdResult, type ErdTable } from "../utils/api";
import { Btn, EmptyState, Spinner } from "./ui";

const ENTITY_W = 240;
const HEADER_H = 30;
const ROW_H = 21;
const GAP_X = 64;
const GAP_Y = 44;
const MARGIN = 32;

interface Pos { x: number; y: number; }

const entityH = (t: ErdTable) => HEADER_H + t.columns.length * ROW_H + 8;

/** Masonry auto-layout: each entity goes into the currently-shortest column. */
function autoLayout(tables: ErdTable[]): Record<string, Pos> {
  const cols = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(tables.length))));
  const colH = new Array(cols).fill(MARGIN);
  const pos: Record<string, Pos> = {};
  for (const t of tables) {
    let ci = 0;
    for (let i = 1; i < cols; i++) if (colH[i] < colH[ci]) ci = i;
    pos[t.name] = { x: MARGIN + ci * (ENTITY_W + GAP_X), y: colH[ci] };
    colH[ci] += entityH(t) + GAP_Y;
  }
  return pos;
}

const shortType = (t: string) =>
  t.replace(/VARCHAR2/i, "VC2").replace(/NVARCHAR2/i, "NVC2").replace(/NUMBER/i, "NUM").replace(/TIMESTAMP/i, "TS");

function LiveErd({ connId, connName }: { connId: string; connName: string }) {
  const s = useStudio();
  const [erd, setErd] = useState<ErdResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<Record<string, Pos>>({});
  const [zoom, setZoom] = useState(1);
  const dragging = useRef<{ name: string; dx: number; dy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.erd(connId)
      .then((r) => {
        setErd(r);
        setPos(autoLayout(r.tables));
      })
      .catch((e: Error) => { setErd(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, [connId]);

  useEffect(() => load(), [load, s.schemaBump]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent, name: string) => {
      const p = pos[name];
      if (!p) return;
      dragging.current = { name, dx: e.clientX / zoom - p.x, dy: e.clientY / zoom - p.y };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [pos, zoom]
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragging.current;
      if (!d) return;
      setPos((p) => ({
        ...p,
        [d.name]: { x: Math.max(0, e.clientX / zoom - d.dx), y: Math.max(0, e.clientY / zoom - d.dy) },
      }));
    },
    [zoom]
  );
  const onPointerUp = useCallback(() => { dragging.current = null; }, []);

  const exportSvg = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    // Every paint attribute in the diagram is `var(--token)`, and those tokens live on
    // :root — outside the SVG. Serialized as-is the file opened black-on-black, because
    // each var() was invalid-at-computed-value-time and fill fell back to black. Resolve
    // them once against the live document and carry the values into the clone.
    const cs = getComputedStyle(document.documentElement);
    const vars = ["--bg", "--panel", "--panel2", "--panel3", "--bdr", "--bdrsoft", "--ink", "--soft", "--mute", "--accent", "--accenthi", "--accentdim", "--ok", "--warn", "--err", "--font-mono"];
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `:root,svg{${vars.map((v) => `${v}:${cs.getPropertyValue(v).trim()}`).join(";")}}`;
    clone.insertBefore(style, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', xml], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${erd?.schema ?? "schema"}-erd.svg`;
    a.click();
    URL.revokeObjectURL(url);
    s.toast("success", `Diagram exported as ${a.download}`);
  }, [erd, s]);

  if (loading && !erd) return <div className="h-full flex items-center justify-center"><Spinner label={`Reading foreign keys from ${connName}…`} /></div>;

  if (error)
    return (
      <div className="p-4">
        <div className="border border-err/30 bg-err/8 rounded-lg px-3 py-2.5 text-[12px] text-soft">
          <span className="text-err font-semibold">Could not build the diagram</span> — {error}
        </div>
        <Btn variant="outline" className="mt-3" onClick={load}><RefreshCcw size={12} /> Retry</Btn>
      </div>
    );

  if (!erd || erd.tables.length === 0)
    return (
      <EmptyState
        icon={<Network />}
        title="No tables to diagram"
        hint={`The schema ${erd?.schema ?? ""} has no base tables yet. Create one, then refresh.`}
      />
    );

  const tableByName = new Map(erd.tables.map((t) => [t.name, t]));

  // FK edges: anchor at the first local FK column row → target table header
  const edges = erd.relationships.map((r) => {
    const src = tableByName.get(r.fromTable);
    const idx = src ? src.columns.findIndex((c) => c.name === r.fromColumns[0]) : -1;
    return { from: r.fromTable, to: r.toTable, fromRow: Math.max(0, idx), label: r.fromColumns.join(", "), self: r.fromTable === r.toTable };
  }).filter((e) => pos[e.from] && pos[e.to]);

  const edgePath = (e: (typeof edges)[0]) => {
    const a = pos[e.from];
    const b = pos[e.to];
    const ay = a.y + HEADER_H + e.fromRow * ROW_H + ROW_H / 2 + 4;
    if (e.self) {
      // small loop out to the right and back into the header
      const ax = a.x + ENTITY_W;
      const by = a.y + HEADER_H / 2;
      return `M ${ax} ${ay} C ${ax + 60} ${ay}, ${ax + 60} ${by}, ${ax} ${by}`;
    }
    const bt = tableByName.get(e.to)!;
    const by = b.y + Math.min(HEADER_H / 2 + 8, entityH(bt) / 2);
    const fromRight = b.x > a.x + ENTITY_W / 2;
    const ax = fromRight ? a.x + ENTITY_W : a.x;
    const bx = fromRight ? b.x : b.x + ENTITY_W;
    const mx = (ax + bx) / 2;
    return `M ${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`;
  };

  // canvas bounds from positioned entities
  let w = 1000, h = 700;
  for (const t of erd.tables) {
    const p = pos[t.name];
    if (!p) continue;
    w = Math.max(w, p.x + ENTITY_W + MARGIN);
    h = Math.max(h, p.y + entityH(t) + MARGIN);
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-bdrsoft shrink-0">
        <Network size={14} className="text-accenthi shrink-0" />
        <span className="text-[12px] text-soft">
          <b className="text-ink">{erd.schema}</b> — {erd.tables.length} table{erd.tables.length === 1 ? "" : "s"},{" "}
          {erd.relationships.length} foreign key{erd.relationships.length === 1 ? "" : "s"}
          {erd.truncated && <span className="text-warn"> · showing first {erd.tables.length} (truncated)</span>}
          {!!erd.hiddenSystem && (
            <span
              className="text-mute"
              title="Oracle Text index internals (DR$…) and materialized-view container tables. They are implementation detail of an index or an mview, not part of the data model — they stay in the schema tree under “System-Generated Tables”."
            >
              {" "}· {erd.hiddenSystem} system-generated hidden
            </span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Btn variant="outline" onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))} title="Zoom in" aria-label="Zoom in">＋</Btn>
          <span className="text-[11px] text-mute tabular-nums w-9 text-center">{Math.round(zoom * 100)}%</span>
          <Btn variant="outline" onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))} title="Zoom out" aria-label="Zoom out">－</Btn>
          <Btn variant="outline" onClick={() => { setPos(autoLayout(erd.tables)); setZoom(1); }} title="Re-arrange layout">
            <RefreshCcw size={12} /> Arrange
          </Btn>
          <Btn variant="outline" onClick={load} title="Reload from the database">
            <RefreshCcw size={12} /> Refresh
          </Btn>
          <Btn variant="outline" onClick={exportSvg} title="Export diagram as SVG">
            <Download size={12} /> Export
          </Btn>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-[radial-gradient(circle,var(--border-soft)_1px,transparent_1px)] [background-size:22px_22px] min-h-0">
        <svg
          ref={svgRef}
          width={w * zoom}
          height={h * zoom}
          viewBox={`0 0 ${w} ${h}`}
          className="block"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="img"
          aria-label={`Entity relationship diagram of the ${erd.schema} schema`}
        >
          {/* edges */}
          {edges.map((e, i) => (
            <path key={i} d={edgePath(e)} fill="none" stroke="var(--accent)" strokeWidth={1.6} opacity={0.55} />
          ))}

          {/* entities */}
          {erd.tables.map((t) => {
            const p = pos[t.name];
            if (!p) return null;
            const eh = entityH(t);
            return (
              <g key={t.name} transform={`translate(${p.x}, ${p.y})`} className="cursor-grab active:cursor-grabbing" onPointerDown={(e) => onPointerDown(e, t.name)}>
                <rect width={ENTITY_W} height={eh} rx={10} fill="var(--panel)" stroke="var(--border)" strokeWidth={1.4} />
                <rect width={ENTITY_W} height={HEADER_H} rx={10} fill="var(--accent)" opacity={0.16} />
                <rect y={HEADER_H - 1} width={ENTITY_W} height={1} fill="var(--border)" />
                <text x={12} y={20} fontSize={13} fontWeight={700} fill="var(--ink)" fontFamily="var(--font-mono)">
                  {t.name}
                </text>
                {t.rowCount != null && (
                  <text x={ENTITY_W - 12} y={20} fontSize={10} fill="var(--ink-mute)" textAnchor="end">
                    {Intl.NumberFormat("en", { notation: "compact" }).format(t.rowCount)}
                  </text>
                )}
                {t.columns.map((c, i) => (
                  <g key={c.name} transform={`translate(0, ${HEADER_H + i * ROW_H + 4})`}>
                    <text x={26} y={14} fontSize={11} fill={c.pk ? "var(--ink)" : "var(--ink-soft)"} fontWeight={c.pk ? 700 : 400} fontFamily="var(--font-mono)">
                      {c.name}
                    </text>
                    <text x={ENTITY_W - 12} y={14} fontSize={10} fill="var(--ink-mute)" textAnchor="end" fontFamily="var(--font-mono)">
                      {shortType(c.type)}
                    </text>
                    {c.pk && (
                      <g transform="translate(9,4)">
                        <circle r={4} cx={4} cy={7} fill="none" stroke="var(--warn)" strokeWidth={1.8} />
                      </g>
                    )}
                    {c.fk && !c.pk && (
                      <g transform="translate(9,4)">
                        <rect x={0} y={3} width={8} height={8} rx={2} fill="none" stroke="var(--accent-hi)" strokeWidth={1.6} />
                      </g>
                    )}
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="border-t border-bdrsoft px-3 py-1.5 flex items-center gap-4 text-[11px] text-mute shrink-0">
        <span className="inline-flex items-center gap-1">
          <KeyRound size={11} className="text-warn" /> primary key
        </span>
        <span className="inline-flex items-center gap-1">
          <Link2 size={11} className="text-accenthi" /> foreign key
        </span>
        <span className="ml-auto">Drag entities to arrange; lines follow real foreign keys from {connName}.</span>
      </div>
    </div>
  );
}

export default function ErDiagram() {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  if (!conn?.live) {
    return (
      <EmptyState
        icon={<Network />}
        title="The ER diagram needs a live connection"
        hint="Select a live Oracle connection in the sidebar — entities and relationship lines are built from the real data dictionary, so there is nothing to draw without one."
      />
    );
  }
  return <LiveErd key={conn.id} connId={conn.id} connName={conn.name} />;
}
