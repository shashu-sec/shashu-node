/**
 * The public surface, frozen.
 *
 * `contracts/sdk-surface.v1.md` (canonical copy in the gateway repo, vendored
 * beside the schema here) says what a customer of ANY Shashu SDK types.
 * Four SDKs will exist; the code under the hood differs per language and that
 * is fine, but the surface must not.
 *
 * This file exists because a name leaked. `isolateRetrieval` was exported from
 * the package root as a third public retrieval function, doing a job
 * `retrievalScope` already covered — the source said so itself. Nothing caught
 * it, because nothing was watching the export list.
 *
 * So the first test below is deliberately brittle in one direction: ADDING an
 * export fails it. That is the point. A new public name is a change to the
 * contract in `contracts/sdk-surface.v1.md`, not an implementation detail, and
 * the way to add one is to add it there and here in the same change.
 *
 * Sibling of the Python SDK's tests/test_surface.py, which asserts the same
 * three properties against `trustgate.__all__`.
 *
 * Nothing here touches the network: test/setup.ts makes any fetch or socket
 * connect an immediate test error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pkg from '../src/index.js';
import { ShashuConfigError } from '../src/exceptions.js';
import { requireBaseUrl } from '../src/config.js';
import { declareRetrieval, retrievalScope } from '../src/rag.js';
import { hasEvents, snapshot } from '../src/_bus.js';

/**
 * Every value exported from the package root, sorted.
 *
 * Runtime exports only — `export type` erases, so the type aliases in
 * index.ts (RagContext, RagDoc, DeclareRetrievalOptions, …) are absent by
 * construction and are not part of this set.
 *
 * TWO of these are the retrieval surface: declareRetrieval and retrievalScope.
 * There is no third. isolateRetrieval was the third and was removed in 3.0.0.
 */
const EXPECTED_EXPORTS = [
  'Audit',
  'BLOCK_ENCODING_HEADER',
  'BODY_KEY',
  'CONTRACT_VERSION_HEADER',
  'DECISIONS',
  'DECISION_ALLOW',
  'DECISION_ALLOW_ALTERED',
  'DECISION_BLOCK',
  'DECISION_FAIL',
  'DECISION_NOT_CHECKED',
  'DECISION_REFUSE',
  'DEFAULT_BLOCK_ENCODING',
  'DEFAULT_CONTRACT_VERSION',
  'DEFAULT_RETRY_POLICY',
  'DELIVERED_DECISIONS',
  'HEADER_ATTACHMENTS',
  'HEADER_CODE',
  'HEADER_DECISION',
  'HEADER_INSPECTION',
  'HEADER_MEMORY',
  'HEADER_PREFIX',
  'HEADER_REQUEST_ID',
  'HEADER_SHASHU_REQUEST_ID',
  'HEADER_SHOULD_RETRY',
  'HEADER_TRACE_ID',
  'MemoryWriteBlocked',
  // S1-FIX2: the gateway's six pass refusal codes (contract "Signing in with a
  // cloud pass"), the one place the contract lets a client match on `code`.
  'PASS_CODES',
  'PASS_EXPIRED',
  'PASS_NOT_LICENSED',
  'PASS_PROVIDER_NOT_SET_UP',
  'PASS_UNKNOWN_AGENT',
  'PASS_WRONG_AUDIENCE',
  'PASS_WRONG_ISSUER',
  'SOURCES',
  'SOURCE_TOOL_HEADER',
  'Shashu',
  'ShashuAuthenticationError',
  'ShashuBadRequestError',
  'ShashuBudgetExceededError',
  'ShashuConfigError',
  'ShashuContentFilterError',
  'ShashuContextWindowExceeded',
  'ShashuError',
  'ShashuPermissionError',
  'ShashuPolicyViolation',
  'ShashuProviderError',
  'ShashuRateLimitError',
  'TRUSTLOG_HEADER_PREFIX',
  'attachRagContext',
  'buildContextHeaders',
  'buildInvocationHeaders',
  'buildRagContext',
  'buildSourceToolJson',
  'captureIncoming',
  'createShashuAnthropicConfig',
  'createShashuGeminiConfig',
  'createShashuLangChainConfig',
  'createShashuOpenAIOptions',
  'decisionFrom',
  'declareMemory',
  'declareRetrieval',
  'executeWithRetry',
  'gatewayRetryAfter',
  'getAnthropicHeaders',
  'getGeminiHeaders',
  'getN8nHeaderSnippet',
  'getShashuHeaders',
  'getWorkflowContextFromEnv',
  'isShashuBlock',
  'makeRagContext',
  'memoryScope',
  'parseRetryAfter',
  'raiseForResponse',
  'raiseIfContentFiltered',
  'resolveRetryPolicy',
  'retrievalScope',
  'shashuDecision',
  'shashuFetch',
  'tracer',
  'withRetrievalJoiner',
];

