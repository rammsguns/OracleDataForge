/**
 * Tests for a connection's role — the privilege its sessions are opened with. Run with `npm test`.
 *
 * Two things are worth pinning down here, and neither fails loudly in the app.
 *
 * The first is that `normalizeRole` is a whitelist. Its input is a request body, a registry
 * file written by a build that predates the field, or an entry inside an export someone may
 * have hand-edited, and an unrecognised value has to land on the *least* privilege rather
 * than be passed through to the driver.
 *
 * The second is that the seven roles map onto the seven privileges they name. A transposed
 * entry in `ORA_PRIVILEGE` — SYSDG pointing at SYSKM — would connect perfectly well, with
 * authority the user did not ask for, so the map is checked against node-oracledb's own
 * constants rather than against a copy of the numbers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import oracledb from "oracledb";
import {
  CONNECTION_ROLES,
  effectiveRole,
  normalizeRole,
  oraPrivilege,
  ORA_PRIVILEGE,
  type ConnectionRole,
} from "./connectionRole.ts";

describe("CONNECTION_ROLES", () => {
  it("is SQL Developer's list, in SQL Developer's order", () => {
    assert.deepEqual(CONNECTION_ROLES, ["default", "SYSDBA", "SYSOPER", "SYSBACKUP", "SYSDG", "SYSKM", "SYSASM"]);
  });
});

describe("normalizeRole", () => {
  it("keeps every offered role", () => {
    for (const role of CONNECTION_ROLES) assert.equal(normalizeRole(role), role);
  });

  it("accepts the roles in any case, so a hand-written export still lands", () => {
    assert.equal(normalizeRole("sysdba"), "SYSDBA");
    assert.equal(normalizeRole("SysBackup"), "SYSBACKUP");
    assert.equal(normalizeRole("DEFAULT"), "default");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizeRole("  SYSOPER\n"), "SYSOPER");
    assert.equal(normalizeRole("\tsysasm "), "SYSASM");
  });

  it("falls back to default for a missing value, as a pre-role registry entry has", () => {
    assert.equal(normalizeRole(undefined), "default");
    assert.equal(normalizeRole(null), "default");
    assert.equal(normalizeRole(""), "default");
  });

  it("falls back to default rather than passing through an unknown role", () => {
    assert.equal(normalizeRole("SYSADMIN"), "default");
    assert.equal(normalizeRole("SYS"), "default");
    assert.equal(normalizeRole("SYSDBA; DROP"), "default");
  });

  it("refuses the node-oracledb privileges the app does not offer", () => {
    // SYSPRELIM modifies a startup rather than naming a role, and SYSRAC is not in SQL
    // Developer's list either. Both are real oracledb constants, so nothing but the
    // whitelist keeps them out.
    assert.equal(normalizeRole("SYSPRELIM"), "default");
    assert.equal(normalizeRole("SYSRAC"), "default");
  });

  it("is not fooled by a non-string, or by an inherited property name", () => {
    assert.equal(normalizeRole(2), "default");
    assert.equal(normalizeRole(["SYSDBA"]), "default");
    assert.equal(normalizeRole({ role: "SYSDBA" }), "default");
    assert.equal(normalizeRole("constructor"), "default");
    assert.equal(normalizeRole("__proto__"), "default");
    assert.equal(normalizeRole("toString"), "default");
  });
});

describe("effectiveRole", () => {
  it("uses the role that was chosen", () => {
    assert.equal(effectiveRole({ user: "CONTAAPP", role: "SYSBACKUP" }), "SYSBACKUP");
    assert.equal(effectiveRole({ user: "SYSTEM", role: "SYSDBA" }), "SYSDBA");
  });

  it("leaves an ordinary user at default", () => {
    assert.equal(effectiveRole({ user: "SYSTEM", role: "default" }), "default");
    assert.equal(effectiveRole({ user: "HR", role: "default" }), "default");
  });

  it("gives SYS SYSDBA on its own — it cannot connect any other way (ORA-28009)", () => {
    assert.equal(effectiveRole({ user: "SYS", role: "default" }), "SYSDBA");
    assert.equal(effectiveRole({ user: "sys", role: "default" }), "SYSDBA");
    assert.equal(effectiveRole({ user: "  Sys  ", role: "default" }), "SYSDBA");
  });

  it("treats a connection saved before the field existed as default", () => {
    assert.equal(effectiveRole({ user: "SYSTEM" }), "default");
    assert.equal(effectiveRole({ user: "SYS" }), "SYSDBA");
  });

  it("does not override a role SYS asked for explicitly", () => {
    assert.equal(effectiveRole({ user: "SYS", role: "SYSOPER" }), "SYSOPER");
  });

  it("only matches SYS itself, not a username that contains it", () => {
    for (const user of ["SYSTEM", "SYSAUX", "SYSBACKUP", "MYSYS", "SYS_ADMIN", "SYS.ADMIN"]) {
      assert.equal(effectiveRole({ user, role: "default" }), "default", user);
    }
  });
});

describe("ORA_PRIVILEGE", () => {
  it("covers every role but default", () => {
    assert.deepEqual(
      Object.keys(ORA_PRIVILEGE).sort(),
      CONNECTION_ROLES.filter((r) => r !== "default").sort()
    );
  });

  it("maps each role to the node-oracledb privilege of the same name", () => {
    // Against the driver's own constants, not a copy of the numbers: a transposed entry
    // here connects successfully with the wrong authority, which no other test would catch.
    for (const [role, privilege] of Object.entries(ORA_PRIVILEGE)) {
      assert.equal(privilege, (oracledb as unknown as Record<string, number>)[role], role);
    }
  });

  it("gives each role a distinct privilege", () => {
    const values = Object.values(ORA_PRIVILEGE);
    assert.equal(new Set(values).size, values.length);
  });
});

describe("oraPrivilege", () => {
  it("asks for no privilege on an ordinary session", () => {
    assert.equal(oraPrivilege({ user: "SYSTEM", role: "default" }), undefined);
    assert.equal(oraPrivilege({ user: "HR" }), undefined);
  });

  it("passes the driver the privilege the role names", () => {
    const expected: Record<Exclude<ConnectionRole, "default">, number> = {
      SYSDBA: oracledb.SYSDBA,
      SYSOPER: oracledb.SYSOPER,
      SYSBACKUP: oracledb.SYSBACKUP,
      SYSDG: oracledb.SYSDG,
      SYSKM: oracledb.SYSKM,
      SYSASM: oracledb.SYSASM,
    };
    for (const [role, privilege] of Object.entries(expected)) {
      assert.equal(oraPrivilege({ user: "CONTAAPP", role: role as ConnectionRole }), privilege, role);
    }
  });

  it("gives SYS SYSDBA without being asked", () => {
    assert.equal(oraPrivilege({ user: "SYS", role: "default" }), oracledb.SYSDBA);
    assert.equal(oraPrivilege({ user: "SYS" }), oracledb.SYSDBA);
  });

  it("carries a normalized role through end to end", () => {
    // The two halves as index.ts uses them: whatever arrives is normalized on the way into
    // the registry, and what the driver is handed comes from the stored value.
    assert.equal(oraPrivilege({ user: "CONTAAPP", role: normalizeRole("sysdba") }), oracledb.SYSDBA);
    assert.equal(oraPrivilege({ user: "CONTAAPP", role: normalizeRole("SYSPRELIM") }), undefined);
  });
});
