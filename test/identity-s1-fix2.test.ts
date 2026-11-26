/**
 * IDENTITY S1-FIX2: pass refusals are recognised by the gateway's fixed code.
 *
 * The gateway (identity/i13-fix) refuses a pass with HTTP 401, a fixed
 * `error.code` and its approved sentence. The SDK retries ONCE, after fetching
 * a new pass, only for `pass_expired`; every other code throws with `.code`
 * and the gateway's message unchanged. The old "Pass refused: ..." sentence
 * list is gone -- the gateway never sent those sentences, so the retry never
 * fired.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shashu } from '../src/client.js';
import { shashuFetch } from '../src/fetch.js';
import * as credential from '../src/credential.js';
import * as sdk from '../src/index.js';
import { ShashuAuthenticationError } from '../src/exceptions.js';

const SENTENCE: Record<string, string> = {
  pass_provider_not_set_up: 'No identity provider is set up for agents.',
  pass_not_licensed: 'Pass sign-in needs the Enterprise plan.',
  pass_expired: 'This pass has expired. Fetch a new one.',
  pass_wrong_audience: 'This pass is meant for a different audience.',
  pass_wrong_issuer: 'This pass comes from an unknown issuer.',
  pass_unknown_agent: 'No agent matches this pass.',
};

const CHAT = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};

function refusal(code: string): Response {
  return new Response(
    JSON.stringify({
      error: { message: SENTENCE[code], type: 'invalid_request_error', param: null, code },
    }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
}

function ok(): Response {
  return new Response(JSON.stringify(CHAT), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function twoPasses() {
  const calls = { n: 0 };
  // The exp claim is in the past, so the resolver never reuses a cached pass by
  // accident: each fetch is a provider call we can count.
  const provider = () => {
    calls.n += 1;
    return `pass-${calls.n}`;
  };
  return { provider, calls };
}

function plan(responses: Array<() => Response>) {
  const auths: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    auths.push(h.authorization ?? h.Authorization ?? '');
    const next = responses.shift();
    return next ? next() : ok();
  });
  return auths;
}

const call = (tg: Shashu) => tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });

describe('IDENTITY S1-FIX2: refusals by code', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pass_expired: fetches a new pass and retries once', async () => {
    const { provider, calls } = twoPasses();
    const auths = plan([() => refusal('pass_expired'), ok]);
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: provider,
      retryPolicy: null,
    });
    const res = await call(tg);
    expect(res.status).toBe(200);
    expect(calls.n).toBe(2);
    expect(auths).toEqual(['Bearer pass-1', 'Bearer pass-2']);
  });

  for (const code of Object.keys(SENTENCE).filter((c) => c !== 'pass_expired')) {
    it(`${code}: throws with .code and the exact message, no retry`, async () => {
      const { provider, calls } = twoPasses();
      const auths = plan([() => refusal(code), ok]);
      const tg = new Shashu({
        baseUrl: 'http://127.0.0.1:9',
        tokenProvider: provider,
        retryPolicy: null,
      });
      const err = await call(tg).catch((e) => e);
      expect(err).toBeInstanceOf(ShashuAuthenticationError);
      expect(err.code).toBe(code);
      expect(err.message).toBe(SENTENCE[code]);
      expect(calls.n).toBe(1);
      expect(auths.length).toBe(1);
    });
  }

  it('pass_expired twice: retries only once', async () => {
    const { provider, calls } = twoPasses();
    const auths = plan([() => refusal('pass_expired'), () => refusal('pass_expired')]);
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: provider,
      retryPolicy: null,
    });
    const err = await call(tg).catch((e) => e);
    expect(err.code).toBe('pass_expired');
    expect(err.message).toBe(SENTENCE.pass_expired);
    expect(calls.n).toBe(2);
    expect(auths.length).toBe(2);
  });

  it('an older gateway with no code is not retried', async () => {
    const { provider, calls } = twoPasses();
    plan([
      () =>
        new Response(
          JSON.stringify({
            error: { message: SENTENCE.pass_expired, type: 'invalid_request_error' },
          }),
          {
            status: 401,
          }
        ),
    ]);
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: provider,
      retryPolicy: null,
    });
    const err = await call(tg).catch((e) => e);
    expect(err).toBeInstanceOf(ShashuAuthenticationError);
    expect(err.message).toBe(SENTENCE.pass_expired);
    expect(calls.n).toBe(1);
  });

  it('key mode never retries, even on pass_expired', async () => {
    const auths = plan([() => refusal('pass_expired'), ok]);
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'shashu_sk_test',
      retryPolicy: null,
    });
    const err = await call(tg).catch((e) => e);
    expect(err.code).toBe('pass_expired');
    expect(auths).toEqual(['Bearer shashu_sk_test']);
  });

  it('streaming: retries on pass_expired before any byte', async () => {
    const { provider, calls } = twoPasses();
    plan([
      () => refusal('pass_expired'),
      () =>
        new Response('data: x\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    ]);
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: provider,
      retryPolicy: null,
    });
    const res = await tg.fetchStream('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(calls.n).toBe(2);
  });

  it('no retry once bytes have arrived', () => {
    expect(
      credential.shouldRetryPassRefused({
        usesProvider: true,
        status: 401,
        code: 'pass_expired',
        bytesDelivered: true,
      })
    ).toBe(false);
    expect(
      credential.shouldRetryPassRefused({
        usesProvider: true,
        status: 401,
        code: 'pass_expired',
        bytesDelivered: false,
      })
    ).toBe(true);
  });

  it('shashuFetch (plain OpenAI client path) retries on pass_expired too', async () => {
    const { provider, calls } = twoPasses();
    plan([() => refusal('pass_expired'), ok]);
    const f = shashuFetch({ tokenProvider: provider });
    const res = await f('http://127.0.0.1:9/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(calls.n).toBe(2);
  });

  it('the six codes are named constants', () => {
    const s = sdk as Record<string, unknown>;
    expect(s.PASS_CODES).toEqual(Object.keys(SENTENCE));
    expect(s.PASS_EXPIRED).toBe('pass_expired');
    for (const n of [
      'PASS_PROVIDER_NOT_SET_UP',
      'PASS_NOT_LICENSED',
      'PASS_EXPIRED',
      'PASS_WRONG_AUDIENCE',
      'PASS_WRONG_ISSUER',
      'PASS_UNKNOWN_AGENT',
    ]) {
      expect(Object.keys(SENTENCE)).toContain(s[n]);
    }
  });

  it('the old sentence list is gone', () => {
    expect((credential as Record<string, unknown>).PASS_REFUSED_MESSAGES).toBeUndefined();
  });
});
