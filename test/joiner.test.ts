/**
 * The joiner's four properties, each asserted directly.
 *
 * The zero-cost one is asserted by OBJECT IDENTITY rather than by comparing
 * bytes: "the request was not touched" and "the request was rebuilt to the same
 * bytes" are different claims, and only the first is what the empty-bus path
 * promises.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clear, hasEvents, snapshot } from '../src/_bus.js';
import { declareRetrieval } from '../src/rag.js';
import { withRetrievalJoiner } from '../src/_joiner.js';
import { assertValidRagContext } from './helpers/gateway.js';

interface Seen {
  input: unknown;
  init: unknown;
}

/** An underlying fetch that records the exact arguments it was handed. */
function spy(): { calls: Seen[]; fn: (input: any, init?: any) => Promise<Response> } {
  const calls: Seen[] = [];
  return {
    calls,
    fn: async (input: any, init?: any) => {
      calls.push({ input, init });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

function bodyOf(seen: Seen): Record<string, unknown> {
  return JSON.parse((seen.init as { body: string }).body);
}

beforeEach(() => clear());
afterEach(() => {
  delete process.env.TRUSTGATE_DISABLE;
  clear();
});

describe('joiner, empty bus', () => {
  it("forwards the caller's own input and init object references untouched", async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    const input = 'https://gw.invalid/v1/chat/completions';
    const init = { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) };

    await join(input, init);

    expect(underlying.calls).toHaveLength(1);
    expect(underlying.calls[0].input).toBe(input);
    expect(underlying.calls[0].init).toBe(init); // identity, not equality
  });
});

describe('joiner, populated bus', () => {
  it('attaches the declaration and empties the bus', async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    declareRetrieval([{ id: 'D1', text: 'secret body' }], {
      corpus: 'policy_docs_v2',
      query: 'eligibility',
    });

    await join('https://gw.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [] }),
    });

    const metadata = bodyOf(underlying.calls[0]).trustgate_metadata as Record<string, unknown>;
    assertValidRagContext(metadata.rag_context);
    expect(metadata.rag_context).toMatchObject({
      v: 1,
      corpus: 'policy_docs_v2',
      query: 'eligibility',
      source: 'manual',
      docs: [{ id: 'D1', preview: 'secret body' }],
    });
    expect(hasEvents()).toBe(false);
  });

  it('does not reach the next request', async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    declareRetrieval(['a'], { corpus: 'c' });
    const send = () =>
      join('https://gw.invalid/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'm' }),
      });

    await send();
    await send();

    expect(bodyOf(underlying.calls[0]).trustgate_metadata).toBeDefined();
    expect(bodyOf(underlying.calls[1]).trustgate_metadata).toBeUndefined();
  });

  it('leaves an explicit rag_context alone and discards the ambient one', async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    declareRetrieval(['ambient'], { corpus: 'ambient-corpus' });
    const explicit = {
      model: 'm',
      trustgate_metadata: {
        rag_context: { v: 1, corpus: 'explicit', docs: [{ id: 'E', preview: 'e' }] },
      },
    };

    await join('https://gw.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(explicit),
    });

    expect(underlying.calls[0].init).toEqual({ method: 'POST', body: JSON.stringify(explicit) });
    expect(hasEvents()).toBe(false); // consumed and dropped, not deferred
  });

  it('rewrites a content-length the caller had already computed', async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    declareRetrieval(['a'], { corpus: 'c' });
    const body = JSON.stringify({ model: 'm' });

    await join('https://gw.invalid/v1/chat/completions', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    });

    const init = underlying.calls[0].init as { body: string; headers: Record<string, string> };
    expect(Number(init.headers['Content-Length'])).toBe(Buffer.byteLength(init.body));
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('adds no content-length to a request that had none', async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    declareRetrieval(['a'], { corpus: 'c' });

    await join('https://gw.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
      headers: { 'content-type': 'application/json' },
    });

    const init = underlying.calls[0].init as { headers: Record<string, string> };
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain('content-length');
  });

  it('joins onto a Request object as well as an init bag', async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    declareRetrieval(['a'], { corpus: 'c' });
    const request = new Request('https://gw.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
      headers: { 'content-type': 'application/json' },
    });

    await join(request);

    const sent = underlying.calls[0].input as Request;
    expect(sent).toBeInstanceOf(Request);
    const body = JSON.parse(await sent.text());
    expect(body.trustgate_metadata.rag_context.docs[0].preview).toBe('a');
  });
});

