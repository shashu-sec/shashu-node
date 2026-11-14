/**
 * Reading the gateway's decision — both carriers, all six values, and absence.
 *
 * Names come from `contracts/decision-envelope.v1.md`.
 *
 * The most important test in this file is the ABSENT one. A reader that
 * requires the envelope would break every request in production today.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Shashu,
  ShashuError,
  ShashuContentFilterError,
  ShashuPolicyViolation,
  shashuDecision,
  decisionFrom,
} from '../src/index.js';
import {
  DECISION_ALLOW,
  DECISION_ALLOW_ALTERED,
  DECISION_BLOCK,
  DECISION_FAIL,
  DECISION_NOT_CHECKED,
  DECISION_REFUSE,
  DECISIONS,
  DELIVERED_DECISIONS,
  BODY_KEY,
  HEADER_CODE,
  HEADER_DECISION,
  HEADER_INSPECTION,
  HEADER_REQUEST_ID,
  HEADER_SHOULD_RETRY,
} from '../src/decision.js';

const CONTRACT = fileURLToPath(new URL('../contracts/decision-envelope.v1.md', import.meta.url));

const CHAT = '/v1/chat/completions';
const CHAT_200 = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 0,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};

function envelope(decision: string, code?: string, extra: Record<string, unknown> = {}) {
  const env: Record<string, unknown> = {
    decision,
    retryable: false,
    id: 'b510c203bcc970b9f9965ebb86b4348b',
    inspection: { input: 'checked', output: 'checked' },
    versions: { contract: '2026-09-01' },
    message: 'a sentence a client must not parse',
  };
  if (code !== undefined) env.code = code;
  return { ...env, ...extra };
}

function headers(decision: string, code?: string, extra: Record<string, string> = {}) {
  const out: Record<string, string> = {
    'x-request-id': 'b510c203bcc970b9f9965ebb86b4348b',
    'x-trustgate-decision': decision,
    'x-trustgate-inspection': 'input=checked;output=checked',
    'x-should-retry': 'false',
  };
  if (code !== undefined) out['x-trustgate-code'] = code;
  return { ...out, ...extra };
}

function successBody(decision: string, code?: string, extra: Record<string, unknown> = {}) {
  return { ...CHAT_200, trustgate: envelope(decision, code, extra) };
}

function errorBody(decision: string, code: string, message: string, etype: string) {
  return {
    error: {
      message,
      type: etype,
      param: null,
      code,
      trustgate: envelope(decision, code),
    },
    choices: [],
  };
}

function stubGateway(status: number, payload: unknown, hdrs: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json', ...hdrs },
      });
    })
  );
}

async function raised(status: number, payload: unknown, hdrs?: Record<string, string>) {
  stubGateway(status, payload, hdrs);
  const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
  try {
    await tg.fetch(CHAT, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) });
    throw new Error('unreachable: expected the gateway to raise');
  } catch (err) {
    if (err instanceof ShashuError) return err;
    throw err;
  }
}

async function ok(payload: unknown, hdrs?: Record<string, string>) {
  stubGateway(200, payload, hdrs);
  const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
  return tg.fetch(CHAT, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) });
}

afterEach(() => vi.unstubAllGlobals());

describe('the names come from the vendored contract', () => {
  const text = readFileSync(CONTRACT, 'utf8');

  it('the vendored contract is present', () => {
    expect(text.length).toBeGreaterThan(0);
  });

  it('every decision value is named in the contract', () => {
    for (const value of DECISIONS) {
      expect(text).toContain(`\`${value}\``);
    }
  });

  it('every header name is named in the contract', () => {
    for (const header of [
      HEADER_DECISION,
      HEADER_CODE,
      HEADER_INSPECTION,
      HEADER_SHOULD_RETRY,
      HEADER_REQUEST_ID,
    ]) {
      expect(text).toContain(`\`${header}\``);
    }
  });

  it("the body key is the contract's body key", () => {
    expect(BODY_KEY).toBe('trustgate');
    expect(text).toContain(`\`${BODY_KEY}\``);
  });

  it('the six values and the three delivered ones', () => {
    expect(DECISIONS).toEqual([
      DECISION_ALLOW,
      DECISION_ALLOW_ALTERED,
      DECISION_NOT_CHECKED,
      DECISION_BLOCK,
      DECISION_REFUSE,
      DECISION_FAIL,
    ]);
    expect([...DELIVERED_DECISIONS].sort()).toEqual(
      [DECISION_ALLOW, DECISION_ALLOW_ALTERED, DECISION_NOT_CHECKED].sort()
    );
  });
});

describe("absence is today's behaviour", () => {
  it('a response with no envelope and no headers is unchanged', async () => {
    const res = await ok(CHAT_200);
    const body = await res.json();
    expect(body.trustgate).toBeUndefined();
    expect(shashuDecision(res)).toBeUndefined();
    expect(shashuDecision(body)).toBeUndefined();
    expect(body.choices[0].message.content).toBe('ok');
  });

  it('an error with no envelope still raises what it raised before', async () => {
    const err = await raised(403, {
      error: { message: 'denied', type: 'invalid_request_error', code: '403' },
    });
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect(err.decision).toBeUndefined();
    expect(shashuDecision(err)).toBeUndefined();
  });

  it('no envelope means undefined, not a default', () => {
    expect(shashuDecision({})).toBeUndefined();
    expect(shashuDecision(undefined)).toBeUndefined();
    expect(shashuDecision('nope')).toBeUndefined();
    expect(shashuDecision(CHAT_200)).toBeUndefined();
    expect(decisionFrom(undefined, undefined)).toBeUndefined();
    expect(decisionFrom(CHAT_200, {})).toBeUndefined();
  });
});

describe('all six values from the body', () => {
  it('allow', async () => {
    const res = await ok(successBody(DECISION_ALLOW));
    const d = shashuDecision(res);
    expect(d?.decision).toBe(DECISION_ALLOW);
    expect(d?.delivered).toBe(true);
    expect(d?.isAltered).toBe(false);
  });

  it('allow_altered', async () => {
    const res = await ok(
      successBody(DECISION_ALLOW_ALTERED, 'dlp', { altered: { input_spans: 1 } })
    );
    const d = shashuDecision(res);
    expect(d?.decision).toBe(DECISION_ALLOW_ALTERED);
    expect(d?.isAltered).toBe(true);
    expect(d?.delivered).toBe(true);
    expect(d?.code).toBe('dlp');
    expect(d?.altered).toEqual({ input_spans: 1 });
  });

  it('not_checked', async () => {
    const res = await ok(
      successBody(DECISION_NOT_CHECKED, 'inspector_timeout', {
        inspection: { input: 'checked', output: 'skipped', reason: 'adapter_unreachable' },
      })
    );
    const d = shashuDecision(res);
    expect(d?.decision).toBe(DECISION_NOT_CHECKED);
    expect(d?.delivered).toBe(true);
    expect(d?.unverified).toBe(true);
    expect(d?.inspection?.reason).toBe('adapter_unreachable');
  });

  it('block', async () => {
    const err = await raised(
      400,
      errorBody(DECISION_BLOCK, 'prompt_injection', 'blocked', 'content_filter')
    );
    expect(err).toBeInstanceOf(ShashuContentFilterError);
    const d = shashuDecision(err);
    expect(d?.decision).toBe(DECISION_BLOCK);
    expect(d?.delivered).toBe(false);
    expect(d?.code).toBe('prompt_injection');
  });

  it('refuse', async () => {
    const err = await raised(
      403,
      errorBody(DECISION_REFUSE, 'feature_disabled', 'off', 'permission_error')
    );
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    const d = shashuDecision(err);
    expect(d?.decision).toBe(DECISION_REFUSE);
    expect(d?.delivered).toBe(false);
    expect(d?.code).toBe('feature_disabled');
  });

  it('fail', async () => {
    const body = errorBody(DECISION_FAIL, 'inspector_timeout', 'nobody decided', 'api_error');
    (body.error.trustgate as Record<string, unknown>).retryable = true;
    (body.error.trustgate as Record<string, unknown>).retry_after_ms = 15000;
    const err = await raised(503, body);
    const d = shashuDecision(err);
    expect(d?.decision).toBe(DECISION_FAIL);
    expect(d?.delivered).toBe(false);
    expect(d?.retryable).toBe(true);
    expect(d?.retryAfterMs).toBe(15000);
  });
});

describe('all six values from the headers alone', () => {
  it.each([
    [DECISION_ALLOW, undefined],
    [DECISION_ALLOW_ALTERED, 'dlp'],
    [DECISION_NOT_CHECKED, 'inspector_timeout'],
  ] as const)('%s on a 200', async (value, code) => {
    const res = await ok(CHAT_200, headers(value, code));
    const d = shashuDecision(res);
    expect(d?.decision).toBe(value);
    expect(d?.code).toBe(code);
    expect(d?.carriers).toEqual(['headers']);
  });

  it('block from headers on a 400', async () => {
    const err = await raised(
      400,
      { error: { message: 'blocked', type: 'content_filter', code: 'jailbreak' } },
      headers(DECISION_BLOCK, 'jailbreak')
    );
    const d = shashuDecision(err);
    expect(d?.decision).toBe(DECISION_BLOCK);
    expect(d?.carriers).toEqual(['headers']);
  });

  it('refuse from headers on a 403', async () => {
    const err = await raised(
      403,
      { error: { message: 'off', type: 'permission_error', code: '403' } },
      headers(DECISION_REFUSE, 'feature_disabled')
    );
    expect(shashuDecision(err)?.decision).toBe(DECISION_REFUSE);
  });

  it('fail from headers on a 503', async () => {
    const err = await raised(
      503,
      { error: { message: 'nobody decided' } },
      headers(DECISION_FAIL, 'inspector_timeout', {
        'x-should-retry': 'true',
      })
    );
    const d = shashuDecision(err);
    expect(d?.decision).toBe(DECISION_FAIL);
    expect(d?.retryable).toBe(true);
  });
});

describe('both carriers', () => {
  it('the body is authoritative and both carriers are recorded', async () => {
    const res = await ok(
      successBody(DECISION_ALLOW_ALTERED, 'dlp', { altered: { input_spans: 2 } }),
      headers(DECISION_ALLOW_ALTERED, 'dlp')
    );
    const d = shashuDecision(res);
    expect(d?.carriers).toEqual(['body', 'headers']);
    expect(d?.altered).toEqual({ input_spans: 2 });
  });

  it('a disagreement is reported not silently resolved', async () => {
    const res = await ok(successBody(DECISION_ALLOW_ALTERED, 'dlp'), headers(DECISION_ALLOW));
    const d = shashuDecision(res);
    expect(d?.decision).toBe(DECISION_ALLOW_ALTERED);
    expect(d?.carrierDisagreement).toEqual({
      decision: [DECISION_ALLOW_ALTERED, DECISION_ALLOW],
    });
  });
});

describe('fail closed on the decision value', () => {
  it('an unrecognised decision value is a block', async () => {
    const res = await ok(successBody('quarantined_pending_review', 'dlp'));
    const d = shashuDecision(res);
    expect(d?.decision).toBe(DECISION_BLOCK);
    expect(d?.rawDecision).toBe('quarantined_pending_review');
    expect(d?.delivered).toBe(false);
  });

  it('an unrecognised code does not change the decision', async () => {
    const res = await ok(successBody(DECISION_ALLOW_ALTERED, 'provider_guardrail'));
    const d = shashuDecision(res);
    expect(d?.decision).toBe(DECISION_ALLOW_ALTERED);
    expect(d?.code).toBe('provider_guardrail');
  });

  it('a non-object envelope is ignored not crashed on', async () => {
    const res = await ok({ ...CHAT_200, trustgate: 'not an object' });
    expect(shashuDecision(res)).toBeUndefined();
    expect(shashuDecision(await res.clone().json())).toBeUndefined();
  });
});

describe('decisionFrom on the plain carriers', () => {
  it('reads a body-only envelope', () => {
    const d = decisionFrom(successBody(DECISION_ALLOW_ALTERED, 'dlp'), undefined);
    expect(d?.decision).toBe(DECISION_ALLOW_ALTERED);
    expect(d?.carriers).toEqual(['body']);
  });

  it('reads a headers-only envelope', () => {
    const d = decisionFrom(undefined, headers(DECISION_BLOCK, 'jailbreak'));
    expect(d?.decision).toBe(DECISION_BLOCK);
    expect(d?.carriers).toEqual(['headers']);
  });
});
