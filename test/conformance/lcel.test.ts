/**
 * Conformance app (a), (d-langchain), (e), (f-langchain), (g-langchain).
 *
 * A real LCEL chain — `retriever | format | prompt | ChatOpenAI` — built out of
 * @langchain/core and @langchain/openai at the versions package.json pins, with
 * the model pointed at the in-repo mock gateway through the config the
 * middleware actually returns. The assertion is on the bytes that ARRIVE: the
 * request body must carry a `rag_context` that validates against the vendored
 * schema and contains this app's canary.
 *
 * This is the case that has never worked. `test/langchain-collector.test.ts`
 * holds the mechanism; this holds the outcome.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables';
import { ChatOpenAI } from '@langchain/openai';

import { createShashuLangChainConfig, install, uninstall } from '../../src/middleware/langchain.js';
import { declareRetrieval } from '../../src/rag.js';
import { clear } from '../../src/_bus.js';
import { assertValidRagContext, mockGateway, nonce, type MockGateway } from '../helpers/gateway.js';

const GATEWAY = 'https://gw.invalid';

class CanaryRetriever extends BaseRetriever {
  lc_namespace = ['trustgate', 'test'];
  constructor(private readonly canary: string) {
    super();
  }
  async _getRelevantDocuments(query: string): Promise<Document[]> {
    // A real suspension, so the chain's steps are genuinely interleaved.
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 8)));
    return [
      new Document({ pageContent: `${this.canary} :: ${query}`, metadata: { source: 'DOC-1' } }),
    ];
  }
}

function chainFor(canary: string) {
  const config = createShashuLangChainConfig({ baseUrl: `${GATEWAY}/v1`, apiKey: 'tg_sk_test' });
  return RunnableSequence.from([
    new CanaryRetriever(canary),
    RunnableLambda.from((docs: Document[]) => ({
      context: docs.map((d) => d.pageContent).join('\n'),
    })),
    ChatPromptTemplate.fromMessages([['human', 'Answer from: {context}']]),
    new ChatOpenAI({ apiKey: 'tg_sk_test', model: 'gpt-4o-mini', ...config }),
  ]);
}

let gateway: MockGateway;

beforeEach(() => {
  clear();
  gateway = mockGateway();
  globalThis.fetch = gateway.fetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  uninstall();
  clear();
  delete process.env.SHASHU_DISABLE;
});

describe('(a) an LCEL chain, with no line added to it', () => {
  it('carries the retrieved documents to the gateway', async () => {
    const canary = nonce('lcel');
    expect(await install({ corpus: 'policy_docs_v2' })).toBe(true);

    await chainFor(canary).invoke('refinance eligibility');

    expect(gateway.requests).toHaveLength(1);
    const context = gateway.ragContext()!;
    assertValidRagContext(context);
    expect(context).toMatchObject({ v: 1, corpus: 'policy_docs_v2', source: 'langchain' });
    expect(JSON.stringify(context.docs)).toContain(canary);
  });

  it("carries the retriever's query, which handleRetrieverEnd is not given", async () => {
    await install({ corpus: 'policy_docs_v2' });
    await chainFor(nonce('query')).invoke('refinance eligibility');
    expect(gateway.ragContext()!.query).toBe('refinance eligibility');
  });

  it('names the default corpus when the caller named none', async () => {
    // `install()` is idempotent and re-points the corpus, so a blank one is how
    // a caller asks for the default back: rag_context.v1 requires a non-empty
    // corpus and the retriever callback carries no index name.
    await install({ corpus: '' });
    await chainFor(nonce('default')).invoke('q');
    expect(gateway.ragContext()!.corpus).toBe('langchain-retriever');
  });

  it('does not leak the declaration into the next, unrelated model call', async () => {
    await install({ corpus: 'policy_docs_v2' });
    await chainFor(nonce('first')).invoke('q');
    const config = createShashuLangChainConfig({ baseUrl: `${GATEWAY}/v1` });
    await new ChatOpenAI({ apiKey: 'k', model: 'gpt-4o-mini', ...config }).invoke('unrelated');
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.bare(1)).toBe(true);
  });
});

describe('(d) negative: the collector is not installed', () => {
  it('sends no shashu_metadata at all', async () => {
    const canary = nonce('uninstalled');
    await chainFor(canary).invoke('q');
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.bare()).toBe(true);
    // The canary IS in the prompt — that is what RAG does. What must be absent
    // is the declaration: the gateway sees the documents only as user text.
    expect(gateway.requests[0].raw).toContain(canary);
    expect(gateway.requests[0].raw).not.toContain('rag_context');
  });

  it('stops sending again after uninstall()', async () => {
    await install({ corpus: 'c' });
    await chainFor(nonce('on')).invoke('q');
    expect(gateway.bare(0)).toBe(false);
    uninstall();
    await chainFor(nonce('off')).invoke('q');
    expect(gateway.bare(1)).toBe(true);
  });
});

describe('(e) the collector and an explicit declaration together', () => {
  it('conflicting corpora become a miss rather than a merge', async () => {
    await install({ corpus: 'policy_docs_v2' });
    const canary = nonce('dedupe');
    const sharedText = `${canary} shared`;

    class SharedRetriever extends BaseRetriever {
      lc_namespace = ['trustgate', 'test'];
      async _getRelevantDocuments(): Promise<Document[]> {
        return [new Document({ id: 'DOC-SHARED', pageContent: sharedText })];
      }
    }
    const chain = RunnableSequence.from([
      new SharedRetriever(),
      RunnableLambda.from((docs: Document[]) => ({
        context: docs.map((d) => d.pageContent).join(' '),
      })),
      ChatPromptTemplate.fromMessages([['human', '{context}']]),
      new ChatOpenAI({
        apiKey: 'k',
        model: 'gpt-4o-mini',
        ...createShashuLangChainConfig({ baseUrl: `${GATEWAY}/v1` }),
      }),
    ]);

    // Hand-declared against a different corpus than the collector. Merging
    // them would put one retrieval's documents on the other's audit row.
    // Prefer a miss.
    declareRetrieval(
      [
        { id: 'DOC-SHARED', text: sharedText },
        { id: 'DOC-EXTRA', text: `${canary} extra` },
      ],
      { corpus: 'hand_declared', query: 'by hand' }
    );
    await chain.invoke('q');

    expect(gateway.bare()).toBe(true);
  });

  it('a declaration made INSIDE an LCEL step does not reach the model call', async () => {
    // Measured, and the reason the collector does not simply push at
    // handleRetrieverEnd: a Runnable step's async context is discarded when the
    // step returns. Anything declared there is lost, so declare outside.
    await install({ corpus: 'policy_docs_v2' });
    const canary = nonce('inside');
    const chain = RunnableSequence.from([
      RunnableLambda.from((q: string) => {
        declareRetrieval([{ id: 'INSIDE', text: canary }], { corpus: 'inside_step' });
        return { context: q };
      }),
      ChatPromptTemplate.fromMessages([['human', '{context}']]),
      new ChatOpenAI({
        apiKey: 'k',
        model: 'gpt-4o-mini',
        ...createShashuLangChainConfig({ baseUrl: `${GATEWAY}/v1` }),
      }),
    ]);

    await chain.invoke('q');

    expect(gateway.bare()).toBe(true);
  });
});

describe('(f) SHASHU_DISABLE=1', () => {
  it('makes the whole collector inert', async () => {
    await install({ corpus: 'policy_docs_v2' });
    process.env.SHASHU_DISABLE = '1';
    // The middleware hands back {} when disabled, so point the model at the mock
    // directly: the question is whether the COLLECTOR declares, not whether the
    // config still rewrites the endpoint (config.test.ts covers that).
    const chain = RunnableSequence.from([
      new CanaryRetriever(nonce('disabled')),
      RunnableLambda.from((docs: Document[]) => ({
        context: docs.map((d) => d.pageContent).join(''),
      })),
      ChatPromptTemplate.fromMessages([['human', '{context}']]),
      new ChatOpenAI({
        apiKey: 'k',
        model: 'gpt-4o-mini',
        configuration: { baseURL: `${GATEWAY}/v1`, fetch: gateway.fetch },
      }),
    ]);

    await chain.invoke('q');

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.bare()).toBe(true);
  });
});

describe('(g) eight interleaved chains', () => {
  it("gives every request its own canary and nobody else's", async () => {
    await install({ corpus: 'policy_docs_v2' });
    const canaries = Array.from({ length: 8 }, (_, i) => nonce(`conc-${i}`));

    await Promise.all(canaries.map((canary) => chainFor(canary).invoke('q')));

    expect(gateway.requests).toHaveLength(8);
    const arrived = gateway.requests.map((_, i) => {
      const context = gateway.ragContext(i)!;
      assertValidRagContext(context);
      return JSON.stringify(context.docs);
    });
    for (const payload of arrived) {
      const mine = canaries.filter((c) => payload.includes(c));
      expect(mine).toHaveLength(1); // exactly one canary, never two
    }
    expect(new Set(arrived.map((p) => canaries.find((c) => p.includes(c)))).size).toBe(8);
  });
});
