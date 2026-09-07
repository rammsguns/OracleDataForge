import type { StorageRow } from "./tablespaceCapacity.ts";

/** Suggest new filenames, never reuse an existing Oracle-managed ASM filename. */
export function storageDestinations(files: StorageRow[], name: string, temporary: boolean): string[] {
  const stem = name.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || (temporary ? "temp" : "data");
  const kind = temporary ? "TEMPFILE" : "DATAFILE";
  const ordered = [...files.filter(row => row.Kind === kind), ...files.filter(row => row.Kind !== kind)];
  const existing = new Set(files.map(row => String(row.File ?? "").toLowerCase()));
  const destinations = new Set<string>();
  for (const row of ordered) {
    const file = String(row.File ?? "");
    const asm = file.match(/^\+([^/\\]+)(?:[/\\]|$)/);
    if (asm) { destinations.add(`+${asm[1]}`); continue; }
    const separator = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
    if (separator < 0) continue;
    const directory = file.slice(0, separator + 1);
    let index = 1;
    let candidate: string;
    do { candidate = `${directory}${stem}_${String(index++).padStart(2, "0")}.dbf`; } while (existing.has(candidate.toLowerCase()));
    destinations.add(candidate);
  }
  return [...destinations];
}
