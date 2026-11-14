import { randomUUID } from 'node:crypto';
import type { ShashuConfig, RequestOptions, WorkflowContext } from './types.js';
import { requireBaseUrl } from './config.js';
import {
  getWorkflowContextFromEnv,
  buildContextHeaders,
  buildInvocationHeaders,
  applyContractVersion,
  type SessionHeaderOptions,
} from './context.js';
import { SDK_VERSION } from './version.js';
import { Audit } from './audit.js';
import {
  raiseForResponse,
  raiseIfContentFiltered,
  ShashuContentFilterError,
} from './exceptions.js';
import { executeWithRetry, resolveRetryPolicy, type RetryPolicy } from './retry.js';
import { withRetrievalJoiner } from './_joiner.js';
import { decisionFromResponse, rememberDecision } from './decision.js';
import {
  CredentialResolver,
  passRefusalCodeFromText,
  shouldRetryPassRefused,
} from './credential.js';

const USER_AGENT = `trustgate-node/${SDK_VERSION}`;

/**
 * Every request this client sends goes through the retrieval joiner, so a
 * `declareRetrieval()` made anywhere in the same async context rides the next
 * model call. With nothing declared it forwards the caller's own arguments
 * untouched -- see ./_joiner.ts.
 */
const joiningFetch = withRetrievalJoiner();

/**
 * Streaming is not yet supported end-to-end by the Shashu gateway: the
 * proxy buffers `/v1/chat/completions` and returns a full JSON body
 * regardless of the `stream` flag (the gateway's deferred-deanonymize step
 * runs egress security scans on the whole response dict, so true SSE
 * pass-through is intentionally disabled). `fetchStream` therefore does not
 * deliver incremental tokens against a Shashu gateway — it degrades to
 * the buffered JSON response. Warn once per process so callers aren't misled.
 */
let streamingInertWarningEmitted = false;
function warnStreamingInert(): void {
  if (streamingInertWarningEmitted) return;
  streamingInertWarningEmitted = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[trustgate] Streaming is not yet supported end-to-end: the gateway buffers ' +
      '/v1/chat/completions and returns full JSON regardless of the `stream` flag, so no ' +
      'incremental tokens are produced. fetchStream() will fall back to the buffered response. ' +
      '(warned once per process)'
  );
}

function resolveContext(config: ShashuConfig, options?: RequestOptions): WorkflowContext {
  return options?.workflowContext ?? config.workflowContext ?? getWorkflowContextFromEnv();
}

/**
 * The gateway this client talks to: `baseUrl` option, then TRUSTGATE_BASE_URL,
 * then a ShashuConfigError.
 *
 * Not gated by TRUSTGATE_DISABLE, matching the Python client. The kill switch
 * turns off INSTRUMENTATION — the middlewares and the tracer — by leaving the
 * third-party client talking to its own provider. This client has no other
 * destination to fall back to, so there is nothing for it to no-op into; an
 * unnamed address stays an error.
 */
function resolveBaseUrl(config: ShashuConfig): string {
  return requireBaseUrl(config.baseUrl, { entryPoint: 'new Shashu()' });
}

function mergeHeaders(
  config: ShashuConfig,
  options?: RequestOptions,
  context?: WorkflowContext,
  session?: SessionHeaderOptions,
  token?: string
): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    ...config.headers,
    ...options?.headers,
  };
  const credential = token ?? config.apiKey;
  if (credential) {
    out['authorization'] = `Bearer ${credential}`;
  }
  if (context) {
    Object.assign(out, buildContextHeaders(context, session));
  }
  return out;
}

/**
 * Shashu Node.js client. All traffic is sent to the Shashu gateway with
 * Bearer auth (tg_sk_...). The gateway routes to OpenAI/Anthropic based on
 * the `model` field in the request body.
 */
export class Shashu {
  private readonly config: ShashuConfig;
  private readonly resolvedBaseUrl: string;
  private readonly retryPolicy: RetryPolicy | null;
  private readonly resolver: CredentialResolver;
  /** One session for this client. See `contracts/sdk-surface.v1.md`. */
  private readonly _sessionId: string;

