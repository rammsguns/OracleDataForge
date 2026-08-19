/**
 * State of a "compile invalid objects" run, kept outside React.
 *
 * A schema-wide recompile can take minutes, and inactive workspace tabs unmount — so a
 * run owned by component state would be lost the moment the user switched to the
 * worksheet to fix something, which is exactly what they will do. The run therefore
 * lives here: the module starts it, the component subscribes and renders whatever it
 * finds. The same map is what stops a second run being started for a scope that is
 * already running.
 */

import { api, ConfirmRequiredError } from "./api";
import type { CompileBatchResult, CompileScopeRef, InvalidReport } from "./api";

export type CompileRunStatus = "idle" | "loading" | "ready" | "running" | "done";

export interface CompileRun {
  status: CompileRunStatus;
  connId: string;
  connName: string;
  ref: CompileScopeRef;
  report?: InvalidReport;
  result?: CompileBatchResult;
  error?: string;
  /** ms epoch the current run started, for the elapsed counter */
  startedAt?: number;
}

const runs = new Map<string, CompileRun>();
const listeners = new Map<string, Set<() => void>>();

/** A tab is identified by its payload; the connection is part of the key so switching
 *  connection cannot show another database's results. */
export const compileRunKey = (connId: string, payload: string) => `${connId}|${payload}`;

/** `schema` · `group:Packages` · `object:PKG_SALES` — the tab payload, parsed. */
export function parseCompilePayload(payload: string): CompileScopeRef {
  if (payload === "schema") return { scope: "schema" };
  const i = payload.indexOf(":");
  const kind = i === -1 ? payload : payload.slice(0, i);
  const rest = i === -1 ? "" : payload.slice(i + 1); // names may legally contain ":"
  if (kind === "group") return { scope: "group", group: rest };
  if (kind === "object") return { scope: "object", name: rest };
  return { scope: "schema" };
}

export const getCompileRun = (key: string): CompileRun | undefined => runs.get(key);

export function subscribeCompileRun(key: string, fn: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  set.add(fn);
  listeners.set(key, set);
  return () => set.delete(fn);
}

function emit(key: string) {
  for (const fn of listeners.get(key) ?? []) fn();
}

function patch(key: string, next: Partial<CompileRun>) {
  const cur = runs.get(key);
  if (!cur) return;
  runs.set(key, { ...cur, ...next });
  emit(key);
}

/** Preflight (or re-check). Safe to call repeatedly; refuses while a compile is running. */
export async function loadCompileTargets(
  key: string,
  connId: string,
  connName: string,
  ref: CompileScopeRef
): Promise<void> {
  const cur = runs.get(key);
  if (cur?.status === "running" || cur?.status === "loading") return;
  runs.set(key, { ...(cur ?? {}), status: "loading", connId, connName, ref, error: undefined });
  emit(key);
  try {
    const report = await api.compileTargets(connId, ref);
    patch(key, { status: "ready", report });
  } catch (e) {
    patch(key, { status: "ready", error: (e as Error).message });
  }
}

/**
 * Start the compile. Returns the confirmation the server wrote when the request was not
 * acknowledged — the caller shows *that* dialog (never its own wording) and calls again
 * with `confirm`. Resolves to null once the run is under way or finished.
 */
export async function startCompileRun(
  key: string,
  confirm: boolean
): Promise<ConfirmRequiredError | null> {
  const cur = runs.get(key);
  if (!cur || cur.status === "running") return null;
  if (!confirm) {
    // ask the server first: it decides whether this needs confirming and how to word it
    try {
      const result = await api.compileInvalid(cur.connId, cur.ref, false);
      // nothing to compile — the server answers 200 rather than asking about a no-op
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
    const result = await api.compileInvalid(cur.connId, cur.ref, true);
    patch(key, { status: "done", result });
    // Re-read the dictionary so the header count and the "Compile remaining N" button
    // describe what is left *now* — leaving the pre-run preflight on screen next to the
    // results would offer to compile objects that were just fixed.
    try {
      const report = await api.compileTargets(cur.connId, cur.ref);
      patch(key, { report });
    } catch { /* the results still stand; only the follow-up count is stale */ }
  } catch (e) {
    patch(key, { status: "ready", error: (e as Error).message });
  }
  return null;
}

/** Forget a tab's run (called when the tab is closed). */
export function discardCompileRun(key: string): void {
  runs.delete(key);
  listeners.delete(key);
}
