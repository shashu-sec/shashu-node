/**
 * Shashu SDK exception hierarchy (mirrors the Python SDK).
 *
 * Every shape named below is a verbatim capture from a running gateway, taken
 * with `sdks/e2e/capture_error_contract.py` in the gateway repo. That
 * harness is the source of truth for this module; a claim that cannot be
 * reproduced with it does not belong here. The previous version of this header
 * was derived from an investigation write-up and got three things wrong — see
 * CHANGELOG 1.8.0.
 *
 *   401  -> ShashuAuthenticationError      type="invalid_request_error"
 *   400  -> ShashuBadRequestError          type="ProviderInvalidRequestError"
 *   400  -> ShashuContextWindowExceeded    type="context_window_exceeded"
 *   400  -> ShashuContentFilterError       type="content_filter"
 *   429  -> ShashuRateLimitError           see "The two 429s" below
 *   403  -> ShashuPermissionError
 *            └─ ShashuPolicyViolation       (every 403; concrete back-compat type)
 *                 └─ MemoryWriteBlocked        (a 403 whose decision refused a memory write)
 *   404  -> ShashuError                    type="ProviderModelNotFoundError"
 *   502/503/504 -> ShashuProviderError
 *   2xx + finish_reason="content_filter" -> ShashuContentFilterError
 *
 * **A security block has two encodings and ONE exception type.** The gateway
 * serialises the same block either as 200 + `finish_reason "content_filter"`
 * (`compatible` / legacy) or as 400 + `error.type "content_filter"`
 * (`explicit`, the default at contract `2026-09-01`). Which one a caller sees
 * is chosen by a request header or an account default, so the two must not
 * throw different types — see {@link ShashuContentFilterError}.
 *
 * **`error.type` is a discriminator on exactly one value.** Every OTHER 4xx the
 * gateway raises itself carries `"invalid_request_error"` — a 401, a 403 and a
 * 422 are identical in that field — and under contract `2026-09-01` a refusal
 * carries `authentication_error` / `permission_error` / `rate_limit_error` by
 * status, which restates the status rather than refining it. The two values
 * worth branching on are `content_filter` and `context_window_exceeded`, both
 * on a 400, and both are read below. Everything else is dispatched on the
 * status: see `dispatchCode` for what `error.code` actually holds and why it is
 * not the discriminator this module once called it.
 *
 * **A 401 is not always about your key.** The gateway's own auth failure sends
 * `type="invalid_request_error"` with message `"Invalid SHASHU API Key"` or
 * `"Not authenticated"` (the latter with a `WWW-Authenticate: Bearer` header).
 * A 401 carrying `type="authentication_error"` and a message prefixed
 * `"SHASHU Provider Error: "` is a **pass-through**: the gateway's own stored
 * provider credential was rejected upstream. Your `shashu_sk_` key is fine and
 * rotating it changes nothing — a gateway operator has to fix the provider
 * secret. The same is true of 403 (`ProviderPermissionError`), 404, 429 and the
 * 5xx family. This module used to attribute `authentication_error` to the
 * gateway's own 401, which pointed every reader at the wrong credential.
 *
 * **The two 429s.** They are different responses and only one is retryable:
 *
 *   - the token bucket sends `Retry-After` and nests its structured detail at
 *     `error.details.error` — `type="rate_limit_exceeded"`, `scope`,
 *     `retry_after_seconds` and the readable `message`. The OUTER
 *     `error.message` on that body is the literal string `"error"`, so this
 *     module reads the inner one.
 *   - the identical-request breaker sends **no** `Retry-After`, no `details`,
 *     and puts `"Infinite Loop Detected"` at `error.message`. Retrying it
 *     re-trips the breaker and refreshes its window — see `./retry.js`.
 *
 * **Budget-vs-policy is NOT detectable.** It used to be guessed by testing
 * `/budget/i` against the message. That is gone (1.8.0): a message is prose, it
 * gets reworded, and it is not a contract. `ShashuBudgetExceededError` is
 * still exported so existing `catch` clauses type-check, but nothing throws it —
 * every 403 is a `ShashuPolicyViolation`. Catch `ShashuPermissionError` to
 * cover both. It becomes reachable again if the gateway ships a real
 * discriminator (the 403 discriminator ticket).
 *
 * `ShashuError` remains the base (re-exported from "./types.js" for
 * backward compatibility), so existing `catch (e) { e instanceof ShashuError }`
 * code keeps working — every typed error is a subclass. Pillar/severity are not
 * in caller-facing bodies (they live in the audit log) and are absent here.
 */

