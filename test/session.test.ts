/**
 * Session at origin. One place — `resolveSessionId` / `buildContextHeaders`.
 *
 * A request that carries no `x-trustgate-session-id` gets one the gateway
 * derives from the agent id and the first system-or-user message, so every
 * run of an agent whose first message is a static system prompt collapses
 * into ONE Sessions row. Found live in a customer demo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shashu, tracer, buildContextHeaders, getWorkflowContextFromEnv } from '../src/index.js';
import { buildInvocationHeaders, resolveSessionId } from '../src/context.js';
import { shashuFetch } from '../src/fetch.js';

const CHAT = '/v1/chat/completions';
const COMPLETION = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
});

function jsonResponse(status = 200, headers: Record<string, string> = {}): Response {
  return new Response(COMPLETION, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function captureHeaders(): { sent: Record<string, string>; restore: () => void } {
  const sent: Record<string, string> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
      Object.assign(sent, init.headers ?? {});
      return jsonResponse();
    })
  );
  return { sent, restore: () => vi.unstubAllGlobals() };
}

describe('resolveSessionId — the one place', () => {
  it('a per-request session is an INSTRUCTION that wins over captured and default', () => {
    tracer.incoming({ 'x-trustgate-trace-id': 'f', 'x-trustgate-session-id': 'captured' }, () => {
      expect(
        resolveSessionId({ defaultSessionId: 'default', requestSessionId: 'per-request' })
      ).toBe('per-request');
    });
  });

  it('a captured A2A session overrides the construction-time default', () => {
    tracer.incoming({ 'x-trustgate-trace-id': 'f', 'x-trustgate-session-id': 'captured' }, () => {
      expect(resolveSessionId({ defaultSessionId: 'default' })).toBe('captured');
    });
  });

  it('the construction-time default is used at origin', () => {
    expect(resolveSessionId({ defaultSessionId: 'default' })).toBe('default');
  });

  it('mints nothing — two calls without a default stay empty', () => {
    expect(resolveSessionId()).toBeUndefined();
    expect(resolveSessionId()).toBeUndefined();
  });
});

describe('origin request sends x-trustgate-session-id', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a constructed client sends the header at origin', async () => {
    const { sent } = captureHeaders();
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
    await tg.fetch(CHAT, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) });
    expect(sent['x-trustgate-session-id']).toBeDefined();
    expect(sent['x-trustgate-session-id']).toBe(tg.sessionId);
    expect(sent['x-trustgate-caller-agent-id']).toBeUndefined();
    expect(sent['x-trustgate-hop-depth']).toBeUndefined();
  });

  it('one client is one session across two requests', async () => {
    const sessions: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
        sessions.push(init.headers?.['x-trustgate-session-id'] ?? '');
        return jsonResponse();
      })
    );
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
    const body = JSON.stringify({ model: 'm', messages: [] });
    await tg.fetch(CHAT, { method: 'POST', body });
    await tg.fetch(CHAT, { method: 'POST', body });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[0]).toBe(tg.sessionId);
  });

  it('two clients are two sessions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse())
    );
    const a = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
    const b = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('a construction-time sessionId is used verbatim', async () => {
    const { sent } = captureHeaders();
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      sessionId: 'sess-explicit',
      retryPolicy: null,
    });
    await tg.fetch(CHAT, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) });
    expect(sent['x-trustgate-session-id']).toBe('sess-explicit');
    expect(tg.sessionId).toBe('sess-explicit');
  });

  it('a per-request sessionId wins and does not change the client', async () => {
    const sessions: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
        sessions.push(init.headers?.['x-trustgate-session-id'] ?? '');
        return jsonResponse();
      })
    );
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      sessionId: 'client-default',
      retryPolicy: null,
    });
    const body = JSON.stringify({ model: 'm', messages: [] });
    await tg.fetch(CHAT, { method: 'POST', body }, { sessionId: 'per-request' });
    await tg.fetch(CHAT, { method: 'POST', body });
    expect(sessions).toEqual(['per-request', 'client-default']);
    expect(tg.sessionId).toBe('client-default');
  });

  it("a captured A2A session overrides the client's default", async () => {
    const { sent } = captureHeaders();
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      sessionId: 'client-default',
      retryPolicy: null,
    });
    await tracer.incoming(
      { 'x-trustgate-trace-id': 'flow', 'x-trustgate-session-id': 'a2a-sess' },
      async () => {
        await tg.fetch(CHAT, {
          method: 'POST',
          body: JSON.stringify({ model: 'm', messages: [] }),
        });
      }
    );
    expect(sent['x-trustgate-session-id']).toBe('a2a-sess');
    expect(tg.sessionId).toBe('client-default');
  });

  it('a per-request sessionId wins over a captured A2A session', async () => {
    const { sent } = captureHeaders();
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      sessionId: 'client-default',
      retryPolicy: null,
    });
    await tracer.incoming(
      { 'x-trustgate-trace-id': 'flow', 'x-trustgate-session-id': 'a2a-sess' },
      async () => {
        await tg.fetch(
          CHAT,
          { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) },
          { sessionId: 'per-request' }
        );
      }
    );
    expect(sent['x-trustgate-session-id']).toBe('per-request');
  });
});

describe('shashuFetch mints one session at construction', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('two calls through one fetch join one session', async () => {
    const sessions: string[] = [];
    const fetch = shashuFetch({
      sessionId: undefined,
      fetch: async (_input, init) => {
        const h = (init?.headers ?? {}) as Record<string, string>;
        sessions.push(h['x-trustgate-session-id']);
        return jsonResponse();
      },
    });
    await fetch('https://gw.example/v1/chat/completions', { method: 'POST', body: '{}' });
    await fetch('https://gw.example/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBeTruthy();
    expect(sessions[0]).toBe(sessions[1]);
  });
});

describe('buildContextHeaders without a default still omits session at origin', () => {
  it('standalone header build does not mint', () => {
    const h = buildContextHeaders(getWorkflowContextFromEnv());
    expect(h['x-trustgate-session-id']).toBeUndefined();
  });
});

/**
 * `buildInvocationHeaders` was a SECOND session-resolution point.
 *
 * It read `opts.sessionId ?? tracer.sessionId` directly instead of going
 * through `resolveSessionId`, and a second copy of a precedence rule is a rule
 * that can be wrong in one place. Measured 2026-09-17: inverting that line to
 * `tracer.sessionId ?? opts.sessionId` left the whole suite green at 295/295,
 * although it silently loses a caller's per-request INSTRUCTION to whatever
 * session happened to be captured from the inbound hop.
 *
 * These three cases are the precedence tiers, at the surface that had no
 * coverage for any of them. The first is the one that reddens the inversion.
 */
