import { useMemo } from "react";
import { diffLines } from "../utils/lineDiff";

/** Scrolling +/- line diff. Expects a flex-col parent that bounds its height. */
export default function DiffView({ oldSrc, newSrc, tooBigNote }: { oldSrc: string; newSrc: string; tooBigNote?: string }) {
  const diff = useMemo(() => diffLines(oldSrc, newSrc), [oldSrc, newSrc]);
  if (!diff) {
    return (
      <p className="p-3 text-[11.5px] text-mute">
        {tooBigNote ?? "Sources are too large to diff — showing them is still possible from the Source view."}
      </p>
    );
  }
  const added = diff.filter((l) => l.kind === "add").length;
  const removed = diff.filter((l) => l.kind === "del").length;
  return (
    <div className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-relaxed">
      <div className="px-3 py-1.5 text-[10.5px] text-mute font-sans sticky top-0 bg-panel2 border-b border-bdrsoft">
        {added + removed === 0 ? "No line changes (whitespace only)" : `${added} added · ${removed} removed`}
      </div>
      <pre className="p-0 m-0">
        {diff.map((l, i) => (
          <div
            key={i}
            className={l.kind === "add" ? "bg-ok/10 text-ok px-3" : l.kind === "del" ? "bg-err/10 text-err px-3" : "px-3 text-soft"}
          >
            <span className="select-none inline-block w-4 text-mute">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
