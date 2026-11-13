/**
 * Structural comparison of the same table across two live connections (environments).
 * Pure client-side: it diffs two `TableMeta` snapshots and generates the one-way sync
 * script that makes the TARGET match the SOURCE. Columns are matched by name; indexes
 * and constraints by their semantic signature (columns/definition), because their names
 * are environment-specific (SYS_C00…) and would otherwise churn.
 */
import type { TableColumnMeta, TableConstraintMeta, TableIndexMeta, TableMeta } from "./api";
import { addConstraintDdl, createTableDdl, dropConstraintDdl, dropIndexDdl, metaToModel } from "./tableDdl";

export type DiffStatus = "same" | "changed" | "sourceOnly" | "targetOnly";

export interface ColumnDiff {
  name: string;
  status: DiffStatus;
  source: TableColumnMeta | null;
  target: TableColumnMeta | null;
  changes: string[];
}

export interface ObjectDiff<T> {
  key: string;
  label: string;
  status: DiffStatus;
  source: T | null;
  target: T | null;
  /** same signature but a different name in each environment — informational, no DDL */
  renamed?: { source: string; target: string };
}

export interface TableComparison {
  sourceExists: boolean;
  targetExists: boolean;
  columns: ColumnDiff[];
  indexes: ObjectDiff<TableIndexMeta>[];
  constraints: ObjectDiff<TableConstraintMeta>[];
  tableCommentDiff: { source: string; target: string } | null;
  identical: boolean;
  counts: { same: number; changed: number; sourceOnly: number; targetOnly: number };
  /** statements that bring the TARGET in line with the SOURCE */
  sync: string[];
  notes: string[];
}

const norm = (s: string | null | undefined) => (s ?? "").trim();
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

const RESERVED = new Set(
  ("ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT COMPRESS CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS FILE FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS MLSLABEL MODE MODIFY NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER PCTFREE PRIOR PUBLIC RAW RENAME RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW WHENEVER WHERE WITH").split(" ")
);

/**
 * Dictionary names are exact, so anything Oracle would not read back the same way bare —
 * mixed case, `BSEG-BUKRS`, a reserved word — must be quoted in generated DDL.
 */
