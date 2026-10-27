import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { HarnessAdapter } from "./harness/adapter.ts";
import { registerHarnessRoutes } from "./harness/routes.ts";

test("a client disconnect mid-stream aborts the upstream fetch signal", { timeout: 5000 }, async () => {
  let upstreamSignal: AbortSignal | undefined;
  let aborted!: () => void;
  const upstreamAborted = new Promise<void>((resolve) => { aborted = resolve; });
  const adapter = new HarnessAdapter({
    config: { enabled: true, baseUrl: "http://localhost", token: "test-only", timeoutMs: 4000, maxContextBytes: 1024, adapterVersion: "0.1.0" },
    instanceId: "test",
    resolver: {
      targetReference: () => "test:target",
      databaseVersion: async () => "19",
      resolve: async () => [{ category: "selected_source", name: "selection", content: "SELECT 1 FROM dual", provenance: "test" }],
    },
    fetchImpl: async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"first"}\n\n'));
          upstreamSignal?.addEventListener("abort", () => {
            aborted();
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const app = express();
  app.use(express.json());
  registerHarnessRoutes({ router: app, adapter, currentActor: async () => ({ id: "test", role: "Developer", durable: true }) });
  const server = app.listen(0, "0.0.0.0");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ai/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ action: "explain", connectionId: "test", selection: "SELECT 1 FROM dual", editorId: "editor", editorRevision: "1" }),
    });
    const first = await response.body!.getReader().read();
    assert.match(new TextDecoder().decode(first.value), /event: delta/);
    assert.equal(upstreamSignal?.aborted, false, "consuming the POST body must not abort the stream");
    controller.abort();
    await upstreamAborted;
    assert.equal(upstreamSignal?.aborted, true);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
