import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { Token } from "./sql";

/**
 * Above this many tokens the highlight layer is windowed. A 156k-character package
 * (`SYS.STANDARD`) produces ~15k spans and React reconciles every one of them on each
 * keystroke — ~160 ms per input. Tokenizing itself is only ~9 ms, so the DOM nodes are
 * the cost, not the lexer. Normal 1–6 KB sources stay below the threshold and render
 * exactly as before, with no scroll-driven state at all.
 */
const HEAVY_TOKENS = 4000;
/** Lines coloured beyond the viewport, so ordinary scrolling never repaints. */
const WINDOW_SLACK = 80;
/** The window moves in steps of this many lines instead of following every pixel. */
const WINDOW_BLOCK = 40;

export interface HighlightWindow {
  head: string;
  mid: Token[];
  tail: string;
}

/**
 * Colour only the lines around the viewport on a big source; emit everything before and
 * after as one plain text node each. Same characters in the same order, so the layout
 * under the transparent textarea is identical — only the node count drops. Tokenizing
 * stays whole-document, so a block comment or multi-line string opened far above the
 * viewport still resolves correctly inside it.
 *
 * Returns `null` when the source is small enough to highlight in full; the caller then
 * renders every token as before.
 */
export function useHighlightWindow(
  value: string,
  tokens: Token[],
  taRef: RefObject<HTMLTextAreaElement | null>,
  lineHeight: number
): { windowed: HighlightWindow | null; syncWindow: () => void } {
  const [win, setWin] = useState({ from: 0, to: 400 });
  const heavy = tokens.length > HEAVY_TOKENS;

  /** Character offset of the start of each line — used to cut the coloured window. */
  const lineStarts = useMemo(() => {
    if (!heavy) return null;
    const out = [0];
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) out.push(i + 1);
    return out;
  }, [value, heavy]);

  const windowed = useMemo(() => {
    if (!heavy || !lineStarts) return null;
    const startChar = lineStarts[Math.min(win.from, lineStarts.length - 1)] ?? 0;
    const endChar = win.to + 1 < lineStarts.length ? lineStarts[win.to + 1] : value.length;
    let head = "";
    let tail = "";
    const mid: Token[] = [];
    let off = 0;
    for (const t of tokens) {
      const a = off;
      const b = off + t.text.length;
      off = b;
      if (b <= startChar) { head += t.text; continue; }
      if (a >= endChar) { tail += t.text; continue; }
      // a token straddling an edge is split, so no character is printed twice or lost
      const cut = Math.max(0, startChar - a);
      const stop = Math.min(t.text.length, Math.max(0, endChar - a));
      if (cut) head += t.text.slice(0, cut);
      if (stop > cut) mid.push({ cls: t.cls, text: t.text.slice(cut, stop) });
      if (stop < t.text.length) tail += t.text.slice(stop);
    }
    return { head, mid, tail };
  }, [heavy, lineStarts, tokens, value, win.from, win.to]);

  /** Re-aim the window, quantized to blocks so a small scroll costs nothing. */
  const syncWindow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const first = Math.floor(ta.scrollTop / lineHeight);
    const visible = Math.ceil(ta.clientHeight / lineHeight);
    setWin((w) => {
      const from = Math.max(0, Math.floor((first - WINDOW_SLACK) / WINDOW_BLOCK) * WINDOW_BLOCK);
      const to = Math.ceil((first + visible + WINDOW_SLACK) / WINDOW_BLOCK) * WINDOW_BLOCK;
      return from === w.from && to === w.to ? w : { from, to };
    });
  }, [taRef, lineHeight]);

  // the window has to be right before the first paint of a big source, not after a scroll
  useEffect(() => {
    if (heavy) syncWindow();
  }, [heavy, syncWindow]);

  return { windowed: heavy ? windowed : null, syncWindow: heavy ? syncWindow : NOOP };
}

const NOOP = () => {};
