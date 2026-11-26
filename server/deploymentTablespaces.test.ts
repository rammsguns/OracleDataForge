import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCreationTablespaces as apply, readDeploymentTablespaces as read } from './deploymentTablespaces.ts';
const both = {tableTablespace: 'app_data', indexTablespace: 'app_idx'};

test('placement is idempotent when metadata and downloads both apply overrides', () => {
  for (const [type, ddl] of [
    ['TABLE', 'CREATE TABLE T (ID NUMBER GENERATED ALWAYS AS IDENTITY NOT NULL ENABLE, PRIMARY KEY (ID) USING INDEX ENABLE);'],
    ['INDEX', 'CREATE INDEX IX ON T (ID);'],
    ['MATERIALIZED VIEW', 'CREATE MATERIALIZED VIEW MV BUILD IMMEDIATE REFRESH COMPLETE ON DEMAND AS SELECT * FROM T;'],
    ['TABLE', 'CREATE TABLE T (ID NUMBER PRIMARY KEY USING INDEX (CREATE INDEX IX ON T (ID)) ENABLE);'],
  ]) {
    const sql = apply(ddl, type, both);
    assert.equal(apply(sql, type, both), sql);
  }
  assert.throws(() => read({tableTablespace: '"' + '漢'.repeat(43) + '"'}), /1–128 bytes/);
});

test('validates Oracle tablespace identifiers and quotes them without accepting SQL fragments', () => {
  assert.deepEqual(read(both), {tableTablespace: '"APP_DATA"', indexTablespace: '"APP_IDX"'});
  assert.equal(read({tableTablespace: '"Mixed Case"'}).tableTablespace, '"Mixed Case"');
  assert.equal(read({tableTablespace: '  '}).tableTablespace, undefined);
  for (const value of ['DATA; DROP TABLE T', 'DATA --', '"x";SELECT 1', '"line\nbreak"', 'A'.repeat(129)]) assert.throws(() => read({tableTablespace: value}));
});

test('places heap tables and implicitly created primary/unique indexes independently', () => {
  const ddl = 'CREATE TABLE "PROD"."T" ("ID" NUMBER PRIMARY KEY, "CODE" VARCHAR2(50) UNIQUE, CONSTRAINT "UQ" UNIQUE ("ID", "CODE"));';
  const sql = apply(ddl, 'TABLE', both);
  assert.match(sql, /NUMBER PRIMARY KEY USING INDEX TABLESPACE "APP_IDX"/);
  assert.match(sql, /VARCHAR2\(50\) UNIQUE USING INDEX TABLESPACE "APP_IDX"/);
  assert.match(sql, /UNIQUE \("ID", "CODE"\) USING INDEX TABLESPACE "APP_IDX"\) TABLESPACE "APP_DATA";/);
});

test('maps explicit table, LOB, partition and constraint-index tablespaces while preserving literals', () => {
  const ddl = `CREATE TABLE T (ID NUMBER, TXT VARCHAR2(100) DEFAULT q'[TABLESPACE "KEEP"]', BODY CLOB,
    CONSTRAINT PK PRIMARY KEY (ID) USING INDEX PCTFREE 10 STORAGE(INITIAL 65536 NEXT 1048576) TABLESPACE OLD_INDEX ENABLE)
    TABLESPACE OLD_DATA LOB (BODY) STORE AS (TABLESPACE OLD_LOB)
    PARTITION BY RANGE (ID) (PARTITION P1 VALUES LESS THAN (10) TABLESPACE OLD_PART);
    -- TABLESPACE KEEP_COMMENT`;
  const sql = apply(ddl, 'TABLE', both);
  assert.match(sql, /USING INDEX PCTFREE 10 STORAGE\(INITIAL 65536 NEXT 1048576\) TABLESPACE "APP_IDX" ENABLE/);
  assert.match(sql, /LOB \(BODY\) STORE AS \(TABLESPACE "APP_DATA"\)/);
  assert.match(sql, /VALUES LESS THAN \(10\) TABLESPACE "APP_DATA"/);
  assert.match(sql, /q'\[TABLESPACE "KEEP"\]'/);
  assert.match(sql, /-- TABLESPACE KEEP_COMMENT/);
  assert.doesNotMatch(sql, /OLD_INDEX|OLD_DATA|OLD_LOB|OLD_PART/);
});

test('maps standalone index partitions and STORE IN placement without changing expressions', () => {
  const ddl = `CREATE UNIQUE INDEX "I" ON "T" (UPPER('TABLESPACE KEEP'), ID)
    LOCAL (PARTITION P1 TABLESPACE OLD1, PARTITION P2 TABLESPACE OLD2);`;
  const sql = apply(ddl, 'INDEX', both);
  assert.match(sql, /ID\) TABLESPACE "APP_IDX"/);
  assert.match(sql, /PARTITION P1 TABLESPACE "APP_IDX"/);
  assert.match(sql, /UPPER\('TABLESPACE KEEP'\)/);
  assert.doesNotMatch(sql, /APP_DATA|OLD1|OLD2/);
  assert.match(apply('CREATE TABLE T (ID NUMBER) PARTITION BY HASH (ID) PARTITIONS 4 STORE IN (OLD1, OLD2);', 'TABLE', both), /STORE IN \("APP_DATA"\)/);
});

