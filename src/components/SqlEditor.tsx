import { useCodeCompletion } from "./useCodeCompletion";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
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

export default function SqlEditor({
  value,
  onChange,
  errorLine,
  onRun,
  onSelectionChange,
}: {
  value: string;
  onChange: (v: string) => void;
  errorLine?: number | null;
  onRun?: () => void;
  onSelectionChange?: (start: number, end: number) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const completion = useCodeCompletion(taRef, value, onChange);

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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (completion.onKeyDown(e)) return;
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
          {...completion.inputProps}
          onKeyDown={onKeyDown}
          onSelect={e => onSelectionChange?.(e.currentTarget.selectionStart, e.currentTarget.selectionEnd)}
          onScroll={() => { syncScroll(); completion.close(); }}
          spellCheck={false}
          aria-label="SQL editor"
          title="Code suggestions: Ctrl+Space"
          className="absolute inset-0 w-full h-full resize-none bg-transparent text-transparent caret-[var(--accent)] outline-none overflow-auto"
          style={sharedStyle}
        />
        {completion.popup}
      </div>
    </div>
  );
}
