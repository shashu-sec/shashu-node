/**
 * Conformance app (b): a retriever invoked OUTSIDE the model's chain.
 *
 * This is where Node and Python diverge, and the divergence is stated here as a
 * test rather than in prose. Python's collector pushes at `on_retriever_end` and
 * that push lands in the caller's own context, so a bare
 * `retriever.invoke(q)` followed by a model call carries the documents with no
 * further help.
 *
 * Node's does not, and cannot. LangChain dispatches handlers through
 * `consumeCallback`, which either awaits them inside
 * `asyncLocalStorage.run(undefined, ...)` or defers them onto a `p-queue` — both
 * of which discard an `enterWith` performed in the handler. Measured three ways
 * (a handler push, a `handleRetrieverStart` seed, a `BaseRetriever.prototype`
 * wrap), the write never reaches the caller. A prototype wrap that seeded
 * synchronously DID reach the caller and was rejected for a different reason:
 * eight concurrent tasks each saw every other task's documents.
 *
 * So this path is DECLARATION-ONLY. Both halves are asserted: that the collector
 * alone leaves the request bare, and that one `declareRetrieval()` carries it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import { ChatOpenAI } from '@langchain/openai';

import { createShashuLangChainConfig, install, uninstall } from '../../src/middleware/langchain.js';
import { declareRetrieval, retrievalScope } from '../../src/rag.js';
import { clear } from '../../src/_bus.js';
import { assertValidRagContext, mockGateway, nonce, type MockGateway } from '../helpers/gateway.js';

const GATEWAY = 'https://gw.invalid';

class BareRetriever extends BaseRetriever {
  lc_namespace = ['trustgate', 'test'];
  constructor(private readonly canary: string) {
    super();
  }
  async _getRelevantDocuments(): Promise<Document[]> {
    await new Promise((r) => setTimeout(r, 1));
    return [new Document({ id: 'DOC-1', pageContent: this.canary })];
  }
}

function model() {
  return new ChatOpenAI({
    apiKey: 'k',
    model: 'gpt-4o-mini',
    ...createShashuLangChainConfig({ baseUrl: `${GATEWAY}/v1` }),
  });
}

let gateway: MockGateway;

beforeEach(async () => {
  clear();
  gateway = mockGateway();
  globalThis.fetch = gateway.fetch as unknown as typeof globalThis.fetch;
  await install({ corpus: 'policy_docs_v2' });
});

afterEach(() => {
  uninstall();
  clear();
});

describe("(b) a retriever invoked outside the model's chain", () => {
  it('is NOT carried by the collector alone — this path is declaration-only', async () => {
    const canary = nonce('outside');
    const docs = await new BareRetriever(canary).invoke('q');
    expect(docs[0].pageContent).toBe(canary);

    await model().invoke('answer from what I just retrieved');

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.bare()).toBe(true);
  });

  it('is carried by one declareRetrieval() next to the retrieval', async () => {
    const canary = nonce('outside-declared');
    const docs = await new BareRetriever(canary).invoke('q');
    declareRetrieval(docs, { corpus: 'policy_docs_v2', query: 'q' });

    await model().invoke('answer from what I just retrieved');

    const context = gateway.ragContext()!;
    assertValidRagContext(context);
    expect(context).toMatchObject({ corpus: 'policy_docs_v2', query: 'q', source: 'manual' });
    expect((context.docs as Array<{ preview: string }>)[0].preview).toBe(canary);
  });

  it('is carried by retrievalScope(), and not beyond it', async () => {
    const canary = nonce('scoped');
    const docs = await new BareRetriever(canary).invoke('q');

    await retrievalScope(docs, { corpus: 'policy_docs_v2' }, () =>
      model().invoke('inside the scope')
    );
    await model().invoke('outside the scope');

    expect(gateway.requests).toHaveLength(2);
    expect(JSON.stringify(gateway.ragContext(0))).toContain(canary);
    expect(gateway.bare(1)).toBe(true);
  });
});
