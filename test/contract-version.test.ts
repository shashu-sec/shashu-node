/**
 * The contract version header, sent by default — parity with the Python SDK's
 * `contract_version=` (trustgate-python `src/trustgate/context.py`,
 * `DEFAULT_CONTRACT_VERSION = "2026-09-01"`).
 *
 * The gateway resolves an ABSENT `trustgate-version` header to its legacy
 * contract (trustgate-ai `core/app/contract/version.py`): a block is a 200
 * with refusal prose in `message.content`, no envelope in the body, and the
 * `trustgate-block-encoding` header `shashuFetch` sends is read and
 * discarded. The stub below answers the way the gateway does for the version
 * it was told, so every test here sends the same request to the same stub and
 * only the header differs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_VERSION_HEADER,
  DEFAULT_CONTRACT_VERSION,
  MemoryWriteBlocked,
  Shashu,
  ShashuContentFilterError,
  ShashuPolicyViolation,
  shashuDecision,
  shashuFetch,
} from '../src/index.js';
import { createShashuAnthropicConfig, getAnthropicHeaders } from '../src/middleware/anthropic.js';
import { createShashuGeminiConfig } from '../src/middleware/google.js';
import { createShashuLangChainConfig } from '../src/middleware/langchain.js';
import { createShashuOpenAIOptions } from '../src/middleware/vercel-ai.js';
import {
  POLICY_403_EGRESS_DENIED,
  SECURITY_BLOCK_200,
  SECURITY_BLOCK_400_JAILBREAK,
} from './captured';

const BASE = 'https://gateway.example';
const ID = 'b510c203bcc970b9f9965ebb86b4348b';
const MEMORY_SENTENCE =
  'A write through save_memory tried to store an injection into memory, so the write was not stored.';

const CHAT_200 = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 0,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};

/** The `memory` block, field for field what `Envelope.to_dict` serialises. */
function memoryBlock(state: 'flagged' | 'blocked') {
  return {
    coverage: 'gateway',
    writes: 1,
    writes_blocked: state === 'blocked' ? 1 : 0,
    recalls: 0,
    recalls_flagged: 0,
    items: [
      {
        kind: 'write',
        tool: 'save_memory',
        store: 'agent',
        scope: 'session',
        source: 'model',
        enforcement: state === 'blocked' ? 'block' : 'monitor',
        write_ref: 'w1',
        seen_before: false,
        state,
        reason: 'memory_sink_injection',
      },
    ],
  };
}

function envelope(decision: string, extra: Record<string, unknown> = {}, code?: string) {
  return {
    decision,
    retryable: false,
    id: ID,
    inspection: { input: 'checked', output: 'checked' },
    versions: { contract: DEFAULT_CONTRACT_VERSION },
    message: decision === 'allow' ? 'Delivered.' : MEMORY_SENTENCE,
    ...(code ? { code } : {}),
    ...extra,
  };
}

function memoryHeader(state: 'flagged' | 'blocked') {
  return `writes=1;blocked=${state === 'blocked' ? 1 : 0};recalls=0;flagged=0`;
}

type Scenario = 'block' | 'monitor_save' | 'block_save' | 'memory_refusal' | 'policy_refusal';

/**
 * One gateway event, served the way the real gateway serves it for the
 * version the request named. Legacy: refusals are a 200 with prose, no body
 * envelope; deliveries carry the decision in headers only.
 */
function gatewayAnswer(scenario: Scenario, versioned: boolean): Response {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  switch (scenario) {
    case 'block':
      return versioned
        ? json(400, SECURITY_BLOCK_400_JAILBREAK, { 'x-trustgate-decision': 'block' })
        : json(200, SECURITY_BLOCK_200, { 'x-trustgate-decision': 'block' });
    case 'monitor_save':
    case 'block_save': {
      const state = scenario === 'monitor_save' ? 'flagged' : 'blocked';
      const hdrs = { 'x-trustgate-decision': 'allow', 'x-trustgate-memory': memoryHeader(state) };
      return versioned
        ? json(
            200,
            { ...CHAT_200, trustgate: envelope('allow', { memory: memoryBlock(state) }) },
            hdrs
          )
        : json(200, CHAT_200, hdrs);
    }
    case 'memory_refusal':
      return versioned
        ? json(403, {
            error: {
              message: MEMORY_SENTENCE,
              type: 'permission_error',
              param: null,
              code: 'tool_policy',
              trustgate: envelope('refuse', { memory: memoryBlock('blocked') }, 'tool_policy'),
            },
            choices: [],
          })
        : json(200, {
            ...SECURITY_BLOCK_200,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: MEMORY_SENTENCE },
                finish_reason: 'content_filter',
              },
            ],
          });
    case 'policy_refusal':
      return versioned ? json(403, POLICY_403_EGRESS_DENIED) : json(200, SECURITY_BLOCK_200);
  }
}

