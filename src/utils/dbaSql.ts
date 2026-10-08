/** Build one reviewable Oracle administration statement at a time. */
export const memoryParameters = ["memory_target", "memory_max_target", "sga_target", "sga_max_size", "pga_aggregate_target", "pga_aggregate_limit", "db_cache_size", "shared_pool_size"] as const;
const identifier = (value: string) => {
  if (!value.trim() || /[\x00-\x1f]/.test(value)) throw new Error("Enter a valid tablespace name.");
  return `"${value.replace(/"/g, '""')}"`;
};
const literal = (value: string) => {
  if (!value.trim() || /[\x00-\x1f]/.test(value)) throw new Error("Enter a database-server file path or ASM destination.");
  return `'${value.replace(/'/g, "''")}'`;
};
const size = (value: string, allowZero = false) => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (allowZero ? 0 : 1)) throw new Error("Size must be a whole number of MiB.");
  return `${Number(value)}M`;
};
function autoextendClause(enabled: boolean, nextMb?: string, maxMb?: string, initialMb?: string) {
  if (!enabled) return "AUTOEXTEND OFF";
  const next = size(nextMb ?? "");
  const max = size(maxMb ?? "");
  if (Number(maxMb) < Number(nextMb)) throw new Error("Maximum size must be at least the growth increment.");
  if (initialMb !== undefined && Number(maxMb) < Number(initialMb)) throw new Error("Maximum size must be at least the initial file size.");
  return `AUTOEXTEND ON NEXT ${next} MAXSIZE ${max}`;
}
export function storageSql(action: string, name: string, path: string, mb: string, temporary: boolean, autoextend = false, nextMb?: string, maxMb?: string, bigfile = false) {
  const file = temporary ? "TEMPFILE" : "DATAFILE";
  if (action === "create") return `CREATE ${bigfile ? "BIGFILE " : ""}${temporary ? "TEMPORARY " : ""}TABLESPACE ${identifier(name)} ${file} ${literal(path)} SIZE ${size(mb)} ${autoextendClause(autoextend, nextMb, maxMb, mb)};`;
  if (action === "add") return `ALTER TABLESPACE ${identifier(name)} ADD ${file} ${literal(path)} SIZE ${size(mb)} ${autoextendClause(autoextend, nextMb, maxMb, mb)};`;
  if (action === "resize") return `ALTER DATABASE ${file} ${literal(path)} RESIZE ${size(mb)};`;
  throw new Error("Unknown storage operation.");
}
export function memorySql(name: string, mb: string, scope: string) {
  if (!memoryParameters.some((p) => p === name)) throw new Error("Unsupported memory parameter.");
  if (!["MEMORY", "SPFILE", "BOTH"].includes(scope)) throw new Error("Invalid parameter scope.");
  return `ALTER SYSTEM SET ${name} = ${size(mb, true)} SCOPE=${scope};`;
}

export interface StorageChange {
  action: string; name: string; path: string; mb: string; temporary: boolean;
  autoextend?: boolean; nextMb?: string; nextBytes?: string; maxMb?: string; deleteFiles?: boolean; bigfile?: boolean;
}
export function storageChangeSql(change: StorageChange) {
  if (!change || typeof change !== "object") throw new Error("Missing storage change.");
  for (const key of ["action", "name", "path", "mb"] as const) {
    if (typeof change[key] !== "string" || change[key].length > 4096) throw new Error(`Invalid ${key}.`);
  }
  for (const key of ["temporary", "autoextend", "deleteFiles", "bigfile"] as const) {
    if (change[key] !== undefined && typeof change[key] !== "boolean") throw new Error(`Invalid ${key}.`);
  }
  const { action, name, path, mb, temporary } = change;
  if (["drop", "readOnly", "readWrite"].includes(action)) {
    if (!name.trim() || /^(SYSTEM|SYSAUX)$/i.test(name)) throw new Error("Select a non-system tablespace.");
    if (action === "drop") return `DROP TABLESPACE ${identifier(name)} INCLUDING CONTENTS${change.deleteFiles ? " AND DATAFILES" : " KEEP DATAFILES"};`;
    return `ALTER TABLESPACE ${identifier(name)} READ ${action === "readOnly" ? "ONLY" : "WRITE"};`;
  }
  if (action === "autoextend") {
    const target = change.bigfile ? `ALTER TABLESPACE ${identifier(name)}` : `ALTER DATABASE ${temporary ? "TEMPFILE" : "DATAFILE"} ${literal(path)}`;
    return `${target} ${autoextendClause(!!change.autoextend, change.nextMb, change.maxMb)};`;
  }
  if (action === "maxSize") {
    if (change.autoextend !== true) throw new Error("Enable automatic growth before setting a maximum size.");
    const max = size(change.maxMb ?? "");
    size(mb);
    if (Number(change.maxMb) < Number(mb)) throw new Error("Maximum size must be at least the current file size.");
    const nextBytes = change.nextBytes;
    if (!nextBytes || !/^\d+$/.test(nextBytes) || !Number.isSafeInteger(Number(nextBytes)) || Number(nextBytes) < 1) throw new Error("Current growth increment is unavailable. Use Change automatic growth instead.");
    if (Number(nextBytes) > Number(change.maxMb) * 1048576) throw new Error("Maximum size must be at least the growth increment.");
    const target = change.bigfile ? `ALTER TABLESPACE ${identifier(name)}` : `ALTER DATABASE ${temporary ? "TEMPFILE" : "DATAFILE"} ${literal(path)}`;
    return `${target} AUTOEXTEND ON NEXT ${nextBytes} MAXSIZE ${max};`;
  }
  if (action === "resize" && change.bigfile) {
    // Oracle permits resizing a bigfile tablespace by name. Convert the UI's MiB
    // value to bytes so the reviewed statement shows the exact absolute size.
    size(mb);
    const tablespace = /^[A-Z][A-Z0-9_$#]*$/.test(name) ? name : identifier(name);
    return `ALTER TABLESPACE ${tablespace} RESIZE ${BigInt(mb) * 1048576n};`;
  }
  return storageSql(action, name, path, mb, temporary, change.autoextend, change.nextMb, change.maxMb, change.bigfile);
}
