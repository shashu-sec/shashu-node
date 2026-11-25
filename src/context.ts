import { randomUUID } from 'node:crypto';
import type { WorkflowContext, RuntimeMetadata } from './types.js';
import { SDK_VERSION } from './version.js';
import { tracer } from './tracer.js';

/** Lowercase header prefix for proxy/gateway parity with Python SDK. */
export const HEADER_PREFIX = 'x-shashu';
/** Header carrying the full context JSON (structurally identical to Python SDK). */
export const SOURCE_TOOL_HEADER = 'x-shashu-source-tool';

/**
 * The contract generation this SDK speaks, declared on every request — the
 * same value the Python SDK sends (`trustgate.context.DEFAULT_CONTRACT_VERSION`).
 *
 * The gateway resolves an ABSENT `shashu-version` header to its legacy
 * contract: a refusal is a 200 with prose in `message.content`, the body
 * carries no envelope (so memory and file items reach a caller as header
 * counts only), and the `shashu-block-encoding` header `shashuFetch`
 * sends is read and discarded.
 *
 * A documented default, not a hardcode: pass `contractVersion` to pin another,
 * or `contractVersion: null` to send no such header and take whatever the
 * account default already does.
 */
export const DEFAULT_CONTRACT_VERSION = '2026-09-01';

/** The header {@link DEFAULT_CONTRACT_VERSION} is sent under. Lowercase. */
export const CONTRACT_VERSION_HEADER = 'shashu-version';

/**
 * Add the contract version to an outgoing header set, unless the caller
 * already named one (in any case) or opted out with `null`. Mutates and
 * returns `headers`.
 */
export function applyContractVersion(
  headers: Record<string, string>,
  contractVersion: string | null | undefined
): Record<string, string> {
  if (contractVersion === null) return headers;
  const named = Object.keys(headers).some((k) => k.toLowerCase() === CONTRACT_VERSION_HEADER);
  if (!named) headers[CONTRACT_VERSION_HEADER] = contractVersion ?? DEFAULT_CONTRACT_VERSION;
  return headers;
}

/** Env keys we check for workflow/source metadata (Shadow AI context). */
const N8N_KEYS = [
  'N8N_WORKFLOW_ID',
  'N8N_EXECUTION_ID',
  'N8N_WORKFLOW_NAME',
  'N8N_EXECUTION_MODE',
] as const;

const VERCEL_KEYS = [
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_GIT_COMMIT_REF',
  'VERCEL_GIT_REPO_ID',
  'VERCEL_GIT_COMMIT_SHA',
] as const;

const GITHUB_KEYS = [
  'GITHUB_ACTION',
  'GITHUB_ACTIONS',
  'GITHUB_WORKFLOW',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_REPOSITORY',
  'GITHUB_SHA',
] as const;

function pickEnv(keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const v = process.env[key];
    if (v !== undefined && v !== '') out[key] = v;
  }
  return out;
}

/** Base runtime metadata (sdk_version, node_version, os, arch) for Python parity. */
function getBaseMetadata(): RuntimeMetadata {
  return {
    sdk_version: SDK_VERSION,
    node_version: process.version,
    os: process.platform,
    arch: process.arch,
  };
}

/**
 * Searches process.env for workflow metadata from n8n, Vercel, or GitHub.
 * If no managed environment is detected, returns context with source "local_script"
 * so local developer usage is correctly tagged as Shadow AI in the dashboard.
 * Never returns null.
 */
export function getWorkflowContextFromEnv(): WorkflowContext {
  const baseMeta = getBaseMetadata();

  const n8n = pickEnv(N8N_KEYS as unknown as string[]);
  if (Object.keys(n8n).length > 0) {
    return {
      source: 'n8n',
      workflow_id: n8n.N8N_WORKFLOW_ID,
      execution_id: n8n.N8N_EXECUTION_ID,
      metadata: { ...baseMeta, ...n8n },
    };
  }

  const vercel = pickEnv(VERCEL_KEYS as unknown as string[]);
  if (Object.keys(vercel).length > 0) {
    return {
      source: 'vercel',
      workflow_id: vercel.VERCEL_GIT_REPO_ID || vercel.VERCEL_URL,
      execution_id: vercel.VERCEL_GIT_COMMIT_SHA,
      metadata: { ...baseMeta, ...vercel },
    };
  }

  const github = pickEnv(GITHUB_KEYS as unknown as string[]);
  if (Object.keys(github).length > 0) {
    return {
      source: 'github',
      workflow_id: github.GITHUB_WORKFLOW || github.GITHUB_REPOSITORY,
      execution_id: github.GITHUB_RUN_ID || github.GITHUB_RUN_NUMBER,
      metadata: { ...baseMeta, ...github },
    };
  }

  return {
    source: 'local_script',
    metadata: baseMeta,
  };
}

