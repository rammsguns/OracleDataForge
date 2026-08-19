import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ArrowDown, ArrowUp, Replace, X } from "lucide-react";
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

export interface CodeEditorHandle {
  /** Move the caret to a 1-based line/column, select to end of line and scroll it into view. */
  goTo: (line: number, col: number) => void;
  focus: () => void;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lines ending in these open a block — Enter indents one level deeper. */
const OPENS_BLOCK = /\b(then|loop|begin|declare|is|as|else)\s*$/i;

/** Editable PL/SQL/SQL editor: gutter, syntax highlight, auto-indent, find & replace,
 *  and imperative goTo() so compilation errors can jump to their line/column. */
const CodeEditor = forwardRef<
  CodeEditorHandle,
  {
    value: string;
    onChange: (v: string) => void;
    readOnly?: boolean;
    /** 1-based line highlighted as the active error */
    errorLine?: number | null;
    /** Ctrl+Enter / Ctrl+S */
    onCompile?: () => void;
    ariaLabel?: string;
  }
>(function CodeEditor({ value, onChange, readOnly, errorLine, onCompile, ariaLabel }, ref) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [fr, setFr] = useState({ open: false, withReplace: false, q: "", r: "" });

  const lines = value.split("\n");
  const tokens = useMemo(() => tokenize(value), [value]);
  const { windowed, syncWindow } = useHighlightWindow(value, tokens, taRef, LINE_H);
  const matchCount = useMemo(() => {
    if (!fr.open || !fr.q) return 0;
    return (value.toLowerCase().match(new RegExp(escapeRe(fr.q.toLowerCase()), "g")) ?? []).length;
  }, [value, fr.open, fr.q]);

  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
    syncWindow();
  };

  // Re-mirror after every commit. When the coloured window moves, React replaces the
  // children of the highlight layer; while they are swapped the browser can clamp its
  // scrollTop against a momentarily shorter content, and the colours end up offset from
  // the text under them. The textarea is the source of truth, so just re-apply it.
  useEffect(syncScroll);

  const scrollToLine = (line: number) => {
    const ta = taRef.current;
    if (!ta) return;
    ta.scrollTop = Math.max(0, (line - 1) * LINE_H - ta.clientHeight / 2);
    syncScroll();
  };

