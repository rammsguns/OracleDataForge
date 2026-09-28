/** Session identifiers are interpolated into ALTER SYSTEM, so accept only Oracle integers. */
export function sessionIdentifier(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Invalid session identifier.");
  const raw = String(value);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("Invalid session identifier.");
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid session identifier.");
  return number;
}

export function killSessionSql(sid: unknown, serial: unknown, instance?: unknown): string {
  const identity = `${sessionIdentifier(sid)},${sessionIdentifier(serial)}`;
  const target = instance === undefined ? identity : `${identity},@${sessionIdentifier(instance)}`;
  return `ALTER SYSTEM KILL SESSION '${target}' IMMEDIATE`;
}

export const sessionColumns = `
  s.sid AS "sid", s.serial# AS "serial", s.username AS "username",
  s.status AS "status", s.machine AS "machine", s.program AS "program",
  s.module AS "module", s.action AS "action", s.osuser AS "osUser",
  s.process AS "process", s.terminal AS "terminal", s.client_info AS "clientInfo",
  s.schemaname AS "schemaName", s.logon_time AS "logonTime",
  s.last_call_et AS "lastCallSeconds", s.sql_id AS "sqlId",
  s.prev_sql_id AS "previousSqlId", s.event AS "event",
  s.wait_class AS "waitClass", s.state AS "waitState",
  s.blocking_session AS "blockingSid", s.client_identifier AS "clientIdentifier",
  s.service_name AS "serviceName"`;

export const globalSessionsSql = `SELECT s.inst_id AS "instance", ${sessionColumns}
  FROM gv$session s WHERE s.type = 'USER' ORDER BY s.inst_id, s.sid`;

export const localSessionsSql = `SELECT TO_NUMBER(SYS_CONTEXT('USERENV','INSTANCE')) AS "instance", ${sessionColumns}
  FROM v$session s WHERE s.type = 'USER' ORDER BY s.sid`;

const connectInfoColumns = `
  c.sid AS "sid", c.serial# AS "serial",
  MAX(c.client_driver) AS "clientDriver",
  MAX(c.client_version) AS "clientVersion",
  MAX(c.client_connection) AS "clientConnection",
  MAX(c.client_oci_library) AS "clientOciLibrary"`;

export const globalConnectInfoSql = `SELECT c.inst_id AS "instance", ${connectInfoColumns}
  FROM gv$session_connect_info c GROUP BY c.inst_id, c.sid, c.serial#`;

export const localConnectInfoSql = `SELECT TO_NUMBER(SYS_CONTEXT('USERENV','INSTANCE')) AS "instance", ${connectInfoColumns}
  FROM v$session_connect_info c GROUP BY c.sid, c.serial#`;
