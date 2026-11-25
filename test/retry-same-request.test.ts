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

function busy(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: 'The gateway is busy. Retry after the advertised wait.',
        code: 'gateway_busy',
      },
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'Retry-After': '1',
        'x-should-retry': 'true',
      },
    }
  );
}

describe('busy retry resends the same built request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('successful attempt carries the same shashu_metadata as the first', async () => {
    vi.useFakeTimers();
    const bodies: string[] = [];
    const headerBags: string[][] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      headerBags.push(
        [...new Headers(init?.headers).entries()].map(([k, v]) => `${k.toLowerCase()}=${v}`).sort()
      );
      n += 1;
      return n === 1 ? busy() : ok();
    });
    declareRetrieval([{ id: 'd1', text: 'CANARY-retry' }], {
      corpus: 'policy_docs_v2',
      query: 'backups',
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'tg_sk_test' });
    const p = tg.fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await vi.runAllTimersAsync();
    await p;
    expect(bodies).toHaveLength(2);
    const b0 = JSON.parse(bodies[0]!);
    const b1 = JSON.parse(bodies[1]!);
    expect(b0.shashu_metadata?.rag_context?.corpus).toBe('policy_docs_v2');
    expect(JSON.stringify(b0)).toContain('CANARY-retry');
    expect(b0).toEqual(b1);
    const strip = (rows: string[]) => rows.filter((r) => !r.startsWith('authorization='));
    expect(strip(headerBags[0]!)).toEqual(strip(headerBags[1]!));
  });

  it('two concurrent calls keep their own declaration', async () => {
    const perCorpus: Record<string, string[]> = {};
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const corpus = String(body.shashu_metadata?.rag_context?.corpus ?? 'none');
      const bag = (perCorpus[corpus] ??= []);
      bag.push(String(init?.body ?? ''));
      return bag.length === 1 ? busy() : ok();
    });

    async function worker(corpus: string, canary: string) {
      await Promise.resolve();
      declareRetrieval([{ id: 'd', text: canary, score: 0.5 }], { corpus, query: canary });
      const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'tg_sk_test' });
      await tg.fetch('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      });
    }

    await Promise.all([worker('corpus_left', 'LEFT'), worker('corpus_right', 'RIGHT')]);
    expect(perCorpus.none).toBeUndefined();
    for (const [corpus, canary] of [
      ['corpus_left', 'LEFT'],
      ['corpus_right', 'RIGHT'],
    ] as const) {
      const bodies = perCorpus[corpus];
      expect(bodies, corpus).toHaveLength(2);
      for (const raw of bodies!) {
        const rag = JSON.parse(raw).shashu_metadata.rag_context;
        expect(rag.corpus).toBe(corpus);
        expect(JSON.stringify(rag)).toContain(canary);
      }
      expect(bodies![0]).toBe(bodies![1]);
    }
  });
});
