import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, CaseSensitive, Highlighter, Regex, Replace, Search, WholeWord } from "lucide-react";
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
  /** Open the find bar and focus its input — the toolbar Find button, and Ctrl+F from outside. */
  openFind: (withReplace?: boolean) => void;
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
  const [fr, setFr] = useState({
    withReplace: false,
    q: "",
    r: "",
    /** SQL Developer's Aa / "" / .* / highlight toggles */
    matchCase: false,
    wholeWord: false,
    regex: false,
    highlightAll: true,
  });
  /** Which match the caret is sitting on, so the bar can say "3 of 12" rather than just "12". */
  const [activeIdx, setActiveIdx] = useState(-1);

  const lines = value.split("\n");
  const tokens = useMemo(() => tokenize(value), [value]);
  const { windowed, syncWindow } = useHighlightWindow(value, tokens, taRef, LINE_H);
  /**
   * The search as one regular expression, so find, replace and the highlight layer can never
   * disagree about what counts as a hit — they used to: replace-all was hard-coded to `gi`
   * and ignored the search options entirely.
   *
   * A word boundary here is not \b: Oracle identifiers carry $ and # (`v$session`,
   * `dbms_output#`), and \b would happily match inside one.
   */
  const search = useMemo((): { re: RegExp | null; error: boolean } => {
    if (!fr.q) return { re: null, error: false };
    try {
      const body = fr.regex ? fr.q : escapeRe(fr.q);
      // built by concatenation: \w inside a template literal collapses to a literal w
      const src = fr.wholeWord ? "(?<![\\w$#])(?:" + body + ")(?![\\w$#])" : body;
      return { re: new RegExp(src, fr.matchCase ? "g" : "gi"), error: false };
    } catch {
      return { re: null, error: true }; // half-typed regex — say so instead of finding nothing
    }
  }, [fr.q, fr.regex, fr.wholeWord, fr.matchCase]);

  /** Every hit, in document order. Also what the highlight layer paints. */
  const matches = useMemo(() => {
    const re = search.re;
    if (!re) return [] as { start: number; end: number }[];
    const out: { start: number; end: number }[] = [];
    re.lastIndex = 0;
    for (let m = re.exec(value); m; m = re.exec(value)) {
      out.push({ start: m.index, end: m.index + m[0].length });
      if (m[0] === "") re.lastIndex++; // a pattern like `a*` matches empty — do not spin
      if (out.length > 5000) break; // a runaway pattern must not take the editor down with it
    }
    return out;
  }, [search, value]);

  // the old position is meaningless once the query or the text changes
  useEffect(() => setActiveIdx(-1), [search, value]);

  const hits = fr.highlightAll ? matches : [];
  const MATCH_CLS = "bg-warn/25 rounded-[2px]";
  const ACTIVE_CLS = "bg-accent/45 rounded-[2px]";

  /**
   * Render the coloured token spans, cutting any token a hit runs through so the match can
   * carry its own background. Splitting here rather than stacking a second overlay keeps one
   * set of glyphs under the textarea — two layers would drift apart the moment either scrolls.
   *
   * `base` is the character offset of the first token, which is non-zero on a big source
   * where only a window around the viewport is coloured.
   */
  const renderTokens = (toks: typeof tokens, base: number): ReactNode[] => {
    const out: ReactNode[] = [];
    let off = base;
    let mi = 0;
    toks.forEach((t, i) => {
      const a = off;
      const b = off + t.text.length;
      off = b;
      while (mi < hits.length && hits[mi].end <= a) mi++;
      if (mi >= hits.length || hits[mi].start >= b) {
        out.push(
          <span key={i} className={CLS[t.cls]}>
            {t.text}
          </span>
        );
        return;
      }
      const parts: ReactNode[] = [];
      let cursor = a;
      let k = 0;
      let j = mi;
      while (cursor < b) {
        const m = j < hits.length ? hits[j] : null;
        if (!m || m.start >= b) {
          parts.push(<span key={k++}>{value.slice(cursor, b)}</span>);
          break;
        }
        if (m.start > cursor) parts.push(<span key={k++}>{value.slice(cursor, m.start)}</span>);
        const end = Math.min(m.end, b);
        parts.push(
          <span key={k++} className={j === activeIdx ? ACTIVE_CLS : MATCH_CLS}>
            {value.slice(Math.max(cursor, m.start), end)}
          </span>
        );
        cursor = end;
        if (m.end <= b) j++; // a hit running past this token stays current for the next one
      }
      out.push(
        <span key={i} className={CLS[t.cls]}>
          {parts}
        </span>
      );
    });
    return out;
  };

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
    openFind(withReplace = false) {
      setFr((f) => ({ ...f, withReplace: withReplace && !readOnly }));
      requestAnimationFrame(() => findRef.current?.select());
    },
  }));

  /** Step to the next/previous hit from wherever the caret is, wrapping at either end. */
  const doFind = (dir: 1 | -1) => {
    const ta = taRef.current;
    if (!ta || !matches.length) return;
    const i =
      dir === 1
        ? matches.findIndex((m) => m.start >= ta.selectionEnd)
        : (() => {
            for (let k = matches.length - 1; k >= 0; k--) if (matches[k].end <= ta.selectionStart) return k;
            return -1;
          })();
    const next = i >= 0 ? i : dir === 1 ? 0 : matches.length - 1; // wrap
    setActiveIdx(next);
    selectRange(matches[next].start, matches[next].end);
  };

  const doReplace = () => {
    const ta = taRef.current;
    if (!ta || !matches.length || readOnly) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    // replace only when the selection *is* a hit; otherwise this click just moves to one
    const hit = matches.find((m) => m.start === s && m.end === e);
    if (!hit) return doFind(1);
    onChange(value.slice(0, hit.start) + fr.r + value.slice(hit.end));
    requestAnimationFrame(() => {
      const caret = hit.start + fr.r.length;
      ta.setSelectionRange(caret, caret);
      doFind(1);
    });
  };

  const doReplaceAll = () => {
    const re = search.re;
    if (!re || readOnly) return;
    re.lastIndex = 0;
    // in regex mode $1 &c. in the replacement are the user's to use, exactly as SQL Developer
    onChange(value.replace(re, fr.r));
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
      setFr((f) => ({ ...f, withReplace: e.key === "h" && !readOnly }));
      requestAnimationFrame(() => findRef.current?.focus());
      return;
    }
    if (e.key === "F3") {
      e.preventDefault();
      doFind(e.shiftKey ? -1 : 1);
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
    <div className="h-full flex flex-col min-h-0 bg-panel2 font-mono text-[13px] overflow-hidden">
      {/* Find & replace strip. Always on screen, the way SQL Developer keeps its search
          visible, rather than a popover that only a keyboard shortcut could summon. */}
      <div className="shrink-0 flex flex-col gap-1 px-2 py-1.5 border-b border-bdrsoft bg-panel font-sans">
        <div className="flex items-center gap-1 flex-wrap">
          <Search size={13} className="text-mute shrink-0" aria-hidden />
          <input
            ref={findRef}
            value={fr.q}
            onChange={(e) => setFr((f) => ({ ...f, q: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                doFind(e.shiftKey ? -1 : 1);
              }
              // the strip does not close, so Escape just hands typing back to the code
              if (e.key === "Escape") taRef.current?.focus();
            }}
            placeholder="Find…"
            aria-label="Find text"
            className="h-6.5 w-52 px-2 rounded bg-panel2 border border-bdr text-[12px] placeholder:text-mute focus:border-accent focus:outline-none"
          />
          <span
            className={`text-[10px] w-16 text-center tabular-nums ${search.error ? "text-err" : "text-mute"}`}
            aria-live="polite"
          >
            {!fr.q ? "" : search.error ? "bad regex" : !matches.length ? "no results" : `${activeIdx + 1 || 1} of ${matches.length}`}
          </span>
          <button aria-label="Find previous (Shift+Enter)" title="Find previous" className="p-1 rounded text-mute hover:text-ink hover:bg-panel3" onClick={() => doFind(-1)}>
            <ArrowUp size={12} />
          </button>
          <button aria-label="Find next (Enter)" title="Find next" className="p-1 rounded text-mute hover:text-ink hover:bg-panel3" onClick={() => doFind(1)}>
            <ArrowDown size={12} />
          </button>
          {!readOnly && (
            <button
              aria-label="Toggle replace"
              aria-pressed={fr.withReplace}
              title="Replace (Ctrl+H)"
              className={`p-1 rounded hover:bg-panel3 ${fr.withReplace ? "bg-accentdim text-accenthi" : "text-mute hover:text-ink"}`}
              onClick={() => setFr((f) => ({ ...f, withReplace: !f.withReplace }))}
            >
              <Replace size={12} />
            </button>
          )}
          <span aria-hidden className="w-px h-4 bg-bdr mx-0.5" />
          {(
            [
              ["matchCase", CaseSensitive, "Match case"],
              ["wholeWord", WholeWord, "Whole word only"],
              ["regex", Regex, "Use a regular expression"],
              ["highlightAll", Highlighter, "Highlight every match"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              aria-label={label}
              aria-pressed={fr[key]}
              title={label}
              className={`p-1 rounded hover:bg-panel3 ${fr[key] ? "bg-accentdim text-accenthi" : "text-mute hover:text-ink"}`}
              onClick={() => setFr((f) => ({ ...f, [key]: !f[key] }))}
            >
              <Icon size={12} />
            </button>
          ))}
        </div>
        {fr.withReplace && !readOnly && (
          <div className="flex items-center gap-1">
            <Replace size={13} className="text-mute shrink-0" aria-hidden />
            <input
              value={fr.r}
              onChange={(e) => setFr((f) => ({ ...f, r: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), doReplace())}
              placeholder="Replace with…"
              aria-label="Replace with"
              className="h-6.5 w-52 px-2 rounded bg-panel2 border border-bdr text-[12px] placeholder:text-mute focus:border-accent focus:outline-none"
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

      <div className="relative flex-1 min-h-0 flex">
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
                {renderTokens(windowed.mid, windowed.head.length)}
                {windowed.tail}
              </>
            ) : (
              renderTokens(tokens, 0)
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
        </div>
      </div>
    </div>
  );
});

export default CodeEditor;
