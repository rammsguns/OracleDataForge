import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { tokenize } from "../utils/sql";
import { useHighlightWindow } from "../utils/highlightWindow";

const CLS: Record<string, string> = {
  kw: "text-[var(--syn-kw)] font-semibold",
  fn: "text-[var(--syn-fn)]",
  str: "text-[var(--syn-str)]",
  num: "text-[var(--syn-num)]",
  cmt: "text-[var(--syn-cmt)] italic",
  op: "text-[var(--syn-op)]",
  ident: "",
  ws: "",
};

const LINE_H = 20;

// Keyword-only completions — object names came from mock data before live connections replaced it.
const COMPLETIONS = [
  ...["select", "from", "where", "group by", "order by", "having", "join", "left join", "inner join", "insert into", "update", "delete from", "create table", "create or replace procedure", "create or replace function", "fetch first"].map((k) => ({ label: k, detail: "keyword" })),
];

export default function SqlEditor({
  value,
  onChange,
  errorLine,
  onRun,
}: {
  value: string;
  onChange: (v: string) => void;
  errorLine?: number | null;
  onRun?: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [ac, setAc] = useState<{ items: typeof COMPLETIONS; sel: number; word: string } | null>(null);

  const lines = value.split("\n");
  const tokens = useMemo(() => tokenize(value), [value]);
  // a pasted migration script is as big as a dictionary package — same treatment
  const { windowed, syncWindow } = useHighlightWindow(value, tokens, taRef, LINE_H);

  const syncScroll = () => {
    if (!taRef.current) return;
    if (preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
    syncWindow();
  };

  // Re-mirror after every commit: when the coloured window moves React replaces the
  // highlight layer's children, and the browser can clamp its scrollTop mid-swap,
  // leaving the colours offset from the text. The textarea is the source of truth.
  useEffect(syncScroll);

  const currentWord = () => {
    const ta = taRef.current;
    if (!ta) return "";
    const before = value.slice(0, ta.selectionStart);
    return before.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
  };

  const applyCompletion = (label: string) => {
    const ta = taRef.current;
    if (!ta || !ac) return;
    const pos = ta.selectionStart;
    const start = pos - ac.word.length;
    const next = value.slice(0, start) + label + value.slice(pos);
    onChange(next);
    setAc(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + label.length;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ac) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAc({ ...ac, sel: (ac.sel + 1) % ac.items.length }); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAc({ ...ac, sel: (ac.sel - 1 + ac.items.length) % ac.items.length }); return; }
      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); applyCompletion(ac.items[ac.sel].label); return; }
      if (e.key === "Escape") { setAc(null); return; }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onRun?.();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = ta;
      onChange(value.slice(0, s) + "  " + value.slice(en));
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  };

  const onInput = (v: string) => {
    onChange(v);
    requestAnimationFrame(() => {
      const w = currentWord();
      if (w.length >= 2) {
        const items = COMPLETIONS.filter((c) => c.label.startsWith(w.toLowerCase()) && c.label !== w.toLowerCase()).slice(0, 8);
        setAc(items.length ? { items, sel: 0, word: w } : null);
      } else setAc(null);
    });
  };

  const sharedStyle: CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    lineHeight: `${LINE_H}px`,
    tabSize: 2,
    padding: "10px 12px",
    whiteSpace: "pre",
    wordWrap: "normal",
  };

  // caret position for the autocomplete popup (approximate: line/col based)
  const caretPos = () => {
    const ta = taRef.current;
    if (!ta) return { top: 30, left: 60 };
    const upto = value.slice(0, ta.selectionStart);
    const row = upto.split("\n").length - 1;
    const col = upto.length - upto.lastIndexOf("\n") - 1;
    return { top: (row + 1) * 20 + 12 - ta.scrollTop, left: col * 7.6 + 14 - ta.scrollLeft };
  };
  const pos = ac ? caretPos() : null;

  return (
    <div className="relative h-full flex bg-panel2 font-mono text-[13px] overflow-hidden">
      {/* gutter */}
      <div
        ref={gutterRef}
        aria-hidden
        className="w-11 shrink-0 overflow-hidden text-right pr-2 select-none border-r border-bdrsoft bg-panel"
        style={{ ...sharedStyle, padding: "10px 8px 10px 0" }}
      >
        {lines.map((_, i) => (
          <div key={i} className={errorLine === i + 1 ? "text-err font-bold" : "text-mute"}>
            {i + 1}
          </div>
        ))}
      </div>

      <div className="relative flex-1 min-w-0">
        {/* highlight layer */}
        <pre ref={preRef} aria-hidden className="absolute inset-0 overflow-hidden m-0 pointer-events-none text-ink" style={sharedStyle}>
          {errorLine != null && (
            <div
              className="absolute left-0 right-0 bg-err/10 border-l-2 border-err"
              style={{ top: (errorLine - 1) * 20 + 10, height: 20 }}
            />
          )}
          <code>
            {windowed ? (
              <>
                {windowed.head}
                {windowed.mid.map((t, i) => (
                  <span key={i} className={CLS[t.cls]}>
                    {t.text}
                  </span>
                ))}
                {windowed.tail}
              </>
            ) : (
              tokens.map((t, i) => (
                <span key={i} className={CLS[t.cls]}>
                  {t.text}
                </span>
              ))
            )}
            {"\n"}
          </code>
        </pre>
        {/* input layer */}
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onBlur={() => window.setTimeout(() => setAc(null), 150)}
          spellCheck={false}
          aria-label="SQL editor"
          className="absolute inset-0 w-full h-full resize-none bg-transparent text-transparent caret-[var(--accent)] outline-none overflow-auto"
          style={sharedStyle}
        />
        {/* autocomplete */}
        {ac && pos && (
          <div
            className="absolute z-30 bg-panel border border-bdr rounded-lg shadow-2xl py-1 min-w-52 df-fade"
            style={{ top: Math.min(pos.top, 400), left: Math.min(Math.max(pos.left, 8), 500) }}
            role="listbox"
            aria-label="Autocomplete suggestions"
          >
            {ac.items.map((it, i) => (
              <button
                key={it.label + it.detail}
                role="option"
                aria-selected={i === ac.sel}
                className={`w-full flex items-center justify-between gap-4 px-3 py-1 text-[12px] font-mono ${i === ac.sel ? "bg-accentdim text-ink" : "text-soft"}`}
                onMouseDown={(e) => { e.preventDefault(); applyCompletion(it.label); }}
                onMouseEnter={() => setAc({ ...ac, sel: i })}
              >
                <span>{it.label}</span>
                <span className="text-[10px] text-mute font-sans">{it.detail}</span>
              </button>
            ))}
            <div className="px-3 pt-1 mt-1 border-t border-bdrsoft text-[10px] text-mute font-sans">Tab / Enter to accept · Esc to dismiss</div>
          </div>
        )}
      </div>
    </div>
  );
}
