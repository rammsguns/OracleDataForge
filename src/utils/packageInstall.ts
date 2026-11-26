import type { CompareObject, SchemaCompareResult, DeploymentTablespaces } from "./schemaCompare.ts";

export interface PackageInstallRequest extends DeploymentTablespaces {
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
export type InstallLogSeverity = 'info' | 'warning' | 'error';
export interface InstallLogEntry {
  severity: InstallLogSeverity;
  message: string;
  table?: string;
  object?: CompareObject;
  details?: SeedExportDetails;
  elapsedMs?: number;
}
export interface PackageInstallPlan extends SchemaCompareResult {
  roots: string[];
  dependencies: { object: CompareObject; requires: CompareObject[] }[];
  suggestions: { table: string; recommended: boolean; reasons: string[]; evidence: string[] }[];
  warnings: string[];
  exports: { table: string; rows: number; script: string; error?: string; details?: SeedExportDetails; infos?: string[]; warnings?: string[]; elapsedMs?: number; schemaSql?: string[]; preparationSql?: string[]; finalizeSql?: string[] }[];
  script: string;
  commitsSeedData?: boolean;
  identityRecoveryScript?: string;
}

export function seedExportMessages(entry: PackageInstallPlan['exports'][number]): InstallLogEntry[] {
  const messages: InstallLogEntry[] = [];
  const add = (severity: InstallLogSeverity, message: string) => messages.push({severity, message, table: entry.table});
  if (entry.error) messages.push({severity: 'error', message: entry.error, table: entry.table, details: entry.details, elapsedMs: entry.elapsedMs});
  else messages.push({severity: 'info', message: entry.rows + ' source rows scripted. SQL has not been executed.', table: entry.table, elapsedMs: entry.elapsedMs});
  for (const message of entry.infos ?? []) add('info', message);
  for (const message of entry.warnings ?? []) {
    // Older servers combined successful identity handling and operational cautions in one warning.
    const marker = '. The generated script explicitly commits seed data';
    const split = message.indexOf(marker);
    if (!entry.infos && message.startsWith('Identity IDs preserved for ') && split > 0) {
      add('info', message.slice(0, split + 1));
      add('warning', message.slice(split + 2));
    } else if (!entry.infos && message.startsWith('Virtual columns omitted; Oracle recomputes: ')) add('info', message);
    else add('warning', message);
  }
  return messages;
}

/** Use explicit export/error fields; unclassified prerequisite notices remain warnings. */
export function packageInstallMessages(plan: Pick<PackageInstallPlan, 'warnings' | 'objects' | 'exports'>): InstallLogEntry[] {
  const messages: InstallLogEntry[] = [], aggregated = new Set<string>();
  for (const o of plan.objects ?? []) if (o.status === 'error' || o.warning) {
    const message = o.warning ?? 'Metadata unavailable';
    aggregated.add(`${o.type} ${o.name}: ${message}`);
    messages.push({severity: o.status === 'error' ? 'error' : 'warning', object: {name: o.name, type: o.type}, message});
  }
  for (const e of plan.exports) {
    if (e.error) aggregated.add('Seed export ' + e.table + ': ' + e.error + (e.details ? ' [' + e.details.stage + '] ' + e.details.advice : ''));
    for (const w of e.warnings ?? []) aggregated.add(e.table + ': ' + w);
    messages.push(...seedExportMessages(e));
  }
  return [...plan.warnings.filter(w => !aggregated.has(w)).map(message => ({severity: 'warning' as const, message})), ...messages];
}

export function installLogSummary(messages: InstallLogEntry[]) {
  const counts = {info: 0, warning: 0, error: 0};
  for (const entry of messages) counts[entry.severity]++;
  return {...counts, status: counts.error ? 'blocked' : counts.warning ? 'review' : 'ready'};
}

/** Diagnostic download deliberately excludes generated SQL and source row contents. */
export function packageExportLog(plan: PackageInstallPlan) {
  const messages = packageInstallMessages(plan);
  return {
    comparedAt: plan.comparedAt,
    source: {name: plan.sourceName, schema: plan.sourceSchema}, target: {name: plan.targetName, schema: plan.targetSchema},
    packages: plan.roots, tablespaces: {table: plan.tableTablespace, index: plan.indexTablespace},
    summary: installLogSummary(messages), messages, warnings: plan.warnings, commitsSeedData: plan.commitsSeedData,
    exports: plan.exports.map(e => {
      const severity: InstallLogSeverity = e.error ? 'error' : seedExportMessages(e).some(m => m.severity === 'warning') ? 'warning' : 'info';
      const {script: _script, schemaSql: _schema, preparationSql: _preparation, finalizeSql: _finalize, ...entry} = e;
      return {...entry, severity};
    }),
  };
}