test('handles embedded CREATE INDEX definitions and leaves named index references intact', () => {
  const nested = 'CREATE TABLE T (ID NUMBER, CONSTRAINT PK PRIMARY KEY (ID) USING INDEX (CREATE INDEX IX ON T (ID)) ENABLE);';
  assert.match(apply(nested, 'TABLE', both), /CREATE INDEX IX ON T \(ID\) TABLESPACE "APP_IDX"/);
  const named = 'CREATE TABLE T (ID NUMBER, CONSTRAINT PK PRIMARY KEY (ID) USING INDEX "EXISTING_IDX" ENABLE);';
  const sql = apply(named, 'TABLE', both);
  assert.match(sql, /USING INDEX "EXISTING_IDX" ENABLE/);
  assert.doesNotMatch(sql, /EXISTING_IDX" TABLESPACE/);
});

test('materialized views place their data and backing index separately without editing SELECT text', () => {
  const ddl = `CREATE MATERIALIZED VIEW MV TABLESPACE OLD_DATA BUILD IMMEDIATE USING INDEX TABLESPACE OLD_IDX REFRESH FORCE ON DEMAND AS SELECT 'TABLESPACE OLD_DATA' AS TXT FROM T;`;
  const sql = apply(ddl, 'MATERIALIZED VIEW', both);
  assert.match(sql, /MV TABLESPACE "APP_DATA" BUILD IMMEDIATE USING INDEX TABLESPACE "APP_IDX" REFRESH/);
  assert.match(sql, /SELECT 'TABLESPACE OLD_DATA' AS TXT FROM T/);
  const noClauses = 'CREATE MATERIALIZED VIEW MV BUILD IMMEDIATE REFRESH COMPLETE ON DEMAND AS SELECT * FROM T;';
  assert.match(apply(noClauses, 'MATERIALIZED VIEW', both), /MV TABLESPACE "APP_DATA" BUILD IMMEDIATE USING INDEX TABLESPACE "APP_IDX" REFRESH/);
  assert.doesNotMatch(apply('CREATE MATERIALIZED VIEW MV BUILD IMMEDIATE USING NO INDEX AS SELECT * FROM T;', 'MATERIALIZED VIEW', {indexTablespace: 'IX'}), /TABLESPACE/);
});

test('CTAS, clusters, quoted names and one-sided overrides retain their intended scope', () => {
  assert.match(apply('CREATE TABLE T AS SELECT * FROM X;', 'TABLE', both), /TABLE T TABLESPACE "APP_DATA" AS SELECT/);
  assert.match(apply('CREATE CLUSTER C (ID NUMBER);', 'CLUSTER', both), /\) TABLESPACE "APP_DATA";/);
  const ddl = 'CREATE TABLE T (ID NUMBER PRIMARY KEY USING INDEX TABLESPACE OLD_IDX) TABLESPACE OLD_DATA;';
  const tableOnly = apply(ddl, 'TABLE', {tableTablespace: '"Data Files"'});
  assert.match(tableOnly, /TABLESPACE OLD_IDX/); assert.match(tableOnly, /TABLESPACE "Data Files"/);
  const indexOnly = apply(ddl, 'TABLE', {indexTablespace: 'NEW_IDX'});
  assert.match(indexOnly, /TABLESPACE OLD_DATA/); assert.match(indexOnly, /TABLESPACE "NEW_IDX"/);
});

test('only CREATE clauses change; unrelated types, ALTERs, defaults and missing overrides remain untouched', () => {
  const ddl = 'CREATE TABLE T (ID NUMBER); ALTER TABLE T MOVE TABLESPACE KEEP; CREATE INDEX IX ON T (ID);';
  const sql = apply(ddl, 'TABLE', both);
  assert.match(sql, /ALTER TABLE T MOVE TABLESPACE KEEP;/); assert.match(sql, /CREATE INDEX IX ON T \(ID\) TABLESPACE "APP_IDX";/);
  assert.equal(apply(ddl, 'TABLE', {}), ddl);
  const view = "CREATE VIEW V AS SELECT 'TABLESPACE KEEP' TXT FROM T;";
  assert.equal(apply(view, 'VIEW', both), view);
  assert.doesNotMatch(apply('CREATE TABLE T (ID NUMBER PRIMARY KEY) ORGANIZATION INDEX;', 'TABLE', {indexTablespace: 'I'}), /USING INDEX/);
  assert.throws(() => apply('CREATE GLOBAL TEMPORARY TABLE T (ID NUMBER);', 'TABLE', both), /temporary, external/);
});


test('object tables and cluster indexes receive placement after their complete headers', () => {
  assert.match(apply('CREATE TABLE OT OF "S"."OBJ_T" (PRIMARY KEY (ID));', 'TABLE', both), /OF "S"\."OBJ_T" \(PRIMARY KEY \(ID\) USING INDEX TABLESPACE "APP_IDX"\) TABLESPACE "APP_DATA"/);
  assert.match(apply('CREATE INDEX IX ON CLUSTER "S"."C";', 'INDEX', both), /ON CLUSTER "S"\."C" TABLESPACE "APP_IDX";/);
  assert.throws(() => apply('CREATE INDEX IX ON T (TXT) INDEXTYPE IS CTXSYS.CONTEXT;', 'INDEX', both), /index-type storage parameters/);
});
