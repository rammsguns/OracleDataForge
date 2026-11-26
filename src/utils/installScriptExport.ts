import { deploymentScript, type SchemaCompareResult, type SchemaDifference } from './schemaCompare.ts';
import { packageExportLog, packageInstallMessages, type PackageInstallPlan } from './packageInstall.ts';
import { applyCreationTablespaces } from './deploymentTablespaces.ts';

export type InstallScriptOutput = 'single' | 'by-type';
export type InsertScriptOutput = 'single' | 'per-table';
export interface SqlExportFile { name: string; content: string }
const comment = (s: string) => s.replace(/[\r\n\u2028\u2029]/g, ' ');
const typeNames: Record<string, string> = {
  TABLE: 'tables', VIEW: 'views', SEQUENCE: 'sequences', INDEX: 'indexes',
  'MATERIALIZED VIEW': 'materialized_views', 'MATERIALIZED VIEW LOG': 'materialized_view_logs',
  PACKAGE: 'packages', 'PACKAGE BODY': 'package_bodies', PROCEDURE: 'procedures', FUNCTION: 'functions',
  TYPE: 'types', 'TYPE BODY': 'type_bodies', TRIGGER: 'triggers', SYNONYM: 'synonyms',
  CLUSTER: 'clusters', DIMENSION: 'dimensions', 'JAVA SOURCE': 'java_sources', 'JAVA CLASS': 'java_classes',
};
function typeFile(type: string): string {
  return 'by-type/' + (typeNames[type] ?? 'object_type_' + Array.from(type).map(c => c.codePointAt(0)!.toString(16)).join('_')) + '.sql';
}
const preamble = (result: SchemaCompareResult) => deploymentScript({...result, objects: []}, new Set(), false, false);
const incompleteGuard = "-- INCOMPLETE DEPLOYMENT: resolve metadata and export errors before running any script.\nBEGIN RAISE_APPLICATION_ERROR(-20002, 'Deployment plan incomplete; resolve errors and regenerate.'); END;\n/\n";
const label = (o: SchemaDifference) => '-- ' + comment(o.type) + ' ' + comment(o.name) + ' · ' + o.status;
const fileBody = (header: string, chunks: string[]) => header + '\n' + chunks.join('\n\n') + '\n';

function readme(result: SchemaCompareResult, files: SqlExportFile[], separateInserts = false): SqlExportFile {
  return {name: 'README.txt', content: [
    'Oracle DataForge deployment scripts',
    comment(result.sourceName) + ' / ' + comment(result.sourceSchema) + ' -> ' + comment(result.targetName) + ' / ' + comment(result.targetSchema),
    '',
    separateInserts ? 'For object installation, review and run install.sql in SQL*Plus or SQLcl: @install.sql' : 'For the full deployment, review and run install.sql in SQL*Plus or SQLcl: @install.sql',
    separateInserts ? 'install.sql contains object DDL and validation in deployment order. INSERTs are exported separately.' : 'install.sql contains the complete original SQL in its deployment order. It does not run the by-type files.',
    'The by-type scripts contain readable SQL for separate review or selective execution after their prerequisites exist.',
    'Do not run both the full install and the separate scripts for the same deployment.',
    'Key indexes embedded in CREATE TABLE remain in tables.sql; indexes.sql contains standalone index objects.',
    'Grouping objects by type cannot always preserve cross-type dependencies. Use install.sql for the full installation.',
    separateInserts ? 'Complete object DDL and validation, then run the separate inserts.sql or INSERT archive runner.' : 'When running separate scripts: complete object DDL, run validation.sql if present, and then run data.sql last.',
    'INSERT exports preserve identity preparation, COMMIT, sequence synchronization and restoration order.',
    'Review COMMIT statements and implicit DDL commits before execution. No scripts have been executed by DataForge.',
    'identity_recovery.sql is for an interrupted identity load only; review it before running.',
    '', 'Files:', ...files.map(f => '  ' + f.name), '',
  ].join('\n')};
}

