import { useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { getCompletions, type Completion } from '../utils/completions';

export function useCodeCompletion(ref: RefObject<HTMLTextAreaElement>, value: string, onChange: (v: string) => void, readOnly = false) {
  const id = useId();
  const composing = useRef(false);
  const [state, setState] = useState<(NonNullable<ReturnType<typeof getCompletions>> & { source: string; caret: number; selected: number; top: number; left: number; height: number }) | null>(null);
  const ac = !readOnly && state?.source === value ? state : null;
  const close = () => setState(null);
  const suggest = (source: string, explicit = false) => {
    const ta = ref.current;
    if (!ta || readOnly || composing.current || ta.selectionStart !== ta.selectionEnd) return close();
    const result = getCompletions(source, ta.selectionStart, explicit);
    if (!result) return close();
    const lines = source.slice(0, ta.selectionStart).split('\n');
    const metrics = getComputedStyle(ta);
    const y = lines.length * parseFloat(metrics.lineHeight) + parseFloat(metrics.paddingTop) - ta.scrollTop;
    const height = Math.min(250, Math.max(60, ta.clientHeight - 16));
    setState({ ...result, source, caret: ta.selectionStart, selected: 0, height,
      top: Math.max(0, Math.min(y, ta.clientHeight - height)),
      left: Math.max(0, Math.min((lines.at(-1)?.replace(/\t/g, '  ').length ?? 0) * parseFloat(metrics.fontSize) * 0.6 + parseFloat(metrics.paddingLeft) - ta.scrollLeft, ta.clientWidth - 340)) });
  };
  const apply = (item: Completion) => {
    const ta = ref.current;
    if (!ac || !ta || ta.selectionStart !== ac.caret || ta.selectionEnd !== ac.caret) return close();
    const indent = value.slice(0, ac.start).split('\n').at(-1)?.match(/^\s*/)?.[0] ?? '';
    const text = item.text.replace(/\n/g, '\n' + indent);
    onChange(value.slice(0, ac.start) + text + value.slice(ac.end));
    close();
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ac.start + text.length, ac.start + text.length); });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || composing.current || readOnly) return false;
    if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
      e.preventDefault(); e.stopPropagation(); suggest(value, true); return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) { close(); return false; }
    if (!ac) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const selected = (ac.selected + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
      setState({ ...ac, selected });
      requestAnimationFrame(() => document.getElementById(`${id}-${selected}`)?.scrollIntoView({ block: 'nearest' }));
      return true;
    }
    if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) { e.preventDefault(); apply(ac.items[ac.selected]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return true; }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'].includes(e.key)) close();
    return false;
  };
  return {
    onKeyDown, close,
    inputProps: {
      'aria-autocomplete': 'list' as const,
      'aria-controls': ac ? id : undefined,
      'aria-activedescendant': ac ? `${id}-${ac.selected}` : undefined,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => { onChange(e.target.value); suggest(e.target.value); },
      onBlur: close, onClick: close,
      onCompositionStart: () => { composing.current = true; close(); },
      onCompositionEnd: () => { composing.current = false; },
    },
    popup: ac && <div id={id} role="listbox" aria-label="Code suggestions" className="absolute z-30 rounded-lg border border-bdr bg-panel shadow-2xl overflow-auto text-ink" style={{ top: ac.top, left: ac.left, width: 340, maxWidth: '100%', maxHeight: ac.height }}>
      <div className="px-3 py-1 text-[10px] text-mute border-b border-bdrsoft">↑ ↓ navigate · Tab / Enter accept · Esc dismiss</div>
      {ac.items.map((item, i) => <div id={`${id}-${i}`} key={item.label} role="option" aria-selected={i === ac.selected}
        className={`cursor-pointer px-3 py-1 text-[12px] ${i === ac.selected ? 'bg-accentdim' : ''}`}
        onMouseDown={e => { e.preventDefault(); apply(item); }} onMouseEnter={() => setState({ ...ac, selected: i })}>
        <div className="flex justify-between gap-3"><span>{item.label}</span><span className="text-mute text-[10px]">{item.detail}</span></div>
        {i === ac.selected && item.detail.startsWith('snippet') && <pre className="text-[11px] text-soft whitespace-pre-wrap mt-1">{item.text}</pre>}
      </div>)}
    </div>,
  };
}
