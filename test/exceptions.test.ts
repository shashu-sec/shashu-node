import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Shashu,
  ShashuError,
  ShashuAuthenticationError,
  ShashuBadRequestError,
  ShashuContextWindowExceeded,
  ShashuRateLimitError,
  ShashuPermissionError,
  ShashuBudgetExceededError,
  ShashuPolicyViolation,
  ShashuProviderError,
  ShashuContentFilterError,
} from '../src/index';
import {
  ACCESS_403_MESSAGES_WIRE,
  ACCESS_403_MODEL_NOT_ALLOWED,
  AUTH_401_INVALID_KEY,
  AUTH_401_NO_HEADER,
  CRASH_500,
  LOOP_BREAKER_429,
  POLICY_403_EGRESS_DENIED,
  PROVIDER_404,
  RATE_LIMIT_429,
  SCHEMA_INVALID_400,
  SECURITY_BLOCK_200,
  SECURITY_BLOCK_400_DLP,
  SECURITY_BLOCK_400_JAILBREAK,
} from './captured';

// Bodies come from ./captured.ts -- verbatim recordings from a live gateway.
// Stubbed fetch returns whatever it is handed, so a hand-written body here
// proves nothing; three tests in this file used to assert shapes the gateway
// has never sent and passed anyway. See that module's header.

const BASE = 'https://gateway.example';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function errBody(
  opts: {
    message?: string;
    type?: string;
    code?: string;
    scope?: string;
    retry_after_seconds?: number;
  } = {}
) {
  return {
    error: {
      message: opts.message ?? 'boom',
      type: opts.type,
      code: opts.code,
      param: null,
      scope: opts.scope,
      retry_after_seconds: opts.retry_after_seconds,
    },
    choices: [],
  };
}

// Disable retries for pure dispatch tests so 429 doesn't sleep/retry.
function client() {
  return new Shashu({ baseUrl: BASE, apiKey: 'k', retryPolicy: null });
}

