import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shashu, declareRetrieval } from '../src/index';

const CHAT = {
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};

function ok(): Response {
  return new Response(JSON.stringify(CHAT), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function busy(status = 503): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: 'The gateway is busy. Retry after the advertised wait.',
        code: 'gateway_busy',
      },
    }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        'Retry-After': '0',
        'x-should-retry': 'true',
      },
    }
  );
}

function postBody(init?: RequestInit): string {
  return String(init?.body ?? '');
}

function headerMap(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function sameExceptAuth(a: Record<string, string>, b: Record<string, string>): boolean {
  const strip = (h: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(h).filter(
        ([k]) => k !== 'authorization' && k !== 'content-length' && k !== 'host'
      )
    );
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

describe('Part C busy-retry capture harness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('C1 503 then 200 byte identical', async () => {
    const bodies: string[] = [];
    const headers: Record<string, string>[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (_i: unknown, init?: RequestInit) => {
      bodies.push(postBody(init));
      headers.push(headerMap(init));
      n += 1;
      return n === 1 ? busy() : ok();
    });
    declareRetrieval([{ id: 'd', text: 'CANARY', score: 0.1 }], { corpus: 'c1', query: 'q' });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'shashu_sk_test' });
    await tg.fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(sameExceptAuth(headers[0]!, headers[1]!)).toBe(true);
  });

  it('C2 429 then 200 byte identical', async () => {
    const bodies: string[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (_i: unknown, init?: RequestInit) => {
      bodies.push(postBody(init));
      n += 1;
      return n === 1 ? busy(429) : ok();
    });
    declareRetrieval([{ id: 'd', text: 'CANARY', score: 0.1 }], { corpus: 'c2', query: 'q' });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'shashu_sk_test' });
    await tg.fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('C3 503 without invitation does not retry', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 });
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k' });
    await expect(
      tg.fetch('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      })
    ).rejects.toBeTruthy();
    expect(n).toBe(1);
  });

  it('C4 maxRetries 0', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      return busy();
    });
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      retryPolicy: { maxRetries: 0 },
    });
    await expect(
      tg.fetch('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      })
    ).rejects.toBeTruthy();
    expect(n).toBe(1);
  });

  it('C5 gives up after max', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      return busy();
    });
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      retryPolicy: { maxRetries: 2 },
    });
    await expect(
      tg.fetch('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      })
    ).rejects.toBeTruthy();
    expect(n).toBe(3);
  });

  it('C6 5xx not retried by default', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k' });
    await expect(
      tg.fetch('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      })
    ).rejects.toBeTruthy();
    expect(n).toBe(1);
  });

  it('C7 next call does not leak', async () => {
    const bodies: string[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (_i: unknown, init?: RequestInit) => {
      bodies.push(postBody(init));
      n += 1;
      return n === 1 ? busy() : ok();
    });
    declareRetrieval([{ id: 'd', text: 'first', score: 0.1 }], {
      corpus: 'only_first',
      query: 'q',
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k' });
    const payload = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    await tg.fetch('/v1/chat/completions', { method: 'POST', body: payload });
    await tg.fetch('/v1/chat/completions', { method: 'POST', body: payload });
    const parsed = bodies.map((b) => JSON.parse(b));
    expect(parsed[0].shashu_metadata.rag_context.corpus).toBe('only_first');
    expect(parsed[1].shashu_metadata.rag_context.corpus).toBe('only_first');
    expect(parsed[2].shashu_metadata?.rag_context).toBeFalsy();
  });

  it('C8 idempotency key none sent', async () => {
    const headers: Record<string, string>[] = [];
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_i: unknown, init?: RequestInit) => {
      headers.push(headerMap(init));
      bodies.push(postBody(init));
      return ok();
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k' });
    await tg.fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(Object.keys(headers[0]!).some((k) => k.includes('idempotency'))).toBe(false);
    expect(bodies[0]!.toLowerCase().includes('idempotency')).toBe(false);
  });

  it('C9 authorization overlay identical otherwise', async () => {
    const headers: Record<string, string>[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (_i: unknown, init?: RequestInit) => {
      headers.push(headerMap(init));
      n += 1;
      return n === 1 ? busy() : ok();
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'shashu_sk_same' });
    await tg.fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(headers[0]!.authorization).toBe(headers[1]!.authorization);
    expect(sameExceptAuth(headers[0]!, headers[1]!)).toBe(true);
  });

  it('C10 hop depth frozen', async () => {
    const headers: Record<string, string>[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (_i: unknown, init?: RequestInit) => {
      headers.push(headerMap(init));
      n += 1;
      return n === 1 ? busy() : ok();
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k' });
    await tg.fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(headers[0]!['x-shashu-hop-depth']).toBe(headers[1]!['x-shashu-hop-depth']);
  });

  it('C11 trace and session frozen', async () => {
    const headers: Record<string, string>[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (_i: unknown, init?: RequestInit) => {
      headers.push(headerMap(init));
      n += 1;
      return n === 1 ? busy() : ok();
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k' });
    await tg.fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(headers[0]!['x-shashu-trace-id']).toBe(headers[1]!['x-shashu-trace-id']);
    expect(headers[0]!['x-shashu-session-id']).toBe(headers[1]!['x-shashu-session-id']);
  });
});
