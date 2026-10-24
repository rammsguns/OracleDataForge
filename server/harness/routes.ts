/**
 * Same-origin routes for the DataForge Express backend.
 *
 * These implement the two routes the DataForge AI-chat plan proposes, backed by the
 * harness rather than by a second model-provider implementation.
 *
 * The Express types are declared structurally so this package adds no dependency to
 * DataForge; it drops into the existing app with `app.use(createHarnessRoutes(...))`.
 */

import type { AssistRequest, DataForgeActor, HarnessAdapter } from "./adapter.ts";
import { ALLOWED_CONTEXT_CATEGORIES } from "./adapter.ts";

export interface MinimalRequest {
  body: Record<string, unknown>;
  params: Record<string, string>;
  on(event: "close", listener: () => void): void;
}

export interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(): void;
  flushHeaders?(): void;
}

export interface RouteHandler {
  (request: MinimalRequest, response: MinimalResponse): void | Promise<void>;
}

export interface MinimalRouter {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
}

export interface RouteOptions {
  adapter: HarnessAdapter;
  /**
   * Resolves the actor from the *existing* DataForge session. It must never read a
   * role out of the request body: a browser cannot name its own role here.
   */
  currentActor: (request: MinimalRequest) => Promise<DataForgeActor | null>;
  router: MinimalRouter;
}

export function registerHarnessRoutes({ adapter, currentActor, router }: RouteOptions): void {
  router.get("/api/ai/capabilities", async (request, response) => {
    const actor = await currentActor(request);
    if (!actor) {
      response.status(401).json({ error: "Sign in to DataForge first." });
      return;
    }
    response.json(await adapter.capabilities(actor));
  });

  router.post("/api/ai/chat", async (request, response) => {
    const actor = await currentActor(request);
    if (!actor) {
      response.status(401).json({ error: "Sign in to DataForge first." });
      return;
    }

    const parsed = parseAssistRequest(request.body);
    if ("error" in parsed) {
      response.status(400).json({ error: parsed.error });
      return;
    }

    const controller = new AbortController();
    request.on("close", () => controller.abort());

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    // Proxies that buffer will hold the whole answer until the end; this asks the
    // common ones not to.
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();

    try {
      for await (const event of adapter.assist(actor, parsed.request, controller.signal)) {
        response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
    } catch (cause) {
      response.write(
        `event: error\ndata: ${JSON.stringify({
          code: "adapter_failure",
          message: (cause as Error).message,
        })}\n\n`,
      );
    } finally {
      response.end();
    }
  });

  router.post("/api/ai/proposals/:proposalId/apply-check", async (request, response) => {
    const actor = await currentActor(request);
    if (!actor) {
      response.status(401).json({ error: "Sign in to DataForge first." });
      return;
    }
    const body = request.body as {
      editorId?: string;
      revision?: string;
      currentText?: string;
      connectionId?: string;
      schema?: string;
    };
    if (!body.editorId || !body.connectionId || typeof body.currentText !== "string") {
      response
        .status(400)
        .json({ error: "editorId, connectionId and currentText are required." });
      return;
    }
    response.json(
      await adapter.applyCheck(actor, request.params.proposalId ?? "", {
        editorId: body.editorId,
        revision: body.revision ?? "",
        currentText: body.currentText,
        connectionId: body.connectionId,
        schema: body.schema,
      }),
    );
  });
}

export function parseAssistRequest(
  body: Record<string, unknown>,
): { request: AssistRequest } | { error: string } {
  const action = typeof body.action === "string" ? body.action : "";
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const selection = typeof body.selection === "string" ? body.selection : "";
  const editorId = typeof body.editorId === "string" ? body.editorId : "";
  const editorRevision =
    typeof body.editorRevision === "string" ? body.editorRevision : "";

  if (!action) return { error: "An action is required." };
  if (!connectionId) return { error: "A DataForge connection must be selected." };
  if (!editorId || !editorRevision) {
    return {
      error:
        "editorId and editorRevision are required so a proposal can be rejected if " +
        "the document moves.",
    };
  }
  // A browser cannot hand us arbitrary context. It sends its selection and its
  // question; everything else is resolved server-side under the actor's permissions.
  for (const forbidden of ["attachments", "role", "actorReference", "targetReference"]) {
    if (forbidden in body) {
      return { error: `The field ${forbidden} is not accepted from the browser.` };
    }
  }

  return {
    request: {
      action,
      connectionId,
      schema: typeof body.schema === "string" ? body.schema : undefined,
      selection,
      errorText: typeof body.errorText === "string" ? body.errorText : undefined,
      planText: typeof body.planText === "string" ? body.planText : undefined,
      question: typeof body.question === "string" ? body.question : undefined,
      editorId,
      editorRevision,
      conversationId:
        typeof body.conversationId === "string" ? body.conversationId : undefined,
    },
  };
}

export { ALLOWED_CONTEXT_CATEGORIES };
