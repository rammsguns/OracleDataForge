import assert from 'node:assert/strict';
import test from 'node:test';
import type oracledb from 'oracledb';
import { buildPackageInstall, dependencyOrder, exportSeedTable, expandPackageSelection, packageClosure, packageSourceTexts, tableUsage, SeedExportError } from './packageInstall.ts';
import { packageExportLog, type PackageInstallPlan } from '../src/utils/packageInstall.ts';
import { compareObjectKey as key, type CompareCatalog } from '../src/utils/schemaCompare.ts';

const connection = (run: (sql: string, binds: Record<string, unknown>) => unknown) => ({ execute: async (sql: string, binds: Record<string, unknown>) => run(sql, binds) }) as unknown as oracledb.Connection;
const identityOptions = 'INCREMENT BY: 1, MIN_VALUE: 1, MAX_VALUE: 9999999999999999999999999999, CACHE_SIZE: 20, CYCLE_FLAG: N, ORDER_FLAG: N, KEEP_VALUE: N';
const input = { sourceId: 'dev', sourceSchema: 'DEV', targetSchema: 'PROD', packages: ['P'], rowLimit: 2 };
const columns = [{ COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', VIRTUAL_COLUMN: 'NO', IDENTITY_COLUMN: 'NO' }, { COLUMN_NAME: 'TEXT', DATA_TYPE: 'VARCHAR2', VIRTUAL_COLUMN: 'NO', IDENTITY_COLUMN: 'NO' }];

test('lookup suggestions use real SQL evidence and exclude writes, comments and quoted strings', () => {
  const result = tableUsage('STATUS_CATALOG', [{ name: 'PACKAGE BODY P', text: `-- UPDATE STATUS_CATALOG SET X=1;\nbegin\n s := q'[it's UPDATE STATUS_CATALOG SET X=2]';\n select * into x from DEV.STATUS_CATALOG;\nend;` }]);
  assert.equal(result.recommended, true);
  assert.deepEqual(result.evidence, ['PACKAGE BODY P:4 from DEV.STATUS_CATALOG']);
  const writes = tableUsage('STATUS_CATALOG', [{ name: 'P', text: 'select * from STATUS_CATALOG; delete from STATUS_CATALOG where id=1;' }]);
  assert.equal(writes.recommended, false);
  assert.match(writes.reasons.join(' '), /writes/);
  assert.equal(tableUsage('MAIL_BLACK_LIST', []).recommended, true);
  assert.equal(tableUsage('Sales', [{ name: 'P', text: 'select * from "Sales";' }]).recommended, true);
});

test('package closure follows bodies, nested views, sequences, FK parents, indexes and triggers', async () => {
  const objects = [{ name: 'P', type: 'PACKAGE' }, { name: 'P', type: 'PACKAGE BODY' }, { name: 'V', type: 'VIEW' }, { name: 'STATUS_CATALOG', type: 'TABLE' }, { name: 'PARENT', type: 'TABLE' }, { name: 'SEQ', type: 'SEQUENCE' }, { name: 'IX', type: 'INDEX' }, { name: 'TR', type: 'TRIGGER' }];
  const catalog: CompareCatalog = { schema: 'DEV', objects, types: [] };
  const dep = (name: string, type: string, ref: string, rt: string) => ({ NAME: name, TYPE: type, REFERENCED_OWNER: 'DEV', REFERENCED_NAME: ref, REFERENCED_TYPE: rt });
  const conn = connection(sql => {
    if (sql.includes('all_dependencies')) return { rows: [dep('P', 'PACKAGE BODY', 'V', 'VIEW'), dep('P', 'PACKAGE BODY', 'SEQ', 'SEQUENCE'), dep('V', 'VIEW', 'STATUS_CATALOG', 'TABLE'), { ...dep('P', 'PACKAGE BODY', 'REMOTE', 'TABLE'), REFERENCED_OWNER: 'SHARED', REFERENCED_LINK_NAME: 'DB_LINK' }] };
    if (sql.includes("constraint_type = 'R'")) return { rows: [{ TABLE_NAME: 'STATUS_CATALOG', PARENT_OWNER: 'DEV', PARENT_TABLE: 'PARENT' }] };
    if (sql.includes('all_synonyms')) return { rows: [] };
    if (sql.includes('all_indexes')) return { rows: [{ TABLE_NAME: 'STATUS_CATALOG', OBJECT_NAME: 'IX', OBJECT_TYPE: 'INDEX' }, { TABLE_NAME: 'STATUS_CATALOG', OBJECT_NAME: 'TR', OBJECT_TYPE: 'TRIGGER' }] };
    throw new Error(sql);
  });
  const result = await packageClosure(conn, catalog, ['P']);
  assert.equal(result.objects.length, objects.length);
  const expanded = await expandPackageSelection(conn, catalog, [{ name: 'P', type: 'PACKAGE' }]);
  assert.deepEqual(new Set(expanded.objects.map(key)), new Set(objects.map(key)));
  assert.ok(expanded.objects.findIndex(o => o.name === 'PARENT') < expanded.objects.findIndex(o => o.type === 'PACKAGE BODY'));
  const plain = await expandPackageSelection(conn, catalog, [{ name: 'STATUS_CATALOG', type: 'TABLE' }]);
  assert.deepEqual(plain.objects, [{ name: 'STATUS_CATALOG', type: 'TABLE' }]);
  const names = result.objects.map(o => `${o.type}:${o.name}`);
  assert.ok(names.indexOf('TABLE:PARENT') < names.indexOf('TABLE:STATUS_CATALOG'));
  assert.ok(names.indexOf('TABLE:STATUS_CATALOG') < names.indexOf('VIEW:V'));
  assert.ok(names.indexOf('VIEW:V') < names.indexOf('PACKAGE BODY:P'));
  assert.match(result.warnings.join(' '), /SHARED.REMOTE.*DB_LINK/);
  await assert.rejects(() => packageClosure(conn, catalog, ['NOT_VISIBLE']), /not visible/);
});

test('cycles are explicit and shared dependencies are emitted once', () => {
  const a = { name: 'A', type: 'TABLE' }, b = { name: 'B', type: 'TABLE' };
  const result = dependencyOrder([a, b], new Map([[key(a), [b]], [key(b), [a]]]));
  assert.equal(result.ordered.length, 2); assert.ok(result.cycles.length);
});

test('seed scripts preserve numeric precision, escape strings and guard existing primary keys', async () => {
  const conn = connection(sql => {
    if (sql.includes('all_tab_cols')) return { rows: columns };
    if (sql.includes('all_constraints')) return { rows: [{ COLUMN_NAME: 'ID' }] };
    assert.match(sql, /"DEV"\."STATUS_CATALOG".*FETCH FIRST 3 ROWS ONLY/);
    return { rows: [{ ID: '9007199254740993', TEXT: "O'Brien\n/" }] };
  });
  const result = await exportSeedTable(conn, conn, input, 'STATUS_CATALOG', true);
  assert.equal(result.rows, 1);
  assert.match(result.script, /INSERT INTO "PROD"\."STATUS_CATALOG"/);
  assert.match(result.script, /9007199254740993/);
  assert.match(result.script, /O''Brien.*CHR\(10\)/);
  assert.match(result.script, /WHERE NOT EXISTS/);
  assert.doesNotMatch(result.script, /\b(?:DELETE|UPDATE|COMMIT)\b/);
});

test('oversized and unsupported seed tables fail without partial inserts; existing targets require matching keys', async () => {
  const conn = (opts: { type?: string; pk?: boolean; rows?: number }) => connection(sql => {
    if (sql.includes('all_tab_cols')) return { rows: [{ ...columns[0], DATA_TYPE: opts.type ?? 'NUMBER' }] };
    if (sql.includes('all_constraints')) return { rows: opts.pk === false ? [] : [{ COLUMN_NAME: 'ID' }] };
    return { rows: Array.from({ length: opts.rows ?? 0 }, (_, i) => ({ ID: String(i) })) };
  });
  await assert.rejects(() => exportSeedTable(conn({ rows: 3 }), conn({}), input, 'T', false), /no partial/);
  await assert.rejects(() => exportSeedTable(conn({ type: 'XMLTYPE' }), conn({}), input, 'T', false), /Unsupported columns: ID \(XMLTYPE\)/);
  await assert.rejects(() => exportSeedTable(conn({ pk: false }), conn({ pk: false }), input, 'T', true), /primary keys/);
});

test('full package plan installs dependencies before INSERTs and blocks deployment after failed seed exports', async t => {
  const objs = [{ OBJECT_NAME: 'P', OBJECT_TYPE: 'PACKAGE' }, { OBJECT_NAME: 'P', OBJECT_TYPE: 'PACKAGE BODY' }, { OBJECT_NAME: 'STATUS_CATALOG', OBJECT_TYPE: 'TABLE' }];
  const conn = (source: boolean, unsupported = false) => connection((sql, binds) => {
    if (sql.includes('all_users')) return { rows: [{ USERNAME: source ? 'DEV' : 'PROD' }] };
    if (sql.includes('all_objects')) return { rows: source ? objs : [] };
    if (sql.includes('all_dependencies')) return { rows: [{ NAME: 'P', TYPE: 'PACKAGE BODY', REFERENCED_OWNER: 'DEV', REFERENCED_NAME: 'STATUS_CATALOG', REFERENCED_TYPE: 'TABLE' }] };
    if (sql.includes('all_synonyms') || sql.includes('all_indexes')) return { rows: [] };
    if (sql.includes('all_source')) return { rows: [{ NAME: 'P', TYPE: 'PACKAGE BODY', TEXT: 'select * from STATUS_CATALOG;\n' }] };
    if (sql.includes('all_tab_cols')) return { rows: unsupported ? [{...columns[0], DATA_TYPE: 'XMLTYPE'}] : columns };
    if (sql.includes("constraint_type = 'R'")) return { rows: [] };
    if (sql.includes('all_constraints')) return { rows: [{ COLUMN_NAME: 'ID' }] };
    if (sql.includes('DBMS_METADATA.OPEN')) return { outBinds: { output: `CREATE ${binds.kind === 'PACKAGE_SPEC' ? 'OR REPLACE PACKAGE' : binds.kind === 'PACKAGE_BODY' ? 'OR REPLACE PACKAGE BODY' : 'TABLE'} "DEV"."${binds.name}";\n${binds.kind === 'TABLE' ? '' : '/\n'}` } };
    return { rows: [{ ID: '1', TEXT: 'Enabled' }] };
  });
  const plan = await buildPackageInstall(conn(true), conn(false), { ...input, seedTables: ['STATUS_CATALOG'] }, 'Development', 'Production');
  const log = t.mock.method(console, 'error', () => {});
  const failed = await buildPackageInstall(conn(true, true), conn(false), { ...input, seedTables: ['STATUS_CATALOG'] }, 'Development', 'Production');
  assert.equal(failed.exports[0].details?.columns[0].type, 'XMLTYPE');
  assert.ok(failed.script.indexOf('Seed export incomplete') < failed.script.indexOf('CREATE TABLE'));
  assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).event, 'seed-export-failed');
  assert.equal(plan.objects.length, 3);
  assert.equal(plan.exports[0].rows, 1);
  const placed = await buildPackageInstall(conn(true), conn(false), {...input, seedTables: [], tableTablespace: 'INSTALL_DATA', indexTablespace: 'INSTALL_IDX'}, 'DEV', 'PROD');
  assert.equal(placed.tableTablespace, '"INSTALL_DATA"');
  assert.equal(placed.indexTablespace, '"INSTALL_IDX"');
  assert.match(placed.script, /CREATE TABLE "PROD"."STATUS_CATALOG" TABLESPACE "INSTALL_DATA"/);
  assert.ok(plan.script.indexOf('CREATE TABLE') < plan.script.indexOf('CREATE OR REPLACE PACKAGE BODY'));
  assert.ok(plan.script.lastIndexOf('CREATE ') < plan.script.indexOf('INSERT INTO'));
  assert.match(plan.script, /"PROD"\."STATUS_CATALOG"/);
  await assert.rejects(() => buildPackageInstall(conn(true), conn(false), { ...input, seedTables: ['UNRELATED'] }, 'DEV', 'PROD'), /dependency closure/);
});