  const selectRange = (start: number, end: number) => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(start, end);
    scrollToLine(value.slice(0, start).split("\n").length);
  };

  useImperativeHandle(ref, () => ({
    goTo(line, col) {
      const l = Math.min(Math.max(1, line), lines.length);
      const lineStart = lines.slice(0, l - 1).reduce((a, s) => a + s.length + 1, 0);
      const lineText = lines[l - 1] ?? "";
      const from = lineStart + Math.min(Math.max(0, col - 1), lineText.length);
      // select from the reported column to the end of the line so the problem area is visible
      selectRange(from, lineStart + lineText.length);
    },
    focus: () => taRef.current?.focus(),
  }));

  const doFind = (dir: 1 | -1) => {
    const q = fr.q.toLowerCase();
    const ta = taRef.current;
    if (!q || !ta) return;
    const hay = value.toLowerCase();
    let idx: number;
    if (dir === 1) {
      idx = hay.indexOf(q, ta.selectionEnd);
      if (idx < 0) idx = hay.indexOf(q); // wrap
    } else {
      idx = hay.lastIndexOf(q, Math.max(0, ta.selectionStart - 1));
      if (idx < 0) idx = hay.lastIndexOf(q); // wrap
    }
    if (idx >= 0) selectRange(idx, idx + q.length);
  };

  const doReplace = () => {
    const ta = taRef.current;
    if (!ta || !fr.q || readOnly) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    if (value.slice(s, e).toLowerCase() === fr.q.toLowerCase()) {
      onChange(value.slice(0, s) + fr.r + value.slice(e));
      requestAnimationFrame(() => {
        ta.setSelectionRange(s + fr.r.length, s + fr.r.length);
        doFind(1);
      });
    } else doFind(1);
  };

  const doReplaceAll = () => {
    if (!fr.q || readOnly) return;
    onChange(value.replace(new RegExp(escapeRe(fr.q), "gi"), fr.r));
  };

  const insertAt = (text: string, s: number, e: number, caret: number) => {
    onChange(value.slice(0, s) + text + value.slice(e));
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) ta.selectionStart = ta.selectionEnd = caret;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "h")) {
      e.preventDefault();
      setFr((f) => ({ ...f, open: true, withReplace: e.key === "h" && !readOnly }));
      requestAnimationFrame(() => findRef.current?.focus());
      return;
    }
    if (e.key === "F3") {
      e.preventDefault();
      doFind(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "Escape" && fr.open) {
      setFr((f) => ({ ...f, open: false }));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "s")) {
      e.preventDefault();
      // React listens at the root, so without this the native event still reaches App's
      // window handler and Ctrl+S *also* downloads worksheet.sql — a different file than
      // the one being edited — and toasts a success for it
      e.stopPropagation();
      onCompile?.();
      return;
    }
    if (readOnly) return;
    const ta = e.currentTarget;
    if (e.key === "Tab") {
      e.preventDefault();
      insertAt("  ", ta.selectionStart, ta.selectionEnd, ta.selectionStart + 2);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const s = ta.selectionStart;
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      const line = value.slice(lineStart, s);
      let indent = line.match(/^\s*/)?.[0] ?? "";
      if (OPENS_BLOCK.test(line.trimEnd())) indent += "  ";
      insertAt("\n" + indent, s, ta.selectionEnd, s + 1 + indent.length);
    }
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

  return (
    <div className="relative h-full flex bg-panel2 font-mono text-[13px] overflow-hidden">
      {/* gutter */}
      <div
        ref={gutterRef}
        aria-hidden
        className="w-11 shrink-0 overflow-hidden text-right select-none border-r border-bdrsoft bg-panel"
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
          {errorLine != null && errorLine >= 1 && (
            <div
              className="absolute left-0 right-0 bg-err/10 border-l-2 border-err"
              style={{ top: (errorLine - 1) * LINE_H + 10, height: LINE_H }}
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
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          spellCheck={false}
          aria-label={ariaLabel ?? "Code editor"}
          className="absolute inset-0 w-full h-full resize-none bg-transparent text-transparent caret-[var(--accent)] outline-none overflow-auto"
          style={sharedStyle}
        />

        {/* find & replace bar */}
        {fr.open && (
          <div className="absolute top-1.5 right-3 z-20 flex flex-col gap-1 bg-panel border border-bdr rounded-lg shadow-xl p-1.5 df-fade font-sans">
            <div className="flex items-center gap-1">
              <input
                ref={findRef}
                value={fr.q}
                onChange={(e) => setFr((f) => ({ ...f, q: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); doFind(e.shiftKey ? -1 : 1); }
                  if (e.key === "Escape") { setFr((f) => ({ ...f, open: false })); taRef.current?.focus(); }
                }}
                placeholder="Find…"
                aria-label="Find text"
                className="h-6.5 w-40 px-2 rounded bg-panel2 border border-bdr text-[12px] placeholder:text-mute focus:border-accent focus:outline-none"
              />
              <span className="text-[10px] text-mute w-10 text-center tabular-nums">{fr.q ? matchCount : ""}</span>
              <button aria-label="Find previous (Shift+Enter)" title="Find previous" className="p-1 rounded text-mute hover:text-ink hover:bg-panel3" onClick={() => doFind(-1)}>
                <ArrowUp size={12} />
              </button>
              <button aria-label="Find next (Enter)" title="Find next" className="p-1 rounded text-mute hover:text-ink hover:bg-panel3" onClick={() => doFind(1)}>
                <ArrowDown size={12} />
              </button>
              {!readOnly && (
                <button
                  aria-label="Toggle replace"
                  title="Replace (Ctrl+H)"
                  className={`p-1 rounded hover:bg-panel3 ${fr.withReplace ? "text-accenthi" : "text-mute hover:text-ink"}`}
                  onClick={() => setFr((f) => ({ ...f, withReplace: !f.withReplace }))}
                >
                  <Replace size={12} />
                </button>
              )}
              <button aria-label="Close find bar" title="Close (Esc)" className="p-1 rounded text-mute hover:text-ink hover:bg-panel3" onClick={() => { setFr((f) => ({ ...f, open: false })); taRef.current?.focus(); }}>
                <X size={12} />
              </button>
            </div>
            {fr.withReplace && !readOnly && (
              <div className="flex items-center gap-1">
                <input
                  value={fr.r}
                  onChange={(e) => setFr((f) => ({ ...f, r: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), doReplace())}
                  placeholder="Replace with…"
                  aria-label="Replace with"
                  className="h-6.5 w-40 px-2 rounded bg-panel2 border border-bdr text-[12px] placeholder:text-mute focus:border-accent focus:outline-none"
                />
                <button className="px-1.5 py-0.5 rounded text-[11px] text-soft hover:text-ink hover:bg-panel3" onClick={doReplace}>
                  Replace
                </button>
                <button className="px-1.5 py-0.5 rounded text-[11px] text-soft hover:text-ink hover:bg-panel3" onClick={doReplaceAll}>
                  All
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default CodeEditor;