describe('joiner, bodies it must not corrupt', () => {
  const cases: Array<{ name: string; body: unknown }> = [
    { name: 'a non-JSON string body', body: 'model=m&prompt=hi' },
    { name: 'a JSON array body', body: JSON.stringify([1, 2, 3]) },
    { name: 'truncated JSON', body: '{"model": "m"' },
    { name: 'a multipart upload', body: new Uint8Array([1, 2, 3]) },
    { name: 'no body at all', body: undefined },
  ];

  for (const { name, body } of cases) {
    it(`passes ${name} through and does NOT consume the bus`, async () => {
      const underlying = spy();
      const join = withRetrievalJoiner(underlying.fn);
      declareRetrieval(['a'], { corpus: 'c' });
      const init = { method: 'POST', body } as Record<string, unknown>;

      await join('https://gw.invalid/v1/files', init);

      expect(underlying.calls[0].init).toBe(init);
      expect(hasEvents()).toBe(true); // the next real model call still carries it
    });
  }

  it('passes the request through when the underlying fetch is the one that throws', async () => {
    const join = withRetrievalJoiner(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    declareRetrieval(['a'], { corpus: 'c' });
    await expect(
      join('https://gw.invalid/v1/chat/completions', { method: 'POST', body: '{}' })
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('joiner, TRUSTGATE_DISABLE', () => {
  it('sends the request untouched and drops what was already declared', async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    declareRetrieval(['a'], { corpus: 'c' });
    expect(snapshot()).toHaveLength(1); // declared before the switch flipped
    process.env.TRUSTGATE_DISABLE = '1';
    const init = { method: 'POST', body: JSON.stringify({ model: 'm' }) };

    await join('https://gw.invalid/v1/chat/completions', init);

    expect(underlying.calls[0].init).toBe(init);
    expect(hasEvents()).toBe(false);
  });

  it('makes declareRetrieval itself a no-op', () => {
    process.env.TRUSTGATE_DISABLE = '1';
    declareRetrieval(['a'], { corpus: 'c' });
    expect(hasEvents()).toBe(false);
  });
});

describe('joiner, conflicting corpora — prefer a miss over a merge', () => {
  it('refuses to attach when a snapshot holds two corpora', async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    declareRetrieval(['handbook-doc'], { corpus: 'handbook' });
    declareRetrieval(['index-doc'], { corpus: 'other-index' });
    const init = { method: 'POST', body: JSON.stringify({ model: 'm' }) };

    await join('https://gw.invalid/v1/chat/completions', init);

    expect(underlying.calls[0].init).toBe(init); // untouched — a miss
    expect(hasEvents()).toBe(false); // consumed, not deferred
  });

  it('still attaches when every event shares one corpus', async () => {
    const underlying = spy();
    const join = withRetrievalJoiner(underlying.fn);
    declareRetrieval(['a'], { corpus: 'handbook' });
    declareRetrieval(['b'], { corpus: 'handbook' });

    await join('https://gw.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
    });

    const metadata = bodyOf(underlying.calls[0]).trustgate_metadata as Record<string, unknown>;
    expect(metadata.rag_context).toMatchObject({ corpus: 'handbook' });
    expect(hasEvents()).toBe(false);
  });
});

describe('joiner, default underlying fetch', () => {
  it('resolves globalThis.fetch at call time, not at construction', async () => {
    const join = withRetrievalJoiner();
    const late = vi.fn(async () => new Response('{}'));
    globalThis.fetch = late as unknown as typeof globalThis.fetch;
    await join('https://gw.invalid/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(late).toHaveBeenCalledOnce();
  });
});
