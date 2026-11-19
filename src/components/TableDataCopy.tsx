import { useEffect, useMemo, useState } from 'react';
import { api, ConfirmRequiredError } from '../utils/api';
import { indexTableDependencies, limitedCopyCount, tableDataSelection, TABLE_COPY_DEFAULT_TOTAL_ROWS, TABLE_COPY_MAX_ROWS, TABLE_COPY_MAX_TABLES } from '../utils/tableDataDependencies';
import type { CopyProgress } from '../utils/tableDataProgress';
import { useStudio } from '../state/store';
import { Btn, Spinner } from './ui';

export default function TableDataCopy({ sourceId, targetId }: { sourceId: string; targetId: string }) {
  const s = useStudio();
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof api.tableDataPlan>> | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.copyTableData>> | null>(null);
  const [progress, setProgress] = useState<CopyProgress | null>(null);
  const [copying, setCopying] = useState(false);
  const refreshProgress = async () => {
    try { setProgress((await api.tableDataProgress(targetId)).progress); } catch { /* keep the last known progress */ }
  };
  // Show a copy that is already running (for example after reloading the page).
  useEffect(() => { setProgress(null); if (targetId) void refreshProgress(); }, [targetId]);
  const polling = copying || progress?.state === 'running';
  useEffect(() => {
    if (!polling || !targetId) return;
    const timer = setInterval(() => { void refreshProgress(); }, 1000);
    return () => clearInterval(timer);
  }, [polling, targetId]);
  const [limitRows, setLimitRows] = useState(false);
  const [truncate, setTruncate] = useState(false);
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
  const copy = async (confirmed = false) => {
    setBusy(true); setError(''); setResult(null);
    if (confirmed) setCopying(true);
    try {
      const outcome = await api.copyTableData(targetId, sourceId, names, confirmed, rowLimit, maxTotal, truncate);
      setResult(outcome); setRoots([]);
      // The copied tables now contain rows, so they can no longer be copied into.
      setPlan(prev => prev ? { ...prev, targetOccupied: [...new Set([...prev.targetOccupied, ...outcome.tables.filter(t => t.rows > 0).map(t => t.name)])] } : prev);
      if (s.activeConnId === targetId) s.bumpSchema();
      s.toast(outcome.skippedRows ? 'warning' : 'success', `${outcome.totalRows.toLocaleString()} rows copied${outcome.skippedRows ? ` (${outcome.skippedRows.toLocaleString()} skipped)` : ''}`);
    } catch (e) {
      if (e instanceof ConfirmRequiredError) {
        s.askConfirm({ ...e.confirmation, onConfirm: () => { void copy(true); } });
      } else {
        setError((e as Error).message);
        // A failed copy may have committed earlier tables; re-read so they show as not empty.
        if (/already committed|truncated/i.test((e as Error).message)) {
          try { setPlan(await api.tableDataPlan(targetId, sourceId)); } catch { /* keep the error visible */ }
        }
      }
    } finally {
      setBusy(false);
      if (confirmed) { setCopying(false); void refreshProgress(); }
    }
  };
  const blocked = plan?.targetReadOnly || plan?.targetSystemSchema || plan?.sameSchema;
  const occupiedSet = useMemo(() => new Set(plan?.targetOccupied ?? []), [plan?.targetOccupied]);
  // Only empty target tables can receive data, unless they are truncated first. Without
  // truncation, a filled parent is not copied: its rows are used.
  const eligibleNames = useMemo(() => plan?.items.filter(table => table.existsInTarget && (truncate || !occupiedSet.has(table.name))).map(table => table.name) ?? [], [plan?.items, occupiedSet, truncate]);
  const dependencyIndex = useMemo(() => indexTableDependencies(plan?.dependencies ?? []), [plan?.dependencies]);
  const selection = useMemo(() => tableDataSelection(roots, eligibleNames, dependencyIndex), [roots, eligibleNames, dependencyIndex]);
  const names = selection.names;
  const nameSet = useMemo(() => new Set(names), [names]);
  const truncating = truncate ? names.filter(name => occupiedSet.has(name)) : [];
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
    <p className="text-mute">Data is copied only into empty target tables. Tables that already contain rows can’t be selected unless you choose to truncate them first. Duplicate keys or incompatible columns stop the copy. Required parent tables are selected automatically and copied first. Up to {TABLE_COPY_MAX_TABLES.toLocaleString()} tables per copy, with a total row limit you choose (default 100,000, up to 1,000,000) — set a row limit per table to copy a sample of larger tables; Text, numbers, dates, timestamps (including WITH TIME ZONE and WITH LOCAL TIME ZONE), RAW, ROWID, UROWID, VECTOR, JSON, CLOB, and NCLOB columns are supported. Large CLOB, NCLOB and JSON values are streamed in chunks, so they have no size limit. Identity columns retain source IDs; GENERATED ALWAYS is temporarily changed to BY DEFAULT and restored after copying; BLOB and BFILE columns require a custom migration.</p>
    <p className="text-warn">Each table is committed as soon as its rows are inserted, in a separate session, so undo only holds one table at a time. If a table fails it is rolled back, but tables committed before it keep their rows; empty them before retrying. Worksheet Commit/Rollback does not apply.</p>
    <p className="text-warn">Identity sequences are synchronized after copying. Pause other target writes during copying. If interrupted, identity settings may need repair. Target triggers run on attempts, including retries.</p>
    <Btn variant="outline" disabled={busy || !sourceId || !targetId || sourceId === targetId} onClick={() => void read()}>Read tables</Btn>
    {busy && <div role="status"><Spinner /> Working… Keep this tab open until the copy finishes.</div>}
    {error && <p role="alert" className="text-err">{error}</p>}
    {progress && <CopyProgressPanel progress={progress} />}
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
      {maxTotal > TABLE_COPY_DEFAULT_TOTAL_ROWS && <p className="text-warn">Large copies can take several minutes; keep this tab open. Each table commits separately, so the largest single table sets how much undo space is needed.</p>}
      <div className="space-y-1">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={truncate} disabled={busy} onChange={e => { setTruncate(e.target.checked); if (!e.target.checked) setRoots(prev => prev.filter(n => !occupiedSet.has(n))); }} />
          Truncate target tables before copying
        </label>
        {truncate && <p className="text-err">TRUNCATE permanently removes all rows from every selected target table that has data, including automatically selected parents. It cannot be rolled back, even if the copy fails, and DELETE triggers do not fire. Child tables outside the selection that reference them block truncation.</p>}
      </div>
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
      {rowLimit && <p className="text-warn">Sampled child rows whose parent rows were not sampled are skipped and reported, so foreign keys stay valid.</p>}
      <div className="sticky top-0 z-10 flex items-center gap-3 flex-wrap rounded-md border border-bdr bg-panel p-3 shadow-md">
        <Btn variant="primary" disabled={!!copyDisabledReason} title={copyDisabledReason || 'Review and confirm the data copy'} onClick={() => void copy()}>{truncating.length ? `Truncate ${truncating.length} and copy (${names.length} tables)` : `Copy data (${names.length} tables)`}</Btn>
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
          {!!plan.targetOccupied.length && <span className="text-mute">{plan.targetOccupied.length} target table(s) already contain rows{truncate ? ' and will be truncated if selected' : ' and can’t be copied into — choose “Truncate target tables before copying” to include them'}.</span>}
          {eligibleNames.length > selectableNames.length && <span className="text-mute">{eligibleNames.length - selectableNames.length} table(s) can’t be selected (over the {capLabel}-row total limit or no count){limitRows ? '' : ' — set a row limit per table to include large tables'}.</span>}
        </div>
        {!plan.items.length && <p>No source tables found.</p>}
        {plan.items.map(table => <label key={table.name} className="flex gap-2 items-center">
          <input type="checkbox" checked={nameSet.has(table.name)} disabled={!selectableSet.has(table.name) || addedSet.has(table.name) || (!nameSet.has(table.name) && names.length >= TABLE_COPY_MAX_TABLES)} onChange={e => setRoots(prev => e.target.checked ? [...prev, table.name] : prev.filter(n => n !== table.name))} />
          <span className="font-mono">{table.name}</span>
          <span className={rowsFor(table.name) > maxTotal ? 'text-err' : 'text-mute'}>{plan.sourceCounts[table.name] === undefined ? 'Count unavailable — blocked' : plan.sourceCounts[table.name].toLocaleString() + ' source rows' + (rowLimit && plan.sourceCounts[table.name] > rowLimit ? ` → ${rowLimit.toLocaleString()} copied` : '')}</span>
          {rowsFor(table.name) > maxTotal && <span className="text-err">Exceeds the {capLabel}-row total limit — set a row limit per table or raise the total</span>}{!table.existsInTarget && <span className="text-mute">Missing in target</span>}{occupiedSet.has(table.name) && (truncate ? <span className="text-err">{nameSet.has(table.name) ? 'Target has rows — will be truncated' : 'Target has rows — truncated if selected'}</span> : <span className="text-warn">Target not empty — can’t copy</span>)}
          {addedSet.has(table.name) && <span className="text-warn">Auto-selected: required parent</span>}
        </label>)}
      </fieldset>
      {!!relevantDependencies.length && <div role="status" className="border border-warn/40 rounded p-3 space-y-1 text-warn">
        <p className="font-semibold">Foreign-key dependencies require parent data, even when you did not select those tables.</p>
        {relevantDependencies.map(d => <p key={`${d.table}.${d.constraint}`}><span className="font-mono">{d.table} → {d.parentSchema}.{d.parent ?? '[not visible]'}</span> ({d.constraint})</p>)}
        {!!selection.added.length && <p>Automatically included: {selection.added.join(', ')}. Remove the child selections to release their parents.</p>}
        <p>This checks enabled foreign keys in the target schema, not whether every required parent row exists. Parent tables that already contain rows in the target are not copied; child rows whose parent keys are missing are skipped and reported.</p>
        {selection.warnings.map(w => <p key={w}>{w}</p>)}
      </div>}
      {selection.overLimit && <p role="alert" className="text-err">Required dependencies bring this selection above {TABLE_COPY_MAX_TABLES.toLocaleString()} tables. Reduce the selection or use a custom migration; no dependency will be silently skipped.</p>}
      {!!selection.cycles.length && <p role="status" className="text-warn">Self-referencing or circular foreign keys involve {selection.cycles.join(', ')}. Copy is allowed: rows waiting for parent keys are retried after each table is inserted. Constraints remain enabled. Rows whose keys can never be resolved are skipped and reported.</p>}
      {!!names.length && <p className="text-mute">Insert order (parents before children): {names.join(' → ')}</p>}
    </>}
    {result && <div role="status" className="border border-ok/40 rounded p-3"><p className="text-ok">Committed {result.totalRows.toLocaleString()} rows.</p>{!!result.truncated?.length && <p className="text-warn">Truncated before copying: {result.truncated.join(', ')}.</p>}{result.warnings?.map((warning, i) => <p key={i} className="text-warn whitespace-pre-wrap">{warning}</p>)}{result.tables.map(t => <p key={t.name}>{t.name}: {t.rows.toLocaleString()} rows{t.skipped ? <span className="text-warn"> ({t.skipped.toLocaleString()} skipped — parent rows missing)</span> : null}</p>)}</div>}
  </div>;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const duration = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
};

