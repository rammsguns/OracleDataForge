import assert from "node:assert/strict";
import test from "node:test";
import { isConnectionFailure } from "./connectionStatus";

test("recognizes connection establishment, authentication and lost-session failures", () => {
  for (const message of [
    "NJS-503: connection could not be established. connect EACCES 192.0.2.1:1521",
    "NJS-511: connection to listener was refused",
    "ORA-01017: invalid username/password; logon denied",
    "ORA-12514: listener does not currently know of service",
    "ORA-03113: end-of-file on communication channel",
    "connect ECONNREFUSED", "connect ETIMEDOUT", "Failed to fetch",
  ]) assert.equal(isConnectionFailure(message), true, message);
});

test("SQL, privilege and transaction errors do not mean the connection failed", () => {
  for (const message of [
    "ORA-00942: table or view does not exist",
    "ORA-00900: invalid SQL statement",
    "ORA-01031: insufficient privileges",
    "ORA-00001: unique constraint violated",
    "TRANSACTION-EXPIRED: start a new worksheet session",
    "Write confirmation required", "403 Forbidden",
  ]) assert.equal(isConnectionFailure(message), false, message);
});
