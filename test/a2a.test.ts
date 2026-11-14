import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Shashu,
  ShashuPolicyViolation,
  tracer,
  captureIncoming,
  buildContextHeaders,
  buildInvocationHeaders,
  getWorkflowContextFromEnv,
} from '../src/index';

/**
 * WP-A2A-4 / P4-b — A2A inbound-capture + outbound propagation (ADR-007 §0, §4.1).
 * Mirrors the corrected Python reference (trustgate 0.9.1) and the wire-contract shape.
 *
 * Capture is exercised inside `tracer.incoming(headers, fn)` scopes so the
 * AsyncLocalStorage store is deterministic per-case (no enterWith leakage between tests).
 */

const CHAT = '/v1/chat/completions';
const COMPLETION = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
});

/** Minimal local-script workflow context for header-builder assertions. */
const ctx = () => getWorkflowContextFromEnv();

function jsonResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// --------------------------------------------------------------------------- #
// Inbound capture
// --------------------------------------------------------------------------- #
describe('captureIncoming', () => {
  it('populates the store including the inbound caller', () => {
    tracer.incoming(
      {
        'x-trustgate-trace-id': 'flow-1',
        'x-trustgate-session-id': 'sess-1',
        'x-trustgate-hop-depth': '2',
        'x-trustgate-caller-agent-id': 'agent-A',
      },
      () => {
        expect(tracer.isA2aHop).toBe(true);
        expect(tracer.traceId).toBe('flow-1');
        expect(tracer.sessionId).toBe('sess-1');
        expect(tracer.inboundHopDepth).toBe(2);
        expect(tracer.outboundHopDepth).toBe(3);
        expect(tracer.inboundCallerAgentId).toBe('agent-A'); // §4.1: the upstream invoker
      }
    );
  });

  it('no inbound trace is origin (returns false, clears ambient)', () => {
    tracer.incoming({}, () => {
      expect(captureIncoming({ 'x-trustgate-session-id': 's' })).toBe(false);
      expect(captureIncoming({})).toBe(false);
      expect(captureIncoming(undefined)).toBe(false);
      expect(tracer.isA2aHop).toBe(false);
    });
  });

  it('is case-insensitive', () => {
    tracer.incoming(
      {
        'X-TrustGate-Trace-Id': 'T1',
        'X-Trustgate-Session-Id': 'S1',
        'X-TrustGate-Caller-Agent-Id': 'A1',
      },
      () => {
        expect(tracer.traceId).toBe('T1');
        expect(tracer.sessionId).toBe('S1');
        expect(tracer.inboundCallerAgentId).toBe('A1');
      }
    );
  });

  it('accepts a Headers object', () => {
    const h = new Headers({ 'x-trustgate-trace-id': 'T2', 'x-trustgate-hop-depth': '5' });
    tracer.incoming(h, () => {
      expect(tracer.traceId).toBe('T2');
      expect(tracer.outboundHopDepth).toBe(6);
    });
  });

  it('without a hop header defaults outbound depth to 1', () => {
    tracer.incoming({ 'x-trustgate-trace-id': 'f' }, () => {
      expect(tracer.inboundHopDepth).toBe(0);
      expect(tracer.outboundHopDepth).toBe(1);
    });
  });

  it('without a caller header leaves inboundCallerAgentId undefined', () => {
    tracer.incoming({ 'x-trustgate-trace-id': 'f', 'x-trustgate-hop-depth': '1' }, () => {
      expect(tracer.inboundCallerAgentId).toBeUndefined();
    });
  });

  it('a re-capture without a caller resets a stale caller', () => {
    tracer.incoming({}, () => {
      captureIncoming({ 'x-trustgate-trace-id': 'f1', 'x-trustgate-caller-agent-id': 'A' });
      expect(tracer.inboundCallerAgentId).toBe('A');
      captureIncoming({ 'x-trustgate-trace-id': 'f2' });
      expect(tracer.inboundCallerAgentId).toBeUndefined();
    });
  });
});

