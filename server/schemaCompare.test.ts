import test from "node:test";
import assert from "node:assert/strict";
import type oracledb from "oracledb";
import { compareCatalog, compareDataLiteral, compareSchema, compareSchemaObjects, compareTableData, diffCompareData, remapSxml } from "./schemaCompare.ts";
import { targetNamespaceCollision, compareObjectKey, deploymentScript, type CompareCatalog, type SchemaCompareRequest, type SchemaCompareResult } from "../src/utils/schemaCompare.ts";

test("schema names preserve quoted case and reject SQL fragments", () => {
  assert.equal(compareSchema("dev", "OTHER"), "DEV");
  assert.equal(compareSchema('"Mixed Case"', "OTHER"), "Mixed Case");
  assert.equal(compareSchema("", "APP"), "APP");
  assert.throws(() => compareSchema("DEV; DROP USER PROD", "APP"));
});
test("SXML remapping only rewrites schema elements, escaping XML characters", () => {
  assert.equal(remapSxml("<SCHEMA>DEV</SCHEMA><NAME>DEV</NAME><SCHEMA>OTHER</SCHEMA>", "DEV", "A&B"),
    "<SCHEMA>A&amp;B</SCHEMA><NAME>DEV</NAME><SCHEMA>OTHER</SCHEMA>");
});
test("data diff matches composite keys, handles precision, nulls and escaped literals", () => {
  const cols = [{ name: "ID", type: "NUMBER" }, { name: "CODE", type: "VARCHAR2" }, { name: "VALUE", type: "VARCHAR2" }];
  const result = diffCompareData([
    { ID: "9007199254740993", CODE: "A", VALUE: "O'Brien" },
    { ID: "2", CODE: "A", VALUE: null },
  ], [
    { ID: "3", CODE: "A", VALUE: "deleted" },
    { ID: "9007199254740993", CODE: "A", VALUE: "old" },
  ], cols, ["ID", "CODE"], '"PROD"."ITEMS"');
  assert.equal(result.status, "different");
  assert.deepEqual([result.inserted, result.updated, result.deleted], [1, 1, 1]);
  assert.match(result.script, /O''Brien/);
  assert.match(result.script, /9007199254740993/);
  assert.match(result.script, /VALUES \(2, 'A', NULL\)/);
  assert.ok(result.script.startsWith("DELETE"));
});
test("data equality is independent of fetch order and duplicate keys block scripts", () => {
  const cols = [{ name: "ID", type: "NUMBER" }];
  assert.equal(diffCompareData([{ ID: "1" }, { ID: "2" }], [{ ID: "2" }, { ID: "1" }], cols, ["ID"], "T").status, "same");
  const duplicate = diffCompareData([{ ID: "1" }, { ID: "1" }], [], cols, ["ID"], "T");
  assert.equal(duplicate.status, "skipped"); assert.equal(duplicate.script, "");
  assert.throws(() => compareDataLiteral("0); DELETE FROM T;--", "NUMBER"));
  assert.equal(compareDataLiteral("12.34E+10", "NUMBER"), "12.34E+10");
  assert.match(compareDataLiteral("2030-01-01 12:00:00", "DATE"), /^TO_DATE\(/);
  assert.equal(compareDataLiteral("你好", "NVARCHAR2"), "N'你好'");
  assert.equal(compareDataLiteral("a\n/\nb", "VARCHAR2"), "'a' || CHR(10) || '/' || CHR(10) || 'b'");
  assert.ok(compareDataLiteral("x".repeat(4000), "VARCHAR2").includes(" || "));
});
const object = { name: "P", type: "PROCEDURE" };
const catalog: CompareCatalog = { schema: "DEV", objects: [object], types: ["PROCEDURE"] };
const input: SchemaCompareRequest = { sourceId: "dev", sourceSchema: "DEV", targetSchema: "PROD", objects: [object], compareData: false, rowLimit: 1000, includeStorage: false };
function fakeConnection(execute: (sql: string, binds: Record<string, unknown>) => unknown) {
  return { execute: async (sql: string, binds: Record<string, unknown>) => execute(sql, binds) } as unknown as oracledb.Connection;
}
test("metadata errors propagate, never become an empty equal catalog", async () => {
  const conn = fakeConnection(() => { throw new Error("ORA-01031"); });
  await assert.rejects(() => compareCatalog(conn, "DEV"), /ORA-01031/);
  const [r] = await compareSchemaObjects(conn, conn, input, catalog, { ...catalog, schema: "PROD" });
  assert.equal(r.status, "error"); assert.match(r.warning!, /ORA-01031/);
});
test("source DDL is mapped to target while literals retain their meaning", async () => {
  const src = fakeConnection(() => ({ outBinds: { output: `CREATE OR REPLACE PROCEDURE "DEV"."P" AS BEGIN DEV.RUN; dbms_output.put_line('DEV.RUN'); END;\n/` } }));
  const dst = fakeConnection(() => ({ outBinds: { output: "CREATE OR REPLACE PROCEDURE P AS BEGIN NULL; END;\n/" } }));
  const [r] = await compareSchemaObjects(src, dst, input, catalog, { ...catalog, schema: "PROD" });
  assert.equal(r.status, "changed"); assert.match(r.script, /"PROD"\."P"/);
  assert.match(r.script, /"PROD"\.RUN/); assert.match(r.script, /'DEV.RUN'/);
});
test("cross-database ALTER generation submits target first and desired source second", async () => {
  let documents: Record<string, unknown> = {};
  const src = fakeConnection(sql => {
    if (sql.includes("'SXML'")) {
      assert.match(sql, /'PHYSICAL_PROPERTIES', FALSE/);
      return { outBinds: { output: "<TABLE><SCHEMA>DEV</SCHEMA><NAME>T</NAME></TABLE>" } };
    }
    return { outBinds: { output: "CREATE TABLE DEV.T (ID NUMBER, X NUMBER);" } };
  });
  const dst = fakeConnection((sql, binds) => {
    if (sql.includes("'SXML'")) return { outBinds: { output: "<TABLE><SCHEMA>PROD</SCHEMA><NAME>T</NAME><OLD/></TABLE>" } };
    if (sql.includes("OPENC")) { documents = binds; return { outBinds: { output: 'ALTER TABLE "PROD"."T" ADD X NUMBER; ' } }; }
    return { outBinds: { output: "CREATE TABLE PROD.T (ID NUMBER);" } };
  });
  const tables = { schema: "DEV", objects: [{ name: "T", type: "TABLE" }], types: ["TABLE"] };
  const [r] = await compareSchemaObjects(src, dst, { ...input, objects: tables.objects }, tables, { ...tables, schema: "PROD" });
  assert.equal(r.status, "changed"); assert.match(r.script, /ALTER TABLE "PROD"/);
  assert.match((documents.targetDoc as { val: string }).val, /<OLD\/>/);
  assert.equal((documents.sourceDoc as { val: string }).val, "<TABLE><SCHEMA>PROD</SCHEMA><NAME>T</NAME></TABLE>");
});
test("unsupported types and failed ALTER generation require manual review", async () => {
  const conn = fakeConnection(sql => {
    if (sql.includes("'SXML'")) throw new Error("SXML unavailable");
    return { outBinds: { output: "source" } };
  });
  const dst = fakeConnection(() => ({ outBinds: { output: "target" } }));
  const objects = [{ name: "T", type: "TABLE" }, { name: "J", type: "JOB" }];
  const cat = { schema: "DEV", objects, types: ["TABLE", "JOB"] };
  const results = await compareSchemaObjects(conn, dst, { ...input, objects }, cat, cat);
  const t = results.find(o => o.name === "T")!;
  assert.equal(t.status, "changed"); assert.equal(t.script, ""); assert.match(t.warning!, /Manual migration required/);
  assert.equal(results.find(o => o.name === "J")!.status, "error");
});
test("data row caps never report equality or generate partial synchronization", async () => {
  const conn = fakeConnection(sql => {
    if (sql.includes("all_tab_cols")) return { rows: [{ COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", VIRTUAL_COLUMN: "NO", IDENTITY_COLUMN: "NO" }] };
    if (sql.includes("all_constraints")) return { rows: [{ COLUMN_NAME: "ID" }] };
    assert.match(sql, /FETCH FIRST 3 ROWS ONLY/);
    return { rows: [{ ID: "1" }, { ID: "2" }, { ID: "3" }] };
  });
  const result = await compareTableData(conn, conn, "DEV", "PROD", "T", 2);
  assert.equal(result.status, "limited"); assert.equal(result.script, "");
});
test("tables without primary keys and tables with LOBs are explicitly skipped", async () => {
  for (const type of ["NUMBER", "CLOB"]) {
    const conn = fakeConnection(sql => sql.includes("all_tab_cols") ? { rows: [{ COLUMN_NAME: "X", DATA_TYPE: type }] } : { rows: [] });
    const result = await compareTableData(conn, conn, "DEV", "PROD", "T", 2);
    assert.equal(result.status, "skipped"); assert.equal(result.script, "");
  }
});
test("database links never reach the metadata exporter or exported definitions", async () => {
  let calls = 0;
  const conn = fakeConnection(() => { calls++; throw new Error("Database-link metadata must not be read"); });
  const objects = [{ name: "REMOTE_DB", type: "DATABASE LINK" }];
  const cat = { schema: "DEV", objects, types: ["DATABASE LINK"] };
  const [result] = await compareSchemaObjects(conn, conn, { ...input, objects }, cat, cat);
  assert.equal(calls, 0);
  assert.equal(result.status, "error");
  assert.match(result.warning!, /not supported/);
  assert.equal(result.sourceDdl, ""); assert.equal(result.targetDdl, ""); assert.equal(result.script, "");
});
test("data comparison rejects different lengths, precision, scale, semantics and nullability before reading rows", async () => {
  for (const field of ["DATA_LENGTH", "CHAR_LENGTH", "CHAR_USED", "DATA_PRECISION", "DATA_SCALE", "NULLABLE"]) {
    const source = fakeConnection(sql => {
      assert.ok(sql.includes("all_tab_cols"));
      assert.match(sql, new RegExp("\\b" + field + "\\b", "i"));
      return { rows: [{ COLUMN_NAME: "X", DATA_TYPE: "NUMBER", [field]: "source" }] };
    });
    const target = fakeConnection(sql => {
      assert.ok(sql.includes("all_tab_cols"));
      return { rows: [{ COLUMN_NAME: "X", DATA_TYPE: "NUMBER", [field]: "target" }] };
    });
    const result = await compareTableData(source, target, "DEV", "PROD", "T", 2);
    assert.equal(result.status, "skipped"); assert.match(result.message, /Column layouts differ/);
    assert.equal(result.script, "");
  }
});
test("mixed-case schema qualifiers are remapped without changing literal contents", async () => {
  const src = fakeConnection(() => ({ outBinds: { output: `CREATE PROCEDURE "Dev App"."P" AS BEGIN "Dev App".RUN; dbms_output.put_line('Dev App'); END;` } }));
  const dst = fakeConnection(() => ({ outBinds: { output: "other definition" } }));
  const [r] = await compareSchemaObjects(src, dst, { ...input, sourceSchema: "Dev App", targetSchema: 'Prod"App' }, catalog, catalog);
  assert.match(r.script, /"Prod""App"\."P"/);
  assert.match(r.script, /'Dev App'/);
});
test("script exports only selected objects, gates drops and data, and keeps DDL before DML", () => {
  const key = compareObjectKey(object);
  const removed = { name: "OLD", type: "TABLE" };
  const dropKey = compareObjectKey(removed);
  const result: SchemaCompareResult = { sourceSchema: "DEV", targetSchema: "PROD", sourceName: "Dev", targetName: "Prod", comparedAt: "2026-11-24", objects: [
    { ...object, key, status: "changed", sourceDdl: "", targetDdl: "", script: "CREATE OR REPLACE PROCEDURE P AS BEGIN NULL; END;\n/", data: { status: "different", inserted: 0, updated: 1, deleted: 0, message: "Changed", samples: [], script: "UPDATE T SET X = 1;" } },
    { ...removed, key: dropKey, status: "targetOnly", sourceDdl: "", targetDdl: "", script: "DROP TABLE OLD;" },
  ] };
  const normal = deploymentScript(result, new Set([key, dropKey]), false, false);
  assert.ok(!normal.includes("DROP TABLE OLD;")); assert.ok(!normal.includes("UPDATE T SET"));
  const full = deploymentScript(result, new Set([key, dropKey]), true, true);
  assert.ok(full.indexOf("DROP TABLE OLD;") < full.indexOf("UPDATE T SET"));
  assert.match(full, /CURRENT_SCHEMA = "PROD"/);
  assert.ok(!deploymentScript(result, new Set(), true, true).includes("CREATE OR REPLACE PROCEDURE"));
});


test('comparison blocks shared-namespace collisions without reading or exposing DDL', async () => {
  const view = {name: 'V', type: 'VIEW'};
  const sourceCatalog = {schema: 'DEV', objects: [view], types: ['VIEW']};
  const targetCatalog = {schema: 'PROD', objects: [{name: 'V', type: 'TABLE'}], types: ['TABLE']};
  const conn = fakeConnection(() => {throw new Error('Metadata must not be read for a collision');});
  const [result] = await compareSchemaObjects(conn, conn, {...input, objects: [view]}, sourceCatalog, targetCatalog);
  assert.equal(result.status, 'error'); assert.equal(result.script, '');
  assert.match(result.warning!, /VIEW V conflicts with existing TABLE V/);
});

test('Oracle namespace collision checks allow package bodies and separate index/trigger namespaces', () => {
  const target = {schema: 'PROD', objects: [{name: 'P', type: 'PACKAGE'}, {name: 'T', type: 'INDEX'}, {name: 'X', type: 'TRIGGER'}], types: []};
  assert.equal(targetNamespaceCollision({name: 'P', type: 'PACKAGE BODY'}, target), undefined);
  assert.equal(targetNamespaceCollision({name: 'T', type: 'TABLE'}, target), undefined);
  assert.equal(targetNamespaceCollision({name: 'X', type: 'TABLE'}, target), undefined);
  assert.equal(targetNamespaceCollision({name: 'P', type: 'TABLE'}, target)?.type, 'PACKAGE');
});


test('creation tablespaces affect deployment DDL while source definitions and existing target objects stay unchanged', async () => {
  const table = {name: 'T', type: 'TABLE'};
  const ddl = 'CREATE TABLE "DEV"."T" (ID NUMBER PRIMARY KEY);';
  const src = fakeConnection(() => ({outBinds: {output: ddl}}));
  const dst = fakeConnection(() => ({outBinds: {output: ddl.replace('DEV', 'PROD')}}));
  const catalog = {schema: 'DEV', objects: [table], types: ['TABLE']};
  const req = {...input, objects: [table], tableTablespace: 'DATA_T', indexTablespace: 'INDEX_T'};
  const [missing] = await compareSchemaObjects(src, dst, req, catalog, {...catalog, schema: 'PROD', objects: []});
  assert.equal(missing.sourceDdl, ddl);
  assert.match(missing.script, /USING INDEX TABLESPACE "INDEX_T"\) TABLESPACE "DATA_T"/);
  const [existing] = await compareSchemaObjects(src, dst, req, catalog, {...catalog, schema: 'PROD'});
  assert.equal(existing.status, 'same'); assert.equal(existing.script, '');
});
