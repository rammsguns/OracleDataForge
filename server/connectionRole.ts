/**
 * A connection's **role**: the administrative privilege its sessions are opened with, which
 * is SQL Developer's "Role" dropdown and is spelled the same way here.
 *
 * Like `connectionExport.ts` and `oracleWallet.ts`, this sits apart from `index.ts` because
 * it is pure — a value in, a role or a privilege out — and because every value that reaches
 * it is untrusted: a request body, a registry file written by an older build, an entry
 * inside an imported export. Getting it wrong is also not a loud failure. A role that
 * silently falls back to `default` connects fine and then cannot see the data dictionary a
 * DBA opened the tool for; a privilege mapped to the wrong constant connects with more
 * authority than the user asked for. Both are worth a test rather than a reading.
 *
 * `index.ts` owns everything else about a connection: where it is stored, how it is dialled,
 * and the pool a non-privileged one draws from.
 */
import oracledb from "oracledb";

/**
 * `default` is an ordinary session. The rest are the privileges Oracle authenticates through
 * the password file rather than the data dictionary, and are the only way some accounts can
 * connect at all (SYS, an RMAN backup account, an ASM instance).
 *
 * It describes the session, not the destination, so it is deliberately not part of the
 * endpoint identity that guards a stored password — see `sameEndpoint` in `index.ts`.
 */
export type ConnectionRole = "default" | "SYSDBA" | "SYSOPER" | "SYSBACKUP" | "SYSDG" | "SYSKM" | "SYSASM";

/** Every role the connection form offers, in SQL Developer's order. */
export const CONNECTION_ROLES: ConnectionRole[] = ["default", "SYSDBA", "SYSOPER", "SYSBACKUP", "SYSDG", "SYSKM", "SYSASM"];

/**
 * The node-oracledb privilege each role is passed to the driver as. `default` is absent
 * because it has none — an ordinary session is opened by not asking for a privilege.
 *
 * node-oracledb also defines SYSPRELIM and SYSRAC, which are deliberately not offered:
 * SYSPRELIM is a modifier for starting an instance rather than a role, and neither appears
 * in SQL Developer's list.
 */
export const ORA_PRIVILEGE: Record<Exclude<ConnectionRole, "default">, number> = {
  SYSDBA: oracledb.SYSDBA,
  SYSOPER: oracledb.SYSOPER,
  SYSBACKUP: oracledb.SYSBACKUP,
  SYSDG: oracledb.SYSDG,
  SYSKM: oracledb.SYSKM,
  SYSASM: oracledb.SYSASM,
};

/**
 * The role an untrusted value asks for, or `default` when it asks for nothing this app
 * offers.
 *
 * A whitelist rather than a cast: the value arrives from a request body, from a registry
 * file that may predate the field entirely (`undefined`), or from inside an imported export
 * someone may have written by hand. Compared case-insensitively and trimmed so a file
 * spelling it `sysdba` lands on the privilege it plainly means, but never widened beyond the
 * seven roles — an unrecognised value falls back to the least privilege, not the most.
 *
 * Anything that is not a string is one of those unrecognised values. It is checked rather
 * than coerced because `String()` would quietly unwrap a JSON array — `["SYSDBA"]` stringifies
 * to `SYSDBA` — and read a privilege out of a body that never plainly asked for one.
 */
export function normalizeRole(value: unknown): ConnectionRole {
  if (typeof value !== "string") return "default";
  const asked = value.trim().toUpperCase();
  return CONNECTION_ROLES.find((r) => r.toUpperCase() === asked) ?? "default";
}

/** SYS can only connect AS SYSDBA (ORA-28009) — the privilege is applied automatically, like SQL Developer does. */
const isSysUser = (user: string) => user.trim().toLowerCase() === "sys";

/**
 * The role a connection actually connects with.
 *
 * An explicit choice wins. Otherwise SYS still gets SYSDBA on its own, which is both what
 * SQL Developer does and what keeps connections saved before the role existed — they read
 * back as `default` — working exactly as they did.
 */
export function effectiveRole(c: { user: string; role?: ConnectionRole }): ConnectionRole {
  if (c.role && c.role !== "default") return c.role;
  return isSysUser(c.user) ? "SYSDBA" : "default";
}

/** The node-oracledb privilege a connection's sessions open with, or undefined for an ordinary session. */
export function oraPrivilege(c: { user: string; role?: ConnectionRole }): number | undefined {
  const role = effectiveRole(c);
  return role === "default" ? undefined : ORA_PRIVILEGE[role];
}
