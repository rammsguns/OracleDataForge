/** Per-routine Run/Test state kept while the tab is unmounted (inactive workspace tabs
 *  unmount). Keyed by `${connId}.${routineName}` — same convention as editBuffers. */

import type { RoutineRunResult } from "./api";

export interface ArgState {
  value: string;
  isNull: boolean;
  useDefault: boolean;
}

/** A member's PL/SQL block. `dirty` = the user edited it, so the generator stops
 *  overwriting it when the parameter values change (Reset puts it back). */
export interface BlockState {
  text: string;
  dirty: boolean;
}

export interface RunBuffer {
  /** `${member.name}#${member.overload ?? ""}` of the selected member */
  memberKey: string | null;
  /** memberKey → param name → form state */
  values: Record<string, Record<string, ArgState>>;
  /** what the Run button executes: the parameter form or the hand-written block */
  mode: "form" | "block";
  /** memberKey → block state */
  blocks: Record<string, BlockState>;
  result: RoutineRunResult | null;
}

const buffers = new Map<string, RunBuffer>();

export const runKey = (connId: string, routine: string) => `${connId}.${routine}`;

export function getRunBuffer(key: string): RunBuffer | undefined {
  return buffers.get(key);
}

export function setRunBuffer(key: string, b: RunBuffer): void {
  buffers.set(key, b);
}