import { ShashuError } from './types.js';
import type { Decision, MemoryActivity } from './decision.js';

export { ShashuError };

type ErrorDetails = {
  type?: string;
  code?: string;
  decision?: Decision;
  responseHeaders?: Headers;
};

/**
 * The gateway stamps this on the message of every error it passes through from
 * an upstream provider, whatever the status. Captured on 400/404 with the
 * harness; the gateway builds it in one place (`proxy/processor.py`) for the
 * whole provider-error family.
 */
const PROVIDER_ERROR_PREFIX = 'SHASHU Provider Error:';

/**
 * The SDK was asked to instrument or address a process it cannot address.
 *
 * The odd one out in this module: every other class here is HTTP-status shaped
 * and describes a response. This one is raised BEFORE any request, at
 * construction or configuration time, and only for configuration the caller can
 * fix. `status` is therefore `0` — not an HTTP status, but the honest statement
 * that nothing was sent. (The field is non-optional on the base class and
 * widening it to `number | undefined` would break every consumer that compares
 * it, so 0 carries the meaning instead.)
 *
 * SHASHU is self-hosted, so there is no address the SDK could fall back to —
 * a fallback would send the operator's prompts to a host they never named.
 * Resolution is: explicit `baseUrl` option, then the environment, then this
 * error. The message names the environment variable and the option; it
 * deliberately suggests no hostname. See ./config.ts.
 */
export class ShashuConfigError extends ShashuError {
  constructor(message: string) {
    super(message, 0);
    this.name = 'ShashuConfigError';
    Object.setPrototypeOf(this, ShashuConfigError.prototype);
  }
}

/**
 * 401 — an authentication failure. NOT necessarily yours.
 *
 * Two different producers land here and they need opposite fixes:
 *
 *  - the **gateway's own** agent-key check — missing, unknown, deactivated or
 *    rotated `shashu_sk_` key. `type="invalid_request_error"`, message
 *    `"Invalid SHASHU API Key"` or `"Not authenticated"`. Fix: your key.
 *  - a **provider pass-through** — the gateway's stored provider credential was
 *    rejected upstream. `type="authentication_error"`, message prefixed
 *    `"SHASHU Provider Error: "`. Your key is fine; rotating it changes
 *    nothing. Fix: a gateway operator replaces the provider secret.
 *
 * {@link isProviderPassthrough} tells them apart.
 */
export class ShashuAuthenticationError extends ShashuError {
  constructor(message: string, status: number, body?: unknown, details?: ErrorDetails) {
    super(message, status, body, details);
    this.name = 'ShashuAuthenticationError';
    Object.setPrototypeOf(this, ShashuAuthenticationError.prototype);
  }

  /**
   * True when the upstream provider rejected the gateway's credential.
   *
   * Reads `error.type`, the one field the gateway populates differently for
   * pass-throughs, and falls back to the message prefix it stamps on every
   * pass-through when the body carried no type.
   */
  get isProviderPassthrough(): boolean {
    if (this.type === 'authentication_error') return true;
    return this.message.startsWith(PROVIDER_ERROR_PREFIX);
  }
}

export class ShashuBadRequestError extends ShashuError {
  constructor(message: string, status: number, body?: unknown, details?: ErrorDetails) {
    super(message, status, body, details);
    this.name = 'ShashuBadRequestError';
    Object.setPrototypeOf(this, ShashuBadRequestError.prototype);
  }
}

