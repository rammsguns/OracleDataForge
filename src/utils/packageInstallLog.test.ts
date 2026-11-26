import assert from 'node:assert/strict';
import test from 'node:test';
import { installLogSummary, packageExportLog, packageInstallMessages, seedExportMessages, type PackageInstallPlan } from './packageInstall.ts';

const legacyIdentity = 'Identity IDs preserved for RECIPIENT_ID. The generated script explicitly commits seed data before synchronizing identity sequences and restoring ALWAYS modes. Run during a maintenance window; use the recovery script if interrupted.';
const basePlan = (): PackageInstallPlan => ({sourceSchema: 'DEV', targetSchema: 'PROD', sourceName: 'Development', targetName: 'Production', comparedAt: 'now', objects: [], roots: ['PKG'], dependencies: [], suggestions: [], warnings: [], exports: [], script: ''});

test('successful identity handling is informational and maintenance/commit requirements are warnings', () => {
  const messages = seedExportMessages({table: 'RECIPIENTS', rows: 2, script: '', infos: ['Identity IDs preserved for RECIPIENT_ID.'], warnings: ['Seed data is explicitly committed; use a maintenance window.']});
  assert.deepEqual(messages.map(m => m.severity), ['info', 'info', 'warning']);
  assert.equal(messages[1].message, 'Identity IDs preserved for RECIPIENT_ID.');
  assert.deepEqual(installLogSummary(messages), {info: 2, warning: 1, error: 0, status: 'review'});
});

test('older combined identity notices are split without hiding the maintenance warning', () => {
  const messages = seedExportMessages({table: 'RECIPIENTS', rows: 1, script: '', warnings: [legacyIdentity, 'Virtual columns omitted; Oracle recomputes: DISPLAY_NAME', 'Unrecognized prerequisite; review manually.']});
  assert.deepEqual(messages.map(m => m.severity), ['info', 'info', 'warning', 'info', 'warning']);
  assert.equal(messages[1].message, 'Identity IDs preserved for RECIPIENT_ID.');
  assert.match(messages[2].message, /^The generated script explicitly commits/);
  assert.match(messages[2].message, /maintenance window/);
});

test('metadata and seed failures are errors and aggregated messages are not double counted', () => {
  const p = basePlan();
  p.objects = [{type: 'VIEW', name: 'V', key: 'V', status: 'error', warning: 'ORA-31603: metadata unavailable', sourceDdl: '', targetDdl: '', script: ''}];
  p.exports = [{table: 'T', rows: 0, script: '', error: 'Unsupported column', details: {table: 'T', sourceSchema: 'DEV', targetSchema: 'PROD', stage: 'describe', code: 'SEED_EXPORT_FAILED', columns: [{name: 'VALUE', type: 'XMLTYPE', reason: 'Unsupported'}], advice: 'Use a dedicated export.'}}];
  p.warnings = ['VIEW V: ORA-31603: metadata unavailable', 'Seed export T: Unsupported column [describe] Use a dedicated export.', 'Review dynamic SQL.'];
  const messages = packageInstallMessages(p);
  assert.deepEqual(installLogSummary(messages), {info: 0, warning: 1, error: 2, status: 'blocked'});
  assert.equal(messages.find(m => m.table === 'T')!.details!.columns[0].type, 'XMLTYPE');
  assert.equal(messages.filter(m => m.message.includes('Unsupported column')).length, 1);
  assert.ok(!messages.some(m => m.message.includes('source rows scripted')));
});

test('download log exposes severity and summary while excluding seed SQL and row values', () => {
  const p = basePlan();
  p.exports = [{table: 'T', rows: 1, script: "INSERT INTO T VALUES ('private row');", schemaSql: ['ALTER TABLE T MODIFY (A VARCHAR2(99));'], preparationSql: ['PREPARATION SQL'], finalizeSql: ['FINALIZATION SQL'], warnings: ['Review triggers.'], infos: ['Identity IDs preserved for ID.']}];
  const log = packageExportLog(p);
  assert.equal(log.summary.error, 0);
  assert.equal(log.summary.warning, 1);
  assert.equal(log.exports[0].severity, 'warning');
  assert.equal(log.messages.find(m => m.message.startsWith('Identity'))!.severity, 'info');
  assert.doesNotMatch(JSON.stringify(log), /private row|INSERT INTO|ALTER TABLE|PREPARATION SQL|FINALIZATION SQL/);
  p.exports.push({table: 'BAD', rows: 0, error: 'ORA-01031: insufficient privileges', script: ''});
  const failed = packageExportLog(p);
  assert.equal(failed.exports[1].severity, 'error');
  assert.equal(failed.summary.status, 'blocked');
});

test('metadata failures without warnings remain errors; empty and informational logs have no errors', () => {
  const p = basePlan();
  assert.deepEqual(installLogSummary(packageInstallMessages(p)), {info: 0, warning: 0, error: 0, status: 'ready'});
  p.objects.push({type: 'TABLE', name: 'T', key: 'T', status: 'error', sourceDdl: '', targetDdl: '', script: ''});
  assert.equal(packageInstallMessages(p)[0].severity, 'error');
  assert.equal(packageInstallMessages(p)[0].message, 'Metadata unavailable');
  p.objects = [];
  p.exports = [{table: 'EMPTY', rows: 0, script: '', infos: ['Virtual columns are recomputed.']}];
  assert.equal(packageExportLog(p).summary.status, 'ready');
  assert.equal(packageExportLog(p).exports[0].severity, 'info');
});
