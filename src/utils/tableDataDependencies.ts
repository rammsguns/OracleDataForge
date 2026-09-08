export interface TableDependency {
  table: string;
  constraint: string;
  parent: string | null;
  parentSchema: string;
  local: boolean;
}

/** Expand parent dependencies without silently truncating at the copy limit. */
export function tableDataSelection(roots: string[], available: string[], dependencies: TableDependency[]) {
  const allowed = new Set(available);
  const selected = new Set(roots.filter(n => allowed.has(n)));
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const warnings = new Set<string>();
  const visit = (table: string) => {
    if (visiting.has(table)) { cycles.add(table); return; }
    if (visited.has(table)) return;
    visiting.add(table);
    for (const fk of dependencies.filter(d => d.table === table)) {
      if (fk.local && fk.parent && allowed.has(fk.parent)) {
        selected.add(fk.parent);
        visit(fk.parent);
      } else {
        warnings.add(`${table} (${fk.constraint}) requires matching parent rows in ${fk.parentSchema}.${fk.parent ?? '[parent table not visible]'}. This parent cannot be copied from the selected source; its required data must already exist in the target database.`);
      }
    }
    visiting.delete(table);
    visited.add(table);
    order.push(table);
  };
  for (const table of roots) if (allowed.has(table)) visit(table);
  return { names: order, added: order.filter(n => !roots.includes(n)), cycles: [...cycles], warnings: [...warnings], overLimit: selected.size > 25 };
}
