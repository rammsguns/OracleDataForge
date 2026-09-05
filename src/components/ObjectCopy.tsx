import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Database,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useStudio } from "../state/store";
import type { CopyExisting, CopyKind, ObjectCopyObjectResult, ObjectCopyPlan } from "../utils/api";
import {
  getObjectCopyRun,
  loadObjectCopyPlan,
  objectCopyKey,
  objectCopyKindSummary,
  selectedCounts,
  setObjectCopyOptions,
  startObjectCopy,
  subscribeObjectCopyRun,
} from "../utils/objectCopyRuns";
import { Badge, Btn, Spinner, inputCls } from "./ui";

const fmtSecs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const fmtNum = (n: number) => n.toLocaleString();

/** The kind a fresh panel opens on — the same default the backend applies. */
const DEFAULT_KIND: CopyKind = "tables";

/**
 * Copy objects of one kind from one Oracle connection into another.
 *
 * The other half of the Migration tab. Schema compare answers "what is different here?" and
 * builds a script for the tables that are; this answers "put these in there", one kind of
 * object at a time, and runs it on the backend. They share the tab's source and target
 * pickers because they are the same question asked at two different sizes, and a user who
 * starts with one regularly wants the other.
 *
 * One kind per run is the shape of the feature rather than a limit of this component: a run
 * reads one listing and reports one kind of outcome, so what it did is legible from the result
 * instead of having to be untangled from it. Nothing about a kind is spelled out here either —
 * the plan the backend answers with describes every kind it knows how to copy, so this renders
 * a list it was given rather than a list it agrees with the backend about.
 */
