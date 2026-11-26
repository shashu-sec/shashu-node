import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shashu, decisionFrom, HEADER_PREFIX } from '../src/index';
import { BOTH_OR_NEITHER } from '../src/credential.js';
import { executeWithRetry, resolveRetryPolicy, type RetryPolicy } from '../src/retry.js';

const BUSY_SENTENCE = 'The gateway is busy. Retry after the advertised wait.';
const CHAT = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};

function ok(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ...CHAT, ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function busy(
  headers: Record<string, string> = { 'Retry-After': '1', 'x-should-retry': 'true' }
): Response {
  return new Response(JSON.stringify({ error: { message: BUSY_SENTENCE, code: 'gateway_busy' } }), {
    status: 503,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const policy = (over: Partial<RetryPolicy> = {}) => resolveRetryPolicy(over) as RetryPolicy;

describe('SDK 1.1.0 SHASHU wire names', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(a) only x-shashu / Shashu names are sent', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return ok();
    });
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'shashu_sk_test',
      retryPolicy: null,
    });
    await tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
    const headers = seen[0]!;
    const names = [...headers.keys()].map((k) => k.toLowerCase());
    expect(names.filter((k) => k.startsWith('x-trustgate-') || k === 'trustgate-version')).toEqual(
      []
    );
    expect(names.some((k) => k === 'x-shashu-trace-id' || k === 'x-shashu-session-id')).toBe(true);
    expect(headers.get('shashu-version')).toBe('2026-09-01');
    expect(HEADER_PREFIX).toBe('x-shashu');
  });

  it('(b) x-shashu response headers and body shashu are read', async () => {
    vi.stubGlobal('fetch', async () =>
      ok(
        { shashu: { decision: 'allow', code: 'ok' } },
        { 'x-shashu-decision': 'allow', 'x-shashu-code': 'ok', 'Shashu-Version': '2026-09-01' }
      )
    );
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      retryPolicy: null,
    });
    const res = await tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
    const body = await res.json();
    const d = decisionFrom(body, res.headers);
    expect(d?.decision).toBe('allow');
  });

  it('(c) old response names are ignored', async () => {
    vi.stubGlobal('fetch', async () =>
      ok(
        { trustgate: { decision: 'block', code: 'jailbreak' } },
        {
          'x-trustgate-decision': 'block',
          'x-trustgate-code': 'jailbreak',
          'TrustGate-Version': '2026-09-01',
        }
      )
    );
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      retryPolicy: null,
    });
    const res = await tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
    const body = await res.json();
    expect(decisionFrom(body, res.headers)).toBeUndefined();
  });

  it('(d) shashu_metadata is sent for rag', async () => {
    let raw = '';
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      raw = String(init?.body ?? '');
      return ok();
    });
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'shashu_sk_test',
      retryPolicy: null,
    });
    await tg.fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'm',
        messages: [],
        shashu_metadata: {
          rag_context: { v: 1, corpus: 'handbook', docs: [{ id: 'D', preview: 'p' }] },
        },
      }),
    });
    const parsed = JSON.parse(raw);
    expect(parsed.shashu_metadata.rag_context.corpus).toBe('handbook');
    expect(parsed.trustgate_metadata).toBeUndefined();
  });

  it('(e) shashu_sk_ keys work and both-or-neither text is exact', () => {
    expect(BOTH_OR_NEITHER).toBe('Give either a SHASHU key or a token provider, not both.');
    expect(
      () =>
        new Shashu({
          baseUrl: 'http://127.0.0.1:9',
          apiKey: 'shashu_sk_x',
          tokenProvider: () => 'p',
        })
    ).toThrow(BOTH_OR_NEITHER);
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'shashu_sk_x',
      retryPolicy: null,
    });
    expect(tg).toBeTruthy();
  });
});

describe('SDK 1.1.0 busy-retry', () => {
  it('(f) waits for Retry-After then succeeds', async () => {
    const sleeps: number[] = [];
    const send = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
    await executeWithRetry(send, policy(), async (s) => {
      sleeps.push(s);
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1);
    expect(sleeps[0]).toBeLessThanOrEqual(1.2);
  });

  it('(f) gives up after max and keeps the gateway sentence', async () => {
    const send = vi.fn().mockResolvedValue(busy());
    const res = await executeWithRetry(send, policy(), async () => {});
    expect(res.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(3);
    const body = await res.json();
    expect(body.error.message).toBe(BUSY_SENTENCE);
    expect(body.error.code).toBe('gateway_busy');
  });

  it('(f) no retry without invitation', async () => {
    const sleeps: number[] = [];
    const send = vi.fn().mockResolvedValue(busy({}));
    const res = await executeWithRetry(send, policy(), async (s) => {
      sleeps.push(s);
    });
    expect(res.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('(f) maxRetries 0 disables busy-retry', async () => {
    const send = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
    const res = await executeWithRetry(send, policy({ maxRetries: 0 }), async () => {});
    expect(res.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('(f) x-should-retry without Retry-After still retries', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(busy({ 'x-should-retry': 'true' }))
      .mockResolvedValueOnce(ok());
    await executeWithRetry(send, policy(), async () => {});
    expect(send).toHaveBeenCalledTimes(2);
  });
});