/**
 * JSON payload for x-shashu-source-tool header (structurally identical to Python SDK).
 */
export function buildSourceToolJson(ctx: WorkflowContext): string {
  const meta = ctx.metadata ?? getBaseMetadata();
  const payload: Record<string, unknown> = {
    source: ctx.source,
    metadata: meta,
  };
  if (ctx.workflow_id !== undefined) payload.workflow_id = ctx.workflow_id;
  if (ctx.execution_id !== undefined) payload.execution_id = ctx.execution_id;
  if (ctx.workflow_step !== undefined) payload.workflow_step = ctx.workflow_step;
  return JSON.stringify(payload);
}

/** Prefix for runtime/metadata headers (e.g. x-trustlog-node-version). */
export const TRUSTLOG_HEADER_PREFIX = 'x-trustlog-';

/**
 * Trace id minted at ORIGIN (no active span, no captured A2A flow), mirroring the Python
 * SDK's _get_trace_id(): prefer the managed runtime's own execution id so the trace joins
 * the run (n8n, GitHub Actions, GitLab CI), else a fresh UUID.
 */
function resolveOriginTraceId(): string {
  const n8n = process.env.N8N_EXECUTION_ID;
  if (n8n) return n8n;
  const github = process.env.GITHUB_RUN_ID;
  if (github) return github;
  const gitlab = process.env.CI_PIPELINE_ID;
  if (process.env.GITLAB_CI && gitlab) return gitlab;
  return randomUUID();
}

/**
 * Builds Shashu context headers: x-shashu-workflow-step, x-shashu-source, etc.,
 * plus x-trustlog-* for metadata (e.g. x-trustlog-node-version). Also x-shashu-source-tool JSON.
 */
/**
 * Lowercase every header key. Python parity (`{k.lower(): v ...}` in
 * build_shashu_headers and build_invocation_headers) and a correctness fix,
 * not a style choice: metadata keys come straight from environment-variable
 * names via getWorkflowContextFromEnv(), so running inside GitHub Actions, n8n
 * or Vercel produced keys like `x-trustlog-GITHUB-ACTION`. HTTP/2 requires
 * header field names to be lowercase and treats a request carrying an uppercase
 * one as MALFORMED (RFC 9113 §8.2.1), and the gateway parses these keys
 * literally. Written as a loop rather than Object.fromEntries to stay on ES2017.
 */
function lowercaseHeaderKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

export function buildContextHeaders(
  ctx: WorkflowContext,
  session?: SessionHeaderOptions
): Record<string, string> {
  const meta = ctx.metadata ?? getBaseMetadata();
  const h: Record<string, string> = {
    [SOURCE_TOOL_HEADER]: buildSourceToolJson({ ...ctx, metadata: meta }),
    [`${HEADER_PREFIX}-source`]: ctx.source,
  };
  if (ctx.workflow_id) h[`${HEADER_PREFIX}-workflow-id`] = ctx.workflow_id;
  if (ctx.execution_id) h[`${HEADER_PREFIX}-execution-id`] = ctx.execution_id;
  if (ctx.workflow_step) h[`${HEADER_PREFIX}-workflow-step`] = ctx.workflow_step;
  for (const [k, v] of Object.entries(meta)) {
    if (v) h[`${TRUSTLOG_HEADER_PREFIX}${k.replace(/_/g, '-')}`] = String(v);
  }

  // --- TRACING INJECTION ---
  if (tracer.isActive) {
    if (tracer.traceId) h['x-shashu-trace-id'] = tracer.traceId;
    // Python parity: span-id is the CURRENT span, parent-id its REAL parent ("" for a root).
    h['x-shashu-span-id'] = tracer.currentSpanId ?? '';
    h['x-shashu-parent-id'] = tracer.parentSpanId ?? '';
  } else if (tracer.isA2aHop) {
    // Mid-flow without a span: PROPAGATE the captured trace (do NOT mint a new one).
    if (tracer.traceId) h['x-shashu-trace-id'] = tracer.traceId;
  } else if (!h['x-shashu-trace-id']) {
    // Origin: ALWAYS emit a trace id (Python _get_trace_id() parity).
    h['x-shashu-trace-id'] = resolveOriginTraceId();
  }

  // Session is resolved in ONE place. A constructed client always passes a
  // default (minted once), so origin sends x-shashu-session-id and the
  // gateway does not synthesise `derived-` + sha256(agent + first message).
  // A captured A2A session overrides that default; a per-request one wins.
  // caller-agent-id and hop-depth remain A2A-only (ADR-007 §5, as superseded
  // 2026-09-13: origin still emits neither).
  const sessionId = resolveSessionId(session);
  if (sessionId) h['x-shashu-session-id'] = sessionId;

  if (tracer.isA2aHop) {
    const inboundCaller = tracer.inboundCallerAgentId;
    if (inboundCaller) h['x-shashu-caller-agent-id'] = inboundCaller;
    h['x-shashu-hop-depth'] = String(tracer.outboundHopDepth);
  }

  return lowercaseHeaderKeys(h);
}

