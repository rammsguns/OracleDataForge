/**
 * Adapter configuration.
 *
 * These are new settings to add to OracleDataForge, not existing ones. All three are
 * read on the server. The token is a backend secret: it must never be sent to a
 * browser, put in a URL, or written to an ordinary log line.
 */

export interface HarnessIntegrationConfig {
  enabled: boolean;
  /** Administrator-controlled base URL. Never taken from a chat prompt or a header. */
  baseUrl: string;
  token: string;
  /** Milliseconds before the adapter gives up on the harness. */
  timeoutMs: number;
  /** Upper bound on the context one request may carry, before the harness limit. */
  maxContextBytes: number;
  adapterVersion: string;
}

export const ADAPTER_VERSION = "0.1.0";

export class ConfigurationProblem extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ConfigurationProblem";
    this.field = field;
  }
}

export function readConfig(env: Record<string, string | undefined>): HarnessIntegrationConfig {
  const enabled = (env.DATAFORGE_HARNESS_ENABLED ?? "false").toLowerCase() === "true";
  const baseUrl = (env.DATAFORGE_HARNESS_URL ?? "").trim().replace(/\/$/, "");
  const token = (env.DATAFORGE_HARNESS_TOKEN ?? "").trim();

  if (enabled) {
    if (!baseUrl) {
      throw new ConfigurationProblem(
        "DATAFORGE_HARNESS_URL",
        "The integration is enabled but no harness URL is configured.",
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new ConfigurationProblem(
        "DATAFORGE_HARNESS_URL",
        `${baseUrl} is not a valid URL.`,
      );
    }
    if (parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) {
      throw new ConfigurationProblem(
        "DATAFORGE_HARNESS_URL",
        "Use https for a harness that is not on loopback; the integration credential " +
          "travels on this connection.",
      );
    }
    if (!token) {
      throw new ConfigurationProblem(
        "DATAFORGE_HARNESS_TOKEN",
        "The integration is enabled but no integration credential is configured.",
      );
    }
  }

  return {
    enabled,
    baseUrl,
    token,
    timeoutMs: Number(env.DATAFORGE_HARNESS_TIMEOUT_MS ?? 60000),
    maxContextBytes: Number(env.DATAFORGE_HARNESS_MAX_CONTEXT_BYTES ?? 131072),
    adapterVersion: ADAPTER_VERSION,
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * A redacted view for the settings screen and for diagnostics. It never includes the
 * credential, not even a prefix.
 */
export function describeConfig(config: HarnessIntegrationConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    tokenConfigured: config.token.length > 0,
    timeoutMs: config.timeoutMs,
    maxContextBytes: config.maxContextBytes,
    adapterVersion: config.adapterVersion,
  };
}
