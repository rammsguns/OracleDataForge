/**
 * The OracleDataForge backend bridge.
 *
 * Ownership, restated because it is the whole point of the design:
 *
 * - DataForge owns its Oracle connections, wallets, user authorization, editor
 *   buffers and every database operation. None of that moves here.
 * - The harness owns provider configuration, the model call, the context rules,
 *   request limits and copilot history.
 * - The browser authenticates to DataForge only. This adapter authenticates to the
 *   harness with a scoped service credential held on the server.
 *
 * The adapter never lets a browser choose which context is resolved: it asks the
 * host application, through `ContextResolver`, using the *current* DataForge actor
 * and that application's own permission checks.
 */

import { ADAPTER_VERSION, type HarnessIntegrationConfig } from "./config.ts";

export const PROTOCOL_VERSION = "1.1";
export const SUPPORTED_PROTOCOL_MAJOR = 1;

/** Categories the adapter is willing to forward. Anything else is dropped. */
export const ALLOWED_CONTEXT_CATEGORIES = [
  "selected_source",
  "object_definition",
  "schema_metadata",
  "error_text",
  "plan_text",
  "database_version",
] as const;

export type ContextCategory = (typeof ALLOWED_CONTEXT_CATEGORIES)[number];

export interface ContextAttachment {
  category: ContextCategory;
  name: string;
  content: string;
  provenance: string;
}

/** The DataForge actor, as the DataForge backend already knows them. */
export interface DataForgeActor {
  /** Stable id where DataForge has named accounts; null for a local session. */
  id: string | null;
  /** DataForge's own capability-based role. Never sent to the harness as authority. */
  role: string;
  /** False when the installation has no named accounts. */
  durable: boolean;
}

export interface AssistRequest {
  action: string;
  connectionId: string;
  schema?: string;
  selection: string;
  errorText?: string;
  planText?: string;
  question?: string;
  editorId: string;
  editorRevision: string;
  conversationId?: string;
}

/**
 * Implemented by DataForge. It must re-check the current actor's permissions for
 * every attachment it returns; the adapter does not know DataForge's rules.
 */
export interface ContextResolver {
  /** Opaque, stable identity for the target. Display names are not identifiers. */
  targetReference(instanceId: string, connectionId: string, schema?: string): string;
  /** The database version DataForge already knows for that connection. */
  databaseVersion(connectionId: string): Promise<string>;
  /**
   * Permission-filtered attachments for this actor and request. Returning fewer
   * attachments is always allowed; returning something the actor may not see is not.
   */
  resolve(actor: DataForgeActor, request: AssistRequest): Promise<ContextAttachment[]>;
}

/**
 * Stream events this adapter understands. Protocol 1.1 added Kiwi's lookup trace
 * (plan_step, tool_call, tool_result, budget). Anything else a newer harness sends
 * within the same major version is dropped rather than passed to the editor.
 */
export const KNOWN_STREAM_EVENTS = [
  "start",
  "delta",
  "proposal",
  "usage",
  "done",
  "error",
  "plan_step",
  "tool_call",
  "tool_result",
  "budget",
] as const;

export type StreamEventName = (typeof KNOWN_STREAM_EVENTS)[number];

export interface StreamEvent {
  event: StreamEventName;
  data: Record<string, unknown>;
}

export interface Capabilities {
  enabled: boolean;
  reachable: boolean;
  compatible: boolean;
  protocolVersion?: string;
  actions: string[];
  providerReady?: boolean;
  isFixtureProvider?: boolean;
  limits?: Record<string, number>;
  adapterVersion: string;
  detail: string;
  requestId: string;
}