describe('buildInvocationHeaders resolves the session in one place', () => {
  afterEach(() => {
    tracer.captureIncoming(undefined);
  });

  it('a per-request session is an INSTRUCTION and beats a captured hop', () => {
    tracer.captureIncoming({
      'x-trustgate-trace-id': 'trace-from-the-hop',
      'x-trustgate-session-id': 'captured-from-the-hop',
      'x-trustgate-hop-depth': '1',
    });

    const headers = buildInvocationHeaders({
      callerAgentId: 'agent-a',
      sessionId: 'the-callers-instruction',
    });

    expect(headers['x-trustgate-session-id']).toBe('the-callers-instruction');
  });

  it('a captured hop is used when the caller passed none', () => {
    tracer.captureIncoming({
      'x-trustgate-trace-id': 'trace-from-the-hop',
      'x-trustgate-session-id': 'captured-from-the-hop',
      'x-trustgate-hop-depth': '1',
    });

    const headers = buildInvocationHeaders({ callerAgentId: 'agent-a' });

    expect(headers['x-trustgate-session-id']).toBe('captured-from-the-hop');
  });

  it('no session anywhere emits no session header — it is not minted here', () => {
    const headers = buildInvocationHeaders({ callerAgentId: 'agent-a' });

    expect(headers['x-trustgate-session-id']).toBeUndefined();
  });
});