test('dependency queries stay scoped to the visited frontier and skip unrelated schema metadata', async () => {
  const objects = [{ name: 'P', type: 'PACKAGE' }, { name: 'P', type: 'PACKAGE BODY' }, { name: 'V', type: 'VIEW' }, { name: 'T', type: 'TABLE' }, ...Array.from({length: 1000}, (_, i) => ({ name: 'UNRELATED_' + i, type: 'TABLE' }))];
  const visitedNames: string[] = [];
  const conn = connection((sql, binds) => {
    assert.ok(!Object.values(binds).some(v => String(v).startsWith('UNRELATED_')));
    if (sql.includes('all_dependencies')) {
      assert.match(sql, /name IN \(:n0/);
      const names = Object.entries(binds).filter(([k]) => k.startsWith('n')).map(([,v]) => String(v));
      visitedNames.push(...names);
      return { rows: names.includes('P') ? [{ NAME: 'P', TYPE: 'PACKAGE BODY', REFERENCED_OWNER: 'DEV', REFERENCED_NAME: 'V', REFERENCED_TYPE: 'VIEW' }] : names.includes('V') ? [{ NAME: 'V', TYPE: 'VIEW', REFERENCED_OWNER: 'DEV', REFERENCED_NAME: 'T', REFERENCED_TYPE: 'TABLE' }] : [] };
    }
    assert.match(sql, /table_name IN \(:t0/); assert.equal(binds.t0, 'T');
    return { rows: [] };
  });
  const result = await packageClosure(conn, { schema: 'DEV', objects, types: [] }, ['P']);
  assert.deepEqual(new Set(result.objects.map(o => o.name)), new Set(['P', 'V', 'T']));
  assert.deepEqual(new Set(visitedNames), new Set(['P', 'V', 'T']));
});

test('analysis never extracts DDL; generation never reads retained dependency DDL or SXML', async () => {
  const objects = [{ OBJECT_NAME: 'P', OBJECT_TYPE: 'PACKAGE' }, { OBJECT_NAME: 'P', OBJECT_TYPE: 'PACKAGE BODY' }, { OBJECT_NAME: 'T', OBJECT_TYPE: 'TABLE' }];
  const metadataCalls: string[] = [];
  const conn = (source: boolean) => connection((sql, binds) => {
    if (sql.includes('all_users')) return { rows: [{ USERNAME: source ? 'DEV' : 'PROD' }] };
    if (sql.includes('all_objects')) return { rows: source ? objects : [objects[2]] };
    if (sql.includes('all_dependencies')) return { rows: [{ NAME: 'P', TYPE: 'PACKAGE BODY', REFERENCED_OWNER: 'DEV', REFERENCED_NAME: 'T', REFERENCED_TYPE: 'TABLE' }] };
    if (sql.includes('all_source')) return { rows: [{ NAME: 'P', TYPE: 'PACKAGE BODY', TEXT: 'SELECT * FROM T;\n' }] };
    if (sql.includes('all_indexes') || sql.includes('all_constraints')) return { rows: [] };
    if (sql.includes('DBMS_METADATA.OPEN')) {
      assert.equal(source, true); assert.equal(binds.name, 'P'); assert.doesNotMatch(sql, /SXML|DBMS_METADATA_DIFF/);
      metadataCalls.push(String(binds.kind));
      return { outBinds: { output: 'CREATE OR REPLACE PACKAGE "DEV"."P" AS END;\n/' } };
    }
    throw new Error('Unexpected query: ' + sql);
  });
  const plan = await buildPackageInstall(conn(true), conn(false), input, 'DEV', 'PROD');
  assert.equal(metadataCalls.length, 0);
  assert.equal(plan.objects.find(o => o.name === 'T')?.definitionCompared, false);
  assert.equal(plan.suggestions[0].table, 'T');
  const script = await buildPackageInstall(conn(true), conn(false), {...input, seedTables: []}, 'DEV', 'PROD');
  assert.deepEqual(metadataCalls.sort(), ['PACKAGE_BODY', 'PACKAGE_SPEC']);
  assert.match(script.script, /CREATE OR REPLACE PACKAGE/);
  assert.doesNotMatch(script.script, /CREATE TABLE/);
});

test('dependency timeout errors identify the query stage and selected package', async () => {
  const conn = connection(() => { throw new Error('NJS-123: call timeout exceeded'); });
  await assert.rejects(() => packageClosure(conn, {schema: 'DEV', objects: [{name: 'P', type: 'PACKAGE'}], types: []}, ['P']), /Reading dependencies for P: NJS-123/);
});


test('CLOB, NCLOB and BLOB seed blocks preserve Unicode, quotes, empty LOBs and null values', async () => {
  const text = "O'Brien\n😀/".repeat(800);
  const metadata = [columns[0], { COLUMN_NAME: 'BODY', DATA_TYPE: 'CLOB' }, { COLUMN_NAME: 'NATIONAL', DATA_TYPE: 'NCLOB' }, { COLUMN_NAME: 'PAYLOAD', DATA_TYPE: 'BLOB' }, { COLUMN_NAME: 'EMPTY_TEXT', DATA_TYPE: 'CLOB' }, { COLUMN_NAME: 'NULL_TEXT', DATA_TYPE: 'CLOB' }];
  const conn = connection(sql => {
    if (sql.includes('all_tab_cols')) return {rows: metadata};
    if (sql.includes('all_constraints')) return {rows: [{COLUMN_NAME: 'ID'}]};
    return {rows: [{ID: '1', BODY: text, NATIONAL: '你好😀', PAYLOAD: Buffer.from([0, 255, 128]), EMPTY_TEXT: '', NULL_TEXT: null}]};
  });
  const result = await exportSeedTable(conn, conn, input, 'EMAIL_MESSAGES', true);
  assert.equal(result.rows, 1);
  assert.match(result.script, /df_lob_1 CLOB;\n/);
  assert.match(result.script, /DBMS_LOB.APPEND\(df_lob_1, TO_CLOB\(/);
  assert.match(result.script, /O''Brien/);
  assert.match(result.script, /CHR\(10\)/);
  assert.match(result.script, /TO_NCLOB\(N'你好😀'\)/);
  assert.match(result.script, /HEXTORAW\('00ff80'\)/);
  assert.match(result.script, /CREATETEMPORARY\(df_lob_4, TRUE\)/);
  assert.doesNotMatch(result.script, /APPEND\(df_lob_4/);
  assert.doesNotMatch(result.script, /df_lob_5/);
  assert.match(result.script, /SELECT 1, df_lob_1, df_lob_2, df_lob_3, df_lob_4, NULL FROM DUAL WHERE NOT EXISTS/);
  assert.match(result.script, /EXCEPTION WHEN OTHERS THEN\n/);
  assert.doesNotMatch(result.script, /COMMIT|ALTER TABLE/);
});

test('virtual columns are recomputed and BY DEFAULT identity keys are preserved with synchronization advice', async () => {
  const metadata = [{...columns[0], IDENTITY_COLUMN: 'YES'}, {...columns[1], COLUMN_NAME: 'COMPUTED_VALUE', VIRTUAL_COLUMN: 'YES'}];
  const conn = connection(sql => {
    if (sql.includes('all_tab_cols')) return {rows: metadata};
    if (sql.includes('all_tab_identity_cols')) return {rows: [{COLUMN_NAME: 'ID', GENERATION_TYPE: 'BY DEFAULT', IDENTITY_OPTIONS: identityOptions}]};
    if (sql.includes('all_constraints')) return {rows: [{COLUMN_NAME: 'ID'}]};
    assert.doesNotMatch(sql, /COMPUTED_VALUE/);
    return {rows: [{ID: '9007199254740993'}]};
  });
  const result = await exportSeedTable(conn, conn, input, 'CAD_TIPOS_REPORTE', true);
  assert.match(result.script, /SELECT 9007199254740993 FROM DUAL/);
  assert.doesNotMatch(result.script.split('\n').filter(l => !l.startsWith('--')).join('\n'), /COMPUTED_VALUE/);
  assert.match(result.warnings.join(' '), /Virtual columns omitted/);
  assert.match(result.warnings.join(' '), /synchronizing identity sequences/);
});

test('unknown identity modes and unsupported types include specific column details and a recovery action', async () => {
  for (const always of [true, false]) {
    const conn = connection(sql => sql.includes('all_tab_cols') ? {rows: [{...columns[0], DATA_TYPE: always ? 'NUMBER' : 'XMLTYPE', IDENTITY_COLUMN: always ? 'YES' : 'NO'}]} : {rows: [{COLUMN_NAME: 'ID', GENERATION_TYPE: 'UNRECOGNIZED'}]});
    await assert.rejects(() => exportSeedTable(conn, conn, input, 'MAT_REGLAS_CLASIFICA_CORREOS', false), error => {
      assert.ok(error instanceof SeedExportError);
      assert.equal(error.details.table, 'MAT_REGLAS_CLASIFICA_CORREOS');
      assert.equal(error.details.columns[0].name, 'ID');
      assert.equal(error.details.columns[0].type, always ? 'NUMBER' : 'XMLTYPE');
      assert.match(error.details.advice, always ? /dedicated table data copy/ : /Data Pump/);
      return true;
    });
  }
});

test('oversized locator errors close every locator and cursor and identify the row and column', async () => {
  let closed = 0, cursorClosed = false;
  const first = {length: 21 * 1024 * 1024, getData: async () => {throw new Error('must not read oversized LOB');}, close: async () => {closed++;}};
  const other = {length: 0, getData: async () => '', close: async () => {closed++;}};
  const conn = connection(sql => {
    if (sql.includes('all_tab_cols')) return {rows: [columns[0], {COLUMN_NAME: 'BODY', DATA_TYPE: 'CLOB'}, {COLUMN_NAME: 'OTHER', DATA_TYPE: 'CLOB'}]};
    if (sql.includes('all_constraints')) return {rows: [{COLUMN_NAME: 'ID'}]};
    return {resultSet: {getRow: async () => ({ID: '1', BODY: first, OTHER: other}), close: async () => {cursorClosed = true;}}};
  });
  await assert.rejects(() => exportSeedTable(conn, conn, input, 'EMAIL_MESSAGES', false), error => {
    assert.ok(error instanceof SeedExportError);
    assert.equal(error.details.row, 1);
    assert.equal(error.details.columns[0].name, 'BODY');
    assert.equal(error.details.stage, 'serialize source value');
    return true;
  });
  assert.equal(closed, 2); assert.equal(cursorClosed, true);
});

test('export diagnostic downloads exclude SQL statements and source row contents', () => {
  const plan = { comparedAt: 'now', sourceName: 'DEV', sourceSchema: 'DEV', targetName: 'PROD', targetSchema: 'PROD', roots: ['P'], warnings: [], exports: [{table: 'EMAIL_MESSAGES', rows: 1, script: "INSERT INTO T VALUES ('private mail text');", warnings: ['LOB supported']}] } as unknown as PackageInstallPlan;
  const log = JSON.stringify(packageExportLog(plan));
  assert.match(log, /EMAIL_MESSAGES/);
  assert.doesNotMatch(log, /INSERT INTO|private mail text/);
});


test('ALWAYS identity seed plans preserve IDs with preparation, commit, restoration and bounded sequence options', async () => {
  const metadata = [{...columns[0], IDENTITY_COLUMN: 'YES'}, columns[1]];
  const objects = [{OBJECT_NAME: 'P', OBJECT_TYPE: 'PACKAGE'}, {OBJECT_NAME: 'T', OBJECT_TYPE: 'TABLE'}];
  const conn = (source: boolean) => connection((sql, binds) => {
    if (sql.includes('all_users')) return {rows: [{USERNAME: source ? 'DEV' : 'PROD'}]};
    if (sql.includes('all_objects')) return {rows: objects};
    if (sql.includes('all_dependencies')) return {rows: [{NAME: 'P', TYPE: 'PACKAGE', REFERENCED_OWNER: 'DEV', REFERENCED_NAME: 'T', REFERENCED_TYPE: 'TABLE'}]};
    if (sql.includes('all_source')) return {rows: []};
    if (sql.includes('all_tab_cols')) return {rows: metadata};
    if (sql.includes('all_tab_identity_cols')) return {rows: [{COLUMN_NAME: 'ID', GENERATION_TYPE: 'ALWAYS', IDENTITY_OPTIONS: identityOptions}]};
    if (sql.includes("constraint_type = 'P'")) return {rows: [{COLUMN_NAME: 'ID'}]};
    if (sql.includes('all_constraints') || sql.includes('all_indexes')) return {rows: []};
    if (sql.includes('DBMS_METADATA.OPEN')) return {outBinds: {output: 'CREATE OR REPLACE PACKAGE "' + binds.owner + '"."P" AS END;\n/'}};
    return {rows: [{ID: '9007199254740993', TEXT: 'catalog'}]};
  });
  const plan = await buildPackageInstall(conn(true), conn(false), {...input, seedTables: ['T']}, 'DEV', 'PROD');
  assert.equal(plan.exports[0].error, undefined);
  assert.equal(plan.commitsSeedData, true);
  assert.ok(plan.script.indexOf('GENERATED BY DEFAULT AS IDENTITY') < plan.script.indexOf('INSERT INTO'));
  assert.ok(plan.script.indexOf('INSERT INTO') < plan.script.indexOf('\n\nCOMMIT;'));
  assert.ok(plan.script.indexOf('\n\nCOMMIT;') < plan.script.indexOf('GENERATED ALWAYS AS IDENTITY'));
  assert.match(plan.script, /START WITH LIMIT VALUE INCREMENT BY 1 MINVALUE 1 MAXVALUE 9999999999999999999999999999 CACHE 20 NOCYCLE NOORDER NOKEEP/);
  assert.ok(plan.script.indexOf('START WITH LIMIT VALUE') < plan.script.indexOf('GENERATED ALWAYS AS IDENTITY'));
  assert.ok(plan.identityRecoveryScript!.indexOf('START WITH LIMIT VALUE') < plan.identityRecoveryScript!.indexOf('GENERATED ALWAYS AS IDENTITY'));
  assert.match(plan.script, /9007199254740993/);
  assert.match(plan.identityRecoveryScript!, /ROLLBACK;\nALTER TABLE/);
  assert.match(plan.identityRecoveryScript!, /GENERATED ALWAYS AS IDENTITY/);
  assert.doesNotMatch(JSON.stringify(packageExportLog(plan)), /ALTER TABLE|INSERT INTO/);
});


test('VARCHAR2 widening is scripted without applying changes, and wider target columns are retained', async () => {
  for (const width of [150, 1000]) {
    const conn = (source: boolean) => connection(sql => {
      if (sql.includes('all_tab_cols')) return {rows: [columns[0], {...columns[1], COLUMN_NAME: 'NOMBRE_ARCHIVO', DATA_LENGTH: source ? 500 : width, CHAR_LENGTH: source ? 500 : width, CHAR_USED: 'B'}]};
      if (sql.includes('all_constraints')) return {rows: [{COLUMN_NAME: 'ID'}]};
      assert.match(sql, /^SELECT /); return {rows: [{ID: '1', NOMBRE_ARCHIVO: 'report.csv'}]};
    });
    const result = await exportSeedTable(conn(true), conn(false), input, 'CAD_TIPOS_REPORTE', true);
    assert.equal(result.rows, 1);
    if (width === 150) assert.deepEqual(result.schemaSql, ['ALTER TABLE "PROD"."CAD_TIPOS_REPORTE" MODIFY ("NOMBRE_ARCHIVO" VARCHAR2(500 BYTE));']);
    else assert.equal(result.schemaSql.length, 0);
  }
});


test('ALL_SOURCE assembly preserves line boundaries, dictionary offsets and existing terminators', () => {
  const selected = new Set([key({name: 'P', type: 'PACKAGE BODY'})]);
  const texts = packageSourceTexts([
    {NAME: 'P', TYPE: 'PACKAGE BODY', LINE: 1, TEXT: 'BEGIN\r\n'},
    {NAME: 'P', TYPE: 'PACKAGE BODY', LINE: 3, TEXT: 'SELECT * FROM'},
    {NAME: 'P', TYPE: 'PACKAGE BODY', LINE: 4, TEXT: 'STATUS_CATALOG;'},
    {NAME: 'P', TYPE: 'PACKAGE BODY', LINE: 5, TEXT: '-- UPDATE STATUS_CATALOG'},
    {NAME: 'P', TYPE: 'PACKAGE BODY', LINE: 6, TEXT: 'DELETE FROM STATUS_CATALOG;'},
    {NAME: 'OTHER', TYPE: 'PACKAGE BODY', LINE: 1, TEXT: 'SELECT * FROM OTHER_TABLE;'},
  ], selected);
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /^BEGIN\n\nSELECT \* FROM\nSTATUS_CATALOG;/);
  const usage = tableUsage('STATUS_CATALOG', texts);
  assert.equal(usage.recommended, false);
  assert.deepEqual(usage.evidence, ['PACKAGE BODY P:3 FROM STATUS_CATALOG', 'PACKAGE BODY P:6 DELETE FROM STATUS_CATALOG']);
});

test('package installer blocks conflicting target object types during both analysis and generation', async () => {
  const conn = (source: boolean) => connection(sql => {
    if (sql.includes('all_users')) return {rows: [{USERNAME: source ? 'DEV' : 'PROD'}]};
    if (sql.includes('all_objects')) return {rows: source ? [{OBJECT_NAME: 'P', OBJECT_TYPE: 'PACKAGE'}, {OBJECT_NAME: 'V', OBJECT_TYPE: 'VIEW'}] : [{OBJECT_NAME: 'V', OBJECT_TYPE: 'TABLE'}]};
    if (sql.includes('all_dependencies')) return {rows: [{NAME: 'P', TYPE: 'PACKAGE', REFERENCED_OWNER: 'DEV', REFERENCED_NAME: 'V', REFERENCED_TYPE: 'VIEW'}]};
    throw new Error('Unexpected metadata extraction after collision: ' + sql);
  });
  for (const seedTables of [undefined, []]) await assert.rejects(() => buildPackageInstall(conn(true), conn(false), {...input, seedTables}, 'DEV', 'PROD'), /Target namespace collision: VIEW V conflicts with existing TABLE V/);
});