function mockFetchOnce(res: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => res)
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('typed exception dispatch', () => {
  it("401 invalid agent key is the gateway's OWN auth failure", async () => {
    mockFetchOnce(jsonResponse(401, AUTH_401_INVALID_KEY));
    const err = await client()
      .fetch('/v1/chat/completions', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuAuthenticationError);
    expect((err as Error).message).toBe('Invalid TrustGate API Key');
    // The gateway's OWN 401 carries invalid_request_error. It does NOT carry
    // "authentication_error" -- that value belongs to a provider pass-through,
    // and this module used to document the opposite.
    expect((err as ShashuAuthenticationError).type).toBe('invalid_request_error');
    expect((err as ShashuAuthenticationError).isProviderPassthrough).toBe(false);
  });

  it("401 missing header is also the gateway's own", async () => {
    mockFetchOnce(jsonResponse(401, AUTH_401_NO_HEADER, { 'www-authenticate': 'Bearer' }));
    const err = await client()
      .fetch('/x', { method: 'POST' })
      .catch((e) => e);
    expect((err as Error).message).toBe('Not authenticated');
    expect((err as ShashuAuthenticationError).isProviderPassthrough).toBe(false);
  });

  it('400 invalid_request_error -> ShashuBadRequestError (not context-window)', async () => {
    mockFetchOnce(jsonResponse(400, errBody({ type: 'invalid_request_error', code: '400' })));
    const err = await client()
      .fetch('/x', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuBadRequestError);
    expect(err).not.toBeInstanceOf(ShashuContextWindowExceeded);
  });

  it('400 context_window_exceeded -> ShashuContextWindowExceeded (subclass of BadRequest)', async () => {
    mockFetchOnce(jsonResponse(400, errBody({ type: 'context_window_exceeded', code: '400' })));
    const err = await client()
      .fetch('/x', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuContextWindowExceeded);
    expect(err).toBeInstanceOf(ShashuBadRequestError);
  });

  it('429 token bucket reads the nested detail, not error.*', async () => {
    // scope and retry_after_seconds live at error.details.error. Reading them
    // off `error` (what this SDK did before 1.7.3) left scope undefined on
    // every rate-limit rejection, and surfaced the outer message -- which the
    // gateway sets to the literal string "error".
    mockFetchOnce(jsonResponse(429, RATE_LIMIT_429, { 'retry-after': '1' }));
    const err = await client()
      .fetch('/x', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuRateLimitError);
    expect((err as ShashuRateLimitError).scope).toBe('agent');
    expect((err as ShashuRateLimitError).retryAfterSeconds).toBe(1);
    expect((err as Error).message).toBe('Rate limit exceeded (agent). Retry after 1 second(s).');
    expect((err as Error).message).not.toBe('error');
  });

  it('429 loop breaker has no scope and no retry time', async () => {
    // The other 429. No details, no Retry-After -- and that absence is the signal.
    mockFetchOnce(jsonResponse(429, LOOP_BREAKER_429));
    const err = await client()
      .fetch('/x', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuRateLimitError);
    expect((err as ShashuRateLimitError).scope).toBeUndefined();
    expect((err as ShashuRateLimitError).retryAfterSeconds).toBeUndefined();
    expect((err as Error).message).toBe('Infinite Loop Detected');
  });

  it('403 access denial -> ShashuPolicyViolation (and instanceof ShashuError for back-compat)', async () => {
    mockFetchOnce(jsonResponse(403, ACCESS_403_MODEL_NOT_ALLOWED));
    const err = await client()
      .fetch('/x', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect(err).toBeInstanceOf(ShashuPermissionError);
    expect(err).toBeInstanceOf(ShashuError); // existing customer catches still work
    expect((err as Error).message).toContain('not in the allowed routes');
  });

  it('403 is never split by words in the message', async () => {
    // Until 1.7.3 a /budget/i match threw ShashuBudgetExceededError. The
    // gateway sends no discriminator -- every 403 is
    // {type:"invalid_request_error", code:"403"} -- so the split was guessing
    // from prose. It is gone; nothing throws the budget subclass today.
    const body = {
      error: {
        ...ACCESS_403_MODEL_NOT_ALLOWED.error,
        message: 'Access Denied: this agent has no budget headroom for that route.',
      },
      choices: [],
    };
    mockFetchOnce(jsonResponse(403, body));
    const err = await client()
      .fetch('/x', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect(err).not.toBeInstanceOf(ShashuBudgetExceededError);
  });

  it('403 on the messages wire still dispatches (no error.code at all)', async () => {
    mockFetchOnce(jsonResponse(403, ACCESS_403_MESSAGES_WIRE));
    const err = await client()
      .fetch('/x', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect((err as ShashuError).status).toBe(403);
    expect((err as Error).message).toContain('not in the allowed routes');
  });

  it('404 provider pass-through is not a permission error', async () => {
    mockFetchOnce(jsonResponse(404, PROVIDER_404));
    const err = await client()
      .fetch('/x', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuError);
    expect(err).not.toBeInstanceOf(ShashuPermissionError);
    expect((err as ShashuError).status).toBe(404);
    expect((err as ShashuError).type).toBe('ProviderModelNotFoundError');
  });

  it('502 -> ShashuProviderError', async () => {
    // Status-level assertion only: the harness cannot make a provider return
    // 5xx without breaking a credential, so there is no captured envelope for
    // this one and none is invented.
    mockFetchOnce(
      jsonResponse(502, { error: { message: 'upstream down', code: '502' }, choices: [] })
    );
    await expect(client().fetch('/x', { method: 'POST' })).rejects.toBeInstanceOf(
      ShashuProviderError
    );
  });

  it('200 with content_filter -> ShashuContentFilterError', async () => {
    const body = {
      id: 'chatcmpl-x',
      choices: [
        { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' },
      ],
    };
    mockFetchOnce(jsonResponse(200, body));
    const err = await client()
      .fetch('/v1/chat/completions', { method: 'POST' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShashuContentFilterError);
    expect((err as ShashuContentFilterError).finishReason).toBe('content_filter');
  });

  it('normal 200 does not throw and body is still readable after the content-filter peek', async () => {
    const body = {
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    };
    mockFetchOnce(jsonResponse(200, body));
    const res = await client().fetch('/v1/chat/completions', { method: 'POST' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(body); // clone() peek left the body intact
  });
});

// ---------------------------------------------------------------------------
// Contract 2026-09-01 dispatch — the five properties, pinned
// ---------------------------------------------------------------------------
// `error.code` stopped being "the HTTP status as a string" on every path when
// the gateway shipped its §3 reason vocabulary, and the dispatcher's fail-closed
// behaviour was left resting on the fact that `parseInt("jailbreak")` happens to
// return NaN. These five make each property structural instead: (a) the block
// that was answered as a client error, (b) an unrecognised code on a 403, (c) an
// unrecognised code on a 400, (d) no code at all, (e) a code that merely looks
// numeric.
describe('contract 2026-09-01 dispatch', () => {
  const post = () =>
    client()
      .fetch('/v1/chat/completions', { method: 'POST' })
      .catch((e) => e);

  it('(a) 400 + type content_filter is a content filter, NOT a bad request', async () => {
    // THE defect. Under the `explicit` encoding a security block is a 400. It
    // was thrown as ShashuBadRequestError, which tells the caller their
    // request was malformed — so the well-behaved integration goes and "fixes"
    // a payload that was never the problem, and the block never reaches
    // whatever handles blocks.
    mockFetchOnce(jsonResponse(400, SECURITY_BLOCK_400_JAILBREAK));
    const err = await post();
    expect(err).toBeInstanceOf(ShashuContentFilterError);
    expect(err).not.toBeInstanceOf(ShashuBadRequestError);
    expect((err as ShashuContentFilterError).status).toBe(400);
    expect((err as ShashuContentFilterError).type).toBe('content_filter');
    // The finding survives to the caller — this is the field that says WHICH
    // detector refused, and the reason `error.code` is no longer a status.
    expect((err as ShashuContentFilterError).code).toBe('jailbreak');
    // No choices array on this encoding, so nothing carries a finish reason.
    expect((err as ShashuContentFilterError).finishReason).toBeNull();
  });

  it("(a') every §3 content code lands on the same type, not just jailbreak", async () => {
    mockFetchOnce(jsonResponse(400, SECURITY_BLOCK_400_DLP));
    const err = await post();
    expect(err).toBeInstanceOf(ShashuContentFilterError);
    expect((err as ShashuContentFilterError).code).toBe('dlp');
  });

  it('the two block encodings throw the SAME type', async () => {
    // Which one a caller sees is chosen by a request header or an account
    // default — neither of which the calling code necessarily controls. If the
    // two threw different types, an operator moving the account default would
    // break a customer's catch clause with no change on the customer's side.
    mockFetchOnce(jsonResponse(200, SECURITY_BLOCK_200));
    const compat = await post();
    mockFetchOnce(jsonResponse(400, SECURITY_BLOCK_400_JAILBREAK));
    const explicit = await post();
    expect(compat.constructor).toBe(explicit.constructor);
    // ...and the caller can still tell them apart when it needs to.
    expect((compat as ShashuContentFilterError).finishReason).toBe('content_filter');
    expect((compat as ShashuContentFilterError).status).toBe(200);
    expect((explicit as ShashuContentFilterError).finishReason).toBeNull();
    expect((explicit as ShashuContentFilterError).status).toBe(400);
  });

  it('(b) 403 + an UNRECOGNISED code is still a policy violation — fail closed', async () => {
    // This is the property that used to hold only because
    // `parseInt("egress_denied")` is NaN. Asserted so it survives any future
    // change to how the code field is read.
    mockFetchOnce(jsonResponse(403, POLICY_403_EGRESS_DENIED));
    const err = await post();
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect(err).toBeInstanceOf(ShashuPermissionError);
    expect((err as ShashuError).status).toBe(403);
    expect((err as ShashuError).code).toBe('egress_denied');
  });

  it('(c) 400 + an unrecognised code is a bad request, not swallowed', async () => {
    // A schema-invalid body sends `code: "invalid_request"` — neither a §3
    // reason nor a status. It must stay a bad request and must NOT fall into
    // the content-filter branch just because it is a 400 with an unknown code.
    mockFetchOnce(jsonResponse(400, SCHEMA_INVALID_400));
    const err = await post();
    expect(err).toBeInstanceOf(ShashuBadRequestError);
    expect(err).not.toBeInstanceOf(ShashuContentFilterError);
    expect(err).not.toBeInstanceOf(ShashuContextWindowExceeded);
    expect((err as ShashuError).status).toBe(400);
    expect((err as ShashuError).code).toBe('invalid_request');
  });

  it('(d) a code that is absent entirely dispatches on the transport status', async () => {
    // The 500 crash handler sends `error` as a bare STRING, so there is no
    // error.code and no error.message.
    mockFetchOnce(jsonResponse(500, CRASH_500));
    const err = await post();
    expect(err).toBeInstanceOf(ShashuError);
    expect((err as ShashuError).status).toBe(500);
    expect((err as ShashuError).code).toBeUndefined();
    // 500 is not in the 502/503/504 provider family and must not be typed as one.
    expect(err).not.toBeInstanceOf(ShashuProviderError);
  });

  it('the Anthropic envelope has no code and dispatches on the status', async () => {
    // `/v1/messages` under the enforced Messages wire drops `code` entirely.
    mockFetchOnce(jsonResponse(403, ACCESS_403_MESSAGES_WIRE));
    const err = await post();
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect((err as ShashuError).code).toBeUndefined();
    expect((err as ShashuError).status).toBe(403);
  });

  // (e) A reason code that merely LOOKS numeric must not become an HTTP status.
  // No §3 code is numeric today, so this is a guard rather than a bug report —
  // but the guard is the whole point: `parseInt` reads a numeric PREFIX and
  // discards the rest, so `parseInt("403_policy") === 403` would have turned a
  // content block on a 400 into a policy violation nobody raised, and
  // `parseInt("4_0_3") === 4` into a status that exists nowhere.
  for (const numericLooking of ['4_0_3', '403_policy', ' 403 ', '+403', '0403']) {
    it(`(e) a numeric-looking code (${JSON.stringify(numericLooking)}) is not dispatched as a status`, async () => {
      const body = {
        ...SECURITY_BLOCK_400_JAILBREAK,
        error: { ...SECURITY_BLOCK_400_JAILBREAK.error, code: numericLooking },
      };
      mockFetchOnce(jsonResponse(400, body));
      const err = await post();
      expect(err).toBeInstanceOf(ShashuContentFilterError);
      expect((err as ShashuError).status).toBe(400);
      expect((err as ShashuError).code).toBe(numericLooking);
    });
  }
});