/** Per-type files are for selective use; the master preserves every original dependency transition. */
export function schemaDeploymentFiles(result: SchemaCompareResult, selected: Set<string>, includeDrops: boolean, includeData: boolean): SqlExportFile[] {
  const objects = result.objects.filter(o => selected.has(o.key));
  const header = preamble(result);
  const files: SqlExportFile[] = [{name: 'install.sql', content: deploymentScript(result, selected, includeDrops, includeData)}];
  const types = [...new Set(objects.filter(o => !!o.script && o.status !== 'error' && (o.status !== 'targetOnly' || includeDrops)).map(o => o.type))];
  for (const type of types) {
    const scoped = objects.filter(o => o.type === type && o.status !== 'error');
    files.push({name: typeFile(type), content: deploymentScript({...result, objects: scoped}, new Set(scoped.map(o => o.key)), includeDrops, false)});
  }
  if (includeData) {
    const data = objects.filter(o => !!o.data);
    if (data.length) files.push({name: 'data.sql', content: fileBody(header, [
      '-- Run after all object definitions and review foreign keys and triggers.',
      ...data.flatMap(o => ['-- ' + comment(o.name) + ': ' + comment(o.data!.message), o.data!.script]),
      '-- Data changes require an explicit COMMIT after review.',
    ])});
  }
  files.push(readme(result, files));
  return files;
}

function validationSql(objects: SchemaDifference[], schema: string): string {
  const compilable = objects.filter(o => /^(PACKAGE|PACKAGE BODY|TYPE|TYPE BODY|PROCEDURE|FUNCTION|VIEW|TRIGGER)$/.test(o.type) && o.script);
  if (!compilable.length) return '';
  const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  const matches = compilable.map(o => '(object_name = ' + literal(o.name) + ' AND object_type = ' + literal(o.type) + ')').join(' OR ');
  return `-- Stop before data if an installed object is invalid. Review ALL_ERRORS.\nDECLARE invalid_count PLS_INTEGER;\nBEGIN\n  SELECT COUNT(*) INTO invalid_count FROM all_objects WHERE owner = ${literal(schema)} AND status <> 'VALID' AND (${matches});\n  IF invalid_count > 0 THEN RAISE_APPLICATION_ERROR(-20001, 'Install has invalid objects; review ALL_ERRORS before loading seed data.'); END IF;\nEND;\n/`;
}

function packageContext(plan: PackageInstallPlan) {
  const blocked = plan.exports.some(e => !!e.error) || plan.objects.some(o => o.status === 'error');
  const notices = packageInstallMessages(plan).map(e => '-- [' + e.severity.toUpperCase() + '] ' + comment((e.table ? e.table + ': ' : e.object ? e.object.type + ' ' + e.object.name + ': ' : '') + e.message)).join('\n');
  const header = preamble({...plan, warnings: []}) + notices + '\n' + (blocked ? '\n' + incompleteGuard : '');
  const roots = new Set(plan.roots);
  const install = plan.objects.filter(o => !!o.script && (o.status === 'sourceOnly' || roots.has(o.name) && /^(PACKAGE|PACKAGE BODY)$/.test(o.type) && o.status === 'changed'))
    .map(o => ({...o, script: applyCreationTablespaces(o.script, o.type, plan)}));
  return {header, install, validation: validationSql(install, plan.targetSchema)};
}

/** Rebuild from structured objects, never split SQL text (which may contain LOBs or PL/SQL). */
export function packageObjectScript(plan: PackageInstallPlan): string {
  const {header, install, validation} = packageContext(plan);
  return fileBody(header, [
    '-- Object DDL only. Run the separate INSERT export after this script succeeds.',
    '-- Seed-related notices above apply to that separate export.',
    ...plan.exports.flatMap(e => e.schemaSql ?? []),
    ...install.flatMap(o => [label(o), ...(o.warning ? ['-- [WARNING] ' + comment(o.warning)] : []), o.script]),
    ...(validation ? [validation] : []),
  ]);
}

export function packageDeploymentFiles(plan: PackageInstallPlan): SqlExportFile[] {
  const {header, install, validation} = packageContext(plan);
  const files: SqlExportFile[] = [{name: 'install.sql', content: packageObjectScript(plan)}];
  const groups = new Map<string, string[]>();
  const widening = plan.exports.flatMap(e => e.schemaSql ?? []);
  if (widening.length) groups.set('TABLE', ['-- Widen existing target columns before creating dependent objects.', ...widening]);
  for (const o of install) {
    const chunks = groups.get(o.type) ?? [];
    chunks.push(label(o), ...(o.warning ? ['-- REVIEW: ' + comment(o.warning)] : []), o.script);
    groups.set(o.type, chunks);
  }
  for (const [type, chunks] of groups) files.push({name: typeFile(type), content: fileBody(header, chunks)});
  if (validation) files.push({name: 'validation.sql', content: fileBody(header, [validation])});
  files.push({name: 'export-log.json', content: JSON.stringify(packageExportLog(plan), null, 2) + '\n'});
  files.push(readme(plan, files, true));
  return files;
}

