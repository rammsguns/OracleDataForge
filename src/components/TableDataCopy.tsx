import { useState } from 'react';
import { api, ConfirmRequiredError } from '../utils/api';
import { tableDataSelection } from '../utils/tableDataDependencies';
import { useStudio } from '../state/store';
import { Btn, Spinner } from './ui';

export default function TableDataCopy({ sourceId, targetId }: { sourceId: string; targetId: string }) {
  const s = useStudio();
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof api.tableDataPlan>> | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [existing, setExisting] = useState<{ occupied: string[]; names: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.copyTableData>> | null>(null);
  const read = async () => {
    setBusy(true); setError(''); setResult(null); setPlan(null); setRoots([]);
    try { setPlan(await api.tableDataPlan(targetId, sourceId)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async (confirmed = false, mode: 'append' | 'replace' = 'append', checked = false) => {
    setBusy(true); setError(''); setResult(null);
    try {
      if (!confirmed && !checked) {
        const check = await api.checkTableData(targetId, sourceId, names);
        setPlan(prev => prev ? { ...prev, sourceCounts: { ...prev.sourceCounts, ...check.sourceCounts } } : prev);
        if (check.occupied.length) { setExisting({ ...check, names: [...names] }); return; }
      }
      setExisting(null);
      const outcome = await api.copyTableData(targetId, sourceId, names, confirmed, mode);
      setResult(outcome); setRoots([]);
      if (s.activeConnId === targetId) s.bumpSchema();
      s.toast('success', `${outcome.totalRows.toLocaleString()} rows copied`);
    } catch (e) {
      if (e instanceof ConfirmRequiredError) {
        s.askConfirm({ ...e.confirmation, onConfirm: () => { void copy(true, mode, true); } });
      } else { setError((e as Error).message); }
    } finally { setBusy(false); }
  };
  const blocked = plan?.targetReadOnly || plan?.targetSystemSchema || plan?.sameSchema;
  const eligibleNames = plan?.items.filter(table => table.existsInTarget).map(table => table.name) ?? [];
  const selection = tableDataSelection(roots, eligibleNames, plan?.dependencies ?? []);
  const names = selection.names;
  const relevantDependencies = plan?.dependencies.filter(d => names.includes(d.table)) ?? [];
  const selectableNames = eligibleNames.filter(name => plan?.sourceCounts[name] !== undefined && plan.sourceCounts[name] <= 100000);
  const invalidCounts = names.filter(name => plan?.sourceCounts[name] === undefined || plan.sourceCounts[name] > 100000);
  const sourceTotal = names.reduce((sum, name) => sum + (plan?.sourceCounts[name] ?? 0), 0);
  const selectionFull = names.length >= Math.min(25, selectableNames.length);
  const copyDisabledReason = busy ? 'An operation is running.'
    : blocked ? 'Choose a different, writable target schema.'
    : !names.length ? 'Select at least one table to copy.'
    : invalidCounts.length ? `Cannot copy: ${invalidCounts.join(', ')} exceeds 100,000 rows or has no verified count (including required parents).`
    : sourceTotal > 100000 ? `${sourceTotal.toLocaleString()} selected rows exceed the 100,000-row copy limit. Select fewer tables.`
    : selection.overLimit ? 'The selection and required parents exceed the 25-table limit.'
    : '';
  return <div className="space-y-3 text-[12px]">
    <p className="text-soft">Copy table rows from the source connection’s schema to the target connection’s schema. Create missing tables with Copy objects first.</p>
    <p className="text-mute">Before copying, target tables are checked for existing rows. Duplicate keys or incompatible columns stop the copy. Required parent tables are selected automatically and copied first. Up to 25 tables and 100,000 rows per copy; Text, numbers, dates, timestamps, RAW, VECTOR, JSON, CLOB, and NCLOB columns are supported. Text is limited to 16 MB per row. Identity columns retain source IDs; GENERATED ALWAYS is temporarily changed to BY DEFAULT and restored after copying; BLOB and BFILE columns require a custom migration.</p>
    <p className="text-warn">Identity sequences are synchronized after rows commit. Identity settings change separately from the row transaction. Pause other target writes during copying. If interrupted, identity settings may need repair.</p>
    <p className="text-warn">Copied rows commit together in a separate session. Worksheet Commit/Rollback does not apply. Target triggers run on attempts, including retries; autonomous changes cannot be rolled back.</p>
    <Btn variant="outline" disabled={busy || !sourceId || !targetId || sourceId === targetId} onClick={() => void read()}>Read tables</Btn>
    {busy && <div role="status"><Spinner /> Working… Keep this tab open until the copy finishes.</div>}
    {existing && existing.names.join('|') === names.join('|') && <div role="alert" className="border border-warn rounded p-3 space-y-2">
      <p>Existing data found in: {existing.occupied.join(', ')}.</p>
      <p>Replace deletes all rows in all {names.length} selected tables, including required parents, before copying. Deletes and inserts commit together; a failure rolls them back. Foreign-key conflicts may block replacement.</p>
      <Btn disabled={busy} variant="outline" onClick={() => void copy(false, 'replace', true)}>Replace data (delete existing rows)</Btn>
      <Btn disabled={busy} variant="outline" onClick={() => void copy(false, 'append', true)}>Copy anyway (risk of duplicate keys)</Btn>
      <Btn disabled={busy} variant="outline" onClick={() => setExisting(null)}>Cancel</Btn>
    </div>}
    {error && <p role="alert" className="text-err">{error}</p>}
    {plan && <>
      <p>{plan.sourceSchema} → {plan.targetSchema}</p>
      <p>Selected source rows: {sourceTotal.toLocaleString()} / 100,000. Counts are checked again before copying.</p>
      <div className="sticky top-0 z-10 flex items-center gap-3 flex-wrap rounded-md border border-bdr bg-panel p-3 shadow-md">
        <Btn variant="primary" disabled={!!copyDisabledReason} title={copyDisabledReason || 'Review and confirm the data copy'} onClick={() => void copy()}>Copy data ({names.length} tables)</Btn>
        <p role="status" className={`flex-1 min-w-48 ${copyDisabledReason ? 'text-warn' : 'text-soft'}`}>
          {copyDisabledReason || 'Ready to copy. You will review a confirmation before any rows are sent.'}
        </p>
      </div>
      {blocked && <p className="text-err">Choose a different, writable target schema that is not Oracle-maintained.</p>}
      <fieldset disabled={busy || !!blocked} className="border border-bdr rounded p-3 max-h-72 overflow-auto space-y-2">
        <legend className="px-1">Tables ({names.length}/25 selected)</legend>
        <div className="flex items-center gap-2 flex-wrap">
          <Btn variant="outline" disabled={busy || !!blocked || selectionFull} onClick={() => setRoots(prev => [...prev, ...selectableNames.filter(name => !names.includes(name))].slice(0, 25))}>Select all</Btn>
          <Btn variant="outline" disabled={busy || !!blocked || !names.length} onClick={() => setRoots([])}>Clear selection</Btn>
          {eligibleNames.length > 25 && <span className="text-mute">Select all chooses up to 25 tables, plus their required parents. Dependency groups exceeding the limit need a custom migration.</span>}
        </div>
        {!plan.items.length && <p>No source tables found.</p>}
        {plan.items.map(table => <label key={table.name} className="flex gap-2 items-center">
          <input type="checkbox" checked={names.includes(table.name)} disabled={!selectableNames.includes(table.name) || selection.added.includes(table.name) || (!names.includes(table.name) && names.length >= 25)} onChange={e => setRoots(prev => e.target.checked ? [...prev, table.name] : prev.filter(n => n !== table.name))} />
          <span className="font-mono">{table.name}</span>
          <span className={plan.sourceCounts[table.name] > 100000 ? 'text-err' : 'text-mute'}>{plan.sourceCounts[table.name] === undefined ? 'Count unavailable — blocked' : plan.sourceCounts[table.name].toLocaleString() + ' source rows'}</span>
          {plan.sourceCounts[table.name] > 100000 && <span className="text-err">Exceeds 100,000-row limit — cannot copy</span>}{!table.existsInTarget && <span className="text-mute">Missing in target</span>}
          {selection.added.includes(table.name) && <span className="text-warn">Auto-selected: required parent</span>}
        </label>)}
      </fieldset>
      {!!relevantDependencies.length && <div role="status" className="border border-warn/40 rounded p-3 space-y-1 text-warn">
        <p className="font-semibold">Foreign-key dependencies require parent data, even when you did not select those tables.</p>
        {relevantDependencies.map(d => <p key={`${d.table}.${d.constraint}`}><span className="font-mono">{d.table} → {d.parentSchema}.{d.parent ?? '[not visible]'}</span> ({d.constraint})</p>)}
        {!!selection.added.length && <p>Automatically included: {selection.added.join(', ')}. Remove the child selections to release their parents.</p>}
        <p>This checks enabled foreign keys in the target schema, not whether every required parent row exists. Copying parents that already contain the same keys can fail with duplicate-key errors.</p>
        {selection.warnings.map(w => <p key={w}>{w}</p>)}
      </div>}
      {selection.overLimit && <p role="alert" className="text-err">Required dependencies bring this selection above 25 tables. Reduce the selection or use a custom migration; no dependency will be silently skipped.</p>}
      {!!selection.cycles.length && <p role="status" className="text-warn">Self-referencing or circular foreign keys involve {selection.cycles.join(', ')}. Copy is allowed: rows waiting for parent keys will be retried after their parents are inserted. Constraints remain enabled. If required keys cannot be resolved, the whole copy rolls back.</p>}
      {!!names.length && <p className="text-mute">Copy order: {names.join(' → ')}</p>}
    </>}
    {result && <div role="status" className="border border-ok/40 rounded p-3"><p className="text-ok">Committed {result.totalRows.toLocaleString()} rows.</p>{result.warnings?.map((warning, i) => <p key={i} className="text-warn whitespace-pre-wrap">{warning}</p>)}{result.tables.map(t => <p key={t.name}>{t.name}: {t.rows.toLocaleString()} rows</p>)}</div>}
  </div>;
}
