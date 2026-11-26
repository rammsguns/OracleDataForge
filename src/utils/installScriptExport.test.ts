import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { createSqlZip, packageDeploymentFiles, packageInsertFiles, packageObjectScript, schemaDeploymentFiles, type SqlExportFile } from './installScriptExport.ts';
import { deploymentScript, type SchemaCompareResult, type SchemaDifference } from './schemaCompare.ts';
import type { PackageInstallPlan } from './packageInstall.ts';

function object(type: string, name: string, status: SchemaDifference['status'] = 'sourceOnly'): SchemaDifference {
  return {type, name, key: JSON.stringify([type, name]), status, sourceDdl: '', targetDdl: '', script: `${status === 'targetOnly' ? 'DROP' : 'CREATE'} ${type} "PROD"."${name}";`};
}
function comparison(objects: SchemaDifference[]): SchemaCompareResult {
  return {sourceName: 'Development', targetName: 'Production', sourceSchema: 'DEV', targetSchema: 'PROD', comparedAt: '2026-11-25', objects, tableTablespace: 'DEPLOY_DATA', indexTablespace: 'DEPLOY_IDX'};
}
function plan(objects: SchemaDifference[] = []): PackageInstallPlan {
  return {...comparison(objects), roots: ['PKG'], dependencies: [], suggestions: [], warnings: [], exports: [], script: '-- original combined deployment\n'};
}
const content = (files: SqlExportFile[], name: string) => {
  const file = files.find(f => f.name === name);
  assert.ok(file, name);
  return file.content;
};

test('package downloads enforce selected tablespaces in identity-table, index and materialized-view ZIP entries', async () => {
  const table = object('TABLE', 'MAT_REGLAS_CLASIFICA_CORREOS');
  table.script = `CREATE TABLE "CONTAAPP"."MAT_REGLAS_CLASIFICA_CORREOS"
  ("ID_REGLA" NUMBER GENERATED ALWAYS AS IDENTITY MINVALUE 1 MAXVALUE 9999999999999999999999999999 INCREMENT BY 1 START WITH 1 CACHE 20 NOORDER NOCYCLE NOKEEP NOSCALE NOT NULL ENABLE,
   "PROCESO" VARCHAR2(20), "PATRON" VARCHAR2(1000),
   "CREATED_AT" TIMESTAMP (6) DEFAULT SYSTIMESTAMP,
   PRIMARY KEY ("ID_REGLA") USING INDEX ENABLE
  ) ;`;
  const index = object('INDEX', 'IX_REGLAS');
  index.script = 'CREATE INDEX "CONTAAPP"."IX_REGLAS" ON "CONTAAPP"."MAT_REGLAS_CLASIFICA_CORREOS" ("PROCESO");';
  const mv = object('MATERIALIZED VIEW', 'MV_REGLAS');
  mv.script = 'CREATE MATERIALIZED VIEW "CONTAAPP"."MV_REGLAS" BUILD IMMEDIATE REFRESH COMPLETE ON DEMAND AS SELECT * FROM "CONTAAPP"."MAT_REGLAS_CLASIFICA_CORREOS";';
  const p = {...plan([table, index, mv]), targetSchema: 'CONTAAPP', tableTablespace: '"Deploy Data"', indexTablespace: 'DEPLOY_IDX'};
  const before = JSON.stringify(p.objects);
  const checkTable = (sql: string) => {
    assert.match(sql, /PRIMARY KEY \("ID_REGLA"\) USING INDEX TABLESPACE "DEPLOY_IDX" ENABLE/);
    assert.match(sql, /\) TABLESPACE "Deploy Data" ;/);
    assert.match(sql, /GENERATED ALWAYS AS IDENTITY MINVALUE 1/);
  };
  checkTable(packageObjectScript(p));
  const files = packageDeploymentFiles(p);
  checkTable(content(files, 'by-type/tables.sql'));
  assert.match(content(files, 'by-type/indexes.sql'), /\("PROCESO"\) TABLESPACE "DEPLOY_IDX";/);
  assert.match(content(files, 'by-type/materialized_views.sql'), /MV_REGLAS" TABLESPACE "Deploy Data" BUILD IMMEDIATE USING INDEX TABLESPACE "DEPLOY_IDX" REFRESH/);
  // Inspect actual archived SQL, rather than matching tablespace names in header comments.
  const zip = Buffer.from(await createSqlZip(files).arrayBuffer());
  let offset = 0;
  const unpacked = new Map<string, string>();
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    unpacked.set(zip.toString('utf8', offset + 30, offset + 30 + nameLength), zip.toString('utf8', start, start + size));
    offset = start + size;
  }
  for (const name of ['install.sql', 'by-type/tables.sql']) checkTable(unpacked.get(name)!);
  assert.equal(JSON.stringify(p.objects), before);
  assert.ok(packageObjectScript({...p, tableTablespace: undefined, indexTablespace: undefined}).includes(table.script));
});