export const q = (name: string): string =>
  /^[A-Z][A-Z0-9_$#]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, "")}"`;

/** LOB segments and other indexes Oracle creates and owns itself — never ours to create or drop. */
const isSystemIndex = (i: TableIndexMeta) => i.type === "LOB" || i.columns.length === 0 || /^SYS_IL/.test(i.name);
/** A hidden-column index entry whose expression we could not read — nothing to recreate it from. */
const unreadableIndex = (i: TableIndexMeta) => i.columns.some((c, n) => /^SYS_NC\d+\$/.test(c) && !i.expressions?.[n]);
/** Indexes the sync script can faithfully recreate from their column list. */
const portableIndex = (i: TableIndexMeta) => !i.constraintBacked && !isSystemIndex(i) && !unreadableIndex(i);
/** A `"COL" IS NOT NULL` check is the column's nullability, already carried by the column definition. */
const realConstraint = (c: TableConstraintMeta) => !(c.type === "C" && /^"[^"]+"\s+IS\s+NOT\s+NULL$/i.test(norm(c.searchCondition)));
/** Index column, keeping a trailing DESC outside the quoted name. */
/** Index column list as DDL: the expression where there is one, else the quoted name; DESC kept outside. */
const indexCols = (ix: TableIndexMeta) =>
  ix.columns.map((c, n) => {
    const desc = / DESC$/.test(c) ? " DESC" : "";
    return (ix.expressions?.[n] ?? q(desc ? c.slice(0, -5) : c)) + desc;
  });
const indexDdl = (table: string, name: string, ix: TableIndexMeta) =>
  `CREATE ${ix.unique ? "UNIQUE " : /BITMAP/i.test(ix.type) ? "BITMAP " : ""}INDEX ${q(name)} ON ${table} (${indexCols(ix).join(", ")});`;

/** `NAME TYPE [DEFAULT x] [NOT NULL]` from live metadata. */
const colDef = (c: TableColumnMeta): string => {
  let d = `${q(c.name)} ${c.dataType}`;
  if (c.identity) d += ` GENERATED ${c.identity} AS IDENTITY`;
  else if (norm(c.dataDefault)) d += ` DEFAULT ${norm(c.dataDefault)}`;
  if (!c.nullable && !c.identity) d += " NOT NULL";
  return d;
};

/**
 * Object names are schema-unique in Oracle, so reusing the source's index/constraint names
 * collides when the target table lives in the same schema. When a name follows the usual
 * `<TABLE>_<suffix>` convention, swap the source table prefix for the target's; otherwise
 * keep it as-is (the cross-environment case, where both tables share a name, is untouched).
 */
export function retargetName(name: string, srcTable: string, tgtTable: string): string {
  if (!name || srcTable.toUpperCase() === tgtTable.toUpperCase()) return name;
  const prefix = `${srcTable.toUpperCase()}_`;
  return name.toUpperCase().startsWith(prefix) ? `${tgtTable.toUpperCase()}_${name.slice(prefix.length)}` : name;
}

/** Semantic identity of an index — column list + uniqueness (names differ per environment). */
const indexSig = (ix: TableIndexMeta) => `${ix.unique ? "U" : "N"}:${indexCols(ix).join(",").replace(/\s+/g, "")}`;

/** Semantic identity of a constraint — its definition, not its (often generated) name. */
const constraintSig = (c: TableConstraintMeta) => {
  switch (c.type) {
    case "R":
      return `R:${c.columns.join(",")}->${c.refTable ?? ""}(${c.refColumns.join(",")})`;
    case "C":
      return `C:${norm(c.searchCondition).replace(/\s+/g, " ").toUpperCase()}`;
    default:
      return `${c.type}:${c.columns.join(",")}`;
  }
};

export function compareTables(source: TableMeta, target: TableMeta): TableComparison {
  const notes: string[] = [];
  const sync: string[] = [];
  const t = q(target.name);

  // ---- columns (matched by name) ----
  const srcCols = new Map(source.columns.map((c) => [c.name.toUpperCase(), c]));
  const tgtCols = new Map(target.columns.map((c) => [c.name.toUpperCase(), c]));
  const colNames = Array.from(new Set([...srcCols.keys(), ...tgtCols.keys()]));
  const columns: ColumnDiff[] = colNames.map((name) => {
    const s = srcCols.get(name) ?? null;
    const g = tgtCols.get(name) ?? null;
    if (s && !g) return { name, status: "sourceOnly", source: s, target: null, changes: [] };
    if (!s && g) return { name, status: "targetOnly", source: null, target: g, changes: [] };
    const changes: string[] = [];
    if (s!.dataType !== g!.dataType) changes.push(`type ${g!.dataType} → ${s!.dataType}`);
    if (s!.nullable !== g!.nullable) changes.push(g!.nullable ? "NULL → NOT NULL" : "NOT NULL → NULL");
    if ((s!.identity ?? null) !== (g!.identity ?? null)) changes.push(`identity ${g!.identity ?? "none"} → ${s!.identity ?? "none"}`);
    if (norm(s!.dataDefault) !== norm(g!.dataDefault)) changes.push(`default ${norm(g!.dataDefault) || "—"} → ${norm(s!.dataDefault) || "—"}`);
    if (norm(s!.comment) !== norm(g!.comment)) changes.push("comment differs");
    return { name, status: changes.length ? "changed" : "same", source: s, target: g, changes };
  });
  // keep source order first, then target-only columns
  columns.sort((a, b) => (a.source?.position ?? 9e6) - (b.source?.position ?? 9e6) || a.name.localeCompare(b.name));

  // ---- indexes (matched by signature; constraint-backed ones belong to their constraint) ----
  // A PK/UNIQUE constraint builds its own index on the target, so a separate source index over
  // the same columns would only collide with it (ORA-00955 / ORA-01408).
  const keyCols = new Set(source.constraints.filter((c) => c.type === "P" || c.type === "U").map((c) => c.columns.join(",")));
  // Likewise when the target already covers it with a constraint's index (same definition or name):
  // the constraint-backed index is hidden from the diff, but creating a twin would still fail.
  const tgtKeyIx = target.indexes.filter((i) => i.constraintBacked);
  const tgtKeySigs = new Set(tgtKeyIx.map((i) => indexSig(i)));
  const tgtKeyNames = new Set(tgtKeyIx.map((i) => i.name));
  const srcIx = source.indexes.filter((i) =>
    portableIndex(i) && !keyCols.has(i.columns.join(",")) && !tgtKeySigs.has(indexSig(i)) && !tgtKeyNames.has(retargetName(i.name, source.name, target.name)));
  const tgtIx = target.indexes.filter(portableIndex);
  for (const i of source.indexes) {
    if (!i.constraintBacked && !isSystemIndex(i) && unreadableIndex(i)) notes.push(`Index ${i.name} on ${source.name} is function-based and its expression could not be read, so it is not synced — create it by hand.`);
  }
  const indexes = diffBySignature(srcIx, tgtIx, indexSig, (i) => i.name, (i) => `${i.name} (${indexCols(i).join(", ")})${i.unique ? " UNIQUE" : ""}`);

  // ---- constraints (matched by signature) ----
  const constraints = diffBySignature(
    source.constraints.filter(realConstraint),
    target.constraints.filter(realConstraint),
    constraintSig,
    (c) => c.name,
    (c) => `${c.typeLabel} ${c.name}${c.columns.length ? ` (${c.columns.join(", ")})` : ""}`
  );

  const tableCommentDiff =
    norm(source.tableComment) !== norm(target.tableComment) ? { source: norm(source.tableComment), target: norm(target.tableComment) } : null;

  // ---- sync script (target ← source) ----
  if (!target.exists) {
    const model = metaToModel(source);
    model.table = t;
    for (const c of model.columns) c.name = q(c.name);
    sync.push(createTableDdl(model));
    for (const c of source.columns) if (norm(c.comment)) sync.push(`COMMENT ON COLUMN ${t}.${q(c.name)} IS ${quote(norm(c.comment))};`);
    if (norm(source.tableComment)) sync.push(`COMMENT ON TABLE ${t} IS ${quote(norm(source.tableComment))};`);
    for (const c of source.constraints.filter((x) => x.type !== "P" && realConstraint(x))) sync.push(addConstraintFor(target.name, c, source.name));
    for (const ix of srcIx) sync.push(indexDdl(t, retargetName(ix.name, source.name, target.name), ix));
    notes.push(`${t} does not exist in the target — the sync script creates it from scratch.`);
  } else {
    // drop target-only constraints and indexes first so column drops can succeed
    for (const d of constraints) if (d.status === "targetOnly") sync.push(dropConstraintDdl(t, q(d.target!.name)));
    for (const d of indexes) if (d.status === "targetOnly") sync.push(dropIndexDdl(q(d.target!.name)));

    const dropped = columns.filter((c) => c.status === "targetOnly");
    if (dropped.length) {
      sync.push(`ALTER TABLE ${t} DROP (${dropped.map((c) => q(c.name)).join(", ")});`);
      notes.push(`Dropping ${dropped.map((c) => c.name).join(", ")} from the target permanently deletes that data.`);
    }
    const added = columns.filter((c) => c.status === "sourceOnly");
    if (added.length) {
      sync.push(`ALTER TABLE ${t} ADD (${added.map((c) => colDef(c.source!)).join(", ")});`);
      for (const c of added) if (!c.source!.nullable && !norm(c.source!.dataDefault)) {
        notes.push(`Adding NOT NULL column ${c.name} without a default fails if the target table already has rows.`);
      }
    }
    for (const c of columns.filter((x) => x.status === "changed")) {
      const s = c.source!;
      const g = c.target!;
      const clauses: string[] = [];
      if (s.dataType !== g.dataType) clauses.push(s.dataType);
      if (norm(s.dataDefault) !== norm(g.dataDefault)) clauses.push(`DEFAULT ${norm(s.dataDefault) || "NULL"}`);
      if (s.nullable !== g.nullable) clauses.push(s.nullable ? "NULL" : "NOT NULL");
      if (clauses.length) sync.push(`ALTER TABLE ${t} MODIFY (${q(c.name)} ${clauses.join(" ")});`);
      const sId = s.identity ?? null;
      const gId = g.identity ?? null;
      if (sId !== gId) {
        if (sId && gId) sync.push(`ALTER TABLE ${t} MODIFY (${q(c.name)} GENERATED ${sId} AS IDENTITY);`);
        else if (gId) sync.push(`ALTER TABLE ${t} MODIFY (${q(c.name)} DROP IDENTITY);`);
        else notes.push(`${t}.${c.name} is an identity column in the source; Oracle cannot turn an existing column into one, so it is not synced.`);
      }
      if (norm(s.comment) !== norm(g.comment)) sync.push(`COMMENT ON COLUMN ${t}.${q(c.name)} IS ${quote(norm(s.comment))};`);
    }
    if (tableCommentDiff) sync.push(`COMMENT ON TABLE ${t} IS ${quote(tableCommentDiff.source)};`);

    for (const d of constraints) if (d.status === "sourceOnly") sync.push(addConstraintFor(target.name, d.source!, source.name));
    for (const d of indexes) if (d.status === "sourceOnly") {
      const ix = d.source!;
      sync.push(indexDdl(t, retargetName(ix.name, source.name, target.name), ix));
    }
  }

  for (const d of [...indexes, ...constraints]) {
    if (d.renamed) notes.push(`${d.label} matches the target's ${d.renamed.target} — same definition, different name (not synced).`);
  }

  const all = [...columns.map((c) => c.status), ...indexes.map((i) => i.status), ...constraints.map((c) => c.status)];
  const counts = {
    same: all.filter((x) => x === "same").length,
    changed: all.filter((x) => x === "changed").length,
    sourceOnly: all.filter((x) => x === "sourceOnly").length,
    targetOnly: all.filter((x) => x === "targetOnly").length,
  };

  return {
    sourceExists: source.exists,
    targetExists: target.exists,
    columns,
    indexes,
    constraints,
    tableCommentDiff,
    identical: counts.changed === 0 && counts.sourceOnly === 0 && counts.targetOnly === 0 && !tableCommentDiff,
    counts,
    sync,
    notes,
  };
}

/** ALTER TABLE … ADD CONSTRAINT for a constraint read from live metadata. */
function addConstraintFor(table: string, c: TableConstraintMeta, srcTable: string): string {
  return addConstraintDdl(q(table), {
    // a system-generated name (SYS_C0012345) belongs to the source database — let the target pick its own
    name: /^SYS_C\d+$/.test(c.name) ? "" : q(retargetName(c.name, srcTable, table)),
    kind: c.type,
    columns: c.columns.map(q),
    refTable: c.refTable ? q(c.refTable) : "",
    refColumns: c.refColumns.map(q),
    checkExpr: norm(c.searchCondition),
  });
}

/** Pair two object lists by semantic signature; equal signatures with different names are flagged as renames. */
function diffBySignature<T>(
  src: T[],
  tgt: T[],
  sig: (x: T) => string,
  nameOf: (x: T) => string,
  labelOf: (x: T) => string
): ObjectDiff<T>[] {
  const tgtBySig = new Map<string, T>();
  for (const x of tgt) tgtBySig.set(sig(x), x);
  const out: ObjectDiff<T>[] = [];
  const matched = new Set<string>();

  for (const s of src) {
    const k = sig(s);
    const g = tgtBySig.get(k);
    if (g) {
      matched.add(k);
      const renamed = nameOf(s) !== nameOf(g) ? { source: nameOf(s), target: nameOf(g) } : undefined;
      out.push({ key: k, label: labelOf(s), status: "same", source: s, target: g, renamed });
    } else {
      out.push({ key: k, label: labelOf(s), status: "sourceOnly", source: s, target: null });
    }
  }
  for (const g of tgt) {
    const k = sig(g);
    if (!matched.has(k)) out.push({ key: k, label: labelOf(g), status: "targetOnly", source: null, target: g });
  }
  return out;
}