  /**
   * This agent's OWN id (ADR-007 §4.1). Seeded by the `agentId` option and refreshed from
   * each gateway response's `x-trustgate-agent-id` header (read on EVERY response, incl.
   * 4xx). Used by {@link buildInvocationHeaders} to stamp caller = self when invoking a
   * downstream agent — never sent as the gateway call's caller. Advisory lineage, never auth.
   */
  private _agentId?: string;

  /** Audit-event ingestion for vendor-controlled SaaS chokepoints. */
  readonly audit: Audit;

  constructor(config: ShashuConfig) {
    this.resolvedBaseUrl = resolveBaseUrl(config);
    this.config = { ...config, baseUrl: this.resolvedBaseUrl };
    this.resolver = new CredentialResolver({
      apiKey: config.apiKey,
      tokenProvider: config.tokenProvider,
      requireOne: true,
    });
    this._agentId = config.agentId;
    this._sessionId = config.sessionId ?? randomUUID();
    // undefined -> conservative default; null -> retries disabled.
    this.retryPolicy = resolveRetryPolicy(config.retryPolicy);
    this.audit = new Audit(this);
  }

  /** Base URL of the Shashu gateway. */
  get baseUrl(): string {
    return this.resolvedBaseUrl;
  }

  /** This agent's own id, as known so far (seed option or cached response header). */
  get agentId(): string | undefined {
    return this._agentId;
  }

  /**
   * The session this client joins. Minted once at construction when the caller
   * did not pass `sessionId`. A captured A2A session overrides it; a
   * per-request `sessionId` overrides both.
   */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Cache this agent's own id from the gateway's `x-trustgate-agent-id` response header
   * (delivered by WP-A2A-1). Used by {@link buildInvocationHeaders} to stamp caller = self
   * on a downstream invocation. Read on EVERY response — including non-2xx — so even a
   * blocked response seeds the self-id. NEVER an auth credential. Fail-soft: never throws.
   */
  private captureAgentId(res: Response): void {
    try {
      const aid = res.headers.get('x-trustgate-agent-id');
      if (aid) this._agentId = aid;
    } catch {
      // ignore
    }
  }

  /**
   * Lineage headers to stamp on a message THIS agent sends to a DOWNSTREAM agent (the
   * invoking side, ADR-007 §4.1). caller-agent-id = this client's own id (`agentId` option,
   * refreshed from gateway responses); trace / hop / session default from the tracer so the
   * served flow is propagated. The downstream agent calls `captureIncoming()` on these
   * headers. Throws if self-id is not known yet — set the `agentId` option or make one
   * gateway call first so the `x-trustgate-agent-id` response header can seed it.
   */
  buildInvocationHeaders(opts?: {
    traceId?: string;
    sessionId?: string;
    hopDepth?: number;
  }): Record<string, string> {
    if (!this._agentId) {
      throw new Error(
        'self agent id is unknown — set the agentId option or make one gateway call first ' +
          'so the x-trustgate-agent-id response header can seed it.'
      );
    }
    return buildInvocationHeaders({ callerAgentId: this._agentId, ...opts });
  }

  /**
   * Get the current effective workflow context (from config override or process.env).
   */
  getWorkflowContext(options?: RequestOptions): WorkflowContext {
    return resolveContext(this.config, options);
  }

