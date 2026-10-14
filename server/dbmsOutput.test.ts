import assert from "node:assert/strict";
import test from "node:test";
import type oracledb from "oracledb";
import { readDbmsOutput, withDbmsOutput } from "./dbmsOutput.ts";

function session(lines: (string | null)[], unavailable = false) {
  const calls: string[] = [];
  const conn = {
    execute: async (sql: string) => {
      calls.push(sql);
      if (unavailable) throw new Error("Output unavailable");
      return sql.includes("GET_LINES") ? { outBinds: { lines, n: lines.length } } : {};
    },
  } as unknown as Pick<oracledb.Connection, "execute">;
  return { conn, calls };
}

test("captures lines and cleans up the same session without committing", async () => {
  const { conn, calls } = session(["hello", null, "world"]);
  const result = await withDbmsOutput(conn, async () => {
    calls.push("user statement");
    return 42;
  });
  assert.deepEqual(result, { result: 42, dbmsOutput: ["hello", "", "world"], dbmsOutputTruncated: false });
  assert.match(calls[0], /DISABLE.*ENABLE\(NULL\)/);
  assert.equal(calls[1], "user statement");
  assert.match(calls[2], /GET_LINES/);
  assert.match(calls[3], /DISABLE/);
  assert.ok(calls.every(sql => !sql.includes("COMMIT")));
});

test("preserves the Oracle error and output printed before failure", async () => {
  const { conn, calls } = session(["before failure"]);
  const failure = Object.assign(new Error("failed"), { errorNum: 20001, offset: 12 });
  await assert.rejects(withDbmsOutput(conn, async () => { throw failure; }), error => {
    assert.equal(error, failure);
    assert.equal(failure.errorNum, 20001);
    assert.deepEqual((error as Error & { dbmsOutput?: string[] }).dbmsOutput, ["before failure"]);
    return true;
  });
  assert.match(calls.at(-1)!, /DISABLE/);
});

test("only marks output truncated when more than 1,000 lines are present", async () => {
  assert.equal((await readDbmsOutput(session(Array(1000).fill("line")).conn)).truncated, false);
  const output = await readDbmsOutput(session(Array(1001).fill("line")).conn);
  assert.equal(output.lines.length, 1000);
  assert.equal(output.truncated, true);
});

test("output package failures do not prevent execution", async () => {
  const { conn } = session([], true);
  assert.deepEqual(await withDbmsOutput(conn, async () => "ok"), {
    result: "ok", dbmsOutput: [], dbmsOutputTruncated: false,
  });
});
