import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Shashu } from '../src/client.js';
import { shashuFetch } from '../src/fetch.js';
import { BOTH_OR_NEITHER, PASS_EXPIRED, shouldRetryPassRefused } from '../src/credential.js';
import { ShashuAuthenticationError, ShashuPolicyViolation } from '../src/exceptions.js';
import { createShashuGeminiConfig } from '../src/middleware/google.js';

function mintPass(profile: string, lifetimeS = 300): { token: string; iat: number; exp: number } {
  const root = process.env.IDENTITY_HARNESS_ROOT ?? 'D:\\Trustgate\\_agent\\wt-integrate-resume';
  const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
from tests.identity_harness.harness import IdentityHarness
profile, lifetime = sys.argv[2], int(sys.argv[3])
h = IdentityHarness()
m = h.mint(profile, lifetime_s=lifetime)
print(json.dumps({"token": m.token, "iat": m.claims["iat"], "exp": m.claims["exp"]}))
`;
  const proc = spawnSync('py', ['-3.13', '-c', script, root, profile, String(lifetimeS)], {
    encoding: 'utf8',
  });
  if (proc.status !== 0) throw new Error(proc.stderr || 'mint failed');
  const line = proc.stdout.trim().split(/\r?\n/).at(-1)!;
  return JSON.parse(line);
}

const CHAT = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};

const EXPIRED_SENTENCE = 'This pass has expired. Fetch a new one.';

/** The gateway's pass refusal body (identity/i13-fix): fixed code + its sentence. */
function refusal(message: string = EXPIRED_SENTENCE, code: string = PASS_EXPIRED) {
  return { error: { message, type: 'invalid_request_error', code } };
}

describe('IDENTITY S1', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('both-or-neither error', () => {
    expect(
      () =>
        new Shashu({
          baseUrl: 'http://127.0.0.1:9',
          apiKey: 'tg_sk_x',
          tokenProvider: () => 'p',
        })
    ).toThrow(BOTH_OR_NEITHER);
    expect(() => new Shashu({ baseUrl: 'http://127.0.0.1:9' })).toThrow(BOTH_OR_NEITHER);
  });

  it('reuses a pass until exp-60s', async () => {
    const minted = mintPass('aws_role', 300);
    let n = 0;
    const provider = () => {
      n += 1;
      return minted.token;
    };
    vi.spyOn(Date, 'now').mockReturnValue(minted.iat * 1000);
    const auths: string[] = [];
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      auths.push(h.get('authorization') ?? '');
      return new Response(JSON.stringify(CHAT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: provider,
      retryPolicy: null,
    });
    await tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
    await tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(n).toBe(1);
    expect(auths).toEqual([`Bearer ${minted.token}`, `Bearer ${minted.token}`]);
  });

  it('refreshes at exp-60s', async () => {
    const first = mintPass('entra_v2_app', 90);
    const second = mintPass('google_service_account', 300);
    const tokens = [first.token, second.token];
    let n = 0;
    const provider = () => tokens[Math.min(n++, 1)]!;
    let now = first.iat * 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify(CHAT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: provider,
      retryPolicy: null,
    });
    await tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
    now = (first.exp - 59) * 1000;
    await tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(n).toBe(2);
  });

  it('single refresh under 50 concurrent requests', async () => {
    const minted = mintPass('aws_role', 300);
    let n = 0;
    const provider = async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 40));
      return minted.token;
    };
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify(CHAT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: provider,
      retryPolicy: null,
    });
    await Promise.all(
      Array.from({ length: 50 }, () =>
        tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' })
      )
    );
    expect(n).toBe(1);
  });

  it('retries once on pass_expired', async () => {
    const first = mintPass('aws_role', 300);
    const second = mintPass('entra_v2_app', 300);
    const tokens = [first.token, second.token];
    let n = 0;
    const provider = () => tokens[Math.min(n++, 1)]!;
    let hits = 0;
    vi.stubGlobal('fetch', async () => {
      hits += 1;
      if (hits === 1) {
        return new Response(JSON.stringify(refusal()), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(CHAT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: provider,
      retryPolicy: null,
    });
    const res = await tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(n).toBe(2);
    expect(hits).toBe(2);
  });

  it('does not retry 403', async () => {
    let n = 0;
    const minted = mintPass('google_service_account', 300);
    vi.stubGlobal('fetch', async () => {
      n += 1;
      return new Response(JSON.stringify({ error: { message: 'blocked' } }), { status: 403 });
    });
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: () => minted.token,
      retryPolicy: null,
    });
    await expect(
      tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' })
    ).rejects.toBeInstanceOf(ShashuPolicyViolation);
    expect(n).toBe(1);
  });

  it('key mode does not retry a pass_expired 401', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      return new Response(JSON.stringify(refusal()), { status: 401 });
    });
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'tg_sk_test',
      retryPolicy: null,
    });
    await expect(
      tg.fetch('/v1/chat/completions', { method: 'POST', body: '{}' })
    ).rejects.toBeInstanceOf(ShashuAuthenticationError);
    expect(n).toBe(1);
  });

  it('streaming retries only when no bytes delivered', async () => {
    expect(
      shouldRetryPassRefused({
        usesProvider: true,
        status: 401,
        code: PASS_EXPIRED,
        bytesDelivered: true,
      })
    ).toBe(false);
    const first = mintPass('aws_role', 300);
    const second = mintPass('entra_v2_app', 300);
    const tokens = [first.token, second.token];
    let n = 0;
    let hits = 0;
    vi.stubGlobal('fetch', async () => {
      hits += 1;
      if (hits === 1) {
        return new Response(JSON.stringify(refusal()), { status: 401 });
      }
      return new Response('data: x\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: () => tokens[Math.min(n++, 1)]!,
      retryPolicy: null,
    });
    const res = await tg.fetchStream('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(hits).toBe(2);
  });

  it('shashuFetch sets the credential per request', async () => {
    const a = mintPass('aws_role', 50);
    const b = mintPass('entra_v2_app', 300);
    const tokens = [a.token, b.token];
    let n = 0;
    const auths: string[] = [];
    vi.stubGlobal('fetch', async (_i: unknown, init?: RequestInit) => {
      auths.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response('{}', { status: 200 });
    });
    const fetch = shashuFetch({ tokenProvider: () => tokens[Math.min(n++, 1)]! });
    await fetch('http://127.0.0.1:9/v1/chat/completions', { method: 'POST' });
    await fetch('http://127.0.0.1:9/v1/chat/completions', { method: 'POST' });
    expect(auths[0]).not.toBe(auths[1]);
  });

  it('gemini middleware is key only for now', () => {
    expect(() =>
      createShashuGeminiConfig({
        baseUrl: 'http://127.0.0.1:9',
        tokenProvider: () => 'p',
      })
    ).toThrow(/key only for now/);
  });
});
