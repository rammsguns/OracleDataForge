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
export function storageSql(action: string, name: string, path: string, mb: string, temporary: boolean) {
  const file = temporary ? "TEMPFILE" : "DATAFILE";
  if (action === "create") return `CREATE ${temporary ? "TEMPORARY " : ""}TABLESPACE ${identifier(name)} ${file} ${literal(path)} SIZE ${size(mb)} AUTOEXTEND OFF;`;
  if (action === "add") return `ALTER TABLESPACE ${identifier(name)} ADD ${file} ${literal(path)} SIZE ${size(mb)} AUTOEXTEND OFF;`;
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
  autoextend?: boolean; nextMb?: string; maxMb?: string; deleteFiles?: boolean; bigfile?: boolean;
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
    if (change.autoextend && Number(change.maxMb) < Number(change.nextMb)) throw new Error("Maximum size must be at least the growth increment.");
    const target = change.bigfile ? `ALTER TABLESPACE ${identifier(name)}` : `ALTER DATABASE ${temporary ? "TEMPFILE" : "DATAFILE"} ${literal(path)}`;
    return `${target} AUTOEXTEND ${change.autoextend ? `ON NEXT ${size(change.nextMb ?? "")} MAXSIZE ${size(change.maxMb ?? "")}` : "OFF"};`;
  }
  return storageSql(action, name, path, mb, temporary);
}