export class ShashuContextWindowExceeded extends ShashuBadRequestError {
  constructor(message: string, status: number, body?: unknown, details?: ErrorDetails) {
    super(message, status, body, details);
    this.name = 'ShashuContextWindowExceeded';
    Object.setPrototypeOf(this, ShashuContextWindowExceeded.prototype);
  }
}

export class ShashuRateLimitError extends ShashuError {
  /** Limiter scope ("tenant" | "agent" | "tpm") when provided by the gateway. */
  readonly scope?: string;
  /** Seconds to wait before retrying, from the body or the Retry-After header. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    status: number,
    body?: unknown,
    details?: ErrorDetails & { scope?: string; retryAfterSeconds?: number }
  ) {
    super(message, status, body, details);
    this.name = 'ShashuRateLimitError';
    this.scope = details?.scope;
    this.retryAfterSeconds = details?.retryAfterSeconds;
    Object.setPrototypeOf(this, ShashuRateLimitError.prototype);
  }
}

export class ShashuPermissionError extends ShashuError {
  constructor(message: string, status: number, body?: unknown, details?: ErrorDetails) {
    super(message, status, body, details);
    this.name = 'ShashuPermissionError';
    Object.setPrototypeOf(this, ShashuPermissionError.prototype);
  }
}

/**
 * 403 — the agent's monthly budget is exhausted.
 *
 * **Never thrown today.** It used to be thrown when `/budget/i` matched the 403
 * message, which is guessing from prose: it misfired on any policy denial whose
 * wording mentioned a budget, and missed a real budget denial the moment someone
 * reworded the message. The gateway sends no discriminator — every 403 carries
 * an identical `{type: "invalid_request_error", code: "403"}` envelope — so the
 * honest answer is that this cannot be detected.
 *
 * Kept exported so existing `catch` clauses still type-check. Catch
 * {@link ShashuPermissionError} to cover budget and policy together. This
 * class becomes reachable again if the gateway ships a real discriminator
 * (the 403 discriminator ticket,
 * the gateway issue tracker (403 discriminator)).
 */
export class ShashuBudgetExceededError extends ShashuPermissionError {
  constructor(message: string, status: number, body?: unknown, details?: ErrorDetails) {
    super(message, status, body, details);
    this.name = 'ShashuBudgetExceededError';
    Object.setPrototypeOf(this, ShashuBudgetExceededError.prototype);
  }
}

export class ShashuPolicyViolation extends ShashuPermissionError {
  constructor(message: string, status: number, body?: unknown, details?: ErrorDetails) {
    super(message, status, body, details);
    this.name = 'ShashuPolicyViolation';
    Object.setPrototypeOf(this, ShashuPolicyViolation.prototype);
  }
}

/**
 * 403 — the gateway refused to store a memory write.
 *
 * A {@link ShashuPolicyViolation}, so every existing `catch` for that type
 * still catches it. Thrown when the decision's `memory` block reports a
 * blocked write; which write, and why, is on {@link MemoryWriteBlocked.memory}.
 * The type is chosen from that block, never from a copy of the `code` or
 * reason vocabulary.
 */
export class MemoryWriteBlocked extends ShashuPolicyViolation {
  constructor(message: string, status: number, body?: unknown, details?: ErrorDetails) {
    super(message, status, body, details);
    this.name = 'MemoryWriteBlocked';
    Object.setPrototypeOf(this, MemoryWriteBlocked.prototype);
  }

