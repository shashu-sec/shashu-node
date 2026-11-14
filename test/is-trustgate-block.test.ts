/**
 * isShashuBlock(err) — inspects an error, answers yes or no.
 * Patches nothing, wraps nothing, replaces nothing. Fails closed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Shashu,
  ShashuError,
  ShashuContentFilterError,
  isShashuBlock,
  shashuDecision,
} from '../src/index.js';

const CHAT = '/v1/chat/completions';
const BODY = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

function envelope(decision: string, code: string | undefined) {
  const env: Record<string, unknown> = {
    decision,
    retryable: false,
    id: 'e6e20e1aeb51b21ba679bd4f6d354b2d',
    inspection: { input: 'checked', output: 'checked' },
    versions: { contract: '2026-09-01' },
    message: 'a sentence a client must not parse',
  };
  if (code !== undefined) env.code = code;
  return env;
}

function errorBody(decision: string, code: string, etype: string) {
  return {
    error: {
      message:
        "I cannot fulfill this request because it violates the organization's security policy.",
      type: etype,
      param: null,
      code,
      trustgate: envelope(decision, code),
    },
    choices: [],
  };
}

function stub(status: number, payload: unknown, hdrs: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json', ...hdrs },
      });
    })
  );
}

async function raised(status: number, payload: unknown, hdrs?: Record<string, string>) {
  stub(status, payload, hdrs);
  const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
  try {
    await tg.fetch(CHAT, { method: 'POST', body: BODY });
    throw new Error('unreachable: expected the gateway to raise');
  } catch (err) {
    if (err instanceof ShashuError) return err;
    throw err;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('true: it is our block', () => {
  it('a block envelope is a block', async () => {
    const err = await raised(400, errorBody('block', 'prompt_injection', 'content_filter'));
    expect(isShashuBlock(err)).toBe(true);
  });

  it('a block from the headers alone is a block', async () => {
    const err = await raised(
      400,
      { error: { message: 'blocked', type: 'content_filter', code: 'jailbreak' } },
      { 'x-trustgate-decision': 'block', 'x-trustgate-code': 'jailbreak' }
    );
    expect(isShashuBlock(err)).toBe(true);
  });

  it('the legacy 200 encoding is a block', async () => {
    stub(200, {
      id: 'chatcmpl-mock',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null },
          finish_reason: 'content_filter',
        },
      ],
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
    await expect(tg.fetch(CHAT, { method: 'POST', body: BODY })).rejects.toBeInstanceOf(
      ShashuContentFilterError
    );
    try {
      await tg.fetch(CHAT, { method: 'POST', body: BODY });
    } catch (err) {
      expect(isShashuBlock(err)).toBe(true);
    }
  });

  it('the explicit 400 encoding without an envelope is a block', async () => {
    const err = await raised(400, {
      error: { message: 'blocked', type: 'content_filter', code: 'dlp' },
    });
    expect(isShashuBlock(err)).toBe(true);
  });
});

describe('fail closed', () => {
  it('a block with a code this SDK does not recognise is still a block', async () => {
    const err = await raised(400, errorBody('block', 'provider_guardrail', 'content_filter'));
    expect(isShashuBlock(err)).toBe(true);
  });

  it('an unrecognised decision carrying a block signal is a block', async () => {
    const err = await raised(
      400,
      errorBody('quarantined_pending_review', 'provider_guardrail', 'content_filter')
    );
    expect(isShashuBlock(err)).toBe(true);
  });
});

describe('false: it is not our block', () => {
  it('a plain provider error is not a block', async () => {
    const err = await raised(400, {
      error: {
        message: "Invalid 'temperature': expected a number",
        type: 'ProviderInvalidRequestError',
        code: 'invalid_request',
      },
    });
    expect(isShashuBlock(err)).toBe(false);
  });

  it('a refusal is not a block', async () => {
    const err = await raised(403, errorBody('refuse', 'feature_disabled', 'permission_error'));
    expect(isShashuBlock(err)).toBe(false);
  });

  it('a delivered altered response is not a block', async () => {
    stub(200, {
      id: 'chatcmpl-mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      trustgate: envelope('allow_altered', 'dlp'),
    });
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
    const res = await tg.fetch(CHAT, { method: 'POST', body: BODY });
    expect(shashuDecision(res)?.decision).toBe('allow_altered');
    expect(isShashuBlock(res)).toBe(false);
  });

  it('a rate limit is not a block', async () => {
    const err = await raised(429, {
      error: { message: 'error', type: 'invalid_request_error', code: '429' },
    });
    expect(isShashuBlock(err)).toBe(false);
  });

  it('an auth failure is not a block', async () => {
    const err = await raised(401, {
      error: { message: 'Invalid TrustGate API Key', type: 'invalid_request_error', code: '401' },
    });
    expect(isShashuBlock(err)).toBe(false);
  });

  it.each([null, 'a string', 42, new Error('something else entirely')])(
    'a non-trustgate object is not a block: %s',
    (value) => {
      expect(isShashuBlock(value)).toBe(false);
    }
  );

  it('never raises on a hostile error object', () => {
    class Hostile extends Error {
      get body(): unknown {
        throw new Error('boom');
      }
      get response(): unknown {
        throw new Error('boom');
      }
    }
    expect(isShashuBlock(new Hostile())).toBe(false);
  });
});

describe('it replaces nothing', () => {
  it('calling it does not alter the error', async () => {
    const err = await raised(400, errorBody('block', 'dlp', 'content_filter'));
    const before = [err.constructor, err.status, err.type, err.code, String(err)];
    isShashuBlock(err);
    isShashuBlock(err);
    expect([err.constructor, err.status, err.type, err.code, String(err)]).toEqual(before);
  });
});
