import test from "node:test";
import assert from "node:assert/strict";
import { globalConnectInfoSql, globalSessionsSql, killSessionSql, localConnectInfoSql, localSessionsSql, sessionIdentifier } from "./oracleSessions.ts";

test("session identifiers cannot inject an ALTER SYSTEM statement", () => {
  assert.equal(killSessionSql(10, 42, 2), "ALTER SYSTEM KILL SESSION '10,42,@2' IMMEDIATE");
  assert.equal(killSessionSql("10", "42"), "ALTER SYSTEM KILL SESSION '10,42' IMMEDIATE");
  for (const invalid of [0, -1, 1.5, "1; DROP USER X", "01", "1,2", "1e2", Number.MAX_SAFE_INTEGER + 1, null, {}]) {
    assert.throws(() => sessionIdentifier(invalid));
    assert.throws(() => killSessionSql(invalid, 2, 1));
  }
});

test("connect-info queries join by instance, SID and serial without duplicating banner rows", () => {
  assert.match(globalConnectInfoSql, /FROM gv\$session_connect_info c GROUP BY c\.inst_id, c\.sid, c\.serial#/);
  assert.match(localConnectInfoSql, /FROM v\$session_connect_info c GROUP BY c\.sid, c\.serial#/);
  for (const sql of [globalConnectInfoSql, localConnectInfoSql]) {
    assert.match(sql, /MAX\(c\.client_driver\) AS "clientDriver"/);
    assert.match(sql, /MAX\(c\.client_version\) AS "clientVersion"/);
  }
});

test("session queries list user sessions with stable instance and serial identifiers", () => {
  assert.match(globalSessionsSql, /FROM gv\$session s WHERE s\.type = 'USER'/);
  assert.match(localSessionsSql, /FROM v\$session s WHERE s\.type = 'USER'/);
  for (const sql of [globalSessionsSql, localSessionsSql]) {
    assert.match(sql, /s\.serial# AS "serial"/);
    assert.match(sql, /AS "instance"/);
  }
});
