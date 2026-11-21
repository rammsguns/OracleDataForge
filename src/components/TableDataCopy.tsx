import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ConfirmRequiredError } from '../utils/api';
import { copyRowLimitFor, indexTableDependencies, limitedCopyCount, tableDataSelection, TABLE_COPY_DEFAULT_LOB_ROWS, TABLE_COPY_DEFAULT_TOTAL_ROWS, TABLE_COPY_MAX_ROWS, TABLE_COPY_MAX_TABLES } from '../utils/tableDataDependencies';
import type { CopyProgress } from '../utils/tableDataProgress';
import { countInRange, parseCountBound, sameRowCount, sortTableNames, tableNameMatches, TABLE_MATCH_MODES, TABLE_SORTS, type TableMatchMode, type TableSort } from '../utils/tableListFilter';
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
  // A finished copy's panel the user cleared; a new copy (new start time) shows again.
  const [dismissedCopy, setDismissedCopy] = useState<number | null>(null);
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
  const [disableTriggers, setDisableTriggers] = useState(false);
  const [rowLimitText, setRowLimitText] = useState('1000');
  const parsedLimit = Number(rowLimitText);
  const rowLimitValid = !limitRows || (Number.isSafeInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= TABLE_COPY_MAX_ROWS);
  const rowLimit = limitRows && rowLimitValid ? parsedLimit : null;
  const [totalLimitText, setTotalLimitText] = useState(String(TABLE_COPY_DEFAULT_TOTAL_ROWS));
  const parsedTotal = Number(totalLimitText);
  const totalLimitValid = Number.isSafeInteger(parsedTotal) && parsedTotal >= 1 && parsedTotal <= TABLE_COPY_MAX_ROWS;
  const maxTotal = totalLimitValid ? parsedTotal : TABLE_COPY_DEFAULT_TOTAL_ROWS;
  const capLabel = maxTotal.toLocaleString();
  const [limitLobRows, setLimitLobRows] = useState(false);
  const [lobRowLimitText, setLobRowLimitText] = useState(String(TABLE_COPY_DEFAULT_LOB_ROWS));
  const parsedLobLimit = Number(lobRowLimitText);
  const lobRowLimitValid = !limitLobRows || (Number.isSafeInteger(parsedLobLimit) && parsedLobLimit >= 1 && parsedLobLimit <= TABLE_COPY_MAX_ROWS);
  const lobRowLimit = limitLobRows && lobRowLimitValid ? parsedLobLimit : null;
  const lobTables = useMemo(() => new Set(plan?.lobTables ?? []), [plan?.lobTables]);
  // Rows chosen for individual tables (empty = use the limits above). A chosen number wins.
  const [tableRowsText, setTableRowsText] = useState<Record<string, string>>({});
  // Table list: find, filter and order (display only; selection rules are unchanged).
  const [search, setSearch] = useState('');
  const [matchMode, setMatchMode] = useState<TableMatchMode>('contains');
  const [sort, setSort] = useState<TableSort>('name-asc');
  const [show, setShow] = useState<'all' | 'selected' | 'selectable' | 'target-rows' | 'missing' | 'needs-data'>('all');
  const [ignoreEmpty, setIgnoreEmpty] = useState(false);
  const [ignoreSame, setIgnoreSame] = useState(false);
  const [range, setRange] = useState({ sourceMin: '', sourceMax: '', targetMin: '', targetMax: '' });
  const tableRowsValid = (text: string) => { const n = Number(text); return Number.isSafeInteger(n) && n >= 1 && n <= TABLE_COPY_MAX_ROWS; };
  const tableRowLimits = useMemo(() => Object.fromEntries(Object.entries(tableRowsText).filter(([, text]) => text.trim() && tableRowsValid(text)).map(([name, text]) => [name, Number(text)])), [tableRowsText]);
  const limitFor = (name: string) => copyRowLimitFor(name, rowLimit, lobRowLimit, lobTables, tableRowLimits);
  // WHERE filters for large tables. Only an applied filter (checked and counted on the source) is used.
  const [filterOpen, setFilterOpen] = useState<Record<string, boolean>>({});
  const [filterText, setFilterText] = useState<Record<string, string>>({});
  const [appliedFilters, setAppliedFilters] = useState<Record<string, { where: string; count: number }>>({});
  const [filterErrors, setFilterErrors] = useState<Record<string, string>>({});
  const [filterBusy, setFilterBusy] = useState<string | null>(null);
  // Source columns offered while writing a filter; `indexed` = leading column of an index or the PK.
  type FilterColumn = { name: string; dataType: string; indexed: boolean };
  const [filterColumns, setFilterColumns] = useState<Record<string, FilterColumn[] | { error: string } | 'loading'>>({});
  const filterInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const loadFilterColumns = async (name: string) => {
    if (filterColumns[name] && filterColumns[name] !== 'loading' && !('error' in (filterColumns[name] as object))) return;
    setFilterColumns(prev => ({ ...prev, [name]: 'loading' }));
    try {
      const meta = await api.tableMeta(sourceId, name);
      if (meta.error) throw new Error(meta.error);
      const leading = new Set([...meta.indexes.map(i => i.columns[0]), meta.primaryKey?.columns[0]].filter((c): c is string => !!c));
      setFilterColumns(prev => ({ ...prev, [name]: meta.columns.map(c => ({ name: c.name, dataType: c.dataType, indexed: leading.has(c.name) })) }));
    } catch (e) { setFilterColumns(prev => ({ ...prev, [name]: { error: (e as Error).message } })); }
  };
  /** Insert a column name at the cursor of the table's filter box, quoting names that need it. */
  const insertFilterColumn = (table: string, column: string) => {
    const ref = /^[A-Z][A-Z0-9_$#]*$/.test(column) ? column : `"${column.replace(/"/g, '""')}"`;
    const input = filterInputs.current[table];
    const text = filterText[table] ?? '';
    const start = input?.selectionStart ?? text.length, end = input?.selectionEnd ?? text.length;
    const before = text.slice(0, start), after = text.slice(end);
    const insert = (before && !/[\s(]$/.test(before) ? ' ' : '') + ref + (after && !/^\s/.test(after) ? ' ' : '');
    setFilterText(prev => ({ ...prev, [table]: before + insert + after }));
    requestAnimationFrame(() => { const at = before.length + insert.length; input?.focus(); input?.setSelectionRange(at, at); });
  };
  const without = <T,>(record: Record<string, T>, name: string) => { const next = { ...record }; delete next[name]; return next; };
  /** The table's filter was changed or removed by hand: it no longer follows the condition for all tables. */
  const detachFromAll = (name: string, cleared: boolean) => setAllFilter(prev => prev && {
    ...prev, applied: prev.applied.filter(n => n !== name), failed: prev.failed.filter(n => n !== name),
    cleared: cleared ? [...prev.cleared.filter(n => n !== name), name] : prev.cleared.filter(n => n !== name),
  });
  const clearFilter = (name: string) => {
    setAppliedFilters(prev => without(prev, name)); setFilterText(prev => without(prev, name));
    setFilterErrors(prev => without(prev, name)); setFilterOpen(prev => without(prev, name));
    detachFromAll(name, true);
  };
  const applyFilter = async (name: string) => {
    const where = (filterText[name] ?? '').trim();
    if (!where) { clearFilter(name); return; }
    setFilterBusy(name); setFilterErrors(prev => without(prev, name));
    try {
      const { count } = await api.countTableDataFilter(targetId, sourceId, name, where);
      setAppliedFilters(prev => ({ ...prev, [name]: { where, count } }));
      detachFromAll(name, false);
    } catch (e) { setFilterErrors(prev => ({ ...prev, [name]: (e as Error).message })); }
    finally { setFilterBusy(null); }
  };
  // One WHERE condition for every selected table. Applying it checks and counts it on each table
  // and stores it as that table's filter; a table's own filter is kept instead. Tables without
  // the columns it names (ORA-00904) are listed and copied without a filter.
  const [allWhere, setAllWhere] = useState('');
  const [allFilter, setAllFilter] = useState<{ where: string; applied: string[]; skipped: string[]; failed: string[]; cleared: string[] } | null>(null);
  const [allProgress, setAllProgress] = useState<{ done: number; total: number } | null>(null);
  const globalSet = useMemo(() => new Set(allFilter?.applied ?? []), [allFilter]);
  const ownFilter = (name: string) => !!appliedFilters[name] && !globalSet.has(name);
  const clearAllFilter = () => {
    const applied = allFilter?.applied ?? [];
    const failed = allFilter?.failed ?? [];
    setAppliedFilters(prev => { const next = { ...prev }; for (const n of applied) delete next[n]; return next; });
    setFilterText(prev => { const next = { ...prev }; for (const n of [...applied, ...failed]) if (!ownFilter(n)) delete next[n]; return next; });
    setFilterErrors(prev => { const next = { ...prev }; for (const n of failed) delete next[n]; return next; });
    setAllFilter(null);
  };
  const applyAllFilter = async (tables: string[]) => {
    const where = allWhere.trim();
    if (!where) { clearAllFilter(); return; }
    // Re-applying replaces the previous condition on the tables it was applied to.
    const targets = tables.filter(name => !ownFilter(name));
    const applied: string[] = [], skipped: string[] = [], failed: string[] = [];
    const counts: Record<string, number> = {}, errors: Record<string, string> = {};
    setFilterBusy('*'); setAllProgress({ done: 0, total: targets.length });
    let next = 0, done = 0;
    const worker = async () => {
      while (next < targets.length) {
        const name = targets[next++];
        try { counts[name] = (await api.countTableDataFilter(targetId, sourceId, name, where)).count; applied.push(name); }
        catch (e) {
          const message = (e as Error).message;
          // A syntax problem is the same for every table: no need to ask each one.
          if (!/ORA-|NJS-|took longer/.test(message)) { next = targets.length; errors['*'] = message; }
          else if (/ORA-00904/.test(message)) skipped.push(name);
          else { failed.push(name); errors[name] = message; }
        }
        setAllProgress({ done: ++done, total: targets.length });
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker)); }
    finally { setFilterBusy(null); setAllProgress(null); }
    if (errors['*']) { setError(`WHERE for all tables: ${errors['*']}`); return; }
    setError('');
    const previous = allFilter;
    setAppliedFilters(prev => {
      const nextFilters = { ...prev };
      for (const n of previous?.applied ?? []) delete nextFilters[n];
      for (const n of applied) nextFilters[n] = { where, count: counts[n] };
      return nextFilters;
    });
    setFilterText(prev => {
      const nextText = { ...prev };
      for (const n of [...(previous?.applied ?? []), ...(previous?.failed ?? [])]) if (!ownFilter(n)) delete nextText[n];
      for (const n of [...applied, ...failed]) nextText[n] = where;
      return nextText;
    });
    // A table the condition failed on keeps it as an unapplied filter, which blocks the copy until fixed or cleared.
    setFilterErrors(prev => {
      const nextErrors = { ...prev };
      for (const n of previous?.failed ?? []) delete nextErrors[n];
      for (const n of failed) nextErrors[n] = errors[n];
      return nextErrors;
    });
    if (failed.length) setFilterOpen(prev => ({ ...prev, ...Object.fromEntries(failed.map(n => [n, true])) }));
    const order = (list: string[]) => tables.filter(n => list.includes(n));
    setAllFilter({ where, applied: order(applied), skipped: order(skipped), failed: order(failed), cleared: [] });
  };
  /** Typed but not applied (or changed since): the copy would not use what is shown. */
  const filterPending = (name: string) => (filterText[name] ?? '').trim() !== (appliedFilters[name]?.where ?? '');
  /** Source rows before per-table limits: the filtered count when a filter is applied. */
  const baseCount = (name: string) => appliedFilters[name]?.count ?? plan?.sourceCounts[name];
  const rowsFor = (name: string) => limitedCopyCount(baseCount(name) ?? 0, limitFor(name));
  const read = async () => {
    setBusy(true); setError(''); setResult(null); setPlan(null); setRoots([]); setTableRowsText({});
    setFilterOpen({}); setFilterText({}); setAppliedFilters({}); setFilterErrors({}); setFilterColumns({}); setAllFilter(null);
    try { setPlan(await api.tableDataPlan(targetId, sourceId)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async (confirmed = false) => {
    setBusy(true); setError(''); setResult(null);
    if (confirmed) setCopying(true);
    try {
      const outcome = await api.copyTableData(targetId, sourceId, names, confirmed, rowLimit, maxTotal, truncate, lobRowLimit, disableTriggers, Object.fromEntries(Object.entries(tableRowLimits).filter(([name]) => nameSet.has(name))),
        Object.fromEntries(Object.entries(appliedFilters).filter(([name]) => nameSet.has(name)).map(([name, f]) => [name, f.where])));
      setResult(outcome); setRoots([]);
      // The copied tables now contain rows, so they can no longer be copied into.
      // Copies only go into empty or truncated tables, so each copied table now holds exactly its copied rows.
      setPlan(prev => prev ? { ...prev, targetOccupied: [...new Set([...prev.targetOccupied.filter(n => !outcome.truncated?.includes(n)), ...outcome.tables.filter(t => t.rows > 0).map(t => t.name)])],
        targetCounts: { ...prev.targetCounts, ...Object.fromEntries((outcome.truncated ?? []).map(n => [n, 0])), ...Object.fromEntries(outcome.tables.map(t => [t.name, t.rows])) } } : prev);
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
  const selection = useMemo(() => tableDataSelection(roots, eligibleNames, dependencyIndex, truncate ? { truncateOccupied: occupiedSet } : {}), [roots, eligibleNames, dependencyIndex, truncate, occupiedSet]);
  const names = selection.names;
  const nameSet = useMemo(() => new Set(names), [names]);
  const truncating = truncate ? names.filter(name => occupiedSet.has(name)) : [];
  const addedSet = useMemo(() => new Set(selection.added), [selection.added]);
  const addedChildSet = useMemo(() => new Set(selection.addedChildren), [selection.addedChildren]);
  const relevantDependencies = useMemo(() => names.flatMap(name => dependencyIndex.get(name) ?? []), [names, dependencyIndex]);
  const isEmptySource = (name: string) => plan?.sourceCounts[name] === 0;
  const isSameCount = (name: string) => !!plan && sameRowCount(name, plan.sourceCounts, plan.targetCounts);
  const isIgnored = (name: string) => (ignoreEmpty && isEmptySource(name)) || (ignoreSame && isSameCount(name));
  // Ignored tables can't be picked, but are still copied when required as a parent.
  const selectableNames = eligibleNames.filter(name => plan?.sourceCounts[name] !== undefined && rowsFor(name) <= maxTotal && !isIgnored(name));
  const selectableSet = new Set(selectableNames);
  const emptySourceCount = plan?.items.filter(t => isEmptySource(t.name)).length ?? 0;
  const sameCountCount = plan?.items.filter(t => isSameCount(t.name)).length ?? 0;
  const rangeInvalid = Object.values(range).some(v => parseCountBound(v) === 'invalid');
  const rangeSet = Object.values(range).some(v => v.trim());
  const visibleItems = useMemo(() => {
    if (!plan) return [];
    const byName = new Map(plan.items.map(t => [t.name, t]));
    const shown = plan.items.filter(t => {
      // Selected tables stay visible even when empty, so auto-selected parents are never hidden.
      if (isIgnored(t.name) && !nameSet.has(t.name)) return false;
      if (!tableNameMatches(t.name, search, matchMode)) return false;
      if (!countInRange(plan.sourceCounts[t.name], range.sourceMin, range.sourceMax)) return false;
      if (!countInRange(plan.targetCounts?.[t.name], range.targetMin, range.targetMax)) return false;
      switch (show) {
        case 'selected': return nameSet.has(t.name);
        case 'selectable': return selectableSet.has(t.name);
        case 'target-rows': return occupiedSet.has(t.name);
        case 'missing': return !t.existsInTarget;
        case 'needs-data': return t.existsInTarget && (plan.sourceCounts[t.name] ?? 0) > 0 && plan.targetCounts?.[t.name] === 0;
        default: return true;
      }
    }).map(t => t.name);
    return sortTableNames(shown, sort, plan.sourceCounts, plan.targetCounts).map(n => byName.get(n)!);
  }, [plan, ignoreEmpty, ignoreSame, range, search, matchMode, show, sort, nameSet, occupiedSet, selectableNames.join('\u0000')]);
  const shownSelectable = visibleItems.map(t => t.name).filter(n => selectableSet.has(n));
  const shownRoots = new Set(visibleItems.map(t => t.name));
  const filtering = !!search.trim() || show !== 'all' || ignoreEmpty || ignoreSame || rangeSet;
  const rangeInput = (key: keyof typeof range, label: string) => <input type="text" inputMode="numeric" value={range[key]} placeholder={label.endsWith('min') ? 'min' : 'max'}
    aria-label={label} onChange={e => { const v = e.target.value; setRange(prev => ({ ...prev, [key]: v })); }}
    className={`w-24 rounded border bg-panel px-1.5 py-0.5 font-mono ${parseCountBound(range[key]) === 'invalid' ? 'border-err' : 'border-bdr'}`} />;
  const invalidCounts = names.filter(name => plan?.sourceCounts[name] === undefined || rowsFor(name) > maxTotal);
  const sourceTotal = names.reduce((sum, name) => sum + rowsFor(name), 0);
  const selectionFull = names.length >= Math.min(TABLE_COPY_MAX_TABLES, selectableNames.length);
  const invalidTableRows = names.filter(name => (tableRowsText[name] ?? '').trim() && !tableRowsValid(tableRowsText[name]));
  const unappliedFilters = names.filter(filterPending);
  // Tables selected after the condition for all tables was applied have not been checked yet.
  const allUnchecked = allFilter ? names.filter(n => !globalSet.has(n) && !allFilter.skipped.includes(n) && !allFilter.failed.includes(n) && !allFilter.cleared.includes(n) && !ownFilter(n)) : [];
  const allWherePending = allWhere.trim() !== (allFilter?.where ?? '');
  const copyDisabledReason = busy ? 'An operation is running.'
    : blocked ? 'Choose a different, writable target schema.'
    : !totalLimitValid ? `Enter a total row limit from 1 to ${TABLE_COPY_MAX_ROWS.toLocaleString()}.`
    : !rowLimitValid ? `Enter a row limit from 1 to ${TABLE_COPY_MAX_ROWS.toLocaleString()}.`
    : !lobRowLimitValid ? `Enter a row limit for CLOB/JSON tables from 1 to ${TABLE_COPY_MAX_ROWS.toLocaleString()}.`
    : filterBusy ? 'Checking a filter…'
    : allWherePending ? 'Apply or clear the WHERE condition for all tables.'
    : allUnchecked.length ? `Apply the WHERE condition for all tables again; it hasn’t been checked on: ${allUnchecked.join(', ')}.`
    : unappliedFilters.length ? `Apply or clear the filter for: ${unappliedFilters.join(', ')}.`
    : invalidTableRows.length ? `Enter rows to copy from 1 to ${TABLE_COPY_MAX_ROWS.toLocaleString()} (or leave empty) for: ${invalidTableRows.join(', ')}.`
    : !names.length ? 'Select at least one table to copy.'
    : invalidCounts.length ? `Cannot copy: ${invalidCounts.join(', ')} exceeds the ${capLabel}-row total limit or has no verified count (including required parents). Set a row limit per table or raise the total limit.`
    : sourceTotal > maxTotal ? `${sourceTotal.toLocaleString()} selected rows exceed the ${capLabel}-row total limit. Raise the total limit (up to ${TABLE_COPY_MAX_ROWS.toLocaleString()}), select fewer tables, or lower the row limit per table.`
    : selection.overLimit ? `The selection and required parents exceed the ${TABLE_COPY_MAX_TABLES}-table limit.`
    : '';
  return <div className="space-y-3 text-[12px]">
    <p className="text-soft">Copy table rows from the source connection’s schema to the target connection’s schema. Create missing tables with Copy objects first.</p>
    <p className="text-mute">Data is copied only into empty target tables. Tables that already contain rows can’t be selected unless you choose to truncate them first. Duplicate keys or incompatible columns stop the copy. Required parent tables are selected automatically and copied first. Up to {TABLE_COPY_MAX_TABLES.toLocaleString()} tables per copy, with a total row limit you choose (default 100,000, up to {TABLE_COPY_MAX_ROWS.toLocaleString()}) — set a row limit per table to copy a sample of larger tables; Text, numbers, dates, timestamps (including WITH TIME ZONE and WITH LOCAL TIME ZONE), RAW, ROWID, UROWID, VECTOR, JSON, CLOB, and NCLOB columns are supported. Large CLOB, NCLOB and JSON values are streamed in chunks, so they have no size limit. Identity columns retain source IDs; GENERATED ALWAYS is temporarily changed to BY DEFAULT and restored after copying; BLOB and BFILE columns require a custom migration.</p>
    <p className="text-warn">Each table is committed as soon as its rows are inserted, in a separate session, so undo only holds one table at a time. If a table fails it is rolled back, but tables committed before it keep their rows; empty them before retrying. Worksheet Commit/Rollback does not apply.</p>
    <p className="text-warn">Identity sequences are synchronized after copying. Pause other target writes during copying. If interrupted, identity settings may need repair. Target triggers run on attempts, including retries, unless you disable them below.</p>
    <Btn variant="outline" disabled={busy || !sourceId || !targetId || sourceId === targetId} onClick={() => void read()}>Read tables</Btn>
    {busy && <div role="status"><Spinner /> Working… Keep this tab open until the copy finishes.</div>}
    {error && <p role="alert" className="text-err">{error}</p>}
    {progress && progress.startedAt !== dismissedCopy && <CopyProgressPanel progress={progress} onDismiss={() => setDismissedCopy(progress.startedAt)} onStop={() => s.askConfirm({
      title: 'Stop the data copy?',
      body: `The table being copied now is rolled back. Tables already committed keep their rows${progress.tables.some(t => t.status === 'committed') ? ` (${progress.tables.filter(t => t.status === 'committed').map(t => t.name).join(', ')})` : ''}; empty them before copying again. Identity settings and triggers are restored as usual.`,
      confirmLabel: 'Stop copy', danger: true,
      onConfirm: () => { void api.stopTableDataCopy(targetId).then(refreshProgress, e => setError((e as Error).message)); },
    })} />}
    {plan && <>
      <p>{plan.sourceSchema} → {plan.targetSchema}</p>
      <p className={sourceTotal > maxTotal ? 'text-err' : undefined}>Rows to copy: {sourceTotal.toLocaleString()} / {capLabel}. Counts are checked again before copying.</p>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2">
          Total row limit
          <input type="number" min={1} max={TABLE_COPY_MAX_ROWS} step={1} value={totalLimitText} disabled={busy} aria-label="Total row limit for this copy"
            onChange={e => setTotalLimitText(e.target.value)} className={`w-32 rounded border bg-panel px-2 py-1 font-mono ${totalLimitValid ? 'border-bdr' : 'border-err'}`} />
        </label>
        {[100000, 500000, 1000000, 10000000, TABLE_COPY_MAX_ROWS].map(n => <Btn key={n} variant="outline" disabled={busy || maxTotal === n} onClick={() => setTotalLimitText(String(n))}>{n >= 1000000 ? `${n / 1000000}M` : `${n / 1000}K`}</Btn>)}
        <span className="text-mute">max {TABLE_COPY_MAX_ROWS.toLocaleString()}</span>
      </div>
      {maxTotal > TABLE_COPY_DEFAULT_TOTAL_ROWS && <p className="text-warn">Large copies can take several minutes; keep this tab open. Each table commits separately, so the largest single table sets how much undo space is needed.</p>}
      <div className="space-y-1">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={truncate} disabled={busy} onChange={e => { setTruncate(e.target.checked); if (!e.target.checked) setRoots(prev => prev.filter(n => !occupiedSet.has(n))); }} />
          Truncate target tables before copying
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={disableTriggers} disabled={busy} onChange={e => setDisableTriggers(e.target.checked)} />
          Disable target triggers while copying
        </label>
        {disableTriggers && <p className="text-warn">Enabled triggers on the selected target tables are disabled before the first row is inserted and enabled again when the copy ends, even if it fails. They don’t run for copied rows, so sequences, audit or log rows they maintain aren’t updated, and they also don’t run for other sessions’ writes while disabled.</p>}
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
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={limitLobRows} disabled={busy} onChange={e => setLimitLobRows(e.target.checked)} />
          Limit rows in tables with CLOB, NCLOB or JSON columns
        </label>
        {limitLobRows && <>
          <input type="number" min={1} max={TABLE_COPY_MAX_ROWS} step={1} value={lobRowLimitText} disabled={busy} aria-label="Maximum rows per table with CLOB, NCLOB or JSON columns"
            onChange={e => setLobRowLimitText(e.target.value)} className={`w-28 rounded border bg-panel px-2 py-1 font-mono ${lobRowLimitValid ? 'border-bdr' : 'border-err'}`} />
          <span className="text-mute">rows per table{rowLimit ? ' (the smaller of the two limits applies)' : ''}</span>
        </>}
        {!!lobTables.size && <span className="text-mute">{lobTables.size} source table(s) have CLOB, NCLOB or JSON columns</span>}
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <label htmlFor="copy-all-where">WHERE for all selected tables</label>
          <input id="copy-all-where" type="text" value={allWhere} placeholder="num_anio = 2026" maxLength={2000} disabled={busy || !!filterBusy}
            onChange={e => setAllWhere(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && names.length) { e.preventDefault(); void applyAllFilter(names); } }}
            className={`flex-1 min-w-48 max-w-xl rounded border bg-panel px-1.5 py-0.5 font-mono ${allWherePending ? 'border-warn' : 'border-bdr'}`} />
          <Btn variant="outline" disabled={busy || !!filterBusy || !allWhere.trim() || !names.length} onClick={() => void applyAllFilter(names)}
            title="Check the condition on every selected table and copy only the rows it matches">
            {allProgress ? `Checking ${allProgress.done}/${allProgress.total}…` : `Apply to ${names.length} table(s)`}</Btn>
          {(allFilter || allWhere) && <Btn variant="outline" disabled={busy || !!filterBusy} onClick={() => { clearAllFilter(); setAllWhere(''); }}>Clear</Btn>}
        </div>
        <p className="text-mute">Copies only the rows matching this condition from each selected table. A table’s own filter is kept instead. Tables that don’t have the columns it names are copied without a filter.</p>
        {allFilter && <div className="space-y-0.5">
          <p className="text-soft">WHERE {allFilter.where} — applied to {allFilter.applied.length} table(s){allFilter.applied.length ? `, ${allFilter.applied.reduce((n, t) => n + (appliedFilters[t]?.count ?? 0), 0).toLocaleString()} matching rows` : ''}.</p>
          {!allFilter.applied.length && !!allFilter.skipped.length && !allFilter.failed.length && <p className="text-err">None of the selected tables has the columns this condition names. Check the column names.</p>}
          {!!allFilter.skipped.length && <p className="text-warn">No matching columns, copied without a filter: {allFilter.skipped.join(', ')}.</p>}
          {!!allFilter.cleared.length && <p className="text-mute">Filter removed by hand, copied in full: {allFilter.cleared.join(', ')}.</p>}
          {!!allFilter.failed.length && <p className="text-err">The condition failed on: {allFilter.failed.join(', ')}. Fix or clear their filters below.</p>}
          {Object.keys(appliedFilters).some(ownFilter) && <p className="text-mute">Kept their own filter: {names.filter(ownFilter).join(', ')}.</p>}
        </div>}
      </div>
      {(rowLimit || lobRowLimit || Object.keys(tableRowLimits).length > 0) && <p className="text-warn">Sampled child rows whose parent rows were not sampled are skipped and reported, so foreign keys stay valid.</p>}
      <div className="sticky top-0 z-10 flex items-center gap-3 flex-wrap rounded-md border border-bdr bg-panel p-3 shadow-md">
        <Btn variant="primary" disabled={!!copyDisabledReason} title={copyDisabledReason || 'Review and confirm the data copy'} onClick={() => void copy()}>{truncating.length ? `Truncate ${truncating.length} and copy (${names.length} tables)` : `Copy data (${names.length} tables)`}</Btn>
        <p role="status" className={`flex-1 min-w-48 ${copyDisabledReason ? 'text-warn' : 'text-soft'}`}>
          {copyDisabledReason || 'Ready to copy. You will review a confirmation before any rows are sent.'}
        </p>
      </div>
      {blocked && <p className="text-err">Choose a different, writable target schema that is not Oracle-maintained.</p>}
      <fieldset disabled={busy || !!blocked} className="border border-bdr rounded p-3 space-y-2">
        <legend className="px-1">Tables ({names.length}/{TABLE_COPY_MAX_TABLES.toLocaleString()} selected)</legend>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={matchMode} onChange={e => setMatchMode(e.target.value as TableMatchMode)} aria-label="How table names are matched" className="rounded border border-bdr bg-panel px-1.5 py-0.5">
            {TABLE_MATCH_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={matchMode === 'pattern' ? 'e.g. CAT_*  or  *_TEMP*' : 'e.g. CAT_  or  TEMP, BAK'}
            aria-label="Find tables by name" title="Separate several names with commas or spaces; a table matches any of them (“Doesn’t contain” excludes all of them)"
            className="w-56 rounded border border-bdr bg-panel px-1.5 py-0.5 font-mono" />
          <select value={show} onChange={e => setShow(e.target.value as typeof show)} aria-label="Show tables" className="rounded border border-bdr bg-panel px-1.5 py-0.5">
            <option value="all">All tables</option>
            <option value="selected">Selected</option>
            <option value="selectable">Selectable</option>
            <option value="target-rows">Target has rows</option>
            <option value="missing">Missing in target</option>
            <option value="needs-data">Empty in target, has source rows</option>
          </select>
          <select value={sort} onChange={e => setSort(e.target.value as TableSort)} aria-label="Order tables by" className="rounded border border-bdr bg-panel px-1.5 py-0.5">
            {TABLE_SORTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <label className="flex gap-1.5 items-center">
            <input type="checkbox" checked={ignoreEmpty} onChange={e => { const on = e.target.checked; setIgnoreEmpty(on); if (on) setRoots(prev => prev.filter(n => !isEmptySource(n))); }} />
            Ignore tables with 0 rows in source ({emptySourceCount})
          </label>
          <label className="flex gap-1.5 items-center" title="Source and target row counts are equal (including both empty). Counts are compared, not the rows themselves.">
            <input type="checkbox" checked={ignoreSame} onChange={e => { const on = e.target.checked; setIgnoreSame(on); if (on) setRoots(prev => prev.filter(n => !isSameCount(n))); }} />
            Ignore tables with the same number of rows in source and target ({sameCountCount})
          </label>
          {filtering && <Btn variant="outline" onClick={() => { setSearch(''); setShow('all'); setIgnoreEmpty(false); setIgnoreSame(false); setRange({ sourceMin: '', sourceMax: '', targetMin: '', targetMax: '' }); }}>Reset filters</Btn>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span>Source rows</span>{rangeInput('sourceMin', 'Source rows min')}<span>–</span>{rangeInput('sourceMax', 'Source rows max')}
          <span className="ml-2">Target rows</span>{rangeInput('targetMin', 'Target rows min')}<span>–</span>{rangeInput('targetMax', 'Target rows max')}
          {rangeInvalid ? <span className="text-err">Use whole numbers of 0 or more; invalid bounds are ignored.</span> : <span className="text-mute">Inclusive; leave empty for no bound. Tables without a count are hidden while a bound is set.</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-mute">Showing {visibleItems.length.toLocaleString()} of {plan.items.length.toLocaleString()}</span>
          {filtering && <Btn variant="outline" disabled={busy || !!blocked || !shownSelectable.some(n => !nameSet.has(n)) || names.length >= TABLE_COPY_MAX_TABLES} onClick={() => setRoots(prev => [...prev, ...shownSelectable.filter(name => !nameSet.has(name))].slice(0, TABLE_COPY_MAX_TABLES))}>Select shown ({shownSelectable.length})</Btn>}
          {filtering && <Btn variant="outline" disabled={busy || !!blocked || !roots.some(n => shownRoots.has(n))} onClick={() => setRoots(prev => prev.filter(n => !shownRoots.has(n)))}>Deselect shown</Btn>}
          <Btn variant="outline" disabled={busy || !!blocked || selectionFull} onClick={() => setRoots(prev => [...prev, ...selectableNames.filter(name => !nameSet.has(name))].slice(0, TABLE_COPY_MAX_TABLES))}>Select all ({selectableNames.length})</Btn>
          <Btn variant="outline" disabled={busy || !!blocked || !names.length} onClick={() => setRoots([])}>Clear selection</Btn>
          {!!plan.targetOccupied.length && <span className="text-mute">{plan.targetOccupied.length} target table(s) already contain rows{truncate ? ' and will be truncated if selected' : ' and can’t be copied into — choose “Truncate target tables before copying” to include them'}.</span>}
          {eligibleNames.length > selectableNames.length && <span className="text-mute">{eligibleNames.length - selectableNames.length} table(s) can’t be selected (over the {capLabel}-row total limit or no count){limitRows ? '' : ' — set a row limit per table to include large tables'}.</span>}
        </div>
        {!plan.items.length && <p>No source tables found.</p>}
        <p className="text-mute">Type a number in a table’s rows box to copy exactly that many rows (at most) from it; it overrides the limits above for that table. Leave it empty to use those limits.</p>
        <div className="max-h-72 overflow-auto space-y-2">
        {!!plan.items.length && !visibleItems.length && <p className="text-mute">No tables match these filters.</p>}
        {visibleItems.map(table => <div key={table.name} className="flex gap-2 items-center flex-wrap"><label className="flex gap-2 items-center">
          <input type="checkbox" checked={nameSet.has(table.name)} disabled={!selectableSet.has(table.name) || addedSet.has(table.name) || (!nameSet.has(table.name) && names.length >= TABLE_COPY_MAX_TABLES)} onChange={e => setRoots(prev => e.target.checked ? [...prev, table.name] : prev.filter(n => n !== table.name))} />
          <span className="font-mono">{table.name}</span>
          </label>
          {table.existsInTarget && plan.sourceCounts[table.name] !== undefined && <input type="number" min={1} max={TABLE_COPY_MAX_ROWS} step={1}
            value={tableRowsText[table.name] ?? ''} placeholder={String(limitedCopyCount(baseCount(table.name) ?? 0, copyRowLimitFor(table.name, rowLimit, lobRowLimit, lobTables)))}
            aria-label={`Rows to copy from ${table.name}`} title="Rows to copy from this table; empty uses the limits above"
            onChange={e => { const text = e.target.value; setTableRowsText(prev => { const next = { ...prev }; if (text) next[table.name] = text; else delete next[table.name]; return next; }); }}
            className={`w-24 rounded border bg-panel px-1.5 py-0.5 font-mono ${!(tableRowsText[table.name] ?? '').trim() || tableRowsValid(tableRowsText[table.name]) ? 'border-bdr' : 'border-err'}`} />}
          <span className={rowsFor(table.name) > maxTotal ? 'text-err' : 'text-mute'}>{plan.sourceCounts[table.name] === undefined ? 'Count unavailable — blocked' : plan.sourceCounts[table.name].toLocaleString() + ' source rows' + (appliedFilters[table.name] ? ` · ${appliedFilters[table.name].count.toLocaleString()} match the filter` : '') + (rowsFor(table.name) < (baseCount(table.name) ?? 0) ? ` → ${rowsFor(table.name).toLocaleString()} copied` : '')}</span>
          {table.existsInTarget && <Btn variant="outline"
            onClick={() => { if (!filterOpen[table.name]) void loadFilterColumns(table.name); setFilterOpen(prev => ({ ...prev, [table.name]: !prev[table.name] })); }} title="Copy only the rows that match a WHERE condition">
            {appliedFilters[table.name] ? 'WHERE ✓' : 'Filter'}</Btn>}
          {table.existsInTarget && <span className="text-mute">· {plan.targetCounts?.[table.name] === undefined ? 'target count unavailable' : plan.targetCounts[table.name].toLocaleString() + ' target rows'}</span>}
          {lobTables.has(table.name) && <span className="text-mute" title="Has CLOB, NCLOB or JSON columns">LOB</span>}
          {rowsFor(table.name) > maxTotal && <span className="text-err">Exceeds the {capLabel}-row total limit — set a row limit per table or raise the total</span>}{!table.existsInTarget && <span className="text-mute">Missing in target</span>}{occupiedSet.has(table.name) && (truncate ? <span className="text-err">{nameSet.has(table.name) ? 'Target has rows — will be truncated' : 'Target has rows — truncated if selected'}</span> : <span className="text-warn">Target not empty — can’t copy</span>)}
          {addedSet.has(table.name) && <span className="text-warn">{addedChildSet.has(table.name) ? 'Auto-selected: child of a truncated table — truncated and copied too' : 'Auto-selected: required parent'}</span>}
          {filterOpen[table.name] && <div className="basis-full pl-6 space-y-1">
            <div className="flex gap-2 items-center flex-wrap">
              <span className="font-mono text-mute">WHERE</span>
              <input type="text" ref={el => { filterInputs.current[table.name] = el; }} value={filterText[table.name] ?? ''} placeholder="num_anio = 2026" maxLength={2000} aria-label={`WHERE filter for ${table.name}`}
                onChange={e => { const text = e.target.value; setFilterText(prev => ({ ...prev, [table.name]: text })); }}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void applyFilter(table.name); } }}
                className={`flex-1 min-w-48 rounded border bg-panel px-1.5 py-0.5 font-mono ${filterErrors[table.name] ? 'border-err' : 'border-bdr'}`} />
              <Btn variant="outline" disabled={!!filterBusy || !(filterText[table.name] ?? '').trim()} onClick={() => void applyFilter(table.name)}>{filterBusy === table.name ? 'Counting…' : 'Apply'}</Btn>
              <Btn variant="outline" disabled={!!filterBusy} onClick={() => clearFilter(table.name)}>Clear</Btn>
            </div>
            {(() => {
              const cols = filterColumns[table.name];
              if (!cols || cols === 'loading') return <p className="text-mute"><Spinner /> Loading columns…</p>;
              if ('error' in cols) return <p className="text-err">Columns unavailable: {cols.error} <button type="button" className="underline" onClick={() => void loadFilterColumns(table.name)}>Retry</button></p>;
              return <div className="flex gap-1 flex-wrap items-center">
                <span className="text-mute">Columns (click to insert{cols.some(c => c.indexed) ? '; ⚡ = indexed, faster to filter' : ''}):</span>
                {cols.map(c => <button key={c.name} type="button" onClick={() => insertFilterColumn(table.name, c.name)} title={`${c.dataType}${c.indexed ? ' · leading column of an index' : ''}`}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[11px] hover:bg-bdr ${c.indexed ? 'border-ok/60' : 'border-bdr'}`}>
                  {c.indexed ? '⚡ ' : ''}{c.name} <span className="text-mute">{c.dataType}</span></button>)}
              </div>;
            })()}
            {filterErrors[table.name] ? <p role="alert" className="text-err">{filterErrors[table.name]}</p>
              : filterPending(table.name) && (filterText[table.name] ?? '').trim() ? <p className="text-warn">Not applied yet — press Apply (or Enter) to check the filter and count matching rows.</p>
              : appliedFilters[table.name] ? <p className="text-mute">Copies only rows where <span className="font-mono">{appliedFilters[table.name].where}</span>: {appliedFilters[table.name].count.toLocaleString()} of {(plan.sourceCounts[table.name] ?? 0).toLocaleString()} rows. Child rows whose parents are filtered out are skipped and reported.</p>
              : <p className="text-mute">A condition on the source table’s columns, for example <span className="font-mono">num_anio = 2026</span> or <span className="font-mono">fecha &gt;= DATE '2026-01-01'</span>. Only reads are allowed: no “;”, comments or bind variables.</p>}
          </div>}
        </div>)}
        </div>
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

function CopyProgressPanel({ progress: p, onStop, onDismiss }: { progress: CopyProgress; onStop: () => void; onDismiss: () => void }) {
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
  // Clearing only hides entries up to now on this page; the server keeps the full log.
  const [clearedAt, setClearedAt] = useState(0);
  const shownLog = p.log.filter(entry => entry.at > clearedAt);
  return <div role="status" aria-live="polite" className={`border rounded p-3 space-y-2 ${p.state === 'failed' ? 'border-err/50' : p.state === 'succeeded' ? 'border-ok/40' : 'border-bdr'}`}>
    <div className="flex items-center gap-3 flex-wrap">
      <span className={`font-semibold ${p.state === 'failed' ? 'text-err' : p.state === 'succeeded' ? 'text-ok' : ''}`}>
        {running ? <><Spinner /> {p.stopRequested ? 'Stopping' : 'Copying'} {p.sourceSchema} → {p.targetSchema}</> : p.state === 'succeeded' ? `Last copy finished (${p.sourceSchema} → ${p.targetSchema})` : `Last copy ${p.stopRequested ? 'stopped' : 'failed'} (${p.sourceSchema} → ${p.targetSchema})`}
      </span>
      {!running && <Btn variant="outline" onClick={onDismiss} title="Remove this finished copy’s summary and log from the page; the next copy shows here again">Clear</Btn>}
      {running && <Btn variant="outline" disabled={p.stopRequested} onClick={onStop} title="Stop after rolling back the table in progress; committed tables keep their rows">{p.stopRequested ? 'Stopping…' : 'Stop copy'}</Btn>}
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
      <summary className="cursor-pointer">
        Log ({shownLog.length}{shownLog.length < p.log.length ? ` of ${p.log.length}` : ''})
        <span className="inline-flex gap-2 ml-3 align-middle" onClick={e => e.preventDefault()}>
          <Btn variant="outline" disabled={!shownLog.length} onClick={() => setClearedAt(p.log.at(-1)!.at)} title="Hide the entries shown now; new entries still appear">Clear log</Btn>
          {shownLog.length < p.log.length && <Btn variant="outline" onClick={() => setClearedAt(0)}>Show all</Btn>}
        </span>
      </summary>
      <div className="max-h-60 overflow-auto font-mono text-[11px] space-y-0.5">
        {!shownLog.length && <p className="text-mute">Log cleared. New entries appear here.</p>}
        {[...shownLog].reverse().map((entry, i) => <p key={shownLog.length - i} className={entry.level === 'error' ? 'text-err' : entry.level === 'warn' ? 'text-warn' : 'text-soft'}><span className="text-mute">{clock(entry.at)}</span> {entry.message}</p>)}
      </div>
    </details>
  </div>;
}
