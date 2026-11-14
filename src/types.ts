import type { RetryPolicy } from './retry.js';
import type { Decision, RoutePolicy } from './decision.js';

/**
 * Runtime metadata included in every context for parity with the Python SDK.
 * Sent in x-trustgate-source-tool and in x-trustgate-meta-* headers.
 */
export interface RuntimeMetadata {
  /** SDK version (e.g. "1.0.0"). */
  sdk_version: string;
  /** Node.js version (e.g. "v20.1.0"). */
  node_version: string;
  /** Operating system platform (process.platform, e.g. "win32", "darwin", "linux"). */
  os: string;
  /** CPU architecture (process.arch, e.g. "x64", "arm64"). */
  arch: string;
  [key: string]: string;
}

/**
 * Workflow/source metadata for Shadow AI detection and observability.
 * Populated from n8n, Vercel, GitHub Actions, or default "local_script".
 * Metadata always includes sdk_version, node_version, os, arch for Python parity.
 */
export interface WorkflowContext {
  /** Source: "n8n" | "vercel" | "github" | "local_script" | "custom". Never null. */
  source: string;
  /** Workflow or execution identifier */
  workflow_id?: string;
  /** Execution or run ID */
  execution_id?: string;
  /** Step identifier; key for generating Gantt chart bars in the Agent Intelligence dashboard. */
  workflow_step?: string;
  /** Runtime + environment metadata. When omitted, SDK fills sdk_version, node_version, os, arch. */
  metadata?: RuntimeMetadata;
}

/**
 * Base class for every Shashu gateway error. Subclasses in ./exceptions.ts
 * narrow it by status; catch this to catch all of them.
 *
 * `message` is the gateway's `error.message`, except on a rate-limit 429 where
 * that field is the literal string "error" and the readable sentence lives at
 * `error.details.error.message` -- the dispatcher reads the inner one.
 *
 * `type` is NOT a policy discriminator: every 4xx the gateway raises itself
 * carries "invalid_request_error". It is meaningful only on errors passed
 * through from an upstream provider.
 */
export class ShashuError extends Error {
  /** HTTP status code (e.g. 403). */
  readonly status: number;
  /** Raw response body if available (parsed JSON when possible, else text). */
  readonly body?: unknown;
  /** `error.type` from the gateway body, when present. */
  readonly type?: string;
  /** `error.code` from the gateway body, when present. */
  readonly code?: string;
  /**
   * The gateway's decision, when either carrier was present at raise time.
   * Absent (undefined) is today's behaviour — a response that carried none.
   */
  readonly decision?: Decision;
  /** Response headers, kept so a later read can still see the header carrier. */
  readonly responseHeaders?: Headers;

  /**
   * Why a route was refused for the data in the request, off the decision.
   * Set on a `route_data_policy` refusal, so an app can say which route is not
   * approved for which category without parsing the message.
   */
  get routePolicy(): RoutePolicy | undefined {
    return this.decision?.routePolicy;
  }

  constructor(
    message: string,
    status: number,
    body?: unknown,
    details?: { type?: string; code?: string; decision?: Decision; responseHeaders?: Headers }
  ) {
    super(message);
    this.name = 'ShashuError';
    this.status = status;
    this.body = body;
    this.type = details?.type;
    this.code = details?.code;
    this.decision = details?.decision;
    this.responseHeaders = details?.responseHeaders;
    Object.setPrototypeOf(this, ShashuError.prototype);
  }
}

/** Supported LLM providers (kept for middleware compatibility; gateway handles routing by model). */
export type Provider = 'openai' | 'anthropic' | 'google';

/**
 * Shashu client configuration.
 */
export interface ShashuConfig {
  /**
   * Shashu gateway base URL. Falls back to process.env.TRUSTGATE_BASE_URL.
   * There is NO default: SHASHU is self-hosted, so an unset address is a
   * ShashuConfigError, never a vendor host. See ./config.ts.
   */
  baseUrl?: string;
  /** API key (e.g. tg_sk_...). Sent as Authorization: Bearer <apiKey>; gateway handles provider routing. */
  apiKey?: string;
  /**
   * Callable returning the current cloud pass (string or Promise). Mutually
   * exclusive with {@link apiKey}. The SDK never calls Entra, Google or AWS.
   */
  tokenProvider?: () => string | Promise<string>;
  /**
   * This agent's OWN id (ADR-007 §4.1). NOT sent on the gateway call (that FORWARDS the
   * captured inbound caller); used by `buildInvocationHeaders()` to stamp caller = self when
   * THIS agent invokes a downstream agent. Seeds the self-id cache, which is then refreshed
   * from each gateway response's `x-trustgate-agent-id` header. Advisory lineage only —
   * NEVER an auth credential.
   */
  agentId?: string;
  /**
   * Session this client joins. Minted once when omitted, so every request the
   * client makes — every hop of a tool loop — lands in one Sessions row. A
   * captured inbound A2A session overrides this default; a per-request
   * `sessionId` on {@link RequestOptions} overrides both. See
   * `contracts/sdk-surface.v1.md`, "Which session a request joins".
   */
  sessionId?: string;
  /** Override workflow context; if not set, context is derived from process.env (never null). */
  workflowContext?: WorkflowContext;
  /** Extra headers sent with every request */
  headers?: Record<string, string>;
  /**
   * `trustgate-version`: the contract generation to ask the gateway for.
   * Default `DEFAULT_CONTRACT_VERSION` (`"2026-09-01"`, the Python SDK's
   * value): refusals arrive as errors and the body carries the full decision.
   * Pass `null` to send no such header — the gateway then serves the account
   * default, which is the legacy contract unless an operator moved it.
   * A `trustgate-version` entry in `headers` wins over this.
   */
  contractVersion?: string | null;
  /**
   * Client-side retry policy. Omit for the conservative default (retry
   * connection errors + 429 honoring Retry-After; 5xx off). Pass `null` to
   * disable retries, or a partial object to override specific fields.
   */
  retryPolicy?: Partial<RetryPolicy> | null;
}

/**
 * Options for a single request (merge with client config).
 */
export interface RequestOptions {
  /** Override workflow context for this request only */
  workflowContext?: WorkflowContext;
  /**
   * Per-request session. An INSTRUCTION: it wins over a captured A2A session
   * and over the client's construction-time default, and applies to this
   * request only.
   */
  sessionId?: string;
  /** Additional headers for this request */
  headers?: Record<string, string>;
  /** Request timeout in ms */
  timeout?: number;
}

/**
 * Pre-formatted headers for n8n HTTP Request node (name/value pairs).
 */
export interface N8nHeaderSnippet {
  headers: Array<{ name: string; value: string }>;
  /** JSON string suitable for pasting into n8n */
  json: string;
}