/**
 * How {@link buildContextHeaders} picks the session. One place, not a second
 * copy on the client. Rank, from the contract:
 *
 * 1. `requestSessionId` — a per-request INSTRUCTION. Wins.
 * 2. a captured inbound A2A session — overrides the construction-time default.
 * 3. `defaultSessionId` — the client's own session, minted once at construction.
 */
export interface SessionHeaderOptions {
  /** Construction-time default. A captured A2A session overrides this. */
  defaultSessionId?: string;
  /** Per-request instruction. Wins over the captured session and the default. */
  requestSessionId?: string;
}

/**
 * The session this request joins, or undefined when nothing resolved.
 *
 * Exported so tests can hit the resolver without going through a client.
 * Does not mint: minting is a construction-time act, so two calls here
 * cannot invent two sessions for one client.
 */
export function resolveSessionId(opts?: SessionHeaderOptions): string | undefined {
  if (opts?.requestSessionId != null && String(opts.requestSessionId) !== '') {
    return String(opts.requestSessionId);
  }
  const captured = tracer.sessionId;
  if (captured) return captured;
  if (opts?.defaultSessionId != null && String(opts.defaultSessionId) !== '') {
    return String(opts.defaultSessionId);
  }
  return undefined;
}

/** Options for {@link buildInvocationHeaders}. */
export interface InvocationHeaderOptions {
  /** THIS agent's own id — the invoker stamps itself. Advisory lineage, never auth. */
  callerAgentId: string;
  /** Flow id; defaults to the served flow (tracer.traceId) or a fresh root at origin. */
  traceId?: string;
  /** Session id; defaults to the captured session, if any. */
  sessionId?: string;
  /** Hop depth to advertise; defaults to tracer.outboundHopDepth (inbound + 1). */
  hopDepth?: number;
}

/**
 * Build the Shashu lineage headers to stamp on an INTER-AGENT INVOCATION — the message
 * THIS agent sends to a DOWNSTREAM agent it is calling (the invoking side, ADR-007 §4.1
 * locked). The downstream agent then calls {@link captureIncoming} on these headers and
 * FORWARDS this caller on its own gateway call — forming the (this agent -> downstream
 * agent) edge.
 *
 * `callerAgentId` is THIS agent's own id (the invoker stamps itself) — the one case where
 * the SDK sets caller = self. It is advisory lineage, NEVER an auth credential; authenticate
 * to the downstream service by its own means.
 *
 * Defaults pull from the tracer so the flow this agent is serving is propagated: `traceId`
 * -> tracer.traceId (a fresh root is minted at origin, the captured flow is propagated
 * mid-flow); `hopDepth` -> tracer.outboundHopDepth; `sessionId` -> the captured session.
 */
export function buildInvocationHeaders(opts: InvocationHeaderOptions): Record<string, string> {
  const trace = opts.traceId ?? tracer.traceId ?? randomUUID();
  const hop = opts.hopDepth ?? tracer.outboundHopDepth;
  // Session precedence is resolved in exactly ONE place, `resolveSessionId`.
  // This used to be a second, independent `opts.sessionId ?? tracer.sessionId`,
  // and a second copy of a rule is a rule that can be wrong in one place: the
  // whole suite stayed green (295/295) with this line inverted to
  // `tracer.sessionId ?? opts.sessionId`, which silently loses the caller's
  // per-request INSTRUCTION to a captured inbound hop. There is no client
  // default here — this is a static builder — so only the first two tiers of
  // the rule can apply, and passing `defaultSessionId: undefined` says that
  // rather than re-deriving it.
  const session = resolveSessionId({ requestSessionId: opts.sessionId });

  const h: Record<string, string> = {
    'x-shashu-trace-id': String(trace),
    'x-shashu-caller-agent-id': String(opts.callerAgentId),
    'x-shashu-hop-depth': String(hop),
  };
  if (session) h['x-shashu-session-id'] = String(session);
  return lowercaseHeaderKeys(h);
}
