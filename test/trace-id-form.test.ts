/**
 * Trace ids the SDK mints are the standard form: 32 lowercase hex characters.
 *
 * The gateway stores a trace id without dashes, so a dashed id handed back to
 * a caller could not be looked up by that spelling. A trace id the caller (or
 * the environment) supplies is passed through unchanged.
 *
 * A call outside a span gets its own trace; calls inside one `tracer.span()`
 * share it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Shashu, tracer, buildContextHeaders, getWorkflowContextFromEnv } from '../src/index.js';
import { buildInvocationHeaders } from '../src/context.js';
import { getShashuHeaders } from '../src/middleware/vercel-ai.js';

const HEX32 = /^[0-9a-f]{32}$/;
const TRACE = 'x-shashu-trace-id';
const ENV = ['N8N_EXECUTION_ID', 'GITHUB_RUN_ID', 'GITLAB_CI', 'CI_PIPELINE_ID'];
const COMPLETION = JSON.stringify({
  id: 'c',
  object: 'chat.completion',
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
});

let saved: Record<string, string | undefined> = {};
const sent: Record<string, string>[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  sent.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
      sent.push({ ...(init.headers ?? {}) });
      return new Response(COMPLETION, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

function client(): Shashu {
  return new Shashu({ baseUrl: 'http://gateway.test', apiKey: 'shashu_sk_x', retryPolicy: null });
}

async function call(c: Shashu): Promise<void> {
  await c.fetch('/v1/chat/completions', { method: 'POST', body });
}

describe('SDK-minted trace ids are 32 lowercase hex', () => {
  it('a call outside a span', async () => {
    await call(client());
    expect(sent[0][TRACE]).toMatch(HEX32);
  });

  it('the context header builder', () => {
    expect(buildContextHeaders(getWorkflowContextFromEnv())[TRACE]).toMatch(HEX32);
  });

  it('the Vercel AI SDK headers', () => {
    expect(getShashuHeaders()[TRACE]).toMatch(HEX32);
  });

  it('a span', async () => {
    await tracer.span('run', async () => {
      expect(tracer.traceId).toMatch(HEX32);
    });
  });

  it('invocation headers at origin', () => {
    expect(buildInvocationHeaders({ callerAgentId: 'a' })[TRACE]).toMatch(HEX32);
  });
});

describe('sharing one trace across calls', () => {
  it('two calls without a span are two traces', async () => {
    const c = client();
    await call(c);
    await call(c);
    expect(sent[0][TRACE]).not.toBe(sent[1][TRACE]);
  });

  it('calls inside one tracer.span() share one trace', async () => {
    const c = client();
    await tracer.span('conversation', async () => {
      for (let i = 0; i < 3; i += 1) await call(c);
    });
    const traces = new Set(sent.map((h) => h[TRACE]));
    expect(sent).toHaveLength(3);
    expect(traces.size).toBe(1);
    expect([...traces][0]).toMatch(HEX32);
  });
});

describe('a trace id from outside is never rewritten', () => {
  it('a captured inbound trace is sent unchanged', async () => {
    const given = '0F713837-1218-4EFB-ABCD-000000000001';
    await tracer.incoming({ 'x-shashu-trace-id': given }, () => call(client()));
    expect(sent[0][TRACE]).toBe(given);
  });

  it('a caller-given invocation trace is sent unchanged', () => {
    expect(buildInvocationHeaders({ callerAgentId: 'a', traceId: 'My-Trace-1' })[TRACE]).toBe(
      'My-Trace-1'
    );
  });

  it('an environment run id is used unchanged', async () => {
    process.env.GITHUB_RUN_ID = '1234567890';
    await call(client());
    expect(sent[0][TRACE]).toBe('1234567890');
  });
});