function CopyProgressPanel({ progress: p }: { progress: CopyProgress }) {
  const now = Date.now();
  const running = p.state === 'running';
  const done = p.tables.filter(t => t.status === 'committed');
  const current = p.tables.find(t => t.name === p.current && t.status === 'copying');
  const remaining = p.tables.filter(t => t.status === 'waiting' || t.status === 'truncating' || t.status === 'truncated');
  const rolledBack = p.tables.filter(t => t.status === 'rolled back');
  const remainingRows = remaining.reduce((n, t) => n + t.planned, 0) + (current ? Math.max(0, current.planned - current.copied) : 0);
  const pct = p.plannedRows ? Math.min(100, (p.copiedRows / p.plannedRows) * 100) : running ? 0 : 100;
  const idle = now - p.updatedAt;
  const elapsed = (p.finishedAt ?? now) - p.startedAt;
  return <div role="status" aria-live="polite" className={`border rounded p-3 space-y-2 ${p.state === 'failed' ? 'border-err/50' : p.state === 'succeeded' ? 'border-ok/40' : 'border-bdr'}`}>
    <div className="flex items-center gap-3 flex-wrap">
      <span className={`font-semibold ${p.state === 'failed' ? 'text-err' : p.state === 'succeeded' ? 'text-ok' : ''}`}>
        {running ? <><Spinner /> Copying {p.sourceSchema} → {p.targetSchema}</> : p.state === 'succeeded' ? `Last copy finished (${p.sourceSchema} → ${p.targetSchema})` : `Last copy failed (${p.sourceSchema} → ${p.targetSchema})`}
      </span>
      <span className="text-mute">Started {clock(p.startedAt)} · {running ? 'elapsed' : 'took'} {duration(elapsed)}</span>
      {running && <span className={idle > 60000 ? 'text-warn' : 'text-mute'}>Last activity {duration(idle)} ago</span>}
    </div>
    <div className="h-2 rounded bg-bdr overflow-hidden" aria-hidden="true">
      <div className={`h-2 ${p.state === 'failed' ? 'bg-err' : 'bg-ok'} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
    </div>
    <p>Rows: <span className="font-mono">{p.copiedRows.toLocaleString()} / {p.plannedRows.toLocaleString()}</span> ({pct.toFixed(1)}%){running ? <> · <span className="font-mono">{remainingRows.toLocaleString()}</span> remaining</> : null}</p>
    <p>Tables: <span className="text-ok">{done.length} committed</span>{current ? ' · 1 copying' : ''} · {remaining.length} remaining{rolledBack.length ? <span className="text-err"> · {rolledBack.length} rolled back</span> : null} · of {p.tables.length}</p>
    {current && <p>Now copying <span className="font-mono">{current.name}</span>: {current.copied.toLocaleString()} / {current.planned.toLocaleString()} rows{current.startedAt ? ` (for ${duration(now - current.startedAt)})` : ''}</p>}
    {running && idle > 60000 && <p className="text-warn">No new rows for {duration(idle)}. A large batch or LOB may still be transferring, or the table may be locked; each database call times out after 10 minutes.</p>}
    {p.error && <p className="text-err">{p.error}</p>}
    <details>
      <summary className="cursor-pointer">Copied tables ({done.length})</summary>
      <div className="max-h-48 overflow-auto font-mono text-[11px]">
        {done.map(t => <p key={t.name}>{t.name}: {t.committed.toLocaleString()} rows{t.startedAt && t.finishedAt ? ` · ${duration(t.finishedAt - t.startedAt)}` : ''}{t.committed < t.planned ? <span className="text-warn"> ({(t.planned - t.committed).toLocaleString()} not copied)</span> : null}</p>)}
      </div>
    </details>
    <details open={running && remaining.length <= 25}>
      <summary className="cursor-pointer">Remaining tables ({remaining.length})</summary>
      <div className="max-h-48 overflow-auto font-mono text-[11px]">
        {remaining.map(t => <p key={t.name}>{t.name}: {t.planned.toLocaleString()} rows{t.status !== 'waiting' ? <span className="text-warn"> ({t.status})</span> : null}</p>)}
        {rolledBack.map(t => <p key={t.name} className="text-err">{t.name}: rolled back</p>)}
      </div>
    </details>
    <details open>
      <summary className="cursor-pointer">Log ({p.log.length})</summary>
      <div className="max-h-60 overflow-auto font-mono text-[11px] space-y-0.5">
        {[...p.log].reverse().map((entry, i) => <p key={p.log.length - i} className={entry.level === 'error' ? 'text-err' : entry.level === 'warn' ? 'text-warn' : 'text-soft'}><span className="text-mute">{clock(entry.at)}</span> {entry.message}</p>)}
      </div>
    </details>
  </div>;
}
