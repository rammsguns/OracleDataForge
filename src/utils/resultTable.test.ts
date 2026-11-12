import assert from "node:assert/strict";
import test from "node:test";
import { editableTableOf } from "./resultTable.ts";

test("plain single-table selects are editable", () => {
  assert.equal(editableTableOf("select * from emp", "SCOTT"), "EMP");
  assert.equal(editableTableOf("SELECT a, b FROM scott.emp e WHERE e.id = 1 ORDER BY a;", "scott"), "EMP");
  assert.equal(editableTableOf('select * from "MixedCase" fetch first 10 rows only', "X"), "MixedCase");
  assert.equal(editableTableOf("select * from emp where name = 'from x join y'", "X"), "EMP");
});

test("joins, subqueries, aggregates and other schemas are not", () => {
  for (const sql of [
    "select * from a join b on a.id = b.id", "select * from a, b", "select * from (select * from a)",
    "select distinct x from a", "select x, count(*) from a group by x", "select * from a union select * from b",
    "select * from other.emp", "update emp set a = 1", "select 1 from dual where x in (select y from z)",
  ]) assert.equal(editableTableOf(sql, "SCOTT"), null, sql);
});
