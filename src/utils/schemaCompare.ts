export interface DeploymentTablespaces { tableTablespace?: string; indexTablespace?: string }
export interface CompareObject { name: string; type: string }
export interface CompareCatalog { schema: string; objects: CompareObject[]; types: string[] }
export interface SchemaCompareRequest extends DeploymentTablespaces {
  sourceId: string;
  sourceSchema: string;
  targetSchema: string;
  objects: CompareObject[];
  compareData: boolean;
  rowLimit: number;
  includeStorage: boolean;
  includePackageDependencies?: boolean;
}
export interface DataDifference {
  status: "same" | "different" | "limited" | "skipped" | "error";
  message: string;
  inserted: number;
  updated: number;
  deleted: number;
  samples: { key: string; source: Record<string, string | null> | null; target: Record<string, string | null> | null }[];
  script: string;
}
export interface SchemaDifference extends CompareObject {
  key: string;
  status: "same" | "changed" | "sourceOnly" | "targetOnly" | "error";
  sourceDdl: string;
  targetDdl: string;
  script: string;
  warning?: string;
  definitionCompared?: boolean;
  data?: DataDifference;
}
export interface SchemaCompareResult extends DeploymentTablespaces {
  sourceSchema: string;
  targetSchema: string;
  sourceName: string;
  targetName: string;
  comparedAt: string;
  objects: SchemaDifference[];
  warnings?: string[];
}
const sharedObjectNamespace = new Set(['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SEQUENCE', 'SYNONYM', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'TYPE']);
const namespaceType = (type: string) => type.replace(/^(PACKAGE|TYPE) BODY$/, '$1');
export function targetNamespaceCollision(object: CompareObject, target: CompareCatalog): CompareObject | undefined {
  const type = namespaceType(object.type);
  if (!sharedObjectNamespace.has(type)) return undefined;
  return target.objects.find(o => o.name === object.name && sharedObjectNamespace.has(namespaceType(o.type)) && namespaceType(o.type) !== type);
}

export const compareObjectKey = (o: CompareObject) => JSON.stringify([o.type, o.name]);
export const quoteCompareIdentifier = (s: string) => `"${s.replace(/"/g, '""')}"`;
const comment = (s: string) => s.replace(/[\r\n\u2028\u2029]/g, " ");

/** Script selection is tied to the immutable comparison result, never the current pickers. */
export function deploymentScript(result: SchemaCompareResult, selected: Set<string>, includeDrops: boolean, includeData: boolean): string {
  const objects = result.objects.filter(o => selected.has(o.key));
  const lines = [
    "-- Oracle DataForge · Schema Compare",
    `-- ${comment(result.sourceName)} / ${comment(result.sourceSchema)} -> ${comment(result.targetName)} / ${comment(result.targetSchema)}`,
    `-- Compared: ${result.comparedAt}`,
    "-- Review all statements and dependencies before deployment. DDL commits implicitly.",
    "-- Metadata differences may require manual steps; search for REVIEW below.",
    ...(result.tableTablespace || result.indexTablespace ? [`-- Creation tablespaces: table/MV = ${comment(result.tableTablespace || "default/source")}; indexes = ${comment(result.indexTablespace || "default/source")}. Existing objects are not relocated.`] : []),
    ...(result.warnings ?? []).map(w => `-- REVIEW: ${comment(w)}`),
    "SET DEFINE OFF", "SET SQLBLANKLINES ON", "WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK",
    `ALTER SESSION SET CURRENT_SCHEMA = ${quoteCompareIdentifier(result.targetSchema)};`, "",
  ];
  for (const o of objects.filter(o => o.status !== "targetOnly")) {
    lines.push(`-- ${comment(o.type)} ${comment(o.name)} · ${o.status}`);
    if (o.warning) lines.push(`-- REVIEW: ${comment(o.warning)}`);
    if (o.script) lines.push(o.script);
  }
  for (const o of [...objects].reverse().filter(o => o.status === "targetOnly")) {
    lines.push(`-- ${includeDrops ? "DESTRUCTIVE" : "Omitted target-only object"}: ${comment(o.type)} ${comment(o.name)}`);
    if (includeDrops && o.script) lines.push(o.script);
    if (o.warning) lines.push(`-- REVIEW: ${comment(o.warning)}`);
  }
  if (includeData) {
    lines.push("", "-- Data synchronization (review triggers, foreign keys and concurrent changes).");
    for (const o of objects) if (o.data) {
      lines.push(`-- ${comment(o.name)}: ${comment(o.data.message)}`);
      if (o.data.script) lines.push(o.data.script);
    }
    lines.push("-- Data changes require an explicit COMMIT after review.");
  }
  return lines.join("\n\n") + "\n";
}
