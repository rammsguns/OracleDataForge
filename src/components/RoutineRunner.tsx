import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Terminal,
  Upload,
} from "lucide-react";
import { useStudio } from "../state/store";
import {
  api,
  ConfirmRequiredError,
  type RoutineMember,
  type RoutineMeta,
  type RoutineParam,
  type RoutineRunResult,
} from "../utils/api";
import CodeEditor from "./CodeEditor";
import { Badge, Btn, EmptyState, Spinner, inputCls } from "./ui";
import { generateRoutineBlock } from "../utils/plsqlBlock";
import { download } from "../utils/sql";
import { getRunBuffer, runKey, setRunBuffer, type ArgState, type BlockState, type RoutineTestCase } from "../utils/runBuffers";
import { editableArg, inputError, matchesExpected } from "../utils/routineTesting";

const memberKeyOf = (m: RoutineMember) => `${m.name}#${m.overload ?? ""}`;

/** Examples are placeholders; inputs always start editable. */
const freshArg = (): ArgState => ({ value: "", isNull: false, useDefault: false });

const PLACEHOLDER: Record<string, string> = {
  number: "e.g. 42",
  date: "e.g. 2026-09-07 or NULL",
  boolean: "e.g. true or NULL",
  string: "e.g. Hello or NULL",
};

const isInput = (p: RoutineParam) => p.direction !== "OUT";

