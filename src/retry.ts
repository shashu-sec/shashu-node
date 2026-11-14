/**
 * Conservative client-side retry policy for the Shashu Node SDK (mirrors Python).
 *
 * The gateway already retries upstream providers (3 attempts, backoff+jitter,
 * per-provider circuit breakers, honoring Retry-After), so the SDK does not
 * retry provider 5xx by default — stacking retries would amplify load during an
 * incident.
 *
 * **A status code is not a retry signal.** The gateway returns 429 for two
 * unrelated reasons and only one of them clears on its own:
 *
 *  - the **token bucket** (tenant/agent RPS, tenant TPM) sends `Retry-After`
 *    and `error.details.error.retry_after_seconds`. It is telling you when to
 *    come back. Retryable, at that time.
 *  - the **identical-request breaker** — the same request body repeated inside
 *    one trace id — sends **no** `Retry-After` and no structured detail.
 *    Retrying is worse than useless: the counter is incremented by the retry
 *    and its 60-second window is refreshed from the last hit, so a client that
 *    retries holds itself in the block it is trying to escape.
 *
 * So the rule this module enforces is: **retry a refusal only when the gateway
 * named a time to come back.** No `Retry-After` and no `retry_after_seconds`
 * means the gateway is not inviting a retry, whatever the status says — see
 * `gatewayRetryAfter` in ./exceptions.js.
 *
 * That also declines to retry a provider rate limit passed through from
 * upstream, which carries no retry time either. Deliberate, and consistent with
 * the 5xx default above: by the time a provider error reaches you the gateway
 * has already spent its own three attempts on it.
 *
 * By default the SDK retries:
 *  - connection-level failures reaching the gateway (the request never landed), and
 *  - HTTP 429 **that carries a retry time**, honoring it.
 *
 * 401/400/403/404, a 429 with no retry time, and 200-`content_filter` are never
 * retried — they are decisions, not transient failures.
 */

import { gatewayRetryAfter } from './exceptions.js';

export interface RetryPolicy {
  /** Max retries after the initial attempt. Default 2. */
  maxRetries: number;
  /** Base for exponential backoff (seconds). Default 0.5. */
  backoffBaseSeconds: number;
  /** Cap on any single backoff (seconds). Default 30. */
  backoffMaxSeconds: number;
  /** Retry connection-level failures (fetch TypeError). Default true. */
  retryOnConnectionErrors: boolean;
  /** Retry HTTP 429. Default true. */
  retryOn429: boolean;
  /** Retry HTTP 5xx. Default false — the gateway already retries providers. */
  retryOn5xx: boolean;
  /** Statuses that are never retried, even if a flag above would allow it. */
  neverRetryStatus: number[];
  /** Ignore the Retry-After header on 429 and use exponential backoff instead. */
  ignoreRetryAfter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffBaseSeconds: 0.5,
  backoffMaxSeconds: 30,
  retryOnConnectionErrors: true,
  retryOn429: true,
  retryOn5xx: false,
  neverRetryStatus: [400, 401, 403, 404],
  ignoreRetryAfter: false,
};

/** Resolve a config's retryPolicy: undefined -> default; null -> disabled; object -> merged over defaults. */
export function resolveRetryPolicy(
  policy: Partial<RetryPolicy> | null | undefined
): RetryPolicy | null {
  if (policy === null) return null;
  if (policy === undefined) return { ...DEFAULT_RETRY_POLICY };
  return { ...DEFAULT_RETRY_POLICY, ...policy };
}

/**
 * Status-level gate ONLY. It cannot see whether the gateway marked this
 * particular refusal permanent, so it is not the whole decision — see
 * {@link shouldRetryResponse}.
 */
function shouldRetryStatus(policy: RetryPolicy, status: number): boolean {
  if (policy.neverRetryStatus.includes(status)) return false;
  if (status === 429) return policy.retryOn429;
  if (status >= 500 && status <= 599) return policy.retryOn5xx;
  return false;
}

/**
 * Whether this specific response may be retried: the status gate first, then
 * the permanence check. A 429 is retried only when the gateway named a time to
 * come back — retrying the identical-request breaker refreshes the window that
 * is blocking you.
 *
 * `retryAfter` is the value already read for this response, so the body is
 * parsed at most once per attempt and the response stream is never consumed
 * here (the caller must still be able to read it).
 */
function shouldRetryResponse(
  policy: RetryPolicy,
  res: Response,
  retryAfter: number | undefined
): boolean {
  if (!shouldRetryStatus(policy, res.status)) return false;
  if (res.status === 429) return retryAfter !== undefined;
  return true;
}

function delayFor(
  policy: RetryPolicy,
  attempt: number,
  res: Response | null,
  retryAfter: number | undefined
): number {
  if (res !== null && res.status === 429 && !policy.ignoreRetryAfter && retryAfter !== undefined) {
    return Math.min(policy.backoffMaxSeconds, retryAfter);
  }
  return Math.min(policy.backoffMaxSeconds, policy.backoffBaseSeconds * 2 ** attempt);
}

/** A thrown error from `fetch` that represents a connection-level failure. */
function isConnectionError(err: unknown): boolean {
  // undici/global fetch rejects network failures as a TypeError ("fetch failed").
  return err instanceof TypeError;
}

const defaultSleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Parse a response body without consuming the original stream. */
async function peekJson(res: Response): Promise<unknown> {
  try {
    return await res.clone().json();
  } catch {
    return undefined;
  }
}

/**
 * Run `send` with retries per `policy`; returns the final Response.
 * Retry decisions are made on raw status / connection errors BEFORE typed-exception
 * dispatch, so the caller still maps the final response to the exception hierarchy.
 */
export async function executeWithRetry(
  send: () => Promise<Response>,
  policy: RetryPolicy | null,
  sleep: (seconds: number) => Promise<void> = defaultSleep
): Promise<Response> {
  if (policy === null) return send();
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await send();
    } catch (err) {
      if (policy.retryOnConnectionErrors && isConnectionError(err) && attempt < policy.maxRetries) {
        await sleep(delayFor(policy, attempt, null, undefined));
        attempt += 1;
        continue;
      }
      throw err;
    }
    // Read the retry time from a CLONE: the caller still has to read this body,
    // and a Response body can only be consumed once.
    const retryAfter = res.status === 429 ? gatewayRetryAfter(res, await peekJson(res)) : undefined;
    if (attempt < policy.maxRetries && shouldRetryResponse(policy, res, retryAfter)) {
      await sleep(delayFor(policy, attempt, res, retryAfter));
      attempt += 1;
      continue;
    }
    return res;
  }
}
