import test from "node:test";
import assert from "node:assert/strict";
import { memorySql, storageSql, storageChangeSql } from "../src/utils/dbaSql.ts";
import { appendDbaAudit, readDbaAudit } from "./dbaAudit.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectManagementQueries } from "./dbaManagement.ts";
import { dbaModules } from "../src/utils/dbaModules.ts";
import { tablespaceCapacity, type StorageRow } from "../src/utils/tablespaceCapacity.ts";
import { storageDestinations } from "../src/utils/storageDestinations.ts";

test("tablespace deletion keeps physical files unless explicitly requested and protects system tablespaces", () => {
  const change = { action: "drop", name: 'APP"DATA', path: "", mb: "1", temporary: false };
  assert.equal(storageChangeSql(change), 'DROP TABLESPACE "APP""DATA" INCLUDING CONTENTS KEEP DATAFILES;');
  assert.match(storageChangeSql({ ...change, deleteFiles: true }), /INCLUDING CONTENTS AND DATAFILES;/);
  for (const name of ["SYSTEM", "SYSAUX", ""]) assert.throws(() => storageChangeSql({ ...change, name }));
  assert.throws(() => storageChangeSql({ ...change, deleteFiles: "false" as unknown as boolean }));
});

test("automatic growth uses bounded integer sizes and preserves tempfile syntax", () => {
  const change = { action: "autoextend", name: "APP", path: "/db/app.dbf", mb: "1", temporary: true, autoextend: true, nextMb: "128", maxMb: "4096" };
  assert.equal(storageChangeSql(change), "ALTER DATABASE TEMPFILE '/db/app.dbf' AUTOEXTEND ON NEXT 128M MAXSIZE 4096M;");
  assert.match(storageChangeSql({ ...change, autoextend: false }), /AUTOEXTEND OFF;/);
  assert.equal(storageChangeSql({ ...change, bigfile: true }), 'ALTER TABLESPACE "APP" AUTOEXTEND ON NEXT 128M MAXSIZE 4096M;');
  for (const maxMb of ["0", "127", "1; DROP TABLE X", "Infinity"]) assert.throws(() => storageChangeSql({ ...change, maxMb }));
  assert.equal(storageChangeSql({ ...change, action: "readOnly" }), 'ALTER TABLESPACE "APP" READ ONLY;');
  assert.equal(storageChangeSql({ ...change, action: "readWrite" }), 'ALTER TABLESPACE "APP" READ WRITE;');
});