  /** The decision's memory block. */
  get memory(): MemoryActivity | undefined {
    return this.decision?.memory;
  }
}

/**
 * 502/503/504 — an upstream LLM provider error surfaced by the gateway.
 *
 * `error.type` on these is the gateway's own provider-error class name
 * (`ProviderServerError`, `ProviderConnectionError`, `ProviderTimeoutError`, …).
 * There is no `"provider_error"` type; this module used to claim there was.
 */
export class ShashuProviderError extends ShashuError {
  constructor(message: string, status: number, body?: unknown, details?: ErrorDetails) {
    super(message, status, body, details);
    this.name = 'ShashuProviderError';
    Object.setPrototypeOf(this, ShashuProviderError.prototype);
  }
}

/**
 * The gateway blocked the content. ONE type, both encodings.
 *
 * A security block reaches the caller in one of two shapes, and which one
 * depends on request headers (`shashu-version`, `shashu-block-encoding`)
 * or an account default the caller may not control. Since 4.0.0 this SDK
 * sends `shashu-version: 2026-09-01` by default, so the 400 is what a
 * caller sees unless they pass `contractVersion: null`:
 *
 *   - `compatible` / legacy — **HTTP 200**, `finish_reason "content_filter"`.
 *     {@link finishReason} is that string and `status` is 200.
 *   - `explicit` (the default at contract `2026-09-01`) — **HTTP 400**,
 *     `error.type "content_filter"` and `error.code` naming the finding
 *     (`jailbreak`, `dlp`, `pii_output`, `secret`, `prompt_injection`).
 *     {@link finishReason} is `null`; the finding is on `code`.
 *
 * They are the same event, so they throw the same type. Splitting them would
 * mean an `instanceof ShashuContentFilterError` check silently stopped
 * working on the day an operator moved the account default — a client-side
 * break with no client-side change, which is the failure the gateway's own
 * versioning exists to prevent. Callers that must tell the encodings apart
 * read `status` or {@link finishReason}.
 */
export class ShashuContentFilterError extends ShashuError {
  /**
   * `"content_filter"` on the 200 encoding; `null` on the 400 one, where there
   * is no `choices` array to carry a finish reason.
   */
  readonly finishReason: string | null;

  constructor(
    message: string,
    body: unknown,
    finishReason: string | null = null,
    status = 200,
    details?: ErrorDetails
  ) {
    super(message, status, body, details);
    this.name = 'ShashuContentFilterError';
    this.finishReason = finishReason;
    Object.setPrototypeOf(this, ShashuContentFilterError.prototype);
  }
}

/** The token bucket's structured detail, nested at `error.details.error`. */
interface RateLimitDetail {
  type?: string;
  scope?: string;
  retry_after_seconds?: number;
  message?: string;
}

interface GatewayErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    /**
     * Present only when the raising code attached a dict detail. Today that is
     * the rate limiter, and `details.error` is where `scope`,
     * `retry_after_seconds` and the readable message actually live — NOT on
     * `error` itself, which is where this SDK looked before 1.8.0.
     */
    details?: { error?: RateLimitDetail };
  };
  message?: string;
}

/**
 * The token bucket's structured detail, or `{}` for the identical-request
 * breaker, which carries no `details` at all.
 */
function rateLimitDetail(err: GatewayErrorBody['error']): RateLimitDetail {
  const inner = err?.details?.error;
  return inner && typeof inner === 'object' ? inner : {};
}

/**
 * Seconds the gateway asked the caller to wait, or `undefined` if it did not ask.
 *
 * **`undefined` is a decision, not a missing value.** The gateway names a retry
 * time when it is throttling you and stays silent when the refusal will not
 * clear on its own — see `./retry.js`, which uses exactly this to decide whether
 * a 429 may be retried at all.
 *
 * Header first: `Retry-After` is present on every token-bucket rejection and
 * costs nothing to read. `error.details.error.retry_after_seconds` is the same
 * number, consulted only when the header is absent, and read from an
 * already-parsed body so the response stream is never touched.
 */