function CursorGrid({ name, columns, rows, truncated }: { name: string; columns: string[]; rows: (string | number | null)[][]; truncated: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1 text-[11px] font-semibold text-soft">
        <span className="font-mono">{name}</span>
        <span className="text-mute font-normal">
          {rows.length} row{rows.length === 1 ? "" : "s"}
          {truncated && <span className="text-warn"> · showing first {rows.length} (truncated)</span>}
        </span>
      </div>
      <div className="max-h-56 overflow-auto border border-bdrsoft rounded">
        <table className="w-full text-[11.5px] font-mono">
          <thead className="sticky top-0 bg-panel2">
            <tr>
              {columns.map((c) => (
                <th key={c} className="text-left px-2 py-1 font-semibold text-soft border-b border-bdrsoft whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="odd:bg-panel even:bg-panel2/40">
                {r.map((v, j) => (
                  <td key={j} className="px-2 py-0.5 border-b border-bdrsoft/60 whitespace-nowrap max-w-[22rem] overflow-hidden text-ellipsis">
                    {v === null ? <span className="text-mute italic">NULL</span> : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LiveRoutineRunner({ connId, routine }: { connId: string; routine: string }) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === connId);
  const memKey = runKey(connId, routine);
  const mem = getRunBuffer(memKey);

  const [meta, setMeta] = useState<RoutineMeta | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [memberKey, setMemberKey] = useState<string | null>(mem?.memberKey ?? null);
  const [argStates, setArgStates] = useState<Record<string, Record<string, ArgState>>>(mem?.values ?? {});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RoutineRunResult | null>(mem?.result ?? null);
  const [showBlock, setShowBlock] = useState(false);
  const [mode, setMode] = useState<"form" | "block">(mem?.mode ?? "form");
  const [blocks, setBlocks] = useState<Record<string, BlockState>>(mem?.blocks ?? {});
  const fileRef = useRef<HTMLInputElement>(null);
  const [cases, setCases] = useState<RoutineTestCase[]>(mem?.cases ?? []);
  const [caseName, setCaseName] = useState("");
  const [expectation, setExpectation] = useState(mem?.expectation ?? { enabled: false, value: "", isNull: false });
  const [checkResult, setCheckResult] = useState<string | null>(mem?.checkResult ?? null);
  const [runError, setRunError] = useState<string | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  useEffect(() => { if (result || runError) resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [result, runError]);

  useEffect(() => {
    let alive = true;
    api.routine(connId, routine)
      .then((r) => { if (alive) setMeta(r); })
      .catch((e: Error) => { if (alive) setFetchErr(e.message); });
    return () => { alive = false; };
  }, [connId, routine]);

  // keep everything while this tab is unmounted (inactive workspace tabs unmount)
  useEffect(() => {
    setRunBuffer(memKey, {
      memberKey, values: argStates, mode, blocks, result, cases, expectation, checkResult,
    });
  }, [memKey, memberKey, argStates, mode, blocks, result, cases, expectation, checkResult]);

  const isPkg = meta?.type === "PACKAGE";
  const member = useMemo(() => {
    if (!meta?.members.length) return null;
    return meta.members.find((m) => memberKeyOf(m) === memberKey) ?? meta.members[0];
  }, [meta, memberKey]);
  const mKey = member ? memberKeyOf(member) : "";
  const target = meta && member ? (isPkg ? `${meta.name}.${member.name}` : meta.name) : routine;

  const argOf = (p: RoutineParam): ArgState => editableArg(argStates[mKey]?.[p.name] ?? freshArg());
  const setArg = (p: RoutineParam, patch: Partial<ArgState>) =>
    setArgStates((prev) => ({ ...prev, [mKey]: { ...prev[mKey], [p.name]: { ...argOf(p), ...patch } } }));

  const readOnly = conn?.readOnly === true;
  const unsupported = member?.params.filter((p) => !p.bindKind && !(p.hasDefault && argOf(p).useDefault)) ?? [];
  const recordReturn = !!member?.returnFields?.length && member.returnFields.every((f, i) => f.bindKind && f.bindKind !== 'cursor' && !member.params.some(p => p.name.toUpperCase() === `DF_RECORD_${i + 1}`));
  const badReturn = member?.kind === "FUNCTION" && !member.returnBindKind && !recordReturn;
  const inputErrors = Object.fromEntries((member?.params ?? []).map(p => [p.name, inputError(p, argOf(p))]).filter(([, error]) => error));
  const runnable = !!member && !readOnly && unsupported.length === 0 && !badReturn && Object.keys(inputErrors).length === 0;
  /* ---- editable PL/SQL block (SQL Developer's "Run PL/SQL") ---- */

  const block = blocks[mKey]?.text ?? "";
  const blockDirty = blocks[mKey]?.dirty === true;
  const blockRunnable = !readOnly && block.trim().length > 0;

  // The generated block follows the form until the user edits it; from then on it is theirs
  // (Reset regenerates). Composite types have no bindable form value, so the block is the
  // only way to run those members — it declares and builds the value itself.
  useEffect(() => {
    if (!meta || !member) return;
    setBlocks((prev) => {
      if (prev[mKey]?.dirty) return prev;
      const text = generateRoutineBlock(meta, member, argOf);
      if (prev[mKey]?.text === text) return prev;
      return { ...prev, [mKey]: { text, dirty: false } };
    });
    // argOf reads argStates, which is what should retrigger the regeneration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, member, mKey, argStates]);

  const setBlock = (text: string, dirty = true) => setBlocks((prev) => ({ ...prev, [mKey]: { text, dirty } }));

  const resetBlock = () => {
    if (!meta || !member) return;
    setBlock(generateRoutineBlock(meta, member, argOf), false);
    s.toast("info", "Block regenerated from the parameter values");
  };

  const loadBlockFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 256 * 1024) {
      s.toast("error", `${f.name} is ${Math.round(f.size / 1024)} KB — the limit is 256 KB.`);
      return;
    }
    setBlock((await f.text()).replace(/\r\n/g, "\n").trim());
    s.toast("success", `${f.name} loaded — review it before running`);
  };

  const saveBlockFile = () => {
    const file = `${target.replace(/[^A-Za-z0-9_]/g, "_")}.sql`;
    download(file, block);
    s.toast("success", `Block saved as ${file}`);
  };

  const buildArgs = () =>
    (member?.params ?? []).map((p) => {
      const a = argOf(p);
      if (!isInput(p)) return { name: p.name, value: null };
      if (a.useDefault && p.hasDefault) return { name: p.name, value: null, useDefault: true };
      return { name: p.name, value: a.isNull ? null : a.value };
    });

  const exec = async (
    args: { name: string; value: string | null; useDefault?: boolean }[],
    confirmed: boolean,
    plsql?: string
  ): Promise<RoutineRunResult | null> => {
    if (!meta || !member) return null;
    return api.routineRun(
      connId,
      { name: meta.name, member: isPkg ? member.name : undefined, overload: member.overload, args, ...(plsql ? { block: plsql } : {}) },
      confirmed
    );
  };

  /** Run with the form values. Unacknowledged first — the backend's 409 wording drives the dialog (D-13). */
  const run = async (confirmed = false) => {
    if (!runnable || running) return;
    setRunning(true);
    setRunError(null); setResult(null); setCheckResult(null);
    try {
      const r = await exec(buildArgs(), confirmed, recordReturn && meta && member ? generateRoutineBlock(meta, member, argOf) : undefined);
      if (r) {
        setResult(r);
        if (expectation.enabled && member?.kind === 'FUNCTION' && member.returnBindKind) setCheckResult(r.ok && matchesExpected(r.returnValue, expectation.value, expectation.isNull) ? 'Passed — return value matches' : `Failed — expected ${expectation.isNull ? 'NULL' : JSON.stringify(expectation.value)}, received ${r.returnValue === undefined ? 'no return value' : JSON.stringify(r.returnValue)}`);
        if (r.error) s.toast("error", `${target} failed: ${r.error.code}`);
        else s.toast("success", `${target} executed in ${r.durationMs} ms`);
      }
    } catch (e) {
      if (e instanceof ConfirmRequiredError) {
        const cf = e.confirmation;
        s.askConfirm({
          title: cf.title, body: cf.body, confirmLabel: cf.confirmLabel, danger: cf.danger,
          onConfirm: () => { void run(true); },
        });
      } else {
        setRunError((e as Error).message);
        s.toast("error", (e as Error).message);
      }
    } finally {
      setRunning(false);
    }
  };

  /** Run the block exactly as written — same 409-then-confirm handshake, and the backend's
   *  wording is stricter here because a hand-written block can contain anything. */
  const runBlock = async (confirmed = false) => {
    if (!blockRunnable || running) return;
    setRunning(true);
    setRunError(null); setResult(null); setCheckResult(null);
    try {
      const r = await exec([], confirmed, block);
      if (r) {
        setResult(r);
        if (r.error) s.toast("error", `Block failed: ${r.error.code}`);
        else s.toast("success", `Block executed in ${r.durationMs} ms`);
      }
    } catch (e) {
      if (e instanceof ConfirmRequiredError) {
        const cf = e.confirmation;
        s.askConfirm({
          title: cf.title, body: cf.body, confirmLabel: cf.confirmLabel, danger: cf.danger,
          onConfirm: () => { void runBlock(true); },
        });
      } else {
        setRunError((e as Error).message);
        s.toast("error", (e as Error).message);
      }
    } finally {
      setRunning(false);
    }
  };

  const saveCase = () => {
    if (!member || !caseName.trim()) return;
    const name = caseName.trim();
    const entry: RoutineTestCase = { name, memberKey: mKey, values: Object.fromEntries(member.params.map(p => [p.name, { ...argOf(p) }])), mode, block: { text: block, dirty: blockDirty }, expectation: { ...expectation } };
    setCases(prev => [...prev.filter(c => c.name !== name || c.memberKey !== mKey), entry]);
    setCaseName('');
    s.toast('success', `Test case "${name}" saved for this session`);
  };
  const loadCase = (c: RoutineTestCase) => {
    setMemberKey(c.memberKey);
    setArgStates(prev => ({ ...prev, [c.memberKey]: c.values }));
    setBlocks(prev => ({ ...prev, [c.memberKey]: c.block }));
    setMode(c.mode); setExpectation(c.expectation); setResult(null); setCheckResult(null); setRunError(null);
  };

  /* ---- render ---- */

  if (fetchErr) {
    return <EmptyState icon={<AlertTriangle />} title="Could not load the routine" hint={fetchErr} />;
  }
  if (meta?.error) {
    return <EmptyState icon={<AlertTriangle />} title={`${routine} is not runnable`} hint={meta.error} />;
  }
  if (meta && !meta.members.length) {
    return <EmptyState icon={<FlaskConical />} title="No callable routines found" hint="For a package, declare a public procedure or function in its specification and compile it before testing." />;
  }
  if (!meta || !member) {
    return <div className="h-full grid place-items-center"><Spinner label={`Reading ${routine} signature…`} /></div>;
  }

  return (
    <div className="h-full flex flex-col min-w-0" onKeyDown={e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && mode === 'form') { e.preventDefault(); void run(); }
    }}>
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap border-b border-bdr shrink-0">
        <FlaskConical size={15} className="text-accenthi shrink-0" />
        <span className="font-mono text-[13px] font-semibold truncate">{meta.name}</span>
        <Badge tone="accent">{meta.type}</Badge>
        {isPkg && (
          <select
            value={mKey}
            disabled={running}
            onChange={(e) => { setMemberKey(e.target.value); setResult(null); setCheckResult(null); setRunError(null); setExpectation({ enabled: false, value: '', isNull: false }); }}
            aria-label="Package member to run"
            className={`${inputCls} !w-auto max-w-64 font-mono !h-7 text-[12px]`}
          >
            {meta.members.map((m) => (
              <option key={memberKeyOf(m)} value={memberKeyOf(m)}>
                {m.name}{m.overload ? ` (overload ${m.overload})` : ""} — {m.kind.toLowerCase()}
              </option>
            ))}
          </select>
        )}
        {!isPkg && <Badge tone="neutral">{member.kind}</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          {/* what Run executes — the parameter grid's typed binds, or the block as written */}
          <div className="flex rounded-md border border-bdr overflow-hidden text-[11.5px] font-medium" role="group" aria-label="Run mode">
            {(["form", "block"] as const).map((m) => (
              <button
                key={m}
                disabled={running}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                title={m === "form" ? "Run with the parameter values, bound by type" : "Run the PL/SQL block exactly as written"}
                className={`px-2.5 h-7 transition-colors ${mode === m ? "bg-accent text-white" : "text-soft hover:text-ink hover:bg-panel3"}`}
              >
                {m === "form" ? "Guided test" : "Advanced block"}
              </button>
            ))}
          </div>
          <Btn
            variant="primary"
            onClick={() => void (mode === "block" ? runBlock() : run())}
            disabled={running || (mode === "block" ? !blockRunnable : !runnable)}
            title={mode === "block" ? "Run the PL/SQL block below (Ctrl+Enter)" : `Run ${target} with the parameter values below`}
          >
            {running ? <Loader2 size={12} className="df-spin" /> : <Play size={12} />}
            {running ? "Running…" : mode === "block" ? "Run block" : "Run test"}
          </Btn>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <div className="rounded-lg border border-accent/30 bg-accentdim p-3 space-y-1 text-[12px]">
          <h2 className="font-semibold">Test {target}</h2>
          <p className="text-soft">1. Choose inputs → 2. Run test (Ctrl+Enter) → 3. Inspect return values and output.</p>
          <p className="text-mute">Runs the compiled database version on {conn?.name}. Compile source edits before testing.</p>
          <p className="text-warn">Routine runs commit on success in a separate session. Worksheet autocommit and Rollback do not apply here. Commits inside your code also persist.</p>
        </div>
        <fieldset disabled={running} className="border border-bdrsoft rounded-md p-3 space-y-2">
          <legend className="px-1 text-[12px] font-semibold">Reusable test cases</legend>
          <div className="flex gap-2 flex-wrap">
            <input className={`${inputCls} !w-52`} aria-label="Test case name" placeholder="e.g. Customer with no orders" value={caseName} onChange={e => setCaseName(e.target.value)} maxLength={100} />
            <Btn variant="outline" disabled={!caseName.trim() || running} onClick={saveCase}><Save size={12} /> Save test case</Btn>
            <select className={`${inputCls} !w-auto max-w-64`} aria-label="Load test case" value="" onChange={e => { const c = cases[Number(e.target.value)]; if (c) loadCase(c); }}>
              <option value="">Load saved inputs…</option>
              {cases.map((c, i) => <option key={`${c.memberKey}:${c.name}`} value={i}>{c.name} · {c.memberKey.split('#')[0]}</option>)}
            </select>
          </div>
          <p className="text-[11px] text-mute">Keeps inputs, block, and expected return while this app is open. Saving the same name replaces that member’s case. Loading never executes it.</p>
        </fieldset>
        {readOnly && (
          <div className="flex items-start gap-2 p-2.5 rounded-md border border-warn/40 bg-warn/8 text-[12px] text-soft">
            <AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" />
            <span>
              <span className="font-semibold">"{conn?.name}" is read-only</span> — running stored code is blocked because a routine
              can modify data. Edit the connection to disable read-only mode before running it.
            </span>
          </div>
        )}
        {mode === "form" && unsupported.length > 0 && (
          <div className="flex items-start gap-2 p-2.5 rounded-md border border-err/40 bg-err/8 text-[12px] text-soft">
            <AlertTriangle size={14} className="text-err shrink-0 mt-0.5" />
            <span>
              {unsupported.map((p) => `${p.name} (${p.dataType})`).join(", ")} can't be bound by type.{" "}
              <button className="text-accenthi hover:underline font-medium" onClick={() => setMode("block")}>
                Switch to PL/SQL block
              </button>{" "}
              — it declares the value and you build it by hand.
            </span>
          </div>
        )}
        {mode === "form" && badReturn && (
          <div className="flex items-start gap-2 p-2.5 rounded-md border border-err/40 bg-err/8 text-[12px] text-soft">
            <AlertTriangle size={14} className="text-err shrink-0 mt-0.5" />
            <span>
              The return type {member.returnType ?? "(unknown)"} cannot be bound —{" "}
              <button className="text-accenthi hover:underline font-medium" onClick={() => setMode("block")}>
                run it from a PL/SQL block
              </button>{" "}
              instead.
            </span>
          </div>
        )}

        {/* parameters */}
        {recordReturn && <p className="text-[12px] text-soft">Record return supported: Run test will display {member.returnFields!.map(f => f.name).join(', ')} as separate output values.</p>}
        <fieldset disabled={running} className="border border-bdrsoft rounded-md">
          <header className="flex items-center gap-2 px-3 py-2 border-b border-bdrsoft">
            <span className="text-[11px] font-bold uppercase tracking-wider text-mute">
              Parameters{member.kind === "FUNCTION" && member.returnType ? ` · returns ${member.returnType}` : ""}
            </span>
            {mode === "block" && (
              <span className="text-[11px] text-mute">
                {blockDirty ? "the block was edited — these values no longer drive it" : "these values fill the block below"}
              </span>
            )}
          </header>
          {member.params.length === 0 ? (
            <p className="px-3 py-2.5 text-[12px] text-mute">No inputs needed — press Run test to execute it.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wider text-mute">
                  <th className="px-3 py-1.5 font-semibold">Name</th>
                  <th className="px-2 py-1.5 font-semibold">Mode</th>
                  <th className="px-2 py-1.5 font-semibold">Type</th>
                  <th className="px-2 py-1.5 font-semibold w-full">Value</th>
                </tr>
              </thead>
              <tbody>
                {member.params.map((p) => {
                  const a = argOf(p);
                  // a type we can't bind still takes a value in block mode: it goes into the
                  // block as source, so `T_ADDRESS('Main St')` is a legitimate entry there
                  const disabled = !isInput(p) || (!p.bindKind && mode === "form");
                  return (
                    <tr key={p.name} className="border-t border-bdrsoft/60">
                      <td className="px-3 py-1.5 font-mono text-soft whitespace-nowrap">{p.name}</td>
                      <td className="px-2 py-1.5">
                        <Badge tone={p.direction === "IN" ? "neutral" : p.direction === "OUT" ? "accent" : "warn"}>{p.direction}</Badge>
                      </td>
                      <td className="px-2 py-1.5 font-mono text-mute whitespace-nowrap">
                        {p.dataType}
                        {!p.bindKind && (
                          <Badge tone={mode === "block" ? "warn" : "err"}>{mode === "block" ? "by hand" : "unsupported"}</Badge>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        {isInput(p) ? (
                          <div><input
                            aria-invalid={mode === 'form' && !!inputErrors[p.name]}
                            aria-describedby={mode === 'form' && inputErrors[p.name] ? `input-error-${p.position}` : undefined}
                            list={p.bindKind === 'boolean' ? 'routine-booleans' : undefined}
                            value={a.value}
                            disabled={disabled}
                            placeholder={p.dataType === 'CHAR' ? 'e.g. Y or NULL' : p.bindKind ? PLACEHOLDER[p.bindKind] ?? "NULL" : mode === "block" ? "PL/SQL expression" : "—"}
                            aria-label={`Value for ${p.name}`}
                            onChange={(e) => setArg(p, { value: e.target.value, isNull: false, useDefault: false })}
                            className={`${inputCls} font-mono !h-7 disabled:opacity-40 ${mode === 'form' && inputErrors[p.name] ? '!border-warn' : ''}`}
                          />
                          {mode === 'form' && inputErrors[p.name] && <p id={`input-error-${p.position}`} className="text-warn text-[11px] mt-1">{inputErrors[p.name]}</p>}
                          {p.bindKind === 'string' && !a.isNull && !a.useDefault && <p className="text-mute text-[10px] mt-1">Enter text without quotes. Empty text becomes NULL in Oracle.</p>}
                          </div>
                        ) : (
                          <span className="text-mute italic">set by the routine</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {mode === "form" && (
            <p className="px-3 py-2 border-t border-bdrsoft text-[11.5px] text-mute">
              Enter a value or type NULL (case-insensitive). Examples are suggestions only. To use declared defaults, omit parameters in a PL/SQL block. Need composite types, several calls or setup logic?{" "}
              <button className="text-accenthi hover:underline font-medium" onClick={() => setMode("block")}>
                Switch to PL/SQL block
              </button>{" "}
              — the generated block is editable and runs exactly as you leave it.
            </p>
          )}
        </fieldset>
        <datalist id="routine-booleans"><option value="true" /><option value="false" /></datalist>
        {mode === 'form' && member.kind === 'FUNCTION' && member.returnBindKind && member.returnBindKind !== 'cursor' && (
          <fieldset disabled={running} className="border border-bdrsoft rounded-md p-3 space-y-2 text-[12px]">
            <label className="flex items-center gap-2"><input type="checkbox" checked={expectation.enabled} onChange={e => setExpectation(prev => ({ ...prev, enabled: e.target.checked }))} /> Check expected return value</label>
            {expectation.enabled && <div className="flex items-center gap-3">
              <input aria-label="Expected return value" className={`${inputCls} !w-64 font-mono`} disabled={expectation.isNull} placeholder="Expected value (exact match)" value={expectation.value} onChange={e => setExpectation(prev => ({ ...prev, value: e.target.value }))} />
              <label className="flex items-center gap-1"><input type="checkbox" checked={expectation.isNull} onChange={e => setExpectation(prev => ({ ...prev, isNull: e.target.checked }))} /> Expect NULL</label>
            </div>}
            {expectation.enabled && <p className="text-[11px] text-mute">Numbers compare by value; text compares exactly, including spaces and case. Boolean returns use TRUE or FALSE.</p>}
          </fieldset>
        )}
        {mode === 'form' && Object.keys(inputErrors).length > 0 && <p role="status" className="text-[12px] text-warn">Complete the highlighted inputs or choose NULL before running.</p>}

        {/* editable PL/SQL block */}
        {mode === "block" && (
          <section className="border border-bdrsoft rounded-md">
            <header className="flex items-center gap-2 px-3 py-2 border-b border-bdrsoft">
              <Code2 size={12} className="text-accenthi" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-mute">PL/SQL block</span>
              {blockDirty && <Badge tone="warn">edited</Badge>}
              <div className="ml-auto flex items-center gap-1.5">
                <Btn variant="ghost" onClick={resetBlock} title="Regenerate the block from the parameter values above">
                  <RotateCcw size={11} /> Reset
                </Btn>
                <Btn variant="ghost" onClick={() => fileRef.current?.click()} title="Load a block from a .sql file">
                  <Upload size={11} /> From file…
                </Btn>
                <Btn variant="ghost" onClick={saveBlockFile} disabled={!block.trim()} title="Save this block as a .sql file">
                  <Save size={11} /> Save file
                </Btn>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".sql,.pls,.plsql,.prc,.fnc,.txt"
                className="hidden"
                aria-label="PL/SQL block file"
                onChange={(e) => {
                  void loadBlockFile(e.target.files?.[0]);
                  e.target.value = ""; // same file twice in a row must still fire change
                }}
              />
            </header>
            <div className="h-80 border-b border-bdrsoft">
              <CodeEditor value={block} onChange={(v) => setBlock(v)} onCompile={() => void runBlock()} ariaLabel="PL/SQL block to run" />
            </div>
            <p className="px-3 py-2 text-[11.5px] text-mute">
              Runs verbatim on <span className="text-soft">{conn?.name}</span> — Ctrl+Enter runs it, Ctrl+F searches. Every{" "}
              <span className="font-mono text-soft">:NAME</span> is an <span className="text-soft">output</span> bind: matching a
              parameter takes its type, anything else comes back as text. Values are written in as literals, so edit the block for
              expressions.
            </p>
          </section>
        )}

        {/* results */}
        {runError && <section ref={resultsRef} role="alert" className="border border-err/40 rounded-md p-3 text-[12px] text-err"><strong>Could not run test</strong><p className="mt-1 whitespace-pre-wrap">{runError}</p></section>}
        {!result && !runError && <p className="text-[12px] text-mute p-3">{running ? 'Running test… results will appear here.' : 'Results will appear here: return value, OUT parameters, cursor rows, and DBMS_OUTPUT.'}</p>}
        {result && (
          <section ref={resultsRef} aria-live="polite" className="border border-bdrsoft rounded-md">
            <header className="flex items-center gap-2 px-3 py-2 border-b border-bdrsoft">
              <span className="text-[11px] font-bold uppercase tracking-wider text-mute">Result</span>
              <Badge tone={result.ok && !checkResult?.startsWith('Failed') ? "ok" : "err"}>{!result.ok ? 'EXECUTION ERROR' : checkResult ? checkResult.startsWith('Passed') ? 'TEST PASSED' : 'TEST FAILED' : 'EXECUTED'}</Badge>
              {/* which path produced it, so a stale result is never mistaken for the other one */}
              <Badge tone={result.source === "block" ? "accent" : "neutral"}>{result.source === "block" ? "BLOCK" : "PARAMETERS"}</Badge>
              <span className="text-[11px] text-mute">{result.member} · {result.durationMs} ms</span>
              <button
                className="ml-auto flex items-center gap-1 text-[11px] text-mute hover:text-soft"
                onClick={() => setShowBlock((v) => !v)}
                aria-expanded={showBlock}
              >
                {showBlock ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Show block
              </button>
            </header>
            <div className="p-3 space-y-3">
              {checkResult && <p className={`text-[12px] font-semibold ${checkResult.startsWith('Passed') ? 'text-ok' : 'text-err'}`}>{checkResult}</p>}
              {result.ok && <p className="text-[11px] text-mute">Execution completed. {checkResult ? 'Expected return checked for this run.' : 'No expected-value check was applied.'} Results below belong to the last execution.</p>}
              {result.dbmsOutput.length === 0 && <p className="text-[11px] text-mute">No DBMS_OUTPUT messages. Add DBMS_OUTPUT.PUT_LINE(...) to your routine to print diagnostic values.</p>}
              {showBlock && (
                <pre className="p-2 rounded bg-panel2 border border-bdrsoft text-[11.5px] font-mono overflow-x-auto text-soft">{result.block}</pre>
              )}
              {result.error && (
                <div className="p-2.5 rounded-md border border-err/40 bg-err/8 text-[12px]">
                  <p className="text-err font-semibold font-mono">{result.error.code}</p>
                  <p className="text-soft mt-0.5 whitespace-pre-wrap">{result.error.message}</p>
                  {result.error.helpUrl && (
                    <a
                      href={result.error.helpUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 mt-1 text-accenthi hover:underline"
                    >
                      <ExternalLink size={11} /> Oracle documentation for {result.error.code}
                    </a>
                  )}
                </div>
              )}
              {result.returnValue !== undefined && (
                <p className="text-[12.5px]">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-mute mr-2">Return</span>
                  <span className="font-mono text-ok">{result.returnValue === null ? "NULL" : String(result.returnValue)}</span>
                </p>
              )}
              {result.outParams.length > 0 && (
                <table className="text-[12px]">
                  <tbody>
                    {result.outParams.map((o) => (
                      <tr key={o.name}>
                        <td className="pr-3 py-0.5 font-mono text-soft">{/^DF_RECORD_\d+$/.test(o.name) && member.returnFields?.[Number(o.name.slice('DF_RECORD_'.length)) - 1] ? `RETURN.${member.returnFields[Number(o.name.slice('DF_RECORD_'.length)) - 1].name}` : o.name}</td>
                        <td className="pr-3 py-0.5 text-mute font-mono">{o.dataType}</td>
                        <td className="py-0.5 font-mono">{o.value === null ? <span className="text-mute italic">NULL</span> : String(o.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {result.cursors.map((cur) => (
                <CursorGrid key={cur.name} {...cur} />
              ))}
              {result.dbmsOutput.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1 text-[11px] font-semibold text-soft">
                    <Terminal size={11} /> DBMS_OUTPUT
                    {result.dbmsOutputTruncated && <span className="text-warn font-normal">· first 1,000 lines</span>}
                  </div>
                  <pre className="max-h-40 overflow-auto p-2 rounded bg-panel2 border border-bdrsoft text-[11.5px] font-mono text-soft whitespace-pre-wrap">{result.dbmsOutput.join("\n")}</pre>
                </div>
              )}
            </div>
          </section>
        )}

      </div>
    </div>
  );
}

export default function RoutineRunner({ routine }: { routine: string }) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  if (conn?.live) {
    return <LiveRoutineRunner key={`${conn.id}.${routine}`} connId={conn.id} routine={routine} />;
  }
  return (
    <EmptyState
      icon={<FlaskConical />}
      title="Run / Test needs a live Oracle connection"
      hint={
        conn
          ? `"${conn.name}" is not connected.`
          : `Pick an Oracle connection in the sidebar to run ${routine}.`
      }
    />
  );
}
