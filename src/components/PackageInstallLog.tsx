import { useState } from 'react';
import { installLogSummary, type InstallLogEntry, type InstallLogSeverity } from '../utils/packageInstall';
import { inputCls } from './ui';

const colors = {info: 'text-accenthi', warning: 'text-warn', error: 'text-err'};
export default function PackageInstallLog({entries}: {entries: InstallLogEntry[]}) {
  const [filter, setFilter] = useState<InstallLogSeverity | 'all'>('all');
  const summary = installLogSummary(entries);
  const visible = entries.filter(e => filter === 'all' || e.severity === filter);
  return <section aria-label="Deployment log" className="space-y-2 border border-bdr rounded p-3">
    <h4 className="font-semibold">Deployment log</h4>
    <p aria-label="Log severity counts"><span className={colors.info}>INFO: {summary.info}</span> · <span className={colors.warning}>WARNING: {summary.warning}</span> · <span className={colors.error}>ERROR: {summary.error}</span></p>
    <p className={summary.error ? colors.error : 'text-mute'}>{summary.error ? 'Blocked: resolve errors and regenerate before deployment.' : summary.warning ? 'No errors. Review warnings before deployment.' : 'No warnings or errors.'}</p>
    <p className="text-mute text-[11px]">INFO describes generated behavior. WARNING requires review. ERROR means generation failed or is incomplete. This log does not report SQL execution.</p>
    <label className="flex items-center gap-2">Show severity
      <select aria-label="Filter deployment log severity" className={inputCls} value={filter} onChange={e => setFilter(e.target.value as typeof filter)}>
        <option value="all">All ({entries.length})</option><option value="info">Info ({summary.info})</option><option value="warning">Warnings ({summary.warning})</option><option value="error">Errors ({summary.error})</option>
      </select>
    </label>
    <ol className="space-y-2 max-h-80 overflow-auto">{visible.map((e, i) => <li key={i} data-severity={e.severity} className="border-t border-bdrsoft pt-2">
      <p><strong className={colors[e.severity]}>[{e.severity.toUpperCase()}]</strong> {e.table && <code>{e.table}: </code>}{e.object && <code>{e.object.type} {e.object.name}: </code>}{e.message}{e.elapsedMs !== undefined ? ' (' + (e.elapsedMs / 1000).toFixed(1) + ' s)' : ''}</p>
      {e.details && <div className="mt-1 text-[11px]"><p>Stage: {e.details.stage} · {e.details.code}{e.details.row ? ' · Source row ' + e.details.row : ''}</p><p>{e.details.sourceSchema} → {e.details.targetSchema}</p>{e.details.columns.map(c => <p key={c.name}><code>{c.name}</code> ({c.type}): {c.reason}</p>)}<p className="mt-1">Suggested action: {e.details.advice}</p></div>}
    </li>)}</ol>
    {!visible.length && <p className="text-mute">No {filter === 'all' ? 'log' : filter} entries.</p>}
  </section>;
}