export function gatewayRetryAfter(
  res: Pick<Response, 'headers'>,
  parsedBody?: unknown
): number | undefined {
  const fromHeader = parseRetryAfter(res.headers.get('retry-after'));
  if (fromHeader !== undefined) return fromHeader;
  if (!parsedBody || typeof parsedBody !== 'object') return undefined;
  const err = (parsedBody as GatewayErrorBody).error;
  const seconds = rateLimitDetail(err).retry_after_seconds;
  return typeof seconds === 'number' ? seconds : undefined;
}

/** Exactly three ASCII digits — the only shape `error.code` takes as a status. */
const HTTP_SHAPED_CODE = /^[0-9]{3}$/;

/**
 * The status this response should be dispatched on.
 *
 * **What `error.code` actually holds**, measured against the gateway on
 * 2026-09-07 — it is one of four things, and only the second is a status:
 *
 *   1. a §3 **reason code**: `jailbreak`, `dlp`, `pii_output`, `secret`,
 *      `prompt_injection`, `egress_denied`, `tool_policy`, `retrieval_policy`,
 *      `agent_depth_exceeded`, `plan_limit`, `feature_disabled`,
 *      `quota_exceeded`, `inspector_timeout`, `upstream_error`,
 *      `internal_error`, `auth_missing`, `auth_invalid`, `auth_expired`,
 *      `auth_revoked`. Sent on every path served under contract version
 *      `2026-09-01` or later;
 *   2. the **HTTP status as a string** — `"401"`, `"403"`, `"429"`. Still
 *      live, but no longer what this SDK asks for: since 4.0.0 it sends
 *      `shashu-version: 2026-09-01` by default. A caller that passes
 *      `contractVersion: null` on an account with no default is served
 *      `legacy`, and every refusal the gateway's `HTTPException` handler
 *      renders carries `str(status_code)` whatever the version;
 *   3. the literal `"invalid_request"`, on a schema-invalid body on the LLM
 *      wire — neither a reason nor a status;
 *   4. **absent** — the 500 crash handler sends `error` as a bare string, and
 *      the Anthropic-shaped envelope on `/v1/messages` drops the field.
 *
 * The preference for `error.code` is kept because of (2), not because it
 * discriminates: wherever it is HTTP-shaped it *equals* the transport status,
 * so honouring it is a compatibility affordance for the legacy encoding rather
 * than a second source of truth. Everything else falls back to the transport
 * status, which is what routes cases (1), (3) and (4).
 *
 * The shape check is deliberately stricter than `parseInt`. `parseInt` reads a
 * numeric PREFIX and discards the rest, so `parseInt("403_policy", 10) === 403`
 * and `parseInt("4_0_3", 10) === 4` — the first would dispatch a content block
 * as somebody else's policy refusal, the second as a status that exists
 * nowhere. Requiring exactly three digits in 100-599 makes "an unrecognised
 * code falls back" a property of this function rather than an accident of what
 * `parseInt` happens to reject.
 */
function dispatchCode(code: string | undefined, status: number): number {
  if (typeof code !== 'string' || !HTTP_SHAPED_CODE.test(code)) return status;
  const parsed = Number.parseInt(code, 10);
  return parsed >= 100 && parsed < 600 ? parsed : status;
}

/** Parse an integer-seconds or HTTP-date Retry-After header into seconds, or undefined. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const asInt = Number(trimmed);
  if (Number.isFinite(asInt)) return asInt;
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, (asDate - Date.now()) / 1000);
  }
  return undefined;
}

/**
 * Throw the appropriate Shashu error for a non-2xx gateway Response.
 * No-op for 2xx (use {@link raiseIfContentFiltered} for the 200 block path).
 * Reads the body, so call only when you will not also consume `res`.
 *
 * **This function FAILS OPEN as to block-ness, deliberately, and that is the
 * opposite direction to {@link isShashuBlock}. Both are correct because
 * they answer different questions.** This one decides whether to REPLACE a
 * provider's own error with a Shashu type: turning a genuine provider 400
 * into a fake block would break `catch` clauses a customer already has, so it
 * needs a positive signal (a 403, or a 400 whose `error.type` is
 * `content_filter`) before it acts, and anything unreadable stays a generic
 * ShashuError / ShashuBadRequestError. `isShashuBlock` is called on
 * an error the customer already holds, replaces nothing, and therefore fails
 * CLOSED — an unparseable Shashu block signal answers true there. See the
 * docstring on that function for the full argument.
 *
 * @see isShashuBlock
 */
