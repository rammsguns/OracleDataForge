import assert from "node:assert/strict";
import test from "node:test";
import { compileScript, ddlScript, fmtDuration, gatherStatsScript, healthLabel, healthScore, planScript, sessionScript } from "./dbaAdvisor.ts";

test("health score subtracts per severity and floors at zero", () => {
  assert.equal(healthScore([]), 100);
  assert.equal(healthScore(["good"]), 100);
  assert.equal(healthScore(["warning", "serious"]), 84);
  assert.equal(healthScore(["critical", "critical", "critical", "critical", "critical"]), 0);
  assert.equal(healthLabel(90).tone, "ok");
  assert.equal(healthLabel(70).tone, "warn");
  assert.equal(healthLabel(10).tone, "err");
});

test("durations pick a readable unit", () => {
  assert.equal(fmtDuration(0.25), "250 ms");
  assert.equal(fmtDuration(3.456), "3.46 s");
  assert.equal(fmtDuration(90), "1.5 min");
  assert.equal(fmtDuration(7200), "2.0 h");
});

test("scripts quote dictionary values", () => {
  assert.match(planScript("abc"), /DISPLAY_CURSOR\('abc'/);
  assert.match(ddlScript("O'X", "N", "PACKAGE BODY"), /'PACKAGE_BODY', 'N', 'O''X'/);
  assert.equal(
    compileScript([{ owner: "APP", name: "PKG", type: "PACKAGE BODY" }, { owner: "APP", name: 'V"1', type: "VIEW" }]).split("\n").slice(1).join("\n"),
    'ALTER PACKAGE "APP"."PKG" COMPILE BODY;\nALTER VIEW "APP"."V""1" COMPILE;'
  );
  assert.match(gatherStatsScript([{ owner: "APP", table: "T" }]), /ownname => 'APP', tabname => 'T'/);
  // the kill statement is left commented out for review
  assert.match(sessionScript(12, 34), /^-- ALTER SYSTEM KILL SESSION '12,34' IMMEDIATE;$/m);
});
