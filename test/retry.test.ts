import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shashu, executeWithRetry, resolveRetryPolicy, type RetryPolicy } from '../src/index';
import { LOOP_BREAKER_429, RATE_LIMIT_429 } from './captured';

// The 429 bodies are verbatim captures (./captured.ts). The gateway sends two
// unrelated 429s and only one is retryable, which is the whole point of the
// permanence rule these tests pin.
//
// The 5xx responses are NOT captures -- the harness cannot make a provider
// return 5xx without breaking a credential -- so those tests assert the retry
// POLICY (call counts and sleeps), never the envelope.

function resp(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Token bucket: names a retry time, in the header and in the body. */
function rateLimited(): Response {
  return new Response(JSON.stringify(RATE_LIMIT_429), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '1' },
  });
}

/**
 * Identical-request breaker: names no retry time. Permanent for this body.
 *
 * The gateway increments the breaker's counter on every hit and refreshes its
 * 60-second window from the last one, so a client that retries holds itself
 * inside the block it is trying to escape.
 */
function loopBreaker(): Response {
  return new Response(JSON.stringify(LOOP_BREAKER_429), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });
}

function ok(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

const policy = (over: Partial<RetryPolicy> = {}) => resolveRetryPolicy(over) as RetryPolicy;
const noopSleep = async () => {};

function refused(): TypeError {
  const err = new TypeError('fetch failed');
  (err as Error & { cause: { code: string } }).cause = { code: 'ECONNREFUSED' };
  return err;
}

function resetAfterSend(): TypeError {
  const err = new TypeError('fetch failed');
  (err as Error & { cause: { code: string } }).cause = { code: 'ECONNRESET' };
  return err;
}

describe('executeWithRetry (unit)', () => {
  it('retries connection errors then succeeds (exponential backoff)', async () => {
    const sleeps: number[] = [];
    const send = vi
      .fn()
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(ok());
    const res = await executeWithRetry(send, policy(), async (s) => {
      sleeps.push(s);
    });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0.5);
    expect(sleeps[0]).toBeLessThanOrEqual(0.6);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1.0);
    expect(sleeps[1]).toBeLessThanOrEqual(1.2);
  });

  it('exhausts connection retries then rethrows', async () => {
    const send = vi.fn().mockRejectedValue(refused());
    await expect(executeWithRetry(send, policy(), noopSleep)).rejects.toBeInstanceOf(TypeError);
    expect(send).toHaveBeenCalledTimes(3); // 1 + maxRetries(2)
  });

  it('429 with a retry time is retried at that time', async () => {
    const sleeps: number[] = [];
    const send = vi.fn().mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(ok());
    await executeWithRetry(send, policy(), async (s) => {
      sleeps.push(s);
    });
    expect(sleeps[0]).toBeGreaterThanOrEqual(1);
    expect(sleeps[0]).toBeLessThanOrEqual(1.2); // Retry-After plus jitter
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('429 without a retry time is not retried at all', async () => {
    // The permanence rule: no retry time means the gateway is not inviting one.
    // Before 1.7.3 this was retried on exponential backoff, which re-trips the
    // identical-request breaker and refreshes the window blocking the caller.
    const sleeps: number[] = [];
    const send = vi.fn().mockResolvedValueOnce(loopBreaker()).mockResolvedValueOnce(ok());
    const res = await executeWithRetry(send, policy(), async (s) => {
      sleeps.push(s);
    });
    expect(res.status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1); // the ok() second response is never reached
    expect(sleeps).toEqual([]);
  });

  it('a retried 429 is still readable by the caller (the peek uses a clone)', async () => {
    const send = vi.fn().mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(rateLimited());
    const res = await executeWithRetry(send, policy({ maxRetries: 1 }), async () => {});
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ error: { code: '429' } });
  });

  it('does not retry 5xx by default', async () => {
    const send = vi.fn().mockResolvedValue(resp(502));
    const res = await executeWithRetry(send, policy(), noopSleep);
    expect(res.status).toBe(502);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx when enabled', async () => {
    const send = vi.fn().mockResolvedValueOnce(resp(502)).mockResolvedValueOnce(ok());
    const res = await executeWithRetry(send, policy({ retryOn5xx: true }), noopSleep);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never retries 403', async () => {
    const send = vi.fn().mockResolvedValue(resp(403));
    const res = await executeWithRetry(send, policy(), noopSleep);
    expect(send).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(403);
  });

  it('policy=null disables retries (connection error propagates immediately)', async () => {
    const send = vi.fn().mockRejectedValue(refused());
    await expect(executeWithRetry(send, null)).rejects.toBeInstanceOf(TypeError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('retry wired into the client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('client retries a connection error then succeeds', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(refused()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      retryPolicy: { backoffBaseSeconds: 0 },
    });
    const res = await tg.fetch('/v1/chat/completions', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('transport retry after the request has left', () => {
  it('does not resend on ECONNRESET (request may already have run)', async () => {
    const send = vi.fn().mockRejectedValueOnce(resetAfterSend()).mockResolvedValueOnce(ok());
    await expect(executeWithRetry(send, policy(), noopSleep)).rejects.toBeInstanceOf(TypeError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
