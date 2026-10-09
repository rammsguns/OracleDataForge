import test from "node:test";
import assert from "node:assert/strict";
import type { OracleSession } from "./api";
import { matchesSessionColumnFilters, sessionGridColumns } from "./sessionGrid";

const row = {
  instance: 1, sid: 12, serial: 345, username: "SCOTT", status: "INACTIVE",
  program: "JDBC Thin Client", module: "SQL Developer", machine: "workstation",
  sqlId: "abc123", event: "SQL*Net message from client",
} as OracleSession;

test("status and numeric identifiers use exact matching", () => {
  assert.equal(matchesSessionColumnFilters(row, { status: "ACTIVE" }), false);
  assert.equal(matchesSessionColumnFilters(row, { status: " inactive " }), true);
  assert.equal(matchesSessionColumnFilters(row, { sid: "2" }), false);
  assert.equal(matchesSessionColumnFilters(row, { sid: "12", instance: "1", serial: "345" }), true);
});

test("each text column filters the value displayed in the grid", () => {
  for (const column of sessionGridColumns) {
    const value = column.value(row);
    if (typeof value !== "string") continue;
    const query = column.key === "status" ? value.toLowerCase() : value.slice(0, 3).toLowerCase();
    assert.equal(matchesSessionColumnFilters(row, { [column.key]: query }), column.key !== "status" || query === value.toLowerCase(), column.label);
    assert.equal(matchesSessionColumnFilters(row, { [column.key]: "no such value" }), false, column.label);
  }
  assert.equal(matchesSessionColumnFilters(row, { client: "sql developer", program: "jdbc", username: "sco" }), true);
  assert.equal(matchesSessionColumnFilters(row, { client: "sql developer", status: "ACTIVE" }), false);
});

test("resource thresholds combine, preserve zero, and exclude unavailable counters", async () => {
  const {matchesSessionThresholds} = await import("./sessionGrid");
  const resourceRow = {...row, activeSeconds: null, pgaMb: 256, cpuSeconds: 0};
  assert.equal(matchesSessionThresholds(resourceRow, {pgaMb: "128", cpuSeconds: "0"}), true);
  assert.equal(matchesSessionThresholds(resourceRow, {pgaMb: "512"}), false);
  assert.equal(matchesSessionThresholds(resourceRow, {activeSeconds: "0"}), false);
  assert.equal(matchesSessionThresholds(resourceRow, {pgaMb: "-1"}), false);
});

test("rates use elapsed time and never cross session identities or reset counters", async () => {
  const {sampleSessionRates} = await import("./sessionGrid");
  const previous = {...row, logonTime: "2026-10-09", cpuSeconds: 10, readMb: 20, writeMb: 50};
  const current = {...previous, cpuSeconds: 15, readMb: 40, writeMb: 10};
  const [sample] = sampleSessionRates([current], [previous], 10);
  assert.equal(sample.cpuPercent, 50);
  assert.equal(sample.readMbps, 2);
  assert.equal(sample.writeMbps, null);
  assert.equal(sampleSessionRates([{...current, serial: 999}], [previous], 10)[0].cpuPercent, null);
  assert.equal(sampleSessionRates([current], [], 10)[0].cpuPercent, null);
  assert.equal(sampleSessionRates([current], [previous], 0)[0].cpuPercent, null);
});
