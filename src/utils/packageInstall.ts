import type { CompareObject, SchemaCompareResult } from "./schemaCompare.ts";

export interface PackageInstallRequest {
  sourceId: string;
  sourceSchema: string;
  targetSchema: string;
  packages: string[];
  seedTables?: string[];
  rowLimit: number;
}
export interface SeedExportDetails {
  stage: string;
  sourceSchema: string;
  targetSchema: string;
  table: string;
  row?: number;
  code?: string;
  columns: { name: string; type: string; reason: string }[];
  advice: string;
}
export interface PackageInstallPlan extends SchemaCompareResult {
  roots: string[];
  dependencies: { object: CompareObject; requires: CompareObject[] }[];
  suggestions: { table: string; recommended: boolean; reasons: string[]; evidence: string[] }[];
  warnings: string[];
  exports: { table: string; rows: number; script: string; error?: string; details?: SeedExportDetails; warnings?: string[]; elapsedMs?: number; schemaSql?: string[]; preparationSql?: string[]; finalizeSql?: string[] }[];
  script: string;
  commitsSeedData?: boolean;
  identityRecoveryScript?: string;
}

/** Diagnostic download deliberately excludes generated SQL and source row contents. */
export function packageExportLog(plan: PackageInstallPlan) {
  return { comparedAt: plan.comparedAt, source: {name: plan.sourceName, schema: plan.sourceSchema}, target: {name: plan.targetName, schema: plan.targetSchema}, packages: plan.roots, warnings: plan.warnings, commitsSeedData: plan.commitsSeedData, exports: plan.exports.map(({script: _script, schemaSql: _schema, preparationSql: _preparation, finalizeSql: _finalize, ...entry}) => entry) };
}
