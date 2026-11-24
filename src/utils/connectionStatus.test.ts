import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionStatusRequests, isConnectionFailure } from "./connectionStatus";

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


test("a late query response cannot mark a deliberately disconnected connection connected", async () => {
  const requests = new ConnectionStatusRequests();
  let status = "connected";
  let resolveQuery!: () => void;
  const query = new Promise<void>(resolve => { resolveQuery = resolve; });
  const isCurrent = requests.capture("a");
  const response = query.then(() => { if (isCurrent()) status = "connected"; });
  requests.invalidate("a");
  status = "idle";
  resolveQuery();
  await response;
  assert.equal(status, "idle");
});

test("old failures cannot overwrite a reconnected session and other connections remain current", () => {
  const requests = new ConnectionStatusRequests();
  const oldSession = requests.capture("a");
  const otherConnection = requests.capture("b");
  requests.invalidate("a");
  const reconnectedSession = requests.capture("a");
  assert.equal(oldSession(), false);
  assert.equal(otherConnection(), true);
  assert.equal(reconnectedSession(), true);
  requests.invalidate("a");
  assert.equal(reconnectedSession(), false);
});
