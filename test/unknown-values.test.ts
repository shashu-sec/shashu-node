/**
 * Unknown values the gateway may send tomorrow are read today, never thrown on.
 *
 * Written BEFORE the FILE-06 accessors, against the surface that already
 * existed, so it records whether the SDK tolerated a made-up `code`, a made-up
 * reason, a made-up field and a made-up attachment state before anything
 * changed. It uses no FILE-06 name, so it runs on either side of that change.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Shashu,
  ShashuError,
  ShashuPolicyViolation,
  decisionFrom,
  shashuDecision,
} from '../src/index.js';

const ENVELOPE = {
  decision: 'refuse',
  code: 'made_up_code_zz',
  retryable: false,
  id: 'rec-1',
  inspection: { input: 'checked', output: 'checked', detectors: { made_up_detector: 'zz' } },
  versions: { contract: '2099-01-01' },
  message: 'm',
  made_up_top_level_field: { nested: [1, 2] },
  attachments: {
    total: 1,
    blocked: 1,
    made_up_count: 3,
    items: [{ state: 'quarantined_zz', reason: 'made_up_reason_zz', made_up_field: true }],
  },
  memory: { coverage: 'made_up_zz', items: [{ kind: 'zz', reason: 'made_up_reason_zz' }] },
  route_policy: { route: 'r', category: 'zz', reason: 'made_up_reason_zz', extra: 1 },
};

const HEADERS = {
  'x-shashu-decision': 'refuse',
  'x-shashu-code': 'made_up_code_zz',
  'x-shashu-attachments': 'total=1;blocked=1;made_up=2',
  'x-shashu-memory': 'writes=1;made_up=2',
  'x-shashu-made-up-header': 'zz',
};

function stub(status: number, payload: unknown, hdrs: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json', ...hdrs },
        })
    )
  );
}

function client() {
  return new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });
}

const REQ = { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) };

afterEach(() => vi.unstubAllGlobals());

describe('made-up values are read, not thrown on', () => {
  it('decisionFrom reads a made-up code, reason, field and state', () => {
    const d = decisionFrom({ error: { message: 'm', shashu: ENVELOPE } }, HEADERS);
    expect(d?.decision).toBe('refuse');
    expect(d?.code).toBe('made_up_code_zz');
  });

  it('a made-up decision is still a block', () => {
    const d = decisionFrom({ shashu: { ...ENVELOPE, decision: 'made_up_decision_zz' } }, undefined);
    expect(d?.decision).toBe('block');
    expect(d?.rawDecision).toBe('made_up_decision_zz');
  });

  it('the client throws the type it always did', async () => {
    stub(
      403,
      {
        error: {
          message: 'm',
          type: 'permission_error',
          code: 'made_up_code_zz',
          shashu: ENVELOPE,
        },
      },
      HEADERS
    );
    let caught: unknown;
    try {
      await client().fetch('/v1/chat/completions', REQ);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShashuPolicyViolation);
    expect(shashuDecision(caught as ShashuError)?.code).toBe('made_up_code_zz');
  });

  it('a 200 with made-up values is delivered', async () => {
    stub(
      200,
      {
        id: 'c',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        shashu: { ...ENVELOPE, decision: 'allow' },
        made_up_body_field: { x: 1 },
      },
      { ...HEADERS, 'x-shashu-decision': 'allow' }
    );
    const res = await client().fetch('/v1/chat/completions', REQ);
    expect(shashuDecision(res)?.code).toBe('made_up_code_zz');
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('ok');
  });
});
