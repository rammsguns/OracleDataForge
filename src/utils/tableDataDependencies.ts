export interface TableDependency {
  table: string;
  constraint: string;
  parent: string | null;
  parentSchema: string;
  local: boolean;
}

export type TableDependencyIndex = Map<string, TableDependency[]>;

export function indexTableDependencies(dependencies: TableDependency[]): TableDependencyIndex {
  const index: TableDependencyIndex = new Map();
  for (const dependency of dependencies) {
    const table = dependency.table;
    const entries = index.get(table);
    if (entries) entries.push(dependency);
    else index.set(table, [dependency]);
  }
  return index;
}

/** Expand parent dependencies without silently truncating at the copy limit. */
export function tableDataSelection(roots: string[], available: string[], dependencies: TableDependency[] | TableDependencyIndex) {
  const allowed = new Set(available);
  const selected = new Set(roots.filter(n => allowed.has(n)));
  const dependenciesByTable = dependencies instanceof Map ? dependencies : indexTableDependencies(dependencies);
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const warnings = new Set<string>();
  const visit = (table: string) => {
    if (visiting.has(table)) { cycles.add(table); return; }
    if (visited.has(table)) return;
    visiting.add(table);
    for (const fk of dependenciesByTable.get(table) ?? []) {
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