/** A version-aware gateway stub that also records what each request carried. */
function stubGateway(scenario: Scenario) {
  const seen: Record<string, string>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      seen.push(headers);
      return gatewayAnswer(scenario, CONTRACT_VERSION_HEADER in headers);
    })
  );
  return seen;
}

const client = (extra: Record<string, unknown> = {}) =>
  new Shashu({ baseUrl: BASE, apiKey: 'k', retryPolicy: null, ...extra });

const post = (tg: Shashu) =>
  tg.fetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', messages: [] }),
  });

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("(a) the header is sent by default, with Python's value", () => {
  it('names the same version and header as the Python SDK', () => {
    expect(DEFAULT_CONTRACT_VERSION).toBe('2026-09-01');
    expect(CONTRACT_VERSION_HEADER).toBe('trustgate-version');
  });

  it('Shashu.fetch sends it', async () => {
    const seen = stubGateway('monitor_save');
    await post(client());
    expect(seen[0][CONTRACT_VERSION_HEADER]).toBe('2026-09-01');
  });

  it('Shashu.fetchStream sends it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen = stubGateway('monitor_save');
    await client().fetchStream('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(seen[0][CONTRACT_VERSION_HEADER]).toBe('2026-09-01');
  });

  it('shashuFetch sends it alongside the block encoding it already sent', async () => {
    const seen = stubGateway('monitor_save');
    await shashuFetch({ apiKey: 'k' })(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    expect(seen[0][CONTRACT_VERSION_HEADER]).toBe('2026-09-01');
    expect(seen[0]['trustgate-block-encoding']).toBe('explicit');
  });

  it('every middleware config carries it', () => {
    const cfg = { baseUrl: BASE, apiKey: 'k' };
    expect(getAnthropicHeaders(cfg)[CONTRACT_VERSION_HEADER]).toBe('2026-09-01');
    expect(createShashuAnthropicConfig(cfg).defaultHeaders?.[CONTRACT_VERSION_HEADER]).toBe(
      '2026-09-01'
    );
    expect(createShashuGeminiConfig(cfg).headers?.[CONTRACT_VERSION_HEADER]).toBe('2026-09-01');
    const lc = createShashuLangChainConfig(cfg);
    expect(lc.defaultHeaders?.[CONTRACT_VERSION_HEADER]).toBe('2026-09-01');
    expect(lc.configuration?.defaultHeaders?.[CONTRACT_VERSION_HEADER]).toBe('2026-09-01');
    expect(createShashuOpenAIOptions(cfg).headers?.[CONTRACT_VERSION_HEADER]).toBe('2026-09-01');
  });

  it("a caller's own header wins, in any case, and is sent once", async () => {
    const seen = stubGateway('monitor_save');
    await post(client({ headers: { 'TrustGate-Version': '2026-10-01' } }));
    expect(seen[0][CONTRACT_VERSION_HEADER]).toBe('2026-10-01');
  });
});

describe('(b) Monitor: a flagged, delivered memory save is listed', () => {
  it("lists the save as a memory item with Python's fields; memory blocked = 0", async () => {
    stubGateway('monitor_save');
    const res = await post(client());
    expect(res.status).toBe(200);
    const d = shashuDecision(res)!;
    expect(d.memoryBlocked).toBe(0);
    expect(d.memory?.carrier).toBe('body');
    expect(d.memory?.writes).toBe(1);
    expect(d.memory?.items).toHaveLength(1);
    expect(d.memory?.items[0]).toMatchObject({
      kind: 'write',
      state: 'flagged',
      reason: 'memory_sink_injection',
      tool: 'save_memory',
      store: 'agent',
      scope: 'session',
      source: 'model',
      enforcement: 'monitor',
      writeRef: 'w1',
      seenBefore: false,
    });
  });
});

describe('(c) Block: a stripped save is a normal delivered reply', () => {
  it('delivers, memory blocked = 1, and nothing is thrown', async () => {
    stubGateway('block_save');
    const res = await post(client());
    expect(res.status).toBe(200);
    const d = shashuDecision(res)!;
    expect(d.decision).toBe('allow');
    expect(d.memoryBlocked).toBe(1);
    expect(d.memory?.items[0]).toMatchObject({
      kind: 'write',
      state: 'blocked',
      tool: 'save_memory',
    });
  });
});

describe('(d) a refused request raises the type this SDK already uses', () => {
  it('a content block is ShashuContentFilterError carrying the plain sentence', async () => {
    stubGateway('block');
    const err = (await caught(post(client()))) as ShashuContentFilterError;
    expect(err).toBeInstanceOf(ShashuContentFilterError);
    expect(err.status).toBe(400);
    expect(err.message).toBe(SECURITY_BLOCK_400_JAILBREAK.error.message);
    expect(err.code).toBe('jailbreak');
  });

  it('a blocked memory refusal is MemoryWriteBlocked carrying the plain sentence', async () => {
    stubGateway('memory_refusal');
    const err = (await caught(post(client()))) as MemoryWriteBlocked;
    expect(err).toBeInstanceOf(MemoryWriteBlocked);
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect(err.status).toBe(403);
    expect(err.message).toBe(MEMORY_SENTENCE);
    expect(err.memory?.writesBlocked).toBe(1);
  });

  it('any other 403 is ShashuPolicyViolation carrying the plain sentence', async () => {
    stubGateway('policy_refusal');
    const err = (await caught(post(client()))) as ShashuPolicyViolation;
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect(err).not.toBeInstanceOf(MemoryWriteBlocked);
    expect(err.message).toBe(POLICY_403_EGRESS_DENIED.error.message);
  });
});

describe('(e) streaming: a refusal before the stream raises', () => {
  it('fetchStream raises ShashuContentFilterError with the sentence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubGateway('block');
    const err = (await caught(
      client().fetchStream('/v1/chat/completions', { method: 'POST', body: '{}' })
    )) as ShashuContentFilterError;
    expect(err).toBeInstanceOf(ShashuContentFilterError);
    expect(err.status).toBe(400);
    expect(err.message).toBe(SECURITY_BLOCK_400_JAILBREAK.error.message);
  });
});

