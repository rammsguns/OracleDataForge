import assert from "node:assert/strict";
import test from "node:test";
import { HarnessAdapter, type AssistRequest, type ContextResolver, type DataForgeActor } from "./harness/adapter.ts";
import { readConfig } from "./harness/config.ts";

const ACTOR: DataForgeActor = { id: "df-user-7", role: "Developer", durable: true };

const RESOLVER: ContextResolver = {
  targetReference: (instanceId, connectionId, schema) =>
    `dataforge:${instanceId}:${connectionId}:${schema ?? ""}`,
  databaseVersion: async () => "19.3.0.0.0",
  resolve: async () => [
    {
      category: "selected_source",
      name: "selection",
      content: "SELECT 1 FROM dual",
      provenance: "editor selection",
    },
  ],
};

function config(overrides: Record<string, string> = {}) {
  return readConfig({
    DATAFORGE_HARNESS_ENABLED: "true",
    DATAFORGE_HARNESS_URL: "http://localhost:8000",
    DATAFORGE_HARNESS_TOKEN: "odbh_test",
    ...overrides,
  });
}

function sseResponse(events: Array<[string, unknown]>): Response {
  const body = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const REQUEST: AssistRequest = {
  action: "explain",
  connectionId: "conn-9",
  schema: "HARNESS_APP",
  selection: "SELECT 1 FROM dual",
  editorId: "buffer-1",
  editorRevision: "3",
};

for (const [role, action, allowed] of [
  ["Analyst", "diagnose", false],
  ["Analyst", "explain", true],
  ["Developer", "diagnose", true],
] as const) {
  test(`${role} submitting ${action} is ${allowed ? "allowed" : "refused before context or fetch"}`, async () => {
    let calls = 0;
    let resolutions = 0;
    const adapter = new HarnessAdapter({
      config: config(), instanceId: "role-test",
      resolver: { ...RESOLVER, resolve: async (...args) => { resolutions++; return RESOLVER.resolve(...args); } },
      fetchImpl: async () => { calls++; return sseResponse([["done", { outcome: "succeeded" }]]); },
    });
    const events = [];
    for await (const event of adapter.assist({ ...ACTOR, role }, { ...REQUEST, action })) events.push(event);
    assert.equal(calls, allowed ? 1 : 0);
    assert.equal(resolutions, allowed ? 1 : 0);
    assert.equal(events[0]?.event, allowed ? "done" : "error");
    if (!allowed) assert.equal(events[0]?.data.code, "action_not_allowed");
  });
}

test("Analyst apply-check is refused without a harness fetch", async () => {
  const adapter = new HarnessAdapter({
    config: config(), instanceId: "role-test", resolver: RESOLVER,
    fetchImpl: async () => { assert.fail("must not fetch"); },
  });
  assert.deepEqual(await adapter.applyCheck({ ...ACTOR, role: "Analyst" }, "proposal", {
    editorId: "editor", revision: "1", currentText: "SELECT 1", connectionId: "conn",
  }), { canApply: false, reasons: ["action_not_allowed"] });
});