  /**
   * Perform a non-streaming JSON request through Shashu. Request body is
   * sent unchanged; the gateway routes by the `model` field.
   *
   * Non-2xx responses throw the typed exception hierarchy (auth / bad-request /
   * context-window / rate-limit / permission / policy-violation / provider).
   * A 200 whose body has finish_reason="content_filter" throws
   * ShashuContentFilterError.
   *
   * Connection errors are retried per the client's retry policy. A 429 is
   * retried only when the gateway named a time to come back -- the
   * identical-request breaker names none, and retrying it refreshes the
   * window that is blocking you. See ./retry.js.
   */
  async fetch(path: string, init: RequestInit = {}, options?: RequestOptions): Promise<Response> {
    const context = resolveContext(this.config, options);
    const url = path.startsWith('http')
      ? path
      : `${this.resolvedBaseUrl}/${path.replace(/^\//, '')}`;
    const timeout = options?.timeout ?? 60_000;

    // Each attempt gets a fresh AbortController/timeout so retries aren't aborted.
    const send = async (): Promise<Response> => {
      const token = await this.resolver.get();
      const headers = mergeHeaders(
        this.config,
        options,
        context,
        {
          defaultSessionId: this._sessionId,
          requestSessionId: options?.sessionId,
        },
        token
      );
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      try {
        return await joiningFetch(url, {
          ...init,
          headers: applyContractVersion(
            { ...headers, ...(init.headers as Record<string, string>) },
            this.config.contractVersion
          ),
          signal: init.signal ?? controller.signal,
        });
      } finally {
        clearTimeout(id);
      }
    };

    let res = await executeWithRetry(send, this.retryPolicy);
    if (this.resolver.usesProvider && res.status === 401) {
      const code = passRefusalCodeFromText(await res.clone().text());
      if (
        shouldRetryPassRefused({
          usesProvider: true,
          status: res.status,
          code,
          bytesDelivered: false,
        })
      ) {
        this.resolver.invalidate();
        res = await send();
      }
    }
    // Cache self-agent-id BEFORE raising, so even a blocked (non-2xx) response still seeds
    // caller-agent-id for the next A2A invocation (ADR-007 §4.1).
    this.captureAgentId(res);
    const decision = await decisionFromResponse(res);
    if (decision) rememberDecision(res, decision);
    await raiseForResponse(res, decision); // throws typed exceptions on non-2xx

    // Peek (without consuming the caller's body) for a content-filtered 200.
    if (res.headers.get('content-type')?.includes('application/json')) {
      try {
        const json = await res.clone().json();
        raiseIfContentFiltered(json, decision, res.headers);
      } catch (err) {
        if (err instanceof ShashuContentFilterError) throw err;
        // ignore JSON parse errors on the peek; return the original response
      }
    }
    return res;
  }

  /**
   * Perform a streaming request (SSE). Forwards the response stream; gateway
   * attributes the request using workflow context. 403 throws ShashuError.
   *
   * NOTICE — streaming is INERT against a Shashu gateway today. The proxy
   * always calls the provider in non-streaming mode and buffers the full
   * response so its deferred-deanonymize / egress-scan step can run on the
   * complete body; it emits no chat SSE regardless of the `stream` flag or
   * DLP settings. This method consequently does not yield incremental tokens
   * — when the response is not `text/event-stream` it returns the buffered
   * JSON response unchanged. The method is kept (not removed) for forward
   * compatibility once gateway streaming lands. A one-time warning is logged
   * on first use.
   */
  async fetchStream(
    path: string,
    init: RequestInit = {},
    options?: RequestOptions
  ): Promise<Response> {
    warnStreamingInert();
    const context = resolveContext(this.config, options);
    const url = path.startsWith('http')
      ? path
      : `${this.resolvedBaseUrl}/${path.replace(/^\//, '')}`;
    const send = async (): Promise<Response> => {
      const token = await this.resolver.get();
      const headers = mergeHeaders(
        this.config,
        options,
        context,
        {
          defaultSessionId: this._sessionId,
          requestSessionId: options?.sessionId,
        },
        token
      );
      const mergedHeaders = applyContractVersion(
        {
          accept: 'text/event-stream',
          ...headers,
          ...(init.headers as Record<string, string>),
        },
        this.config.contractVersion
      );
      return joiningFetch(url, {
        ...init,
        headers: mergedHeaders,
        signal: init.signal,
      });
    };

    let res = await send();
    if (this.resolver.usesProvider && res.status === 401) {
      const code = passRefusalCodeFromText(await res.clone().text());
      if (
        shouldRetryPassRefused({
          usesProvider: true,
          status: res.status,
          code,
          bytesDelivered: false,
        })
      ) {
        this.resolver.invalidate();
        res = await send();
      }
    }

    this.captureAgentId(res); // seed self-id even on a blocked stream (read before raising)
    const decision = await decisionFromResponse(res);
    if (decision) rememberDecision(res, decision);
    if (!res.ok) {
      await raiseForResponse(res, decision); // throws typed exceptions (e.g. ShashuPolicyViolation on 403)
    }

    if (!res.body) {
      return res;
    }

    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      return res;
    }

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
}