// --------------------------------------------------------------------------- #
// Outbound gateway call (buildContextHeaders): propagate trace, FORWARD the caller
// --------------------------------------------------------------------------- #
describe('buildContextHeaders (gateway call)', () => {
  it('propagates the captured trace (not minted) with session + hop+1', () => {
    tracer.incoming(
      {
        'x-trustgate-trace-id': 'flow-xyz',
        'x-trustgate-session-id': 'sess-1',
        'x-trustgate-hop-depth': '2',
        'x-trustgate-caller-agent-id': 'agent-A',
      },
      () => {
        const h = buildContextHeaders(ctx());
        expect(h['x-trustgate-trace-id']).toBe('flow-xyz'); // propagated, not a fresh uuid
        expect(h['x-trustgate-session-id']).toBe('sess-1');
        expect(h['x-trustgate-hop-depth']).toBe('3'); // inbound 2 + 1
      }
    );
  });

  it('FORWARDS the inbound caller, never self (§4.1)', () => {
    tracer.incoming(
      {
        'x-trustgate-trace-id': 'F',
        'x-trustgate-caller-agent-id': 'agent-A',
        'x-trustgate-hop-depth': '1',
      },
      () => {
        const h = buildContextHeaders(ctx());
        expect(h['x-trustgate-caller-agent-id']).toBe('agent-A');
      }
    );
  });

  it('origin emits NO A2A lineage headers', () => {
    const h = buildContextHeaders(ctx()); // no capture
    expect(h['x-trustgate-session-id']).toBeUndefined();
    expect(h['x-trustgate-caller-agent-id']).toBeUndefined();
    expect(h['x-trustgate-hop-depth']).toBeUndefined();
  });

  it('omits caller-agent-id when no inbound caller was captured', () => {
    tracer.incoming({ 'x-trustgate-trace-id': 'f', 'x-trustgate-hop-depth': '1' }, () => {
      const h = buildContextHeaders(ctx());
      expect(h['x-trustgate-trace-id']).toBe('f');
      expect(h['x-trustgate-hop-depth']).toBe('2');
      expect(h['x-trustgate-caller-agent-id']).toBeUndefined();
    });
  });

  it('omits session when none was propagated', () => {
    tracer.incoming({ 'x-trustgate-trace-id': 'f', 'x-trustgate-caller-agent-id': 'A' }, () => {
      const h = buildContextHeaders(ctx());
      expect(h['x-trustgate-session-id']).toBeUndefined();
      expect(h['x-trustgate-caller-agent-id']).toBe('A'); // forwarded invoker
      expect(h['x-trustgate-hop-depth']).toBe('1');
    });
  });

  it('a span inside a captured flow inherits the trace + still forwards lineage', async () => {
    await tracer.incoming(
      {
        'x-trustgate-trace-id': 'FLOW',
        'x-trustgate-session-id': 'S',
        'x-trustgate-hop-depth': '1',
        'x-trustgate-caller-agent-id': 'A',
      },
      async () => {
        await tracer.span('work', async () => {
          const h = buildContextHeaders(ctx());
          expect(h['x-trustgate-trace-id']).toBe('FLOW'); // span inherits captured trace
          expect(h['x-trustgate-span-id']).toBeDefined();
          expect(h['x-trustgate-session-id']).toBe('S');
          expect(h['x-trustgate-caller-agent-id']).toBe('A'); // forwarded invoker, not self
          expect(h['x-trustgate-hop-depth']).toBe('2');
        });
      }
    );
  });

  it('all header keys stay lowercase mid-flow', () => {
    tracer.incoming(
      {
        'x-trustgate-trace-id': 't',
        'x-trustgate-session-id': 's',
        'x-trustgate-hop-depth': '1',
        'x-trustgate-caller-agent-id': 'a',
      },
      () => {
        const h = buildContextHeaders(ctx());
        for (const k of Object.keys(h)) expect(k).toBe(k.toLowerCase());
      }
    );
  });
});

// --------------------------------------------------------------------------- #
// Invoking side — buildInvocationHeaders stamps caller = SELF (§4.1)
// --------------------------------------------------------------------------- #
describe('buildInvocationHeaders (invoking side)', () => {
  it('at origin stamps caller = self, mints a trace, hop = 1, no session', () => {
    const h = buildInvocationHeaders({ callerAgentId: 'agent-A' });
    expect(h['x-trustgate-caller-agent-id']).toBe('agent-A');
    expect(h['x-trustgate-trace-id']).toBeDefined();
    expect(h['x-trustgate-hop-depth']).toBe('1');
    expect(h['x-trustgate-session-id']).toBeUndefined();
  });

  it('mid-flow propagates the served flow with caller = self', () => {
    tracer.incoming(
      {
        'x-trustgate-trace-id': 'F',
        'x-trustgate-session-id': 'S',
        'x-trustgate-hop-depth': '1',
        'x-trustgate-caller-agent-id': 'agent-A',
      },
      () => {
        const h = buildInvocationHeaders({ callerAgentId: 'agent-B' });
        expect(h['x-trustgate-trace-id']).toBe('F'); // served flow propagated
        expect(h['x-trustgate-caller-agent-id']).toBe('agent-B'); // B stamps ITSELF as invoker of C
        expect(h['x-trustgate-session-id']).toBe('S');
        expect(h['x-trustgate-hop-depth']).toBe('2');
      }
    );
  });

  it('honors explicit overrides', () => {
    const h = buildInvocationHeaders({
      callerAgentId: 'me',
      traceId: 'T',
      sessionId: 'S',
      hopDepth: 5,
    });
    expect(h).toEqual({
      'x-trustgate-trace-id': 'T',
      'x-trustgate-caller-agent-id': 'me',
      'x-trustgate-hop-depth': '5',
      'x-trustgate-session-id': 'S',
    });
  });

  it('forms the A→B→C chain end-to-end (header level)', () => {
    // A (origin) invokes B: A stamps caller = A.
    const aToB = buildInvocationHeaders({ callerAgentId: 'agent-A', traceId: 'FLOW' });
    expect(aToB['x-trustgate-caller-agent-id']).toBe('agent-A');

    // B serves A's call: B's gateway call FORWARDS caller = A (the A→B edge).
    tracer.incoming(aToB, () => {
      const bGateway = buildContextHeaders(ctx());
      expect(bGateway['x-trustgate-trace-id']).toBe('FLOW');
      expect(bGateway['x-trustgate-caller-agent-id']).toBe('agent-A');
      expect(bGateway['x-trustgate-hop-depth']).toBe('2'); // inbound 1 + 1

      // B invokes C: B stamps ITSELF; C will then forward B (the B→C edge).
      const bToC = buildInvocationHeaders({ callerAgentId: 'agent-B' });
      expect(bToC['x-trustgate-caller-agent-id']).toBe('agent-B');
      expect(bToC['x-trustgate-trace-id']).toBe('FLOW'); // same flow

      tracer.incoming(bToC, () => {
        const cGateway = buildContextHeaders(ctx());
        expect(cGateway['x-trustgate-caller-agent-id']).toBe('agent-B'); // C forwards B
        expect(cGateway['x-trustgate-hop-depth']).toBe('3');
      });
    });
  });
});

