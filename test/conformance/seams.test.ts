/**
 * The joiner seam, per middleware — step 0b, as an executable table.
 *
 * The Python SDK patches its own httpx transport and therefore sees every
 * outgoing request. Node has no such chokepoint: three of the four middlewares
 * return a config object the customer hands to THEIR SDK, and we only get to see
 * the request if that SDK accepts a `fetch` we can put in that config.
 *
 * | middleware  | seam                                     | joiner |
 * | ----------- | ---------------------------------------- | ------ |
 * | Shashu   | our own client's `fetch`                 | yes    |
 * | langchain   | `configuration.fetch` -> openai SDK      | yes    |
 * | anthropic   | client option `fetch`                    | yes    |
 * | vercel-ai   | provider option `fetch`                  | yes    |
 * | google      | none — `RequestOptions` has no `fetch`   | **no** |
 *
 * Each row is asserted below against the real SDK at the pinned version, not
 * against a description of it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { ChatOpenAI } from '@langchain/openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

import { Shashu } from '../../src/client.js';
import { createShashuAnthropicConfig } from '../../src/middleware/anthropic.js';
import { createShashuGeminiConfig } from '../../src/middleware/google.js';
import { createShashuLangChainConfig } from '../../src/middleware/langchain.js';
import { createShashuOpenAIOptions } from '../../src/middleware/vercel-ai.js';
import { declareRetrieval } from '../../src/rag.js';
import { clear } from '../../src/_bus.js';
import { assertValidRagContext, mockGateway, nonce, type MockGateway } from '../helpers/gateway.js';

const GATEWAY = 'https://gw.invalid';

let gateway: MockGateway;

beforeEach(() => {
  clear();
  gateway = mockGateway();
  globalThis.fetch = gateway.fetch as unknown as typeof globalThis.fetch;
});

afterEach(() => clear());

/** The declaration arrived, validates, and is this row's own canary. */
function expectCarried(canary: string): void {
  const context = gateway.ragContext()!;
  assertValidRagContext(context);
  expect(JSON.stringify(context.docs)).toContain(canary);
}

describe('middlewares with a fetch seam', () => {
  it("Shashu's own client", async () => {
    const canary = nonce('client');
    const tg = new Shashu({ baseUrl: `${GATEWAY}`, apiKey: 'tg_sk_test' });
    declareRetrieval([{ id: 'D', text: canary }], { corpus: 'c' });
    await tg.fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
    });
    expectCarried(canary);
  });

  it('langchain: configuration.fetch, through the openai SDK', async () => {
    const canary = nonce('langchain-seam');
    const config = createShashuLangChainConfig({ baseUrl: `${GATEWAY}/v1` });
    expect(config.configuration?.fetch).toBeTypeOf('function');
    declareRetrieval([{ id: 'D', text: canary }], { corpus: 'c' });
    await new ChatOpenAI({ apiKey: 'k', model: 'gpt-4o-mini', ...config }).invoke('hi');
    expectCarried(canary);
  });

  it("anthropic: the client's own fetch option", async () => {
    const canary = nonce('anthropic-seam');
    const config = createShashuAnthropicConfig({ baseUrl: GATEWAY, apiKey: 'tg_sk_test' });
    expect(config.fetch).toBeTypeOf('function');
    declareRetrieval([{ id: 'D', text: canary }], { corpus: 'c' });
    await new Anthropic({ apiKey: 'k', ...config }).messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(gateway.requests[0].url).toBe(`${GATEWAY}/v1/messages`);
    expectCarried(canary);
  });

  it("vercel-ai: the provider factory's fetch option", async () => {
    const canary = nonce('vercel-seam');
    const options = createShashuOpenAIOptions({ baseUrl: `${GATEWAY}/v1`, apiKey: 'tg_sk_test' });
    expect(options.fetch).toBeTypeOf('function');
    const openai = createOpenAI({
      apiKey: 'k',
      baseURL: options.baseURL,
      headers: options.headers,
      fetch: options.fetch as never,
    });
    declareRetrieval([{ id: 'D', text: canary }], { corpus: 'c' });
    await generateText({ model: openai.chat('gpt-4o-mini'), prompt: 'hi' });
    expectCarried(canary);
  });

  it('vercel-ai: the plain openai SDK built from the same options', async () => {
    const canary = nonce('openai-seam');
    const options = createShashuOpenAIOptions({ baseUrl: `${GATEWAY}/v1`, apiKey: 'tg_sk_test' });
    const client = new OpenAI({ apiKey: 'k', baseURL: options.baseURL, fetch: options.fetch });
    declareRetrieval([{ id: 'D', text: canary }], { corpus: 'c' });
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [] });
    expectCarried(canary);
  });
});

describe('google: no seam exists, so this path is declaration-only', () => {
  it('hands back no fetch, because @google/generative-ai takes none', () => {
    const config = createShashuGeminiConfig({ baseUrl: GATEWAY, apiKey: 'tg_sk_test' });
    expect(config).not.toHaveProperty('fetch');
    expect(Object.keys(config).sort()).toEqual(['apiKey', 'baseUrl', 'headers']);
  });

  it('ignores a fetch put into its RequestOptions and calls the global one', async () => {
    // The measurement behind the table: the SDK's RequestOptions carries
    // timeout / apiVersion / apiClient / baseUrl / customHeaders and nothing
    // else, so a `fetch` in that bag is dropped on the floor.
    let supplied = 0;
    const genAI = new GoogleGenerativeAI('k');
    const model = genAI.getGenerativeModel(
      { model: 'gemini-1.5-flash' },
      {
        baseUrl: GATEWAY,
        ...({
          fetch: () => {
            supplied += 1;
          },
          customFetch: () => {
            supplied += 1;
          },
        } as any),
      }
    );
    declareRetrieval([{ id: 'D', text: nonce('google') }], { corpus: 'c' });
    await model.generateContent('hi').catch(() => undefined);

    expect(supplied).toBe(0);
    // It reached globalThis.fetch — the mock — rather than the supplied one, and
    // the declaration is still sitting on the bus, unattached.
    expect(gateway.requests.length).toBeGreaterThan(0);
    expect(gateway.bare()).toBe(true);
  });
});