test("audit persists separate attempt/outcome records and isolates connections", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dataforge-audit-"));
  const file = path.join(directory, "audit.jsonl");
  try {
    const event = { id: "one", connection: "db-a", sql: "ALTER TABLESPACE X READ ONLY;", actor: "tester" };
    appendDbaAudit(file, { ...event, outcome: "attempt" });
    appendDbaAudit(file, { ...event, outcome: "success" });
    appendDbaAudit(file, { ...event, connection: "db-b", outcome: "attempt" });
    const entries = readDbaAudit(file, "db-a");
    assert.deepEqual(entries.map(e => e.outcome), ["success", "attempt"]);
    assert.ok(entries.every(e => e.timestamp && e.id === "one" && e.actor === "tester"));
    assert.throws(() => appendDbaAudit(directory, event));
    assert.equal(readDbaAudit(file, "unknown").length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("file suggestions prioritize matching kinds and avoid existing filenames", () => {
  const files = [
    { File: "/db/users.dbf", Kind: "DATAFILE" },
    { File: "/temp/temp.dbf", Kind: "TEMPFILE" },
    { File: "/db/APP_01.dbf", Kind: "DATAFILE" },
    { File: "C:\\oradata\\users.dbf", Kind: "DATAFILE" },
  ];
  assert.deepEqual(storageDestinations(files, "APP", false), ["/db/APP_02.dbf", "C:\\oradata\\APP_01.dbf", "/temp/APP_01.dbf"]);
  assert.equal(storageDestinations(files, "APP", true)[0], "/temp/APP_01.dbf");
});

test("ASM suggestions use disk groups and filenames sanitize tablespace names", () => {
  assert.deepEqual(storageDestinations([{ File: "+DATA/DB/DATAFILE/users.123.456" }, { File: "+DATA/DB/DATAFILE/system.234.567" }], "APP", false), ["+DATA"]);
  assert.deepEqual(storageDestinations([{ File: "/db/users.dbf" }], "../APP", false), ["/db/___APP_01.dbf"]);
  assert.deepEqual(storageDestinations([{ File: null }], "", false), []);
});

test("tablespace alerts use remaining Oracle capacity and exact threshold boundaries", () => {
  for (const [used, health] of [[0, "Healthy"], [84.99, "Healthy"], [85, "Warning"], [94.99, "Warning"], [95, "Critical"], [100, "Critical"], [110, "Critical"]] as const) {
    const result = tablespaceCapacity({ "Used MiB": used, "Capacity MiB": 100 });
    assert.equal(result.health, health);
    assert.equal(result.remaining, Math.max(0, 100 - used));
  }
  assert.equal(tablespaceCapacity({ "Used MiB": "90", "Capacity MiB": "1000" }).health, "Healthy");
});

test("missing, invalid and zero capacity metrics never appear healthy", () => {
  for (const row of [undefined, {}, { "Used MiB": null, "Capacity MiB": 100 }, { "Used MiB": 0, "Capacity MiB": 0 }, { "Used MiB": "invalid", "Capacity MiB": 100 }, { "Used MiB": -1, "Capacity MiB": 100 }] as (StorageRow | undefined)[]) {
    assert.equal(tablespaceCapacity(row).health, "Unknown");
    assert.equal(tablespaceCapacity(row).remaining, null);
  }
});

test("DBA request selection rejects arbitrary SQL, inherited keys, and oversized batches", () => {
  for (const value of ["", "SELECT * FROM dba_users", "__proto__", "constructor", ["users"], "users,unknown", Array(7).fill("users").join(",")]) assert.throws(() => selectManagementQueries(value));
  assert.deepEqual(selectManagementQueries("users,users,roles").map(([key]) => key), ["users", "roles"]);
  assert.equal(selectManagementQueries(undefined).length, 6);
});

test("all eleven DBA modules resolve to implemented views or allowlisted queries", () => {
  assert.equal(dbaModules.length, 11);
  const pages = dbaModules.flatMap(module => module.pages);
  assert.equal(new Set(pages.map(page => page.id)).size, pages.length);
  for (const page of pages) {
    if (page.view) assert.ok(["memory", "storage", "performance", "advisor"].includes(page.view));
    else {
      assert.ok(page.sections?.length);
      assert.equal(selectManagementQueries(page.sections!.map(([key]) => key).join(",")).length, page.sections!.length);
    }
  }
});

test("storage statements quote identifiers and paths without allowing SQL injection", () => {
  assert.equal(storageSql("create", 'DATA"X', "/db/o'ne.dbf", "1024", false), `CREATE TABLESPACE "DATA""X" DATAFILE '/db/o''ne.dbf' SIZE 1024M AUTOEXTEND OFF;`);
  assert.equal(storageSql("add", "TEMP", "/db/temp.dbf", "10", true), `ALTER TABLESPACE "TEMP" ADD TEMPFILE '/db/temp.dbf' SIZE 10M AUTOEXTEND OFF;`);
  assert.equal(storageSql("resize", "", "/db/temp.dbf", "20", true), `ALTER DATABASE TEMPFILE '/db/temp.dbf' RESIZE 20M;`);
});

test("invalid storage input cannot become a statement", () => {
  for (const mb of ["0", "-1", "1.5", "1M; DROP USER X", "Infinity", "9007199254740992"]) assert.throws(() => storageSql("create", "DATA", "/db/data.dbf", mb, false));
  assert.throws(() => storageSql("create", "", "/db/data.dbf", "10", false));
  assert.throws(() => storageSql("resize", "", "", "10", false));
  assert.throws(() => storageSql("drop", "DATA", "/db/data.dbf", "10", false));
});

test("memory changes allow only known parameters, numeric sizes and valid scopes", () => {
  assert.equal(memorySql("sga_target", "2048", "BOTH"), "ALTER SYSTEM SET sga_target = 2048M SCOPE=BOTH;");
  assert.equal(memorySql("memory_target", "0", "SPFILE"), "ALTER SYSTEM SET memory_target = 0M SCOPE=SPFILE;");
  assert.throws(() => memorySql("processes", "100", "MEMORY"));
  assert.throws(() => memorySql("sga_target", "100", "BOTH; SHUTDOWN"));
  assert.throws(() => memorySql("sga_target", "-1", "MEMORY"));
});

