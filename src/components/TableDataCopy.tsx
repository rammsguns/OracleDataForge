import { useMemo, useState } from 'react';
import { api, ConfirmRequiredError } from '../utils/api';
import { indexTableDependencies, limitedCopyCount, tableDataSelection, TABLE_COPY_DEFAULT_TOTAL_ROWS, TABLE_COPY_MAX_ROWS, TABLE_COPY_MAX_TABLES } from '../utils/tableDataDependencies';
import { useStudio } from '../state/store';
import { Btn, Spinner } from './ui';

export default function TableDataCopy({ sourceId, targetId }: { sourceId: string; targetId: string }) {
  const s = useStudio();
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof api.tableDataPlan>> | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [existing, setExisting] = useState<{ occupied: string[]; names: string[]; rowLimit: number | null; maxTotal: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.copyTableData>> | null>(null);
  const [limitRows, setLimitRows] = useState(false);
  const [rowLimitText, setRowLimitText] = useState('1000');
  const parsedLimit = Number(rowLimitText);
  const rowLimitValid = !limitRows || (Number.isSafeInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= TABLE_COPY_MAX_ROWS);
  const rowLimit = limitRows && rowLimitValid ? parsedLimit : null;
  const [totalLimitText, setTotalLimitText] = useState(String(TABLE_COPY_DEFAULT_TOTAL_ROWS));
  const parsedTotal = Number(totalLimitText);
  const totalLimitValid = Number.isSafeInteger(parsedTotal) && parsedTotal >= 1 && parsedTotal <= TABLE_COPY_MAX_ROWS;
  const maxTotal = totalLimitValid ? parsedTotal : TABLE_COPY_DEFAULT_TOTAL_ROWS;
  const capLabel = maxTotal.toLocaleString();
  const rowsFor = (name: string) => limitedCopyCount(plan?.sourceCounts[name] ?? 0, rowLimit);
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
        const check = await api.checkTableData(targetId, sourceId, names, rowLimit, maxTotal);
        setPlan(prev => prev ? { ...prev, sourceCounts: { ...prev.sourceCounts, ...check.sourceCounts } } : prev);
        if (check.occupied.length) { setExisting({ ...check, names: [...names], rowLimit, maxTotal }); return; }
      }
      setExisting(null);
      const outcome = await api.copyTableData(targetId, sourceId, names, confirmed, mode, rowLimit, maxTotal);
      setResult(outcome); setRoots([]);
      if (s.activeConnId === targetId) s.bumpSchema();
      s.toast(outcome.skippedRows ? 'warning' : 'success', `${outcome.totalRows.toLocaleString()} rows copied${outcome.skippedRows ? ` (${outcome.skippedRows.toLocaleString()} skipped)` : ''}`);
    } catch (e) {
      if (e instanceof ConfirmRequiredError) {
        s.askConfirm({ ...e.confirmation, onConfirm: () => { void copy(true, mode, true); } });
      } else { setError((e as Error).message); }
    } finally { setBusy(false); }
  };
  const blocked = plan?.targetReadOnly || plan?.targetSystemSchema || plan?.sameSchema;
  const eligibleNames = useMemo(() => plan?.items.filter(table => table.existsInTarget).map(table => table.name) ?? [], [plan?.items]);
  const dependencyIndex = useMemo(() => indexTableDependencies(plan?.dependencies ?? []), [plan?.dependencies]);
  const selection = useMemo(() => tableDataSelection(roots, eligibleNames, dependencyIndex), [roots, eligibleNames, dependencyIndex]);
  const names = selection.names;
  const nameSet = useMemo(() => new Set(names), [names]);
  const addedSet = useMemo(() => new Set(selection.added), [selection.added]);
  const relevantDependencies = useMemo(() => names.flatMap(name => dependencyIndex.get(name) ?? []), [names, dependencyIndex]);
  const selectableNames = eligibleNames.filter(name => plan?.sourceCounts[name] !== undefined && rowsFor(name) <= maxTotal);
  const selectableSet = new Set(selectableNames);
  const invalidCounts = names.filter(name => plan?.sourceCounts[name] === undefined || rowsFor(name) > maxTotal);
  const sourceTotal = names.reduce((sum, name) => sum + rowsFor(name), 0);
  const selectionFull = names.length >= Math.min(TABLE_COPY_MAX_TABLES, selectableNames.length);
  const copyDisabledReason = busy ? 'An operation is running.'
    : blocked ? 'Choose a different, writable target schema.'
    : !totalLimitValid ? `Enter a total row limit from 1 to ${TABLE_COPY_MAX_ROWS.toLocaleString()}.`
    : !rowLimitValid ? `Enter a row limit from 1 to ${TABLE_COPY_MAX_ROWS.toLocaleString()}.`
    : !names.length ? 'Select at least one table to copy.'
    : invalidCounts.length ? `Cannot copy: ${invalidCounts.join(', ')} exceeds the ${capLabel}-row total limit or has no verified count (including required parents). Set a row limit per table or raise the total limit.`
    : sourceTotal > maxTotal ? `${sourceTotal.toLocaleString()} selected rows exceed the ${capLabel}-row total limit. Raise the total limit (up to ${TABLE_COPY_MAX_ROWS.toLocaleString()}), select fewer tables, or lower the row limit per table.`
    : selection.overLimit ? `The selection and required parents exceed the ${TABLE_COPY_MAX_TABLES}-table limit.`
    : '';
  return <div className="space-y-3 text-[12px]">
    <p className="text-soft">Copy table rows from the source connection’s schema to the target connection’s schema. Create missing tables with Copy objects first.</p>
    <p className="text-mute">Before copying, target tables are checked for existing rows. Duplicate keys or incompatible columns stop the copy. Required parent tables are selected automatically and copied first. Up to {TABLE_COPY_MAX_TABLES.toLocaleString()} tables per copy, with a total row limit you choose (default 100,000, up to 1,000,000) — set a row limit per table to copy a sample of larger tables; Text, numbers, dates, timestamps, RAW, VECTOR, JSON, CLOB, and NCLOB columns are supported. Text is limited to 16 MB per row. Identity columns retain source IDs; GENERATED ALWAYS is temporarily changed to BY DEFAULT and restored after copying; BLOB and BFILE columns require a custom migration.</p>
    <p className="text-warn">Identity sequences are synchronized after rows commit. Identity settings change separately from the row transaction. Pause other target writes during copying. If interrupted, identity settings may need repair.</p>
    <p className="text-warn">Copied rows commit together in a separate session. Worksheet Commit/Rollback does not apply. Target triggers run on attempts, including retries; autonomous changes cannot be rolled back.</p>
    <Btn variant="outline" disabled={busy || !sourceId || !targetId || sourceId === targetId} onClick={() => void read()}>Read tables</Btn>
    {busy && <div role="status"><Spinner /> Working… Keep this tab open until the copy finishes.</div>}
    {existing && existing.rowLimit === rowLimit && existing.maxTotal === maxTotal && existing.names.join('|') === names.join('|') && <div role="alert" className="border border-warn rounded p-3 space-y-2">
      <p>Existing data found in: {existing.occupied.join(', ')}.</p>
      <p>Replace deletes all rows in all {names.length} selected tables, including required parents, before copying. Deletes and inserts commit together; a failure rolls them back. Foreign-key conflicts may block replacement.</p>
      <Btn disabled={busy} variant="outline" onClick={() => void copy(false, 'replace', true)}>Replace data (delete existing rows)</Btn>
      <Btn disabled={busy} variant="outline" onClick={() => void copy(false, 'append', true)}>Copy anyway (risk of duplicate keys)</Btn>
      <Btn disabled={busy} variant="outline" onClick={() => setExisting(null)}>Cancel</Btn>
    </div>}
    {error && <p role="alert" className="text-err">{error}</p>}
    {plan && <>
      <p>{plan.sourceSchema} → {plan.targetSchema}</p>
      <p className={sourceTotal > maxTotal ? 'text-err' : undefined}>Rows to copy: {sourceTotal.toLocaleString()} / {capLabel}. Counts are checked again before copying.</p>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2">
          Total row limit
          <input type="number" min={1} max={TABLE_COPY_MAX_ROWS} step={1} value={totalLimitText} disabled={busy} aria-label="Total row limit for this copy"
            onChange={e => setTotalLimitText(e.target.value)} className={`w-32 rounded border bg-panel px-2 py-1 font-mono ${totalLimitValid ? 'border-bdr' : 'border-err'}`} />
        </label>
        {[100000, 250000, 500000, TABLE_COPY_MAX_ROWS].map(n => <Btn key={n} variant="outline" disabled={busy || maxTotal === n} onClick={() => setTotalLimitText(String(n))}>{n >= 1000000 ? `${n / 1000000}M` : `${n / 1000}K`}</Btn>)}
        <span className="text-mute">max {TABLE_COPY_MAX_ROWS.toLocaleString()}</span>
      </div>
      {maxTotal > TABLE_COPY_DEFAULT_TOTAL_ROWS && <p className="text-warn">Large copies run as one transaction and can take several minutes; keep this tab open and make sure the target has enough undo space.</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={limitRows} disabled={busy} onChange={e => setLimitRows(e.target.checked)} />
          Limit rows per table
        </label>
        {limitRows && <>
          <input type="number" min={1} max={TABLE_COPY_MAX_ROWS} step={1} value={rowLimitText} disabled={busy} aria-label="Maximum rows per table"
            onChange={e => setRowLimitText(e.target.value)} className={`w-28 rounded border bg-panel px-2 py-1 font-mono ${rowLimitValid ? 'border-bdr' : 'border-err'}`} />
          <span className="text-mute">rows per table (first rows returned by each table)</span>
        </>}
      </div>
      {rowLimit && <p className="text-warn">Sampled child rows whose parent rows were not sampled are skipped and reported, so foreign keys stay valid; the rest of the copy still commits.</p>}
      <div className="sticky top-0 z-10 flex items-center gap-3 flex-wrap rounded-md border border-bdr bg-panel p-3 shadow-md">
        <Btn variant="primary" disabled={!!copyDisabledReason} title={copyDisabledReason || 'Review and confirm the data copy'} onClick={() => void copy()}>Copy data ({names.length} tables)</Btn>
        <p role="status" className={`flex-1 min-w-48 ${copyDisabledReason ? 'text-warn' : 'text-soft'}`}>
          {copyDisabledReason || 'Ready to copy. You will review a confirmation before any rows are sent.'}
        </p>
      </div>
      {blocked && <p className="text-err">Choose a different, writable target schema that is not Oracle-maintained.</p>}
      <fieldset disabled={busy || !!blocked} className="border border-bdr rounded p-3 max-h-72 overflow-auto space-y-2">
        <legend className="px-1">Tables ({names.length}/{TABLE_COPY_MAX_TABLES.toLocaleString()} selected)</legend>
        <div className="flex items-center gap-2 flex-wrap">
          <Btn variant="outline" disabled={busy || !!blocked || selectionFull} onClick={() => setRoots(prev => [...prev, ...selectableNames.filter(name => !nameSet.has(name))].slice(0, TABLE_COPY_MAX_TABLES))}>Select all ({selectableNames.length})</Btn>
          <Btn variant="outline" disabled={busy || !!blocked || !names.length} onClick={() => setRoots([])}>Clear selection</Btn>
          {eligibleNames.length > selectableNames.length && <span className="text-mute">{eligibleNames.length - selectableNames.length} table(s) can’t be selected (over the {capLabel}-row total limit or no count){limitRows ? '' : ' — set a row limit per table to include large tables'}.</span>}
        </div>
        {!plan.items.length && <p>No source tables found.</p>}
        {plan.items.map(table => <label key={table.name} className="flex gap-2 items-center">
          <input type="checkbox" checked={nameSet.has(table.name)} disabled={!selectableSet.has(table.name) || addedSet.has(table.name) || (!nameSet.has(table.name) && names.length >= TABLE_COPY_MAX_TABLES)} onChange={e => setRoots(prev => e.target.checked ? [...prev, table.name] : prev.filter(n => n !== table.name))} />
          <span className="font-mono">{table.name}</span>
          <span className={rowsFor(table.name) > maxTotal ? 'text-err' : 'text-mute'}>{plan.sourceCounts[table.name] === undefined ? 'Count unavailable — blocked' : plan.sourceCounts[table.name].toLocaleString() + ' source rows' + (rowLimit && plan.sourceCounts[table.name] > rowLimit ? ` → ${rowLimit.toLocaleString()} copied` : '')}</span>
          {rowsFor(table.name) > maxTotal && <span className="text-err">Exceeds the {capLabel}-row total limit — set a row limit per table or raise the total</span>}{!table.existsInTarget && <span className="text-mute">Missing in target</span>}
          {addedSet.has(table.name) && <span className="text-warn">Auto-selected: required parent</span>}
        </label>)}
      </fieldset>
      {!!relevantDependencies.length && <div role="status" className="border border-warn/40 rounded p-3 space-y-1 text-warn">
        <p className="font-semibold">Foreign-key dependencies require parent data, even when you did not select those tables.</p>
        {relevantDependencies.map(d => <p key={`${d.table}.${d.constraint}`}><span className="font-mono">{d.table} → {d.parentSchema}.{d.parent ?? '[not visible]'}</span> ({d.constraint})</p>)}
        {!!selection.added.length && <p>Automatically included: {selection.added.join(', ')}. Remove the child selections to release their parents.</p>}
        <p>This checks enabled foreign keys in the target schema, not whether every required parent row exists. Copying parents that already contain the same keys can fail with duplicate-key errors.</p>
        {selection.warnings.map(w => <p key={w}>{w}</p>)}
      </div>}
      {selection.overLimit && <p role="alert" className="text-err">Required dependencies bring this selection above {TABLE_COPY_MAX_TABLES.toLocaleString()} tables. Reduce the selection or use a custom migration; no dependency will be silently skipped.</p>}
      {!!selection.cycles.length && <p role="status" className="text-warn">Self-referencing or circular foreign keys involve {selection.cycles.join(', ')}. Copy is allowed: rows waiting for parent keys will be retried after their parents are inserted. Constraints remain enabled. If required keys cannot be resolved, the whole copy rolls back.</p>}
      {!!names.length && <p className="text-mute">Insert order (parents before children): {names.join(' → ')}</p>}
    </>}
    {result && <div role="status" className="border border-ok/40 rounded p-3"><p className="text-ok">Committed {result.totalRows.toLocaleString()} rows.</p>{result.warnings?.map((warning, i) => <p key={i} className="text-warn whitespace-pre-wrap">{warning}</p>)}{result.tables.map(t => <p key={t.name}>{t.name}: {t.rows.toLocaleString()} rows{t.skipped ? <span className="text-warn"> ({t.skipped.toLocaleString()} skipped — parent rows not in sample)</span> : null}</p>)}</div>}
  </div>;
}
