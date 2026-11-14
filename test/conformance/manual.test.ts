/**
 * Conformance apps (c), (d-manual), (f-manual) and (g).
 *
 * A plain `openai` client — no LangChain anywhere — configured through the
 * middleware the customer would actually use, with `declareRetrieval()` called
 * where the retrieval happened and nothing at all at the model call.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';

import { createShashuOpenAIOptions } from '../../src/middleware/vercel-ai.js';
import { declareRetrieval, isolateRetrieval } from '../../src/rag.js';
import { clear } from '../../src/_bus.js';
import { withRetrievalJoiner } from '../../src/_joiner.js';
import { assertValidRagContext, mockGateway, nonce, type MockGateway } from '../helpers/gateway.js';

const GATEWAY = 'https://gw.invalid';

let gateway: MockGateway;

/** The client a customer builds from what the middleware hands back. */
function client(): OpenAI {
  const options = createShashuOpenAIOptions({ baseUrl: `${GATEWAY}/v1`, apiKey: 'tg_sk_test' });
  return new OpenAI({
    apiKey: 'tg_sk_test',
    baseURL: options.baseURL,
    defaultHeaders: options.headers,
    fetch: options.fetch,
  });
}

const ask = (c: OpenAI, prompt: string) =>
  c.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });

/** Any unrelated async work between the declaration and the model call. */
async function somethingUnrelated(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1));
}

/** Stands in for a vector store: it suspends, as a real one does. */
async function retrieve(canary: string): Promise<Array<{ id: string; text: string }>> {
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 8)));
  return [{ id: 'DOC-1', text: canary }];
}

beforeEach(() => {
  clear();
  gateway = mockGateway();
  globalThis.fetch = gateway.fetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  clear();
  delete process.env.TRUSTGATE_DISABLE;
});

describe('(c) a plain SDK plus declareRetrieval()', () => {
  it('carries a declaration made nowhere near the model call', async () => {
    const canary = nonce('manual');
    const c = client();

    // Declared where the retrieval happened; the model call, several statements
    // and one helper later, says nothing about retrieval at all.
    const docs = await retrieve(canary);
    declareRetrieval(docs, { corpus: 'policy_docs_v2', query: 'refinance eligibility' });
    await somethingUnrelated();
    await ask(c, 'Answer from my policy documents.');

    expect(gateway.requests).toHaveLength(1);
    const context = gateway.ragContext()!;
    assertValidRagContext(context);
    expect(context).toMatchObject({
      v: 1,
      corpus: 'policy_docs_v2',
      query: 'refinance eligibility',
      source: 'manual',
      docs: [{ id: 'DOC-1', preview: canary }],
    });
  });

  it('carries one made inside a helper, when the flow is wrapped in a scope', async () => {
    // Node binds a store to the current async FRAME, so a helper that has
    // already suspended cannot write into its caller's. Inside
    // isolateRetrieval() the store is shared and it can. See _bus.ts.
    const canary = nonce('helper');
    const c = client();

    async function loadContext(): Promise<void> {
      const docs = await retrieve(canary);
      declareRetrieval(docs, { corpus: 'policy_docs_v2' });
    }

    await isolateRetrieval(async () => {
      await loadContext();
      await ask(c, 'Answer from my policy documents.');
    });

    expect(JSON.stringify(gateway.ragContext())).toContain(canary);
  });

  it("without a scope, a suspended helper's declaration does not reach the caller", async () => {
    // A characterisation test: this is the documented limit, and it fails loudly
    // if Node's enterWith semantics ever change.
    const canary = nonce('helper-bare');
    const c = client();
    await (async () => {
      await retrieve(canary);
      declareRetrieval([{ id: 'D', text: canary }], { corpus: 'c' });
    })();
    await ask(c, 'hi');
    expect(gateway.bare()).toBe(true);
  });

  it('routes through the gateway with the workflow headers still attached', async () => {
    declareRetrieval(['d'], { corpus: 'c' });
    await ask(client(), 'hi');
    expect(gateway.requests[0].url).toBe(`${GATEWAY}/v1/chat/completions`);
  });
});

describe('(d) negative: nothing was declared', () => {
  it('sends no trustgate_metadata at all', async () => {
    await ask(client(), 'no retrieval happened here');
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.bare()).toBe(true);
    expect(gateway.requests[0].raw).not.toContain('rag_context');
  });

  it('declaring for one call does not annotate the next', async () => {
    const c = client();
    declareRetrieval(['once'], { corpus: 'c' });
    await ask(c, 'first');
    await ask(c, 'second');
    expect(gateway.bare(0)).toBe(false);
    expect(gateway.bare(1)).toBe(true);
  });
});