export async function raiseForResponse(res: Response, decision?: Decision): Promise<void> {
  if (res.ok) return;

  const status = res.status;
  let body: unknown;
  let parsed: GatewayErrorBody = {};
  try {
    const text = await res.text();
    body = text;
    parsed = JSON.parse(text) as GatewayErrorBody;
    body = parsed;
  } catch {
    // keep raw text (or undefined) as body
  }

  const err = parsed?.error ?? {};
  const message =
    (typeof err.message === 'string' && err.message) ||
    (typeof parsed?.message === 'string' && parsed.message) ||
    `SHASHU gateway error (HTTP ${status}).`;
  const type = err.type;
  const code = err.code;
  const details = { type, code, decision, responseHeaders: res.headers };

  // `error.code` is a §3 REASON on the contract versions and the HTTP status as
  // a string on legacy; see `dispatchCode`, which honours it only in the second
  // shape and otherwise dispatches on the transport status.
  const kind = dispatchCode(code, status);

  if (kind === 401) throw new ShashuAuthenticationError(message, status, body, details);

  if (kind === 429) {
    // The structured detail is at error.details.error, not on error. The OUTER
    // message on a token-bucket rejection is the literal string "error", so the
    // readable one comes from the detail too.
    const detail = rateLimitDetail(err);
    const retryAfterSeconds =
      detail.retry_after_seconds ?? parseRetryAfter(res.headers.get('retry-after'));
    throw new ShashuRateLimitError(detail.message ?? message, status, body, {
      ...details,
      scope: detail.scope,
      retryAfterSeconds,
    });
  }

  if (kind === 403) {
    // One type for every 403. Budget-vs-policy was guessed from the message text
    // until 1.8.0; the gateway sends nothing to tell them apart, so the guess is
    // gone rather than dressed up. See ShashuBudgetExceededError. A refused
    // memory write is the one 403 with its own type, read off the decision's
    // memory block rather than off `code`.
    if (decision !== undefined && decision.memoryBlocked > 0) {
      throw new MemoryWriteBlocked(message, status, body, details);
    }
    throw new ShashuPolicyViolation(message, status, body, details);
  }

  if (kind === 400) {
    if (type === 'context_window_exceeded') {
      throw new ShashuContextWindowExceeded(message, status, body, details);
    }
    if (type === 'content_filter') {
      // A security block under the `explicit` encoding — the SAME event as the
      // 200 + finish_reason shape, on a different serialisation. It was thrown
      // as ShashuBadRequestError, which told every caller their request was
      // malformed and sent the well-behaved ones off to fix a payload that was
      // never the problem. `error.code` names the finding (`jailbreak`, `dlp`,
      // ...) and is carried through on `.code`.
      throw new ShashuContentFilterError(message, body, null, status, details);
    }
    throw new ShashuBadRequestError(message, status, body, details);
  }

  if (kind === 502 || kind === 503 || kind === 504) {
    throw new ShashuProviderError(message, status, body, details);
  }

  throw new ShashuError(message, status, body, details);
}

/** Throw ShashuContentFilterError if a parsed 200 body was content-filtered. */
export function raiseIfContentFiltered(
  json: unknown,
  decision?: Decision,
  headers?: Headers
): void {
  if (!json || typeof json !== 'object') return;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const first = choices[0] as { finish_reason?: unknown };
  if (first?.finish_reason === 'content_filter') {
    throw new ShashuContentFilterError(
      "Response was blocked by the gateway content filter (finish_reason='content_filter').",
      json,
      'content_filter',
      200,
      { decision, responseHeaders: headers }
    );
  }
}