export default function ObjectCopy({ sourceId, targetId }: { sourceId: string; targetId: string }) {
  const s = useStudio();
  const key = objectCopyKey(sourceId, targetId);

  // the run lives in a module-level map (tabs unmount mid-copy); this mirrors it into React
  const [, force] = useState(0);
  useEffect(() => subscribeObjectCopyRun(key, () => force((n) => n + 1)), [key]);
  const run = getObjectCopyRun(key);

  // elapsed counter — the only honest progress signal there is, since nothing streams back
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run?.status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [run?.status]);

  const plan = run?.plan;
  const kind = run?.kind ?? DEFAULT_KIND;
  const names = run?.names ?? [];
  const existing = run?.existing ?? "skip";
  const preserveTablespace = run?.preserveTablespace ?? false;
  const result = run?.result;
  const busy = run?.status === "running";
  const loading = run?.status === "loading";

  const reread = useCallback(
    (nextKind?: CopyKind) => {
      const cur = getObjectCopyRun(key);
      void loadObjectCopyPlan(
        key,
        sourceId,
        targetId,
        nextKind ?? cur?.kind ?? DEFAULT_KIND,
        cur?.existing ?? "skip",
        cur?.preserveTablespace ?? false
      );
    },
    [key, sourceId, targetId]
  );

  // the type list's counts come from the breakdown, which covers every kind; the selection's
  // counts come from the picker, and only the second one changes as names are moved across
  const summary = objectCopyKindSummary(plan, kind);
  const { total, conflicts, blocked } = selectedCounts(plan, names);
  const overCap = !!plan && total > plan.cap;

  const copy = useCallback(async () => {
    const pending = await startObjectCopy(key, false);
    if (!pending) {
      const done = getObjectCopyRun(key);
      if (done?.error) s.toast("error", done.error);
      else if (done?.result?.note) s.toast("info", done.result.note);
      return;
    }
    // The server's wording, verbatim: it re-read both dictionaries, classified the operation
    // and counted the objects, so it is the only thing that can say what is about to happen.
    s.askConfirm({
      title: pending.confirmation.title,
      body: pending.confirmation.body,
      confirmLabel: pending.confirmation.confirmLabel,
      danger: pending.confirmation.danger,
      onConfirm: () => {
        void startObjectCopy(key, true).then(() => {
          const done = getObjectCopyRun(key);
          if (done?.error) {
            s.toast("error", done.error);
            return;
          }
          const r = done?.result;
          if (!r) return;
          // the target's catalog just changed — drop the cached tree if it is the open one
          if (targetId === s.activeConnId) s.bumpSchema();
          s.toast(
            r.failed || r.fksFailed ? "warning" : "success",
            `${r.created + r.replaced} ${r.label.toLowerCase()} copied into ${r.targetSchema}` +
              (r.fksCreated ? `, ${r.fksCreated} foreign key(s)` : "") +
              (r.failed ? ` — ${r.failed} failed` : "") +
              (r.fksFailed ? ` — ${r.fksFailed} foreign key(s) not added` : "") +
              ` (${fmtSecs(r.elapsedMs)})`
          );
        });
      },
    });
  }, [key, s, targetId]);

  const blocker = plan ? copyBlocker(plan) : null;

  return (
    <div className="df-fade">
      <p className="text-[11.5px] text-mute mb-3">
        Recreates the source schema's objects of one type in the target. Pick the type and the objects, and the backend reads
        their DDL from the source and creates them in the target under its own schema name.
      </p>

      <div className="flex items-center gap-2 flex-wrap mb-4">
        <Btn variant="outline" onClick={() => reread()} disabled={loading || busy || sourceId === targetId}>
          <RefreshCw size={13} /> {plan ? "Re-read both schemas" : "Read both schemas"}
        </Btn>
        {plan && (
          <span className="text-[11.5px] text-mute">
            <span className="font-mono text-soft">{plan.sourceSchema}</span> on {plan.sourceName} →{" "}
            <span className="font-mono text-soft">{plan.targetSchema}</span> on {plan.targetName}
          </span>
        )}
      </div>

      {run?.error && (
        <div className="border border-err/40 bg-err/8 rounded-lg p-3 text-[12.5px] text-ink mb-4">
          {/* the same field carries both failures, and they are not the same news: without a
              plan nothing was ever attempted, so calling that "copy failed" would report a
              change to the target that never started */}
          <span className="text-err font-semibold">{plan ? "Copy failed:" : "Could not read the schemas:"}</span> {run.error}
        </div>
      )}

      {loading && (
        <div className="py-16 flex justify-center">
          <Spinner label="Reading both data dictionaries…" />
        </div>
      )}

      {busy && (
        <div className="py-16 flex flex-col items-center gap-2">
          <Spinner label={`Copying ${plan?.sourceSchema}'s ${plan?.label.toLowerCase()} into ${plan?.targetSchema}…`} />
          <div className="text-[11.5px] text-mute">
            {fmtSecs(now - (run?.startedAt ?? now))} elapsed — the copy runs on the backend and cannot be cancelled.
          </div>
        </div>
      )}

      {!loading && !busy && plan && (
        <>
          <div className="grid xl:grid-cols-2 gap-4">
            <section className="min-w-0">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">Object type</h3>
              <div className="space-y-1.5">
                {plan.breakdown.map((b) => (
                  <label
                    key={b.kind}
                    className={`flex items-start gap-2.5 border rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                      b.kind === kind ? "border-accent/60 bg-accentdim" : "border-bdr hover:border-accent/40"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`object-copy-kind-${key}`}
                      checked={b.kind === kind}
                      onChange={() => {
                        // re-read rather than just remember: the counts for every kind are
                        // already on the plan, but the objects themselves are only carried for
                        // the kind it was read for
                        setObjectCopyOptions(key, { kind: b.kind });
                        reread(b.kind);
                      }}
                      className="mt-0.5 accent-[var(--accent)]"
                      aria-label={`Copy ${b.label}`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[12.5px] font-semibold">{b.label}</span>
                        <span className="text-[11px] text-mute">{fmtNum(b.total)}</span>
                        {b.conflicts > 0 && (
                          <Badge tone={existing === "replace" && b.kind === kind ? "err" : "warn"}>
                            {b.conflicts} already in target
                          </Badge>
                        )}
                      </div>
                      <div className="text-[11.5px] text-mute mt-0.5">{b.note}</div>
                    </div>
                  </label>
                ))}
              </div>
            </section>

            <section className="min-w-0">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">Objects the target already has</h3>
              <div className="space-y-1.5">
                {(["skip", "replace"] as CopyExisting[]).map((mode) => (
                  <label
                    key={mode}
                    className={`flex items-start gap-2.5 border rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                      existing === mode
                        ? mode === "replace"
                          ? "border-err/60 bg-err/8"
                          : "border-accent/60 bg-accentdim"
                        : "border-bdr hover:border-accent/40"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`object-copy-existing-${key}`}
                      checked={existing === mode}
                      onChange={() => setObjectCopyOptions(key, { existing: mode })}
                      className="mt-0.5 accent-[var(--accent)]"
                      aria-label={mode === "skip" ? "Leave existing objects alone" : "Drop and recreate existing objects"}
                    />
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-semibold">
                        {mode === "skip" ? "Leave them alone" : "Drop and recreate them"}
                      </div>
                      <div className="text-[11.5px] text-mute mt-0.5">
                        {/* the cost of a replacement is the backend's to describe: dropping a
                            table is not dropping an index, and only it knows which kind this is */}
                        {mode === "skip"
                          ? "Only what is missing from the target is created. Safe to re-run: a second copy fills in whatever failed the first time."
                          : summary?.replaceNote ?? "Each existing object is dropped before it is recreated."}
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mt-3 mb-2">Tablespace</h3>
              <label
                className={`flex items-start gap-2.5 border rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                  preserveTablespace ? "border-accent/60 bg-accentdim" : "border-bdr hover:border-accent/40"
                }`}
              >
                <input
                  type="checkbox"
                  checked={preserveTablespace}
                  onChange={(e) => setObjectCopyOptions(key, { preserveTablespace: e.target.checked })}
                  className="mt-0.5 accent-[var(--accent)]"
                  aria-label="Keep the source tablespace"
                />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold">Keep the source tablespace</div>
                  <div className="text-[11.5px] text-mute mt-0.5">
                    {preserveTablespace
                      ? `Each object is created in the tablespace it has in ${plan.sourceSchema}, and fails if ${plan.targetName} has no tablespace of that name.`
                      : `Objects are created in ${plan.targetSchema}'s default tablespace. Storage sizing is left to the target either way.`}
                  </div>
                </div>
              </label>
            </section>
          </div>

          <ObjectPicker
            plan={plan}
            names={names}
            onChange={(next) => setObjectCopyOptions(key, { names: next })}
          />

          <div className="grid xl:grid-cols-2 gap-4 mt-4">
            <div className="border border-bdr rounded-lg p-3">
              <div className="text-[12.5px]">
                <b>{fmtNum(total)}</b> of {fmtNum(summary?.total ?? plan.total)}{" "}
                {(summary?.label ?? plan.label).toLowerCase()} selected
                {conflicts > 0 && (
                  <>
                    , <b className={existing === "replace" ? "text-err" : "text-warn"}>{fmtNum(conflicts)}</b> of them already in{" "}
                    <span className="font-mono">{plan.targetSchema}</span>
                  </>
                )}
              </div>
              {blocked > 0 && (
                <div className="text-[11.5px] text-warn mt-1.5">
                  {fmtNum(blocked)} of them sit on a table <span className="font-mono">{plan.targetSchema}</span> has not got
                  and will be reported as skipped — copy those tables across first if you want them.
                </div>
              )}
              {overCap && (
                <div className="text-[11.5px] text-warn mt-1.5">
                  Over the {fmtNum(plan.cap)}-object cap for one request — copy a smaller selection.
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3">
              {blocker && (
                <div className="border border-err/40 bg-err/8 rounded-lg p-3 flex items-start gap-2.5">
                  <ShieldAlert size={15} className="text-err shrink-0 mt-0.5" />
                  <div className="text-[12.5px] text-ink">{blocker}</div>
                </div>
              )}
              <div>
                <Btn
                  variant={existing === "replace" && conflicts > 0 ? "danger" : "primary"}
                  onClick={copy}
                  disabled={!!blocker || total === 0 || overCap || busy}
                  title={total === 0 ? "Move at least one object across to copy it" : undefined}
                >
                  <Copy size={13} />
                  {existing === "replace" && conflicts > 0 ? "Replace and copy" : "Copy into target"}
                </Btn>
              </div>
            </div>
          </div>
        </>
      )}

      {!loading && !busy && result && (
        <section className="mt-5 df-fade">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute mb-2">
            Result — {result.label}, {fmtSecs(result.elapsedMs)}
            {result.timedOut ? " (stopped at the time budget)" : ""}
          </h3>
          <div className="flex gap-2 flex-wrap mb-3">
            <Tile label="Created" value={result.created} tone="ok" />
            {result.replaced > 0 && <Tile label="Replaced" value={result.replaced} tone="warn" />}
            <Tile label="Skipped" value={result.skipped} tone="neutral" />
            <Tile label="Failed" value={result.failed} tone={result.failed ? "err" : "neutral"} />
            {result.foreignKeys.length > 0 && (
              <Tile label="Foreign keys" value={result.fksCreated} tone={result.fksFailed ? "warn" : "accent"} />
            )}
          </div>

          {result.note && <p className="text-[12px] text-mute mb-3">{result.note}</p>}

          {result.failed > 0 && (
            <div className="mb-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-mute mb-1.5">Failed</div>
              <div className="space-y-1.5">
                {result.objects
                  .filter((o) => o.status === "failed")
                  .map((o) => (
                    <div key={o.name} className="border border-err/30 rounded-lg px-3 py-2 flex items-start gap-2.5">
                      <XCircle size={14} className="text-err shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span className="font-mono text-[12.5px] font-semibold">{o.name}</span>
                        <div className="text-[11.5px] text-err mt-0.5 break-words">{o.error}</div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {result.skipped > 0 && (
            <div className="mb-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-mute mb-1.5">Not copied</div>
              <div className="space-y-1.5">
                {skipGroups(result.objects).map((g) => (
                  <div key={g.reason} className="border border-bdr rounded-lg px-3 py-2">
                    <div className="text-[12px] text-soft">
                      {g.reason} <span className="text-mute">— {fmtNum(g.names.length)}</span>
                    </div>
                    <div className="font-mono text-[11.5px] text-mute mt-0.5 break-words">
                      {g.names.slice(0, 24).join(", ")}
                      {g.names.length > 24 ? `, +${fmtNum(g.names.length - 24)} more` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.fksFailed > 0 && (
            <div className="mb-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-mute mb-1.5">Foreign keys not added</div>
              <div className="space-y-1.5">
                {result.foreignKeys
                  .filter((f) => f.status === "failed")
                  .map((f) => (
                    <div key={`${f.table}.${f.name}`} className="border border-warn/30 rounded-lg px-3 py-2 flex items-start gap-2.5">
                      <AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span className="font-mono text-[12.5px] font-semibold">{f.name}</span>
                        <span className="text-[11px] text-mute"> on {f.table}</span>
                        <div className="text-[11.5px] text-err mt-0.5 break-words">{f.error}</div>
                      </div>
                    </div>
                  ))}
              </div>
              <p className="text-[11.5px] text-mute mt-1.5">
                A foreign key names a second table. One that points at a table this copy did not bring across cannot be added
                until that table is there — copy it and run this again, and the missing keys are filled in.
              </p>
            </div>
          )}

          {/* what this kind carries, in the backend's own words — the same sentence the
              confirmation dialog was written from, so the two cannot describe different copies */}
          <p className="text-[11.5px] text-mute">{objectCopyKindSummary(plan, result.kind)?.note}</p>
        </section>
      )}

      {!loading && !busy && !plan && !run?.error && (
        <div className="border border-dashed border-bdr rounded-xl p-10 text-center text-mute text-[12.5px]">
          <Database size={20} className="mx-auto mb-2 opacity-60" />
          Pick a source and a target above, then <b className="text-soft">Read both schemas</b> to see what a copy would create and
          what the target already has.
        </div>
      )}
    </div>
  );
}

/**
 * The two lists a copy is chosen from: everything the source has on the left, everything this
 * run will copy on the right, and the arrows between them.
 *
 * Shaped after SQL Developer's own object picker, including the name filter over the left
 * list. Two native multi-select lists rather than rows of checkboxes, because that is what
 * gives ctrl-click, shift-click and type-ahead for free on a list that can run to hundreds of
 * tables — and double-clicking one moves it, which is the shortcut everybody tries.
 *
 * The filter narrows the left list only, and **the "move all" arrow moves what the filter is
 * showing**: filtering to `SALES_%` and pressing it is how you pick a whole family of tables at
 * once. The counts in the headings say how many that is before it happens.
 */
function ObjectPicker({
  plan,
  names,
  onChange,
}: {
  plan: ObjectCopyPlan;
  names: string[];
  onChange: (next: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const [leftPicked, setLeftPicked] = useState<string[]>([]);
  const [rightPicked, setRightPicked] = useState<string[]>([]);

  const chosen = useMemo(() => new Set(names), [names]);
  // both lists stay in the dictionary's order however the names were moved about, so the same
  // object is always in the same place
  const available = useMemo(() => {
    const needle = filter.trim().toUpperCase();
    return plan.items.filter((i) => !chosen.has(i.name) && (!needle || i.name.toUpperCase().includes(needle)));
  }, [plan.items, chosen, filter]);
  const selected = useMemo(() => plan.items.filter((i) => chosen.has(i.name)), [plan.items, chosen]);

  const set = (next: Set<string>) => onChange(plan.items.filter((i) => next.has(i.name)).map((i) => i.name));
  const add = (add: string[]) => {
    set(new Set([...chosen, ...add]));
    setLeftPicked([]);
  };
  const remove = (drop: string[]) => {
    const gone = new Set(drop);
    set(new Set([...chosen].filter((n) => !gone.has(n))));
    setRightPicked([]);
  };

  const listCls =
    "w-full h-56 rounded-md bg-panel2 border border-bdr text-[12px] font-mono text-ink p-1 focus:border-accent focus:outline-none";

  return (
    <section className="mt-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-mute">
          {plan.label} to copy
        </h3>
        <label className="flex items-center gap-2">
          <span className="text-[11px] text-mute">Name</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter the list on the left…"
            className={`${inputCls} w-64 font-mono`}
            aria-label={`Filter ${plan.label.toLowerCase()} by name`}
          />
        </label>
      </div>

      <div className="flex items-stretch gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-mute mb-1">
            In {plan.sourceSchema}, not selected — {fmtNum(available.length)}
            {filter.trim() && <> of {fmtNum(plan.items.length - selected.length)}</>}
          </div>
          <select
            multiple
            className={listCls}
            value={leftPicked}
            onChange={(e) => setLeftPicked(Array.from(e.target.selectedOptions, (o) => o.value))}
            onDoubleClick={() => leftPicked.length && add(leftPicked)}
            aria-label={`${plan.label} available to copy`}
          >
            {available.map((i) => (
              <option key={i.name} value={i.name} className="px-1 py-0.5">
                {i.name}
                {itemTag(i)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col justify-center gap-1.5 shrink-0">
          <Btn variant="toolbar" title="Copy the selected objects" onClick={() => add(leftPicked)} disabled={!leftPicked.length}>
            <ChevronRight size={14} />
          </Btn>
          <Btn
            variant="toolbar"
            title={filter.trim() ? "Copy every object the filter is showing" : "Copy every object"}
            onClick={() => add(available.map((i) => i.name))}
            disabled={!available.length}
          >
            <ChevronsRight size={14} />
          </Btn>
          <Btn variant="toolbar" title="Leave the selected objects out" onClick={() => remove(rightPicked)} disabled={!rightPicked.length}>
            <ChevronLeft size={14} />
          </Btn>
          <Btn variant="toolbar" title="Leave every object out" onClick={() => remove([...chosen])} disabled={!selected.length}>
            <ChevronsLeft size={14} />
          </Btn>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-mute mb-1">
            Will be copied into {plan.targetSchema} — {fmtNum(selected.length)}
          </div>
          <select
            multiple
            className={listCls}
            value={rightPicked}
            onChange={(e) => setRightPicked(Array.from(e.target.selectedOptions, (o) => o.value))}
            onDoubleClick={() => rightPicked.length && remove(rightPicked)}
            aria-label={`${plan.label} chosen for this copy`}
          >
            {selected.map((i) => (
              <option key={i.name} value={i.name} className="px-1 py-0.5">
                {i.name}
                {itemTag(i)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="text-[11px] text-mute mt-1.5">
        Ctrl-click and shift-click pick several; double-click moves one. A name marked{" "}
        <span className="font-mono">· in target</span> already exists in {plan.targetSchema} and is what the choice above
        decides the fate of; one marked <span className="font-mono">· needs …</span> is built on a table that is not there
        yet, and copying it would only report that.
      </p>
    </section>
  );
}

/**
 * What a name is marked with in the two lists.
 *
 * An `<option>` holds text and nothing else, so both marks are suffixes rather than badges.
 * "In target" is the short one because the choice above already says what happens to it; the
 * other one names the table, because the table is the thing the user has to go and copy. Only
 * one mark is shown, and a missing table wins it: an object that cannot be created at all is
 * not about to be skipped or replaced either.
 */
function itemTag(i: ObjectCopyPlan["items"][number]): string {
  if (i.missingTable) return `  ·  needs ${i.missingTable}`;
  return i.existsInTarget ? "  ·  in target" : "";
}

/**
 * Skipped objects, gathered under the reason they were skipped.
 *
 * A flat skip list is the least useful part of a result — "already in the target" two hundred
 * times is two hundred rows saying one thing. One row per reason says the same thing once, and
 * the small groups go first because those are the ones worth reading: the handful of indexes
 * whose table has not been copied yet, rather than the two hundred that were already there.
 */
function skipGroups(objects: ObjectCopyObjectResult[]): { reason: string; names: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const o of objects) {
    if (o.status !== "skipped") continue;
    const reason = o.reason ?? "Skipped.";
    groups.set(reason, [...(groups.get(reason) ?? []), o.name]);
  }
  return [...groups]
    .map(([reason, names]) => ({ reason, names }))
    .sort((a, b) => a.names.length - b.names.length || a.reason.localeCompare(b.reason));
}

/** The reason this copy cannot run at all, or null. The backend refuses each of these too. */
function copyBlocker(plan: ObjectCopyPlan): string | null {
  if (plan.sameSchema) {
    return `"${plan.sourceName}" and "${plan.targetName}" are the same schema on the same database — there is nothing to copy between them.`;
  }
  if (plan.targetReadOnly) {
    return `"${plan.targetName}" is read-only. Edit the connection and disable read-only mode before copying into it.`;
  }
  if (plan.targetSystemSchema) {
    return `${plan.targetSchema} is an Oracle-maintained schema — copying into it from here is blocked.`;
  }
  return null;
}

function Tile({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" | "err" | "accent" | "neutral" }) {
  const tones = {
    ok: "border-ok/40 text-ok",
    warn: "border-warn/40 text-warn",
    err: "border-err/40 text-err",
    accent: "border-accent/40 text-accenthi",
    neutral: "border-bdr text-soft",
  };
  return (
    <div className={`border rounded-lg px-3 py-1.5 ${tones[tone]}`}>
      <div className="text-[15px] font-semibold leading-tight">{fmtNum(value)}</div>
      <div className="text-[10.5px] uppercase tracking-wider text-mute">{label}</div>
    </div>
  );
}