describe('(f) TRUSTGATE_DISABLE=1', () => {
  it('makes declareRetrieval and the joiner both inert', async () => {
    process.env.TRUSTGATE_DISABLE = '1';
    declareRetrieval([{ id: 'D', text: nonce('disabled') }], { corpus: 'c' });

    // The middleware returns {} when disabled, so build the client the way a
    // customer whose config went empty would end up with: their own endpoint.
    const c = new OpenAI({
      apiKey: 'k',
      baseURL: `${GATEWAY}/v1`,
      fetch: withRetrievalJoiner(gateway.fetch),
    });
    await ask(c, 'hi');

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.bare()).toBe(true);
  });
});

describe('(g) eight interleaved requests', () => {
  it("gives every request its own canary and nobody else's", async () => {
    const c = client();
    const canaries = Array.from({ length: 8 }, (_, i) => nonce(`conc-${i}`));

    await Promise.all(
      canaries.map(async (canary) => {
        const docs = await retrieve(canary); // the awaited retrieval every RAG flow has
        declareRetrieval(docs, { corpus: 'policy_docs_v2', query: canary });
        await ask(c, 'answer');
      })
    );

    expect(gateway.requests).toHaveLength(8);
    const arrived = gateway.requests.map((_, i) => {
      const context = gateway.ragContext(i)!;
      assertValidRagContext(context);
      return JSON.stringify(context.docs);
    });
    for (const payload of arrived) {
      expect(canaries.filter((canary) => payload.includes(canary))).toHaveLength(1);
    }
    expect(new Set(arrived).size).toBe(8);
  });

  it('stays isolated even after an earlier request left a store bound above them', async () => {
    // The shape that catches a bus which MUTATES an inherited store instead of
    // replacing it: the warm-up leaves its store bound in the frame the eight
    // tasks are started from, so a mutating push would write all eight into that
    // one object. Measured on a prototype-wrap design, every task saw every
    // other task's documents.
    const c = client();
    const warmup = nonce('warmup');
    declareRetrieval([{ id: 'W', text: warmup }], { corpus: 'policy_docs_v2' });
    await ask(c, 'warm up');

    const canaries = Array.from({ length: 8 }, (_, i) => nonce(`post-${i}`));
    await Promise.all(
      canaries.map(async (canary) => {
        const docs = await retrieve(canary);
        declareRetrieval(docs, { corpus: 'policy_docs_v2' });
        // A real gap between declaring and calling, so the eight tasks genuinely
        // interleave in that window rather than each finishing in one tick.
        await new Promise((r) => setTimeout(r, 5));
        await ask(c, 'answer');
      })
    );

    expect(gateway.requests).toHaveLength(9);
    for (let i = 1; i < 9; i += 1) {
      const payload = JSON.stringify(gateway.ragContext(i));
      expect(canaries.filter((canary) => payload.includes(canary))).toHaveLength(1);
      expect(payload).not.toContain(warmup);
    }
  });

  it('isolateRetrieval() closes the one fan-out shape that would share', async () => {
    // Declaring BEFORE the task's first await pushes into the frame the task was
    // started from, which its siblings inherit. `_bus.ts` has the measured table;
    // this is the documented fix, asserted rather than described.
    const c = client();
    const canaries = Array.from({ length: 8 }, (_, i) => nonce(`sync-${i}`));

    await Promise.all(
      canaries.map((canary) =>
        isolateRetrieval(async () => {
          declareRetrieval([{ id: 'D', text: canary }], { corpus: 'policy_docs_v2' });
          await ask(c, 'answer');
        })
      )
    );

    expect(gateway.requests).toHaveLength(8);
    for (let i = 0; i < 8; i += 1) {
      const payload = JSON.stringify(gateway.ragContext(i));
      expect(canaries.filter((canary) => payload.includes(canary))).toHaveLength(1);
    }
  });

  it('without that boundary, a synchronous fan-out DOES share — the limit is real', async () => {
    // A characterisation test, not an endorsement: it fails loudly if Node's
    // enterWith semantics ever change, and it is why isolateRetrieval exists.
    const c = client();
    const canaries = Array.from({ length: 4 }, (_, i) => nonce(`shared-${i}`));

    await Promise.all(
      canaries.map(async (canary) => {
        declareRetrieval([{ id: 'D', text: canary }], { corpus: 'policy_docs_v2' });
        await ask(c, 'answer');
      })
    );

    const payloads = gateway.requests.map((_, i) => JSON.stringify(gateway.ragContext(i)));
    const shared = payloads.some(
      (payload) => canaries.filter((canary) => payload.includes(canary)).length > 1
    );
    expect(shared).toBe(true);
  });
});
