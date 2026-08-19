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
import { getRunBuffer, runKey, setRunBuffer, type ArgState, type BlockState } from "../utils/runBuffers";

const memberKeyOf = (m: RoutineMember) => `${m.name}#${m.overload ?? ""}`;

/** Fresh form state for one parameter. NULL for plain IN params (SQL Developer's default),
 *  the declared DEFAULT when the routine has one — typing a value clears either. */
const freshArg = (p: RoutineParam): ArgState => ({ value: "", isNull: !p.hasDefault, useDefault: p.hasDefault });

const PLACEHOLDER: Record<string, string> = {
  number: "e.g. 42",
  date: "YYYY-MM-DD [HH:MI:SS]",
  boolean: "true / false",
  string: "text value",
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
      memberKey, values: argStates, mode, blocks, result,
    });
  }, [memKey, memberKey, argStates, mode, blocks, result]);

  const isPkg = meta?.type === "PACKAGE";
  const member = useMemo(() => {
    if (!meta?.members.length) return null;
    return meta.members.find((m) => memberKeyOf(m) === memberKey) ?? meta.members[0];
  }, [meta, memberKey]);
  const mKey = member ? memberKeyOf(member) : "";
  const target = meta && member ? (isPkg ? `${meta.name}.${member.name}` : meta.name) : routine;

  const argOf = (p: RoutineParam): ArgState => argStates[mKey]?.[p.name] ?? freshArg(p);
  const setArg = (p: RoutineParam, patch: Partial<ArgState>) =>
    setArgStates((prev) => ({ ...prev, [mKey]: { ...prev[mKey], [p.name]: { ...argOf(p), ...patch } } }));

  const readOnly = conn?.readOnly === true;
  const unsupported = member?.params.filter((p) => !p.bindKind && !(p.hasDefault && argOf(p).useDefault)) ?? [];
  const badReturn = member?.kind === "FUNCTION" && !member.returnBindKind;
  const runnable = !!member && !readOnly && unsupported.length === 0 && !badReturn;
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
    try {
      const r = await exec(buildArgs(), confirmed);
      if (r) {
        setResult(r);
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
        s.toast("error", (e as Error).message);
      }
    } finally {
      setRunning(false);
    }
  };

  /* ---- render ---- */

  if (fetchErr) {
    return <EmptyState icon={<AlertTriangle />} title="Could not load the routine" hint={fetchErr} />;
  }
  if (meta?.error) {
    return <EmptyState icon={<AlertTriangle />} title={`${routine} is not runnable`} hint={meta.error} />;
  }
  if (!meta || !member) {
    return <div className="h-full grid place-items-center"><Spinner label={`Reading ${routine} signature…`} /></div>;
  }

  return (
    <div className="h-full flex flex-col min-w-0">
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 h-11 border-b border-bdr shrink-0">
        <FlaskConical size={15} className="text-accenthi shrink-0" />
        <span className="font-mono text-[13px] font-semibold truncate">{meta.name}</span>
        <Badge tone="accent">{meta.type}</Badge>
        {isPkg && (
          <select
            value={mKey}
            onChange={(e) => setMemberKey(e.target.value)}
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
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                title={m === "form" ? "Run with the parameter values, bound by type" : "Run the PL/SQL block exactly as written"}
                className={`px-2.5 h-7 transition-colors ${mode === m ? "bg-accent text-white" : "text-soft hover:text-ink hover:bg-panel3"}`}
              >
                {m === "form" ? "Parameters" : "PL/SQL block"}
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
            {running ? "Running…" : mode === "block" ? "Run block" : "Run"}
          </Btn>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
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
        <section className="border border-bdrsoft rounded-md">
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
            <p className="px-3 py-2.5 text-[12px] text-mute">No parameters — press Run to execute it.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wider text-mute">
                  <th className="px-3 py-1.5 font-semibold">Name</th>
                  <th className="px-2 py-1.5 font-semibold">Mode</th>
                  <th className="px-2 py-1.5 font-semibold">Type</th>
                  <th className="px-2 py-1.5 font-semibold w-full">Value</th>
                  <th className="px-2 py-1.5 font-semibold">Null</th>
                  <th className="px-3 py-1.5 font-semibold">Default</th>
                </tr>
              </thead>
              <tbody>
                {member.params.map((p) => {
                  const a = argOf(p);
                  // a type we can't bind still takes a value in block mode: it goes into the
                  // block as source, so `T_ADDRESS('Main St')` is a legitimate entry there
                  const disabled = !isInput(p) || a.isNull || a.useDefault || (!p.bindKind && mode === "form");
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
                          <input
                            value={a.value}
                            disabled={disabled}
                            placeholder={p.bindKind ? PLACEHOLDER[p.bindKind] ?? "" : mode === "block" ? "PL/SQL expression" : "—"}
                            aria-label={`Value for ${p.name}`}
                            onChange={(e) => setArg(p, { value: e.target.value, isNull: false, useDefault: false })}
                            className={`${inputCls} font-mono !h-7 disabled:opacity-40`}
                          />
                        ) : (
                          <span className="text-mute italic">set by the routine</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {isInput(p) && (
                          <input
                            type="checkbox"
                            checked={a.isNull}
                            aria-label={`Pass NULL for ${p.name}`}
                            onChange={(e) => setArg(p, { isNull: e.target.checked, ...(e.target.checked ? { useDefault: false } : {}) })}
                          />
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {isInput(p) && p.hasDefault && (
                          <input
                            type="checkbox"
                            checked={a.useDefault}
                            aria-label={`Use the declared default for ${p.name}`}
                            title="Omit this parameter so its declared DEFAULT applies"
                            onChange={(e) => setArg(p, { useDefault: e.target.checked, ...(e.target.checked ? { isNull: false } : {}) })}
                          />
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
              Need composite types, several calls or setup logic?{" "}
              <button className="text-accenthi hover:underline font-medium" onClick={() => setMode("block")}>
                Switch to PL/SQL block
              </button>{" "}
              — the generated block is editable and runs exactly as you leave it.
            </p>
          )}
        </section>

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
        {result && (
          <section className="border border-bdrsoft rounded-md">
            <header className="flex items-center gap-2 px-3 py-2 border-b border-bdrsoft">
              <span className="text-[11px] font-bold uppercase tracking-wider text-mute">Result</span>
              <Badge tone={result.ok ? "ok" : "err"}>{result.ok ? "OK" : "ERROR"}</Badge>
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
                        <td className="pr-3 py-0.5 font-mono text-soft">{o.name}</td>
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
