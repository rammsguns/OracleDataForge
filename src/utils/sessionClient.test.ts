import test from "node:test";
import assert from "node:assert/strict";
import { sessionClient } from "./sessionClient.ts";

test("recognizes Toad and SQL Developer even when Oracle reports a generic driver", () => {
  assert.equal(sessionClient({ program: "JDBC Thin Client", module: "SQL Developer" }), "SQL Developer");
  assert.equal(sessionClient({ program: "Toad.exe", module: null }), "Toad");
  assert.equal(sessionClient({ program: "JDBC Thin Client", clientInfo: "Toad for Oracle" }), "Toad");
  assert.equal(sessionClient({ module: "PL/SQL Developer", program: "sqlplus.exe" }), "PL/SQL Developer");
  assert.equal(sessionClient({ module: "nodele", program: "OracleDataForge/1.0.0", clientDriver: "node-oracledb : 7.0.1 thn" }), "OracleDataForge");
});

test("falls back to the reported program or driver instead of an empty client", () => {
  assert.equal(sessionClient({ program: "JDBC Thin Client", module: null }), "JDBC Thin Client");
  assert.equal(sessionClient({ program: "node", module: "nodele", clientDriver: "node-oracledb : 7.0.1 thn" }), "node-oracledb");
  assert.equal(sessionClient({ program: null, module: null }), "Not reported");
});