test('schema split keeps the exact combined script and partitions selected DDL including materialized views', () => {
  const objects = [object('SEQUENCE', 'SEQ'), object('TABLE', 'T'), object('INDEX', 'IX'), object('FUNCTION', 'F1'), object('VIEW', 'V'), object('FUNCTION', 'F2'), object('MATERIALIZED VIEW', 'MV'), object('TABLE', 'UNSELECTED'), object('VIEW', 'OLD', 'targetOnly')];
  const result = comparison(objects), selected = new Set(objects.filter(o => o.name !== 'UNSELECTED').map(o => o.key));
  const files = schemaDeploymentFiles(result, selected, false, false);
  assert.equal(content(files, 'install.sql'), deploymentScript(result, selected, false, false));
  for (const [type, name] of [['TABLE', 'tables'], ['INDEX', 'indexes'], ['SEQUENCE', 'sequences'], ['VIEW', 'views'], ['MATERIALIZED VIEW', 'materialized_views']]) {
    const sql = content(files, `by-type/${name}.sql`);
    assert.ok(sql.includes(objects.find(o => o.type === type)!.script));
    assert.match(sql, /CURRENT_SCHEMA = "PROD"/);
    assert.match(sql, /DEPLOY_DATA/);
    assert.match(sql, /WHENEVER SQLERROR EXIT/);
  }
  const functions = content(files, 'by-type/functions.sql');
  assert.ok(functions.indexOf('"F1"') < functions.indexOf('"F2"'));
  assert.ok(!functions.includes('CREATE VIEW'));
  assert.ok(files.every(f => !f.content.includes('CREATE TABLE "PROD"."UNSELECTED"')));
  assert.ok(!content(files, 'by-type/views.sql').includes('DROP VIEW'));
  assert.ok(!files.some(f => f.name === 'data.sql'));
  const drops = schemaDeploymentFiles(result, selected, true, false);
  assert.match(content(drops, 'by-type/views.sql'), /DROP VIEW "PROD"\."OLD"/);
});

test('schema data remains opt-in and separate from type DDL', () => {
  const table = object('TABLE', 'T');
  table.data = {status: 'different', message: 'One inserted row', inserted: 1, updated: 0, deleted: 0, samples: [], script: 'INSERT INTO T VALUES (42);'};
  const result = comparison([table]), selected = new Set([table.key]);
  const files = schemaDeploymentFiles(result, selected, false, true);
  assert.match(content(files, 'data.sql'), /INSERT INTO T VALUES \(42\)/);
  assert.match(content(files, 'data.sql'), /explicit COMMIT/);
  assert.ok(!content(files, 'by-type/tables.sql').includes('INSERT INTO'));
  assert.ok(schemaDeploymentFiles(result, selected, false, false).every(f => !f.content.includes('INSERT INTO')));
});

