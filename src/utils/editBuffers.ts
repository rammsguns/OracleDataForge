/** In-progress PL/SQL edits per object, kept while the editor tab is unmounted
 *  (inactive workspace tabs unmount). Keyed by `${connId}.${objectName}`. */

export interface EditBuffers {
  spec: string;
  body: string;
  part: "spec" | "body";
}

const buffers = new Map<string, EditBuffers>();

export const editKey = (connId: string, object: string) => `${connId}.${object}`;

export function getEdits(key: string): EditBuffers | undefined {
  return buffers.get(key);
}

export function setEdits(key: string, b: EditBuffers): void {
  buffers.set(key, b);
}

/** Called when the user confirms closing a dirty tab — the edits are gone for good. */
export function discardEditsFor(object: string): void {
  for (const key of [...buffers.keys()]) {
    if (key.endsWith(`.${object}`)) buffers.delete(key);
  }
}