/**
 * contracts/sdk-surface.v1.md, "The frozen error message".
 *
 * Two substitutions and only two: the entry point the customer called, and the
 * argument that would have supplied the address. Node renders the argument as
 * the bare option name; Python renders the keyword form (`base_url=...`).
 * That one clause is the language's calling convention showing through and is
 * the documented difference — every other byte is shared.
 */
const CONFIG_ERROR = (entryPoint: string, argument: string) =>
  `SHASHU gateway address is not configured, so ${entryPoint} has ` +
  `nothing to route to. Pass ${argument} to ${entryPoint}, or set the ` +
  `SHASHU_BASE_URL environment variable. SHASHU is ` +
  `self-hosted: the SDK has no default address and will not guess one.`;

describe('the public surface is exactly what the contract freezes', () => {
  it('exports exactly the expected names — a new one fails this on purpose', () => {
    expect(Object.keys(pkg).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it('has TWO public retrieval functions, not three', () => {
    const retrieval = Object.keys(pkg).filter(
      (n) => /etrieval/.test(n) && n !== 'withRetrievalJoiner'
    );
    expect(retrieval.sort()).toEqual(['declareRetrieval', 'retrievalScope']);
  });

  it('has TWO public memory functions, not three', () => {
    const memory = Object.keys(pkg).filter(
      (n) =>
        /emory/.test(n) &&
        !n.includes('Blocked') &&
        n !== 'MemoryActivity' &&
        n !== 'MemoryItem' &&
        n !== 'MemoryWriteBlocked'
    );
    expect(memory.sort()).toEqual(['declareMemory', 'memoryScope']);
  });

  it('does not re-export isolateRetrieval — retrievalScope is the replacement', () => {
    expect(Object.keys(pkg)).not.toContain('isolateRetrieval');
  });

  it('no public export name contains trustgate', () => {
    const leaked = Object.keys(pkg).filter((n) => /trustgate/i.test(n));
    expect(leaked).toEqual([]);
  });
});

/**
 * The evidence for removing the third function.
 *
 * `isolateRetrieval` was public for two shapes the docs named: a fan-out where
 * each task declares before its first `await`, and a helper that declares after
 * it has already awaited. `retrievalScope` is built on the same
 * `AsyncLocalStorage.run` boundary, so it covers both — measured here rather
 * than assumed, because "the replacement covers it" is the whole justification
 * for a breaking change.
 */
describe('retrievalScope covers what isolateRetrieval was public for', () => {
  it('fan-out: each task sees only its own declaration', async () => {
    const perTask: string[][] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        retrievalScope([`doc-${n}`], { corpus: `corpus-${n}` }, async () => {
          await new Promise((r) => setTimeout(r, 5 * n));
          perTask.push(snapshot().map((e) => e.corpus));
        })
      )
    );
    expect(perTask.sort()).toEqual([['corpus-1'], ['corpus-2'], ['corpus-3']]);
  });

  it('a helper that already awaited, then declared, still reaches', async () => {
    async function helper() {
      await new Promise((r) => setTimeout(r, 5));
      declareRetrieval(['late doc'], { corpus: 'late_corpus' });
    }
    let inside: string[] = [];
    await retrievalScope(['early doc'], { corpus: 'early_corpus' }, async () => {
      await helper();
      inside = snapshot().map((e) => e.corpus);
    });
    expect(inside).toEqual(['early_corpus', 'late_corpus']);
  });

  it('and nothing declared inside is seen after the block', async () => {
    await retrievalScope(['d'], { corpus: 'c' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(hasEvents()).toBe(false);
  });
});

describe('the documented argument order', () => {
  const ORIGINAL = process.env.SHASHU_DISABLE;
  beforeEach(() => {
    // The bus is a no-op when disabled, which is what lets these assert the
    // SIGNATURE without standing up a gateway or reaching the network.
    process.env.SHASHU_DISABLE = '1';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SHASHU_DISABLE;
    else process.env.SHASHU_DISABLE = ORIGINAL;
  });

  it('declareRetrieval takes docs first, then corpus/query/source', () => {
    expect(pkg.declareRetrieval.length).toBe(2); // (docs, options)
    expect(() =>
      pkg.declareRetrieval(['a doc'], { corpus: 'policy_docs_v2', query: 'q', source: 'manual' })
    ).not.toThrow();
    // query and source are optional; corpus is not.
    expect(() => pkg.declareRetrieval(['a doc'], { corpus: 'policy_docs_v2' })).not.toThrow();
  });

  it('retrievalScope takes docs first, then corpus/query/source, then the unit of work', async () => {
    expect(pkg.retrievalScope.length).toBe(3); // (docs, options, fn)
    const seen = await pkg.retrievalScope(['a doc'], { corpus: 'policy_docs_v2' }, () => 'ran');
    expect(seen).toBe('ran');
  });
});

describe('the frozen config error', () => {
  const ORIGINAL = process.env.SHASHU_BASE_URL;
  const ORIGINAL_SHASHU = process.env.SHASHU_BASE_URL;
  beforeEach(() => {
    delete process.env.SHASHU_BASE_URL;
    delete process.env.SHASHU_BASE_URL;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SHASHU_BASE_URL;
    else process.env.SHASHU_BASE_URL = ORIGINAL;
    if (ORIGINAL_SHASHU === undefined) delete process.env.SHASHU_BASE_URL;
    else process.env.SHASHU_BASE_URL = ORIGINAL_SHASHU;
  });

  it('matches the frozen text verbatim', () => {
    expect(() => requireBaseUrl(undefined, { entryPoint: 'new Shashu()' })).toThrow(
      ShashuConfigError
    );
    try {
      requireBaseUrl(undefined, { entryPoint: 'new Shashu()' });
      throw new Error('unreachable: requireBaseUrl resolved an address it should not have');
    } catch (e) {
      expect((e as Error).message).toBe(CONFIG_ERROR('new Shashu()', 'baseUrl'));
    }
  });

  it('names SHASHU_BASE_URL and SHASHU_BASE_URL', () => {
    try {
      requireBaseUrl(undefined, { entryPoint: 'new Shashu()' });
      throw new Error('unreachable: requireBaseUrl resolved an address it should not have');
    } catch (e) {
      expect((e as Error).message).toContain('SHASHU_BASE_URL');
      expect((e as Error).message).toContain('SHASHU_BASE_URL');
    }
  });

  it('contains no hostname — there is no address to suggest', () => {
    try {
      requireBaseUrl(undefined, { entryPoint: 'new Shashu()' });
      throw new Error('unreachable: requireBaseUrl resolved an address it should not have');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toMatch(/https?:\/\//);
      expect(message).not.toMatch(/\b[a-z0-9-]+\.(io|com|net|ai|dev|local)\b/i);
      expect(message).not.toMatch(/localhost|127\.0\.0\.1/);
    }
  });
});