test('package split preserves object order, scripts only installable objects and separates specs from bodies', () => {
  const objects = [object('FUNCTION', 'F1'), object('VIEW', "V'Q"), object('FUNCTION', 'F2'), object('PACKAGE', 'PKG', 'changed'), object('PACKAGE BODY', 'PKG', 'changed'), object('TABLE', 'EXISTING', 'same'), object('VIEW', 'EXISTING_VIEW', 'changed')];
  const p = plan(objects);
  p.script = objects.slice(0, 5).map(o => o.script).join('\n');
  const files = packageDeploymentFiles(p);
  assert.equal(content(files, 'install.sql'), packageObjectScript(p));
  const master = content(files, 'install.sql');
  assert.ok(master.indexOf(objects[0].script) < master.indexOf(objects[1].script));
  assert.ok(master.indexOf(objects[1].script) < master.indexOf(objects[2].script));
  assert.match(content(files, 'by-type/packages.sql'), /CREATE PACKAGE "PROD"\."PKG"/);
  assert.match(content(files, 'by-type/package_bodies.sql'), /CREATE PACKAGE BODY/);
  assert.ok(!files.some(f => f.name === 'by-type/tables.sql'));
  assert.ok(!content(files, 'by-type/views.sql').includes('EXISTING_VIEW'));
  assert.match(content(files, 'validation.sql'), /object_name = 'V''Q'/);
  assert.match(content(files, 'validation.sql'), /status <> 'VALID'/);
  assert.match(content(files, 'README.txt'), /Do not run both/);
});

test('package data retains identity and commit ordering, widening and recovery without exposing SQL in diagnostics', () => {
  const p = plan([object('TABLE', 'T'), object('PACKAGE BODY', 'PKG')]);
  const schema = 'ALTER TABLE T MODIFY (LABEL VARCHAR2(4000));';
  const prepare = 'ALTER TABLE T MODIFY (ID GENERATED BY DEFAULT AS IDENTITY);';
  const seed = "BEGIN\nINSERT INTO T VALUES (1, 'private row');\nEND;\n/";
  const sync = 'ALTER TABLE T MODIFY (ID GENERATED AS IDENTITY (START WITH LIMIT VALUE));';
  const restore = 'ALTER TABLE T MODIFY (ID GENERATED ALWAYS AS IDENTITY);';
  p.exports = [{table: 'T', rows: 1, script: seed, schemaSql: [schema], preparationSql: [prepare], finalizeSql: [sync, restore]}];
  p.commitsSeedData = true;
  p.identityRecoveryScript = 'ROLLBACK;\n' + restore;
  const files = packageDeploymentFiles(p), inserts = packageInsertFiles(p, 'single'), data = content(inserts, 'inserts.sql');
  const ordered = ['SELECT COUNT(*)', prepare, seed, '\nCOMMIT;', sync, restore].map(s => { const i = data.indexOf(s); assert.ok(i >= 0, s); return i; });
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
  const tables = content(files, 'by-type/tables.sql');
  assert.ok(tables.indexOf(schema) < tables.indexOf('CREATE TABLE'));
  assert.ok(!tables.includes(seed));
  assert.ok(!files.some(f => f.name === 'data.sql' || f.name === 'identity_recovery.sql'));
  assert.ok(!content(files, 'install.sql').includes(seed));
  assert.ok(!content(files, 'install.sql').includes(prepare));
  assert.ok(!content(files, 'install.sql').includes(sync));
  assert.ok(!content(files, 'install.sql').includes(restore));
  assert.equal(content(packageInsertFiles(p, 'per-table'), 'identity_recovery.sql'), p.identityRecoveryScript);
  const log = content(files, 'export-log.json');
  for (const sql of [seed, schema, prepare, sync, restore, 'private row']) assert.ok(!log.includes(sql));
  assert.equal(JSON.parse(log).exports[0].rows, 1);
});

