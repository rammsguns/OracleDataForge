import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import { editorDiagnostics } from '../utils/editorDiagnostics';

const KEY = 'dataforge.editor.appearance.v1';
const defaults = { fontSize: 13, palette: 'app', diagnostics: true };
const palettes: Record<string, Record<string, string>> = {
  app: {},
  ocean: { '--syn-kw': '#82aaff', '--syn-fn': '#89ddff', '--syn-str': '#c3e88d', '--syn-num': '#f78c6c', '--syn-cmt': '#98a6bb', '--syn-op': '#c792ea', '--editor-bg': '#101b2c', '--editor-fg': '#e0e8f5' },
  paper: { '--syn-kw': '#6639a6', '--syn-fn': '#005a9c', '--syn-str': '#246526', '--syn-num': '#9a4200', '--syn-cmt': '#596579', '--syn-op': '#9b2340', '--editor-bg': '#fafaf7', '--editor-fg': '#202938' },
};
function readSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { fontSize: Number.isInteger(s.fontSize) ? Math.max(10, Math.min(24, s.fontSize)) : 13,
      palette: Object.prototype.hasOwnProperty.call(palettes, s.palette) ? s.palette as string : 'app', diagnostics: typeof s.diagnostics === 'boolean' ? s.diagnostics : true };
  } catch { return defaults; }
}

export function useEditorTools(value: string, ref: RefObject<HTMLTextAreaElement>, errorLine?: number | null) {
  const [settings, setSettings] = useState(readSettings);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const sync = () => setSettings(readSettings());
    window.addEventListener(KEY, sync); window.addEventListener('storage', sync);
    return () => { window.removeEventListener(KEY, sync); window.removeEventListener('storage', sync); };
  }, []);
  const update = (next: typeof settings) => {
    setSettings(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); window.dispatchEvent(new Event(KEY)); } catch { /* Session-only if storage is unavailable. */ }
  };
  const diagnostics = useMemo(() => settings.diagnostics ? editorDiagnostics(value) : [], [value, settings.diagnostics]);
  const errors = diagnostics.filter(d => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  const lineHeight = Math.ceil(settings.fontSize * 1.55);
  const jump = (offset: number, line: number) => {
    const ta = ref.current; if (!ta) return;
    ta.focus(); ta.setSelectionRange(offset, offset);
    ta.scrollTop = Math.max(0, (line - 1) * lineHeight - ta.clientHeight / 2);
    ta.dispatchEvent(new Event('scroll'));
  };
  const lineIssues = new Map<number, string>();
  for (const d of diagnostics) if (d.severity === 'error' || !lineIssues.has(d.line)) lineIssues.set(d.line, d.severity);
  const gutterClass = (line: number) => errorLine === line || lineIssues.get(line) === 'error' ? 'text-err font-bold' : lineIssues.has(line) ? 'text-warn font-bold' : 'text-mute';
  const toolbar = <div className="shrink-0 flex flex-wrap items-center gap-3 border-b border-bdrsoft bg-panel px-3 py-1 text-[12px] font-sans text-ink">
    <label className="flex items-center gap-1">Font size <select aria-label="Editor font size" className="bg-panel2 border border-bdr rounded px-1" value={settings.fontSize} onChange={e => update({ ...settings, fontSize: Number(e.target.value) })}>
      {Array.from({ length: 15 }, (_, i) => i + 10).map(n => <option key={n} value={n}>{n}px</option>)}
    </select></label>
    <label className="flex items-center gap-1">Colors <select aria-label="Editor colors" className="bg-panel2 border border-bdr rounded px-1" value={settings.palette} onChange={e => update({ ...settings, palette: e.target.value })}>
      <option value="app">App theme</option><option value="ocean">Ocean</option><option value="paper">Paper</option>
    </select></label>
    <label className="flex items-center gap-1"><input type="checkbox" checked={settings.diagnostics} onChange={e => update({ ...settings, diagnostics: e.target.checked })} />Live checks</label>
    <button type="button" className="hover:underline" onClick={() => update(defaults)}>Reset</button>
  </div>;
  const problems = <div className="shrink-0 border-t border-bdrsoft bg-panel text-[12px] font-sans text-ink">
    <button type="button" aria-expanded={expanded} className="w-full text-left px-3 py-1 hover:bg-panel3" onClick={() => setExpanded(!expanded)}>
      {expanded ? '▾' : '▸'} Problems · {errors} errors · {warnings} warnings{errorLine ? ' · Database error' : ''}{!settings.diagnostics ? ' · Live checks off' : ''}
    </button>
    {expanded && <div className="max-h-36 overflow-auto px-3 pb-2">
      <p className="text-mute mb-1">Local checks cover quotes, parentheses, NULL comparisons and ignored exceptions. Run or compile for Oracle validation.</p>
      {errorLine && <button type="button" className="block text-err text-left" onClick={() => jump(value.split('\n').slice(0, errorLine - 1).reduce((n, s) => n + s.length + 1, 0), errorLine)}>Error · Line {errorLine}: Database reported an error. See the result or compilation panel for details.</button>}
      {diagnostics.map((d, i) => <button type="button" key={i} className={`block text-left hover:underline ${d.severity === 'error' ? 'text-err' : 'text-warn'}`} onClick={() => jump(d.offset, d.line)}>{d.severity === 'error' ? 'Error' : 'Warning'} · {d.line}:{d.column} · {d.message}</button>)}
      {!diagnostics.length && <p className="text-mute">{settings.diagnostics ? 'No local issues found.' : 'Enable Live checks to inspect this document.'}</p>}
    </div>}
  </div>;
  return { toolbar, problems, gutterClass, fontSize: settings.fontSize, lineHeight, style: palettes[settings.palette] as CSSProperties };
}