function insertScript(plan: PackageInstallPlan, entries: PackageInstallPlan['exports'], commitEachTable: boolean): string {
  const {header, validation} = packageContext(plan);
  const preparation = entries.flatMap(e => e.preparationSql ?? []), finalization = entries.flatMap(e => e.finalizeSql ?? []);
  return fileBody(header, [
    '-- Run only after object installation, column alterations and validation have completed successfully.',
    '-- Review required parent-table data, triggers and concurrent writes before execution.',
    ...(validation ? [validation] : []),
    ...(preparation.length ? ['-- Identity preparation DDL before seed INSERTs.', ...preparation] : []),
    ...entries.flatMap(e => ['-- Seed ' + comment(e.table) + ' (' + e.rows + ' source rows)' + (e.error ? ' [ERROR] ' + comment(e.error) : ''), e.script]),
    ...(finalization.length || commitEachTable ? ['-- Explicit COMMIT before any identity synchronization and mode restoration.', 'COMMIT;', ...finalization] : ['-- Data changes require an explicit COMMIT after review.']),
  ]);
}

export function packageInsertFiles(plan: PackageInstallPlan, output: InsertScriptOutput): SqlExportFile[] {
  if (!plan.exports.length) return [];
  if (output === 'single') return [{name: 'inserts.sql', content: insertScript(plan, plan.exports, false)}];
  const tables = plan.exports.map((e, i) => ({
    name: 'tables/' + String(i + 1).padStart(4, '0') + '_' + (e.table.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'TABLE') + '.sql',
    content: insertScript(plan, [e], true),
  }));
  const {header} = packageContext(plan);
  const files: SqlExportFile[] = [{name: 'run_inserts.sql', content: fileBody(header, [
    '-- Run after object installation: @run_inserts.sql',
    '-- Each table script explicitly commits its own rows. Earlier tables remain committed if a later file fails.',
    '-- Preserve this planner order for parent/child tables; review any dependency-cycle warnings.',
    ...tables.map(f => '@@' + f.name),
  ])}, ...tables];
  if (plan.identityRecoveryScript) files.push({name: 'identity_recovery.sql', content: plan.identityRecoveryScript});
  files.push({name: 'export-log.json', content: JSON.stringify(packageExportLog(plan), null, 2) + '\n'});
  files.push({name: 'README.txt', content: [
    'Oracle DataForge - table INSERT exports',
    'Run the object install script first, including column alterations and validation.',
    'In SQL*Plus or SQLcl run @run_inserts.sql from this extracted directory.',
    'The runner loads table files in planner order. Review required parent data and cycle warnings.',
    'Each table file contains only that table seed export and its identity preparation/finalization.',
    'Each table file explicitly commits its rows. A later failure does not roll back earlier committed tables.',
    'For selective use, load prerequisite table data first. Do not also run the all-tables inserts.sql.',
    'Use identity_recovery.sql only after an interrupted identity load; committed rows are preserved.',
    '', 'Files:', ...files.map(f => '  ' + f.name), '',
  ].join('\n')});
  return files;
}

const crcTable = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

/** Uncompressed ZIP avoids a runtime dependency and works offline in all supported browsers. */
export function createSqlZip(files: SqlExportFile[]): Blob {
  if (files.length > 65535) throw new Error('Too many script files for a ZIP archive.');
  const encoder = new TextEncoder(), parts: BlobPart[] = [], directory: BlobPart[] = [], names = new Set<string>();
  let offset = 0, directorySize = 0;
  for (const file of files) {
    if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+$/i.test(file.name) || file.name.split('/').some(p => p === '.' || p === '..') || names.has(file.name.toLowerCase())) throw new Error('Invalid or duplicate archive filename.');
    names.add(file.name.toLowerCase());
    const name = encoder.encode(file.name), bytes = encoder.encode(file.content), crc = crc32(bytes);
    if (name.length > 65535 || offset + bytes.length + name.length + 30 > 0xffffffff) throw new Error('Script archive exceeds ZIP size limits.');
    const local = new Uint8Array(30), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint16(12, 0x0021, true);
    l.setUint32(14, crc, true); l.setUint32(18, bytes.length, true); l.setUint32(22, bytes.length, true); l.setUint16(26, name.length, true);
    parts.push(local, name, bytes);
    const central = new Uint8Array(46), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 0x0021, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    directory.push(central, name); directorySize += central.length + name.length;
    offset += local.length + name.length + bytes.length;
  }
  if (offset + directorySize + 22 > 0xffffffff) throw new Error('Script archive exceeds ZIP size limits.');
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], {type: 'application/zip'});
}
export function downloadSqlZip(files: SqlExportFile[], filename: string): void {
  const url = URL.createObjectURL(createSqlZip(files));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