describe('(f) contractVersion: null — exactly the old behaviour', () => {
  it('sends no header from any entry point', async () => {
    const seen = stubGateway('monitor_save');
    await post(client({ contractVersion: null }));
    await shashuFetch({ apiKey: 'k', contractVersion: null })(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    expect(seen[0][CONTRACT_VERSION_HEADER]).toBeUndefined();
    expect(seen[1][CONTRACT_VERSION_HEADER]).toBeUndefined();
    const cfg = { baseUrl: BASE, apiKey: 'k', contractVersion: null };
    expect(getAnthropicHeaders(cfg)[CONTRACT_VERSION_HEADER]).toBeUndefined();
    expect(createShashuGeminiConfig(cfg).headers?.[CONTRACT_VERSION_HEADER]).toBeUndefined();
    expect(
      createShashuLangChainConfig(cfg).defaultHeaders?.[CONTRACT_VERSION_HEADER]
    ).toBeUndefined();
    expect(createShashuOpenAIOptions(cfg).headers?.[CONTRACT_VERSION_HEADER]).toBeUndefined();
  });

  it('a block is the legacy 200 and still throws, as before', async () => {
    stubGateway('block');
    const err = (await caught(post(client({ contractVersion: null })))) as ShashuContentFilterError;
    expect(err).toBeInstanceOf(ShashuContentFilterError);
    expect(err.status).toBe(200);
    expect(err.finishReason).toBe('content_filter');
  });

  it('a delivery reads memory counts from the header only, as before', async () => {
    stubGateway('monitor_save');
    const d = shashuDecision(await post(client({ contractVersion: null })))!;
    expect(d.memory?.carrier).toBe('header');
    expect(d.memory?.items).toHaveLength(0);
  });

  it('a pinned version is sent as given', async () => {
    const seen = stubGateway('monitor_save');
    await post(client({ contractVersion: '2026-10-01' }));
    expect(seen[0][CONTRACT_VERSION_HEADER]).toBe('2026-10-01');
  });
});