export interface AdapterOptions {
  config: HarnessIntegrationConfig;
  resolver: ContextResolver;
  instanceId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class HarnessAdapter {
  private readonly config: HarnessIntegrationConfig;
  private readonly resolver: ContextResolver;
  private readonly instanceId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AdapterOptions) {
    this.config = options.config;
    this.resolver = options.resolver;
    this.instanceId = options.instanceId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * What the IDE may offer right now. It is safe to call with the feature disabled
   * or the harness down: it answers, it does not throw.
   */
  async capabilities(actor: DataForgeActor): Promise<Capabilities> {
    const requestId = newRequestId();
    if (!this.config.enabled) {
      return {
        enabled: false,
        reachable: false,
        compatible: false,
        actions: [],
        adapterVersion: ADAPTER_VERSION,
        detail: "The harness integration is disabled in this installation.",
        requestId,
      };
    }
    try {
      const response = await this.call("GET", "/api/v1/integrations/capabilities");
      if (!response.ok) {
        return {
          enabled: true,
          reachable: true,
          compatible: false,
          actions: [],
          adapterVersion: ADAPTER_VERSION,
          detail: `The harness refused the integration credential (${response.status}).`,
          requestId,
        };
      }
      const body = (await response.json()) as {
        protocolVersion: string;
        actions: string[];
        providerReady: boolean;
        isFixtureProvider: boolean;
        limits: Record<string, number>;
        enabled: boolean;
      };
      const compatible = protocolCompatible(body.protocolVersion);
      return {
        enabled: body.enabled,
        reachable: true,
        compatible,
        protocolVersion: body.protocolVersion,
        actions: compatible ? filterActionsForRole(body.actions, actor.role) : [],
        providerReady: body.providerReady,
        isFixtureProvider: body.isFixtureProvider,
        limits: body.limits,
        adapterVersion: ADAPTER_VERSION,
        detail: compatible
          ? ""
          : `The harness speaks protocol ${body.protocolVersion}; this adapter speaks ` +
            `${PROTOCOL_VERSION}. Upgrade one of them.`,
        requestId,
      };
    } catch (cause) {
      return {
        enabled: true,
        reachable: false,
        compatible: false,
        actions: [],
        adapterVersion: ADAPTER_VERSION,
        detail:
          "The harness could not be reached. Editing, running and compiling in " +
          `DataForge are unaffected. (${(cause as Error).message})`,
        requestId,
      };
    }
  }

  /**
   * Run one assist request and yield the harness stream events.
   *
   * `signal` propagates a browser disconnect to the harness and the provider. A
   * partially delivered request is never retried automatically.
   */
  async *assist(
    actor: DataForgeActor,
    request: AssistRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    if (!this.config.enabled) {
      yield errorEvent("integration_disabled", "The harness integration is disabled.");
      return;
    }

    const attachments = sanitize(
      await this.resolver.resolve(actor, request),
      this.config.maxContextBytes,
    );
    if (attachments.length === 0 && !request.question?.trim()) {
      yield errorEvent(
        "no_context",
        "Nothing was selected and no question was asked, so there is nothing to send.",
      );
      return;
    }

    const targetReference = this.resolver.targetReference(
      this.instanceId,
      request.connectionId,
      request.schema,
    );

    let response: Response;
    try {
      response = await this.call("POST", "/api/v1/copilot/requests", {
        protocolVersion: PROTOCOL_VERSION,
        action: request.action,
        targetReference,
        conversationId: request.conversationId ?? "",
        userMessage: request.question ?? "",
        databaseVersion: await this.resolver.databaseVersion(request.connectionId),
        schema: request.schema ?? "",
        attachments,
        editor: {
          editorId: request.editorId,
          revision: request.editorRevision,
          text: request.selection,
        },
        // An assertion about which of *our* users is acting, namespaced by the
        // harness. It is not a role and grants nothing.
        actorReference: actor.id ?? "local-session",
        actorIsDurable: actor.durable,
      }, signal);
    } catch (cause) {
      yield errorEvent(
        "harness_unreachable",
        `The harness could not be reached: ${(cause as Error).message}`,
      );
      return;
    }

    if (!response.ok || !response.body) {
      yield errorEvent(
        response.status === 401 || response.status === 403
          ? "integration_unauthorized"
          : "harness_error",
        `The harness returned ${response.status}.`,
      );
      return;
    }

    for await (const event of readSse(response.body)) {
      yield event;
    }
  }

  /**
   * Ask whether a proposal may still be applied. DataForge calls this immediately
   * before touching the buffer, with the buffer text it is about to replace.
   */
  async applyCheck(
    actor: DataForgeActor,
    proposalId: string,
    body: {
      editorId: string;
      revision: string;
      currentText: string;
      connectionId: string;
      schema?: string;
    },
  ): Promise<{ canApply: boolean; reasons: string[]; proposedText?: string }> {
    const response = await this.call(
      "POST",
      `/api/v1/copilot/proposals/${encodeURIComponent(proposalId)}/apply-check`,
      {
        editorId: body.editorId,
        revision: body.revision,
        currentText: body.currentText,
        targetReference: this.resolver.targetReference(
          this.instanceId,
          body.connectionId,
          body.schema,
        ),
        actorReference: actor.id ?? "local-session",
      },
    );
    if (!response.ok) {
      return {
        canApply: false,
        reasons: [`The harness refused the apply check (${response.status}).`],
      };
    }
    return (await response.json()) as {
      canApply: boolean;
      reasons: string[];
      proposedText?: string;
    };
  }

  private call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    return this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        "X-Adapter-Version": ADAPTER_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  }
}

/**
 * DataForge roles are capability-based, not a privilege ladder. Analyst is
 * restricted to table browsing, so it gets documentation-only assistance and no
 * schema-context expansion until that has been reviewed separately.
 */
export function filterActionsForRole(actions: string[], role: string): string[] {
  if (role.toLowerCase() === "analyst") {
    return actions.filter((action) => action === "explain");
  }
  return actions;
}

/** Drop anything outside the allowed categories and bound what is left. */
export function sanitize(
  attachments: ContextAttachment[],
  maxBytes: number,
): ContextAttachment[] {
  const allowed = new Set<string>(ALLOWED_CONTEXT_CATEGORIES);
  const kept: ContextAttachment[] = [];
  let used = 0;
  for (const attachment of attachments) {
    if (!allowed.has(attachment.category)) continue;
    const size = Buffer.byteLength(attachment.content, "utf8");
    if (used + size > maxBytes) continue;
    used += size;
    kept.push(attachment);
  }
  return kept;
}

export function protocolCompatible(theirVersion: string): boolean {
  const major = Number.parseInt(theirVersion.split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major === SUPPORTED_PROTOCOL_MAJOR;
}

export function errorEvent(code: string, message: string): StreamEvent {
  return { event: "error", data: { code, message } };
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSse(chunk);
      if (parsed) yield parsed;
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function parseSse(chunk: string): StreamEvent | null {
  let event = "";
  let data = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!event || !data) return null;
  if (!(KNOWN_STREAM_EVENTS as readonly string[]).includes(event)) return null;
  try {
    return { event: event as StreamEventName, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

let counter = 0;
export function newRequestId(): string {
  counter += 1;
  return `df-${Date.now().toString(36)}-${counter.toString(36)}`;
}