// --------------------------------------------------------------------------- #
// incoming() scopes the capture
// --------------------------------------------------------------------------- #
describe('tracer.incoming', () => {
  it('scopes capture and restores origin on exit', () => {
    tracer.incoming(
      {
        'x-trustgate-trace-id': 'T',
        'x-trustgate-session-id': 'S',
        'x-trustgate-caller-agent-id': 'A',
      },
      () => {
        expect(tracer.isA2aHop).toBe(true);
        expect(buildContextHeaders(ctx())['x-trustgate-trace-id']).toBe('T');
      }
    );
    // Restored -> origin again; no lineage leakage into the next request.
    expect(tracer.isA2aHop).toBe(false);
    const h = buildContextHeaders(ctx());
    expect(h['x-trustgate-caller-agent-id']).toBeUndefined();
    expect(h['x-trustgate-session-id']).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- #
// Self-agent-id cache (client) — used to stamp INVOCATIONS
// --------------------------------------------------------------------------- #
describe('self-agent-id cache + client invocation helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('caches self-id from the response and the gateway call forwards the inbound caller (not self)', async () => {
    let sentHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
        sentHeaders = init.headers ?? {};
        return jsonResponse(200, COMPLETION, { 'x-trustgate-agent-id': 'gw-reported' });
      })
    );

    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      agentId: 'explicit-seed',
      retryPolicy: null,
    });
    await tracer.incoming(
      {
        'x-trustgate-trace-id': 'flow-A',
        'x-trustgate-hop-depth': '1',
        'x-trustgate-caller-agent-id': 'upstream-A',
      },
      async () => {
        await tg.fetch(CHAT, {
          method: 'POST',
          body: JSON.stringify({ model: 'm', messages: [] }),
        });
      }
    );

    expect(sentHeaders['x-trustgate-trace-id']).toBe('flow-A'); // propagated
    expect(sentHeaders['x-trustgate-caller-agent-id']).toBe('upstream-A'); // FORWARDED, not self
    expect(tg.agentId).toBe('gw-reported'); // response refreshed the self-id cache

    // The cached self-id is what THIS agent stamps when it invokes a downstream agent.
    const inv = tg.buildInvocationHeaders();
    expect(inv['x-trustgate-caller-agent-id']).toBe('gw-reported'); // caller = self (invoking side)
  });

  it('buildInvocationHeaders throws when self-id is unknown', () => {
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k' });
    expect(() => tg.buildInvocationHeaders()).toThrow(/self agent id is unknown/i);
  });

  it('caches self-id even on a blocked (4xx) response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          403,
          JSON.stringify({
            error: { message: 'blocked', type: 'invalid_request_error', code: '403' },
          }),
          { 'x-trustgate-agent-id': 'gw-reported' }
        )
      )
    );
    const tg = new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
    await expect(
      tg.fetch(CHAT, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) })
    ).rejects.toBeInstanceOf(ShashuPolicyViolation);
    expect(tg.agentId).toBe('gw-reported'); // seeded before the throw
  });

  it('origin client call emits no A2A lineage headers (even with self-id seeded)', async () => {
    let sentHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
        sentHeaders = init.headers ?? {};
        return jsonResponse(200, COMPLETION);
      })
    );
    const tg = new Shashu({
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      agentId: 'seeded',
      retryPolicy: null,
    });
    await tg.fetch(CHAT, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) });
    expect(sentHeaders['x-trustgate-caller-agent-id']).toBeUndefined(); // origin: no caller even when seeded
    expect(sentHeaders['x-trustgate-session-id']).toBe(tg.sessionId); // origin DOES send a session
    expect(sentHeaders['x-trustgate-hop-depth']).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- #
// Exports
// --------------------------------------------------------------------------- #
describe('exports', () => {
  it('exposes captureIncoming + buildInvocationHeaders', () => {
    expect(typeof captureIncoming).toBe('function');
    expect(typeof buildInvocationHeaders).toBe('function');
  });
});