test('failed package plans guard DDL, validation, combined INSERT and per-table scripts before deployment', () => {
  for (const failure of ['metadata', 'seed']) {
    const p = plan([object('TABLE', 'T'), object('VIEW', 'V')]);
    if (failure === 'metadata') p.objects.push({...object('TABLE', 'BAD'), status: 'error', script: ''});
    p.exports = [{table: 'T', rows: 0, script: '', ...(failure === 'seed' ? {error: 'Unsupported column'} : {})}];
    const files = [...packageDeploymentFiles(p), ...packageInsertFiles(p, 'single'), ...packageInsertFiles(p, 'per-table')];
    for (const file of files.filter(f => f.name.endsWith('.sql'))) {
      assert.match(file.content, /RAISE_APPLICATION_ERROR\(-20002/);
      assert.ok(file.content.indexOf('RAISE_APPLICATION_ERROR(-20002') < file.content.indexOf('CREATE TABLE') || !file.content.includes('CREATE TABLE'));
    }
  }
});

test('per-table INSERT exports preserve planner order, isolate each table and commit before identity restoration', () => {
  const p = plan([object('PACKAGE BODY', 'PKG')]);
  p.exports = [
    {table: 'Z_PARENT', rows: 1, script: "INSERT INTO Z_PARENT VALUES (1, 'parent');", preparationSql: ['PREPARE_PARENT;'], finalizeSql: ['SYNC_PARENT;', 'RESTORE_PARENT;']},
    {table: 'A_CHILD', rows: 1, script: "BEGIN\nINSERT INTO A_CHILD VALUES (1, 'child😀');\nEND;\n/", preparationSql: ['PREPARE_CHILD;'], finalizeSql: ['SYNC_CHILD;', 'RESTORE_CHILD;']},
    {table: '../A_CHILD', rows: 1, script: 'INSERT INTO THIRD_TABLE VALUES (3);'},
    {table: '..\\A_CHILD', rows: 0, script: '-- No source rows'},
  ];
  p.script = p.exports.map(e => e.script).join('\n');
  const files = packageInsertFiles(p, 'per-table'), tables = files.filter(f => f.name.startsWith('tables/'));
  assert.equal(tables.length, 4);
  assert.equal(new Set(files.map(f => f.name.toLowerCase())).size, files.length);
  const runner = content(files, 'run_inserts.sql');
  assert.deepEqual(runner.split('\n').filter(l => l.startsWith('@@')), tables.map(f => '@@' + f.name));
  for (const [i, file] of tables.entries()) {
    assert.match(file.name, /^tables\/\d{4}_[a-z0-9_-]+\.sql$/i);
    const entry = p.exports[i];
    assert.ok(file.content.includes(entry.script));
    for (const other of p.exports.filter(e => e !== entry)) assert.ok(!file.content.includes(other.script));
    assert.match(file.content, /CURRENT_SCHEMA = "PROD"/);
    assert.match(file.content, /\nCOMMIT;/);
    for (const prepare of entry.preparationSql ?? []) assert.ok(file.content.indexOf('SELECT COUNT(*)') < file.content.indexOf(prepare) && file.content.indexOf(prepare) < file.content.indexOf(entry.script));
    for (const restore of entry.finalizeSql ?? []) assert.ok(file.content.indexOf(entry.script) < file.content.indexOf('\nCOMMIT;') && file.content.indexOf('\nCOMMIT;') < file.content.indexOf(restore));
  }
  assert.doesNotThrow(() => createSqlZip(files));
  assert.match(content(files, 'README.txt'), /later failure does not roll back earlier committed tables/);
  const combined = content(packageInsertFiles(p, 'single'), 'inserts.sql');
  const order = ['PREPARE_PARENT;', 'PREPARE_CHILD;', p.exports[0].script, p.exports[1].script, p.exports[2].script, '\nCOMMIT;', 'SYNC_PARENT;', 'RESTORE_PARENT;', 'SYNC_CHILD;', 'RESTORE_CHILD;'].map(s => { const i = combined.indexOf(s); assert.ok(i >= 0, s); return i; });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.doesNotMatch(packageObjectScript(p), /INSERT INTO|PREPARE_PARENT;|RESTORE_CHILD;/);
});

test('INSERT export is absent without selected tables and non-identity combined data leaves COMMIT explicit', () => {
  const p = plan([object('TABLE', 'T')]);
  assert.deepEqual(packageInsertFiles(p, 'single'), []);
  assert.deepEqual(packageInsertFiles(p, 'per-table'), []);
  p.exports = [{table: 'T', rows: 1, script: 'INSERT INTO T VALUES (1);'}];
  const sql = content(packageInsertFiles(p, 'single'), 'inserts.sql');
  assert.match(sql, /explicit COMMIT after review/);
  assert.ok(!sql.includes('\nCOMMIT;'));
  assert.ok(!sql.includes('CREATE TABLE'));
  assert.ok(packageDeploymentFiles(p).every(f => !f.content.includes('INSERT INTO T VALUES (1);')));
});

test('unknown object types have distinct safe archive paths', () => {
  const p = plan([object('../../unsafe', 'A'), object('..\\unsafe', 'B'), object('🧪', 'C')]);
  const files = packageDeploymentFiles(p);
  assert.equal(new Set(files.map(f => f.name)).size, files.length);
  for (const f of files.filter(f => f.name.startsWith('by-type/'))) assert.match(f.name, /^by-type\/object_type_[a-f0-9_]+\.sql$/);
  assert.doesNotThrow(() => createSqlZip(files));
});

test('ZIP local records and central directory round-trip UTF-8 SQL with valid CRCs and offsets', async () => {
  const files = packageDeploymentFiles(plan([object('TABLE', 'T'), object('MATERIALIZED VIEW', 'MV')]));
  files.push({name: 'unicode.sql', content: "-- México • 日本\nBEGIN\nNULL;\nEND;\n/\n"});
  const blob = createSqlZip(files), zip = Buffer.from(await blob.arrayBuffer());
  assert.equal(blob.type, 'application/zip');
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 8), files.length);
  assert.equal(zip.readUInt16LE(end + 10), files.length);
  let central = zip.readUInt32LE(end + 16), local = 0;
  assert.equal(central + zip.readUInt32LE(end + 12), end);
  for (const file of files) {
    const name = Buffer.from(file.name), bytes = Buffer.from(file.content);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt16LE(local + 6), 0x0800);
    assert.equal(zip.readUInt16LE(local + 8), 0); // Stored entries: no decompression required.
    assert.equal(zip.readUInt32LE(local + 14), crc32(bytes));
    assert.equal(zip.readUInt32LE(local + 18), bytes.length);
    assert.equal(zip.readUInt32LE(local + 22), bytes.length);
    assert.equal(zip.readUInt16LE(local + 26), name.length);
    assert.deepEqual(zip.subarray(local + 30, local + 30 + name.length), name);
    assert.deepEqual(zip.subarray(local + 30 + name.length, local + 30 + name.length + bytes.length), bytes);
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    assert.equal(zip.readUInt32LE(central + 42), local);
    assert.equal(zip.readUInt32LE(central + 16), crc32(bytes));
    assert.equal(zip.readUInt32LE(central + 20), bytes.length);
    assert.equal(zip.readUInt16LE(central + 28), name.length);
    assert.deepEqual(zip.subarray(central + 46, central + 46 + name.length), name);
    local += 30 + name.length + bytes.length;
    central += 46 + name.length;
  }
  assert.equal(local, zip.readUInt32LE(end + 16));
  assert.equal(central, end);
});

test('ZIP refuses traversal, unsafe paths and case-insensitive duplicate filenames', () => {
  for (const name of ['../bad.sql', '/bad.sql', 'C:/bad.sql', 'by-type/../bad.sql', 'by-type\\bad.sql', './bad.sql']) {
    assert.throws(() => createSqlZip([{name, content: ''}]), /Invalid/);
  }
  assert.throws(() => createSqlZip([{name: 'README.txt', content: ''}, {name: 'readme.txt', content: ''}]), /duplicate/);
});
