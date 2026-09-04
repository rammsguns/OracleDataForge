/**
 * State of a "copy these objects into that connection" run, kept outside React.
 *
 * Same reason as `compileRuns.ts`: a copy of a few hundred tables takes minutes, inactive
 * workspace tabs unmount, and the user's first instinct while it runs is to go and look at
 * something in the worksheet. A run owned by component state would be lost at exactly that
 * moment. It lives here instead: this module starts it, the panel subscribes and renders
 * whatever it finds, and the same map is what stops a second copy being started between the
 * same two connections.
 */

import { api, ConfirmRequiredError } from "./api";
import type { CopyExisting, CopyKind, ObjectCopyPlan, ObjectCopyResult } from "./api";

export type ObjectCopyStatus = "loading" | "ready" | "running" | "done";

export interface ObjectCopyRun {
  status: ObjectCopyStatus;
  sourceId: string;
  targetId: string;
  /** the kind the user picked — the plan describes every kind, picked or not */
  kind: CopyKind;
  /** the objects ticked across in the picker, a subset of the plan's items */
  names: string[];
  existing: CopyExisting;
  /** copy each object into the tablespace it came from, rather than the target's default */
  preserveTablespace: boolean;
  plan?: ObjectCopyPlan;
  result?: ObjectCopyResult;
  error?: string;
  /** ms epoch the current run started, for the elapsed counter */
  startedAt?: number;
}

const runs = new Map<string, ObjectCopyRun>();
const listeners = new Map<string, Set<() => void>>();

/** A run belongs to a direction, not to a tab: A → B and B → A are different copies. */
export const objectCopyKey = (sourceId: string, targetId: string) => `${sourceId}>${targetId}`;

export const getObjectCopyRun = (key: string): ObjectCopyRun | undefined => runs.get(key);

export function subscribeObjectCopyRun(key: string, fn: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  set.add(fn);
  listeners.set(key, set);
  return () => set.delete(fn);
}

function emit(key: string) {
  for (const fn of listeners.get(key) ?? []) fn();
}

function patch(key: string, next: Partial<ObjectCopyRun>) {
  const cur = runs.get(key);
  if (!cur) return;
  runs.set(key, { ...cur, ...next });
  emit(key);
}

/**
 * The plan's own line for one kind.
 *
 * The plan surveys every kind whether it is the chosen one or not, so switching kinds is a
 * lookup in numbers the browser already has rather than another pair of dictionary reads. The
 * `total` and `conflicts` on the plan itself describe the kind it was read for, which is not
 * the same thing once the user has picked a different one.
 */
export const objectCopyKindSummary = (plan: ObjectCopyPlan | undefined, kind: CopyKind) =>
  plan?.breakdown.find((b) => b.kind === kind);

/**
 * What the current selection comes to: how many objects, and how many of those the target
 * already has — which is what "skip" leaves alone and "replace" drops.
 *
 * Counted from the plan the browser already holds, so moving a name across the picker is
 * arithmetic rather than another pair of dictionary reads. The server counts it again from its
 * own fresh listing before it writes the confirmation, so this never decides anything: it only
 * says what the user is looking at.
 */
export function selectedCounts(
  plan: ObjectCopyPlan | undefined,
  names: string[]
): { total: number; conflicts: number } {
  if (!plan) return { total: 0, conflicts: 0 };
  const picked = new Set(names);
  const chosen = plan.items.filter((i) => picked.has(i.name));
  return { total: chosen.length, conflicts: chosen.filter((i) => i.existsInTarget).length };
}

/** Preflight (or re-check). Safe to call repeatedly; refuses while a copy is running. */
export async function loadObjectCopyPlan(
  key: string,
  sourceId: string,
  targetId: string,
  kind: CopyKind,
  existing: CopyExisting,
  preserveTablespace: boolean
): Promise<void> {
  const cur = runs.get(key);
  if (cur?.status === "running" || cur?.status === "loading") return;
  runs.set(key, {
    ...(cur ?? {}),
    status: "loading",
    sourceId,
    targetId,
    kind,
    names: cur?.names ?? [],
    existing,
    preserveTablespace,
    error: undefined,
  });
  emit(key);
  try {
    const plan = await api.objectCopyPlan(targetId, sourceId, kind);
    // A fresh survey starts with everything picked: reading the schemas is how you ask "what
    // is there", and the answer to that is the copy most people came for. Narrowing it is what
    // the picker is for, and a selection kept across a re-read would silently exclude whatever
    // has appeared in the source since.
    patch(key, { status: "ready", plan, names: plan.items.map((i) => i.name) });
  } catch (e) {
    patch(key, { status: "ready", error: (e as Error).message });
  }
}

/** Change what the run will copy, without going back to the server for it. */
export function setObjectCopyOptions(
  key: string,
  next: { kind?: CopyKind; names?: string[]; existing?: CopyExisting; preserveTablespace?: boolean }
): void {
  patch(key, next);
}

/**
 * Start the copy. Returns the confirmation the server wrote when the request was not
 * acknowledged — the caller shows *that* dialog, never wording of its own, and calls again
 * with `confirm`. Resolves to null once the run is under way or finished.
 */
export async function startObjectCopy(key: string, confirm: boolean): Promise<ConfirmRequiredError | null> {
  const cur = runs.get(key);
  if (!cur || cur.status === "running") return null;
  const req = {
    sourceId: cur.sourceId,
    kind: cur.kind,
    names: cur.names,
    existing: cur.existing,
    preserveTablespace: cur.preserveTablespace,
  };
  if (!confirm) {
    // ask the server first: it re-reads both dictionaries, decides whether this needs
    // confirming, and words it — the browser's plan may be minutes old by now
    try {
      const result = await api.objectCopy(cur.targetId, req, false);
      patch(key, { status: "done", result, error: undefined });
      return null;
    } catch (e) {
      if (e instanceof ConfirmRequiredError) return e;
      patch(key, { status: "ready", error: (e as Error).message });
      return null;
    }
  }
  patch(key, { status: "running", startedAt: Date.now(), error: undefined, result: undefined });
  try {
    const result = await api.objectCopy(cur.targetId, req, true);
    patch(key, { status: "done", result });
    // Re-read the plan so the counts describe the target as it is *now*: leaving the pre-copy
    // survey on screen next to the results would offer to copy objects that have just landed.
    try {
      const plan = await api.objectCopyPlan(cur.targetId, cur.sourceId, cur.kind);
      patch(key, { plan });
    } catch {
      /* the results still stand; only the follow-up counts are stale */
    }
  } catch (e) {
    patch(key, { status: "ready", error: (e as Error).message });
  }
  return null;
}
