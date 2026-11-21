export interface TableDependency {
  table: string;
  constraint: string;
  parent: string | null;
  parentSchema: string;
  local: boolean;
}

export type TableDependencyIndex = Map<string, TableDependency[]>;

/** Shared by the client and server so both enforce the same copy limits. */
export const TABLE_COPY_MAX_TABLES = 1000;
/** Hard ceiling for the total rows in one copy; the user picks a total limit up to this. */
export const TABLE_COPY_MAX_ROWS = 50_000_000;
/** Total row limit used when none is chosen. */
export const TABLE_COPY_DEFAULT_TOTAL_ROWS = 100000;

/** Rows a table contributes to a copy when an optional per-table row limit applies. */
export const limitedCopyCount = (count: number, rowLimit?: number | null) =>
  rowLimit ? Math.min(count, rowLimit) : count;

/** Default row limit for tables with CLOB, NCLOB or JSON columns, when that limit is turned on. */
export const TABLE_COPY_DEFAULT_LOB_ROWS = 100;

/**
 * The row limit for one table. A number chosen for that table (`tableRowLimits`) always wins.
 * Otherwise the per-table limit and, for tables with CLOB, NCLOB or JSON columns, the
 * large-object table limit apply; when both do, the smaller one wins.
 */
export function copyRowLimitFor(name: string, rowLimit: number | null | undefined, lobRowLimit: number | null | undefined, lobTables: ReadonlySet<string>, tableRowLimits?: Readonly<Record<string, number>>): number | null {
  const chosen = tableRowLimits && Object.hasOwn(tableRowLimits, name) ? tableRowLimits[name] : undefined;
  if (chosen) return chosen;
  const limits = [rowLimit, lobTables.has(name) ? lobRowLimit : null].filter((n): n is number => !!n);
  return limits.length ? Math.min(...limits) : null;
}

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
/**
 * The tables to copy: the roots, the local parents they need (recursively), and, when target
 * tables are truncated first, the child tables with rows that reference a truncated table.
 * Truncating a parent would otherwise orphan those children's rows, so they are truncated and
 * copied too (with their own parents, and so on until nothing more is needed).
 *
 * `keepRows` are tables that already have rows and receive the copied rows on top of them
 * (no truncation). They are copied only when chosen as roots: never added as someone's parent
 * (their existing rows serve as parents) and never truncated as a child.
 */
export function tableDataSelection(roots: string[], available: string[], dependencies: TableDependency[] | TableDependencyIndex, options: { truncateOccupied?: ReadonlySet<string>; keepRows?: ReadonlySet<string> } = {}) {
  const keep = options.keepRows ?? new Set<string>();
  const allowed = new Set(available.filter(n => !keep.has(n)));
  const keptRoots = new Set(roots.filter(n => keep.has(n) && available.includes(n)));
  const index = dependencies instanceof Map ? dependencies : indexTableDependencies(dependencies);
  const occupied = options.truncateOccupied && new Set([...options.truncateOccupied].filter(n => !keep.has(n)));
  if (!occupied?.size) return parentClosure(roots, allowed, index, keptRoots);
  const childrenOf = new Map<string, string[]>();
  for (const fks of index.values()) for (const fk of fks) {
    if (fk.local && fk.parent && fk.parent !== fk.table) childrenOf.set(fk.parent, [...(childrenOf.get(fk.parent) ?? []), fk.table]);
  }
  const seeds = roots.filter(n => allowed.has(n) || keptRoots.has(n));
  const children = new Set<string>();
  for (;;) {
    const result = parentClosure(seeds, allowed, index, keptRoots);
    const more = [...new Set(result.names.filter(t => occupied.has(t)).flatMap(t => childrenOf.get(t) ?? []))]
      .filter(c => allowed.has(c) && occupied.has(c) && !seeds.includes(c));
    if (!more.length || result.overLimit) {
      return { ...result, added: result.names.filter(n => !roots.includes(n)), addedChildren: result.names.filter(n => children.has(n) && !roots.includes(n)) };
    }
    for (const c of more) { seeds.push(c); children.add(c); }
  }
}

function parentClosure(roots: string[], available: Set<string>, dependencies: TableDependencyIndex, keptRoots: ReadonlySet<string> = new Set()) {
  // Kept tables count only when chosen themselves; then they still go before their children.
  const allowed = keptRoots.size ? new Set([...available, ...keptRoots]) : available;
  const selected = new Set(roots.filter(n => allowed.has(n)));
  const dependenciesByTable = dependencies;
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
  return { names: order, added: order.filter(n => !roots.includes(n)), addedChildren: [] as string[], cycles: [...cycles], warnings: [...warnings], overLimit: selected.size > TABLE_COPY_MAX_TABLES };
}
