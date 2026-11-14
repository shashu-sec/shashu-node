/**
 * FILE-06: reading the file, memory and route-policy blocks off a decision.
 *
 * The envelope (`contracts/decision-envelope.v1.md`, contract `2026-10-01`)
 * gained three optional blocks — `attachments`, `memory`, `route_policy` — and
 * two headers that carry counts only. Sibling of the Python SDK's
 * tests/test_file_memory_route.py: same six wire responses, same assertions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEADER_ATTACHMENTS,
  HEADER_MEMORY,
  MemoryWriteBlocked,
  Shashu,
  ShashuError,
  ShashuPolicyViolation,
  decisionFrom,
  isShashuBlock,
  shashuDecision,
  type Decision,
} from '../src/index.js';

const ID = 'b510c203bcc970b9f9965ebb86b4348b';
const CHAT_200 = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 0,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const ATTACHMENTS_FLAGGED = {
  total: 2,
  scanned: 1,
  scanned_partial: 0,
  not_inspected: 1,
  blocked: 0,
  items: [
    {
      index: 0,
      path: 'messages[0].content[1]',
      filename: 'q3.pdf',
      declared_type: 'application/pdf',
      sniffed_type: 'application/pdf',
      sha256: 'aa11',
      bytes: 1834021,
      source: 'inline',
      state: 'scanned',
      reason: null,
      findings: [],
    },
    {
      index: 1,
      path: 'messages[0].content[2]',
      filename: 'notes.one',
      declared_type: 'application/onenote',
      sniffed_type: 'application/onenote',
      sha256: 'bb22',
      bytes: 92110,
      source: 'inline',
      state: 'not_inspected',
      reason: 'unsupported_type',
      findings: [],
    },
  ],
};

const ATTACHMENTS_BLOCKED = {
  total: 1,
  scanned: 0,
  scanned_partial: 0,
  not_inspected: 0,
  blocked: 1,
  items: [
    {
      index: 0,
      path: 'messages[0].content[1]',
      filename: 'a.pdf',
      declared_type: 'application/pdf',
      sniffed_type: 'application/x-msdownload',
      sha256: 'cc33',
      bytes: 12,
      source: 'inline',
      state: 'blocked',
      reason: 'type_mismatch',
      findings: [
        {
          detector: 'file',
          category: 'fair_lending.disparate_treatment',
          code: 'file_policy',
          severity: 'high',
          locator: 'page[1]',
          snippet_redacted: '[redacted]',
        },
      ],
    },
  ],
};

const MEMORY_BLOCKED = {
  coverage: 'gateway',
  writes: 1,
  writes_blocked: 1,
  recalls: 0,
  recalls_flagged: 0,
  items: [
    {
      kind: 'write',
      tool: 'memory.write',
      store: 'agent',
      scope: 'session',
      source: 'user',
      enforcement: 'block',
      memory_ref: 'm1',
      seen_before: false,
      state: 'blocked',
      reason: 'memory_sink_injection',
    },
  ],
};

const ROUTE_POLICY = {
  route: 'general-chat',
  category: 'phi',
  reason: 'route_not_authorized_for_phi',
  requested_route: 'general-chat',
};

function envelope(decision: string, code?: string, blocks: Record<string, unknown> = {}) {
  const env: Record<string, unknown> = {
    decision,
    retryable: false,
    id: ID,
    inspection: { input: 'checked', output: 'checked' },
    versions: { contract: '2026-10-01' },
    message: 'a sentence a client must not parse',
  };
  if (code !== undefined) env.code = code;
  return { ...env, ...clone(blocks) };
}

function headers(decision: string, code?: string, extra: Record<string, string> = {}) {
  const out: Record<string, string> = {
    'x-request-id': ID,
    'x-trustgate-decision': decision,
    'x-trustgate-inspection': 'input=checked;output=checked',
    'x-should-retry': 'false',
  };
  if (code !== undefined) out['x-trustgate-code'] = code;
  return { ...out, ...extra };
}

const ok = (decision: string, code?: string, blocks: Record<string, unknown> = {}) => ({
  ...clone(CHAT_200),
  trustgate: envelope(decision, code, blocks),
});

const refused = (code: string, message: string, blocks: Record<string, unknown>) => ({
  error: {
    message,
    type: 'permission_error',
    param: null,
    code,
    trustgate: envelope('refuse', code, blocks),
  },
  choices: [],
});

type Scenario = [number, Record<string, unknown>, Record<string, string>];

/** The six wire responses. The unit and e2e tests read the same bytes. */
const SCENARIOS: Record<string, Scenario> = {
  no_file: [200, ok('allow'), headers('allow')],
  file_flagged: [
    200,
    ok('not_checked', 'attachment_uninspected', { attachments: ATTACHMENTS_FLAGGED }),
    headers('not_checked', 'attachment_uninspected', {
      'x-trustgate-attachments': 'total=2;scanned=1;not_inspected=1;blocked=0',
    }),
  ],
  file_blocked: [
    403,
    refused(
      'file_policy',
      'The file a.pdf declared one type and its contents matched another, so it was not forwarded.',
      { attachments: ATTACHMENTS_BLOCKED }
    ),
    headers('refuse', 'file_policy', {
      'x-trustgate-attachments': 'total=1;scanned=0;not_inspected=0;blocked=1',
    }),
  ],
  memory_blocked: [
    403,
    refused(
      'tool_policy',
      'A write through memory.write tried to store an injection into memory, so the write was not stored.',
      { memory: MEMORY_BLOCKED }
    ),
    headers('refuse', 'tool_policy', {
      'x-trustgate-memory': 'writes=1;blocked=1;recalls=0;flagged=0',
    }),
  ],
  route_blocked: [
    403,
    refused(
      'route_data_policy',
      'This request contains patient health information and route general-chat is not approved for it. Use a BAA-covered route.',
      { route_policy: ROUTE_POLICY }
    ),
    headers('refuse', 'route_data_policy'),
  ],
  // A streaming / header-only reader: no envelope in the body, counts in headers.
  header_only: [
    200,
    clone(CHAT_200),
    headers('not_checked', 'attachment_uninspected', {
      'x-trustgate-attachments': 'total=3;scanned=1;not_inspected=1;blocked=0',
      'x-trustgate-memory': 'writes=2;blocked=0;recalls=4;flagged=1',
    }),
  ],
};

const read = (name: string): Decision => {
  const [, body, hdrs] = SCENARIOS[name];
  const d = decisionFrom(body, hdrs);
  if (!d) throw new Error(`no decision in ${name}`);
  return d;
};

describe('attachments', () => {
  it('a no-file response has none and zero counts', () => {
    const d = read('no_file');
    expect(d.attachments).toBeUndefined();
    expect(d.filesUnverified).toBe(0);
    expect(d.filesBlocked).toBe(0);
  });

  it('a flagged file is read off the body', () => {
    const d = read('file_flagged');
    const att = d.attachments!;
    expect(att.carrier).toBe('body');
    expect([att.total, att.scanned, att.scannedPartial, att.notInspected, att.blocked]).toEqual([
      2, 1, 0, 1, 0,
    ]);
    expect(d.filesUnverified).toBe(1);
    expect(d.filesBlocked).toBe(0);
    const [first, second] = att.items;
    expect(first.filename).toBe('q3.pdf');
    expect(first.state).toBe('scanned');
    expect(first.reason).toBeUndefined();
    expect(first.bytes).toBe(1834021);
    expect(first.sha256).toBe('aa11');
    expect(first.source).toBe('inline');
    expect(second.state).toBe('not_inspected');
    expect(second.rawState).toBe('not_inspected');
    expect(second.reason).toBe('unsupported_type');
    expect(second.declaredType).toBe('application/onenote');
    expect(second.sniffedType).toBe('application/onenote');
  });

  it('scanned_partial counts as unverified', () => {
    const block = { ...clone(ATTACHMENTS_FLAGGED), scanned_partial: 2 };
    expect(
      decisionFrom(
        { trustgate: envelope('not_checked', undefined, { attachments: block }) },
        undefined
      )?.filesUnverified
    ).toBe(3);
  });

  it('a blocked file and its findings', () => {
    const d = read('file_blocked');
    expect(d.filesBlocked).toBe(1);
    const [item] = d.attachments!.items;
    expect(item.state).toBe('blocked');
    expect(item.reason).toBe('type_mismatch');
    expect(item.findings).toEqual([
      {
        detector: 'file',
        category: 'fair_lending.disparate_treatment',
        code: 'file_policy',
        severity: 'high',
        locator: 'page[1]',
      },
    ]);
  });

  it('header-only falls back to the counts and says so', () => {
    const d = read('header_only');
    const att = d.attachments!;
    expect(att.carrier).toBe('header');
    expect(att.items).toEqual([]);
    expect([att.total, att.scanned, att.notInspected, att.blocked]).toEqual([3, 1, 1, 0]);
    expect(att.scannedPartial).toBe(1);
    expect(d.filesUnverified).toBe(2);
  });

  it('the body wins over the header', () => {
    const [, body, hdrs] = SCENARIOS.file_flagged;
    const d = decisionFrom(body, {
      ...hdrs,
      'x-trustgate-attachments': 'total=9;scanned=9;not_inspected=0;blocked=0',
    });
    expect(d?.attachments?.carrier).toBe('body');
    expect(d?.attachments?.total).toBe(2);
  });

  it('the records are frozen', () => {
    const d = read('file_flagged');
    expect(Object.isFrozen(d.attachments)).toBe(true);
    expect(Object.isFrozen(d.attachments!.items)).toBe(true);
    expect(Object.isFrozen(d.attachments!.items[0])).toBe(true);
  });

  it('names the two count headers the contract names', () => {
    expect(HEADER_ATTACHMENTS).toBe('x-trustgate-attachments');
    expect(HEADER_MEMORY).toBe('x-trustgate-memory');
  });
});

describe('memory', () => {
  it('none on a plain response', () => {
    const d = read('no_file');
    expect(d.memory).toBeUndefined();
    expect(d.memoryBlocked).toBe(0);
    expect(d.memoryRecallsFlagged).toBe(0);
    expect(d.memoryCoverage).toBeUndefined();
  });

  it('a blocked write is read off the body', () => {
    const d = read('memory_blocked');
    const mem = d.memory!;
    expect(mem.carrier).toBe('body');
    expect([mem.writes, mem.writesBlocked, mem.recalls, mem.recallsFlagged]).toEqual([1, 1, 0, 0]);
    expect(d.memoryBlocked).toBe(1);
    expect(d.memoryCoverage).toBe('gateway');
    expect(mem.items[0]).toEqual({
      kind: 'write',
      state: 'blocked',
      reason: 'memory_sink_injection',
      tool: 'memory.write',
      store: 'agent',
      scope: 'session',
      source: 'user',
      enforcement: 'block',
      memoryRef: 'm1',
      writeRef: undefined,
      seenBefore: false,
    });
  });

  it('header-only counts', () => {
    const d = read('header_only');
    const mem = d.memory!;
    expect(mem.carrier).toBe('header');
    expect(mem.items).toEqual([]);
    expect([mem.writes, mem.writesBlocked, mem.recalls, mem.recallsFlagged]).toEqual([2, 0, 4, 1]);
    expect(d.memoryRecallsFlagged).toBe(1);
    expect(d.memoryCoverage).toBeUndefined();
  });
});

describe('route policy', () => {
  it('absent on a plain response', () => {
    expect(read('no_file').routePolicy).toBeUndefined();
  });

  it('read off the body', () => {
    expect(read('route_blocked').routePolicy).toEqual({
      route: 'general-chat',
      category: 'phi',
      reason: 'route_not_authorized_for_phi',
      requestedRoute: 'general-chat',
      degradedRoute: undefined,
    });
  });
});

function madeUpEnvelope() {
  const att = clone(ATTACHMENTS_FLAGGED) as Record<string, any>;
  att.made_up_block_field = { x: 1 };
  att.items[0].state = 'quarantined_zz';
  att.items[0].reason = 'made_up_reason_zz';
  att.items[0].made_up_item_field = [1, 2];
  att.items[0].findings = [{ detector: 'zz', category: 'zz.new', made_up: true }];
  const mem = clone(MEMORY_BLOCKED) as Record<string, any>;
  mem.coverage = 'made_up_coverage_zz';
  mem.items[0].reason = 'made_up_memory_reason_zz';
  mem.items[0].kind = 'made_up_kind_zz';
  mem.items[0].made_up_item_field = 'x';
  return {
    ...envelope('refuse', 'made_up_code_zz', {
      attachments: att,
      memory: mem,
      route_policy: { ...ROUTE_POLICY, reason: 'made_up_route_reason_zz', made_up_field: 7 },
    }),
    made_up_top_level_field: { nested: ['x'] },
  };
}

describe('tolerance', () => {
  it('an unknown code, reason, field and state are read, not thrown on', () => {
    const d = decisionFrom(
      {
        error: {
          message: 'm',
          type: 'permission_error',
          code: 'made_up_code_zz',
          trustgate: madeUpEnvelope(),
        },
      },
      headers('refuse', 'made_up_code_zz', {
        'x-trustgate-attachments': 'total=2;scanned=1;not_inspected=1;blocked=0;made_up=4',
        'x-trustgate-memory': 'writes=1;blocked=1;made_up=9',
      })
    )!;
    expect(d.code).toBe('made_up_code_zz');
    const item = d.attachments!.items[0];
    expect(item.state).toBe('unknown');
    expect(item.rawState).toBe('quarantined_zz');
    expect(item.reason).toBe('made_up_reason_zz');
    expect(item.findings[0].category).toBe('zz.new');
    expect(d.memory!.items[0].reason).toBe('made_up_memory_reason_zz');
    expect(d.memory!.items[0].kind).toBe('made_up_kind_zz');
    expect(d.memoryCoverage).toBe('made_up_coverage_zz');
    expect(d.routePolicy!.reason).toBe('made_up_route_reason_zz');
  });

  it('wrongly typed blocks are ignored, not thrown on', () => {
    let d = decisionFrom(
      {
        trustgate: envelope('allow', undefined, { attachments: 'x', memory: [1], route_policy: 5 }),
      },
      undefined
    )!;
    expect(d.attachments).toBeUndefined();
    expect(d.memory).toBeUndefined();
    expect(d.routePolicy).toBeUndefined();
    d = decisionFrom(
      {
        trustgate: envelope('allow', undefined, {
          attachments: { total: 'two', items: ['x', null, { state: 3 }] },
        }),
      },
      undefined
    )!;
    expect(d.attachments!.total).toBe(0);
    expect(d.attachments!.items).toHaveLength(1);
    expect(d.attachments!.items[0].state).toBe('unknown');
    expect(d.attachments!.items[0].rawState).toBeUndefined();
  });

  it('garbage count headers are ignored', () => {
    const d = decisionFrom(
      undefined,
      headers('allow', undefined, {
        'x-trustgate-attachments': 'total=;scanned=x;;=3',
        'x-trustgate-memory': 'nonsense',
      })
    )!;
    expect(d.decision).toBe('allow');
    expect(d.attachments).toBeUndefined();
    expect(d.memory).toBeUndefined();
  });
});

describe('a decision serialises as it always did', () => {
  it('the same own keys, in the same order, and none of the new accessors', () => {
    const d = read('file_flagged');
    expect(Object.keys(d)).toEqual([
      'decision',
      'rawDecision',
      'code',
      'retryable',
      'id',
      'requestId',
      'traceId',
      'inspection',
      'versions',
      'message',
      'retryAfterMs',
      'altered',
      'carriers',
      'carrierDisagreement',
      'delivered',
      'isBlock',
      'isAltered',
      'unverified',
    ]);
    const json = JSON.parse(JSON.stringify(d));
    expect(json.delivered).toBe(true);
    expect(json.unverified).toBe(true);
    expect(json.attachments).toBeUndefined();
  });
});

describe('exceptions and isShashuBlock', () => {
  it('MemoryWriteBlocked is a ShashuPolicyViolation', () => {
    const e = new MemoryWriteBlocked('m', 403);
    expect(e).toBeInstanceOf(ShashuPolicyViolation);
    expect(e).toBeInstanceOf(MemoryWriteBlocked);
    expect(e.name).toBe('MemoryWriteBlocked');
  });

  it('isShashuBlock is unchanged for the new refusals', () => {
    for (const name of ['file_blocked', 'memory_blocked', 'route_blocked']) {
      expect(read(name).isBlock).toBe(false);
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

function serve(name: string) {
  const [status, body, hdrs] = SCENARIOS[name];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', ...hdrs },
        })
    )
  );
}

const REQ = { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) };
const client = () => new Shashu({ baseUrl: 'https://gw.example', apiKey: 'k', retryPolicy: null });

async function thrown(name: string): Promise<ShashuError> {
  serve(name);
  try {
    await client().fetch('/v1/chat/completions', REQ);
  } catch (err) {
    if (err instanceof ShashuError) return err;
    throw err;
  }
  throw new Error(`expected ${name} to throw`);
}

describe('wire e2e: the six responses through the real client', () => {
  it('no file', async () => {
    serve('no_file');
    const d = shashuDecision(await client().fetch('/v1/chat/completions', REQ))!;
    expect(d.decision).toBe('allow');
    expect(d.attachments).toBeUndefined();
    expect(d.memory).toBeUndefined();
    expect(d.routePolicy).toBeUndefined();
    expect([d.filesUnverified, d.filesBlocked, d.memoryBlocked]).toEqual([0, 0, 0]);
  });

  it('file flagged', async () => {
    serve('file_flagged');
    const d = shashuDecision(await client().fetch('/v1/chat/completions', REQ))!;
    expect(d.decision).toBe('not_checked');
    expect(d.attachments!.carrier).toBe('body');
    expect(d.filesUnverified).toBe(1);
    expect(d.attachments!.items.map((i) => i.state)).toEqual(['scanned', 'not_inspected']);
  });

  it('file blocked', async () => {
    const err = await thrown('file_blocked');
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect(err).not.toBeInstanceOf(MemoryWriteBlocked);
    expect(err.decision!.filesBlocked).toBe(1);
    expect(err.decision!.attachments!.items[0].reason).toBe('type_mismatch');
    expect(isShashuBlock(err)).toBe(false);
  });

  it('memory blocked', async () => {
    const err = await thrown('memory_blocked');
    expect(err).toBeInstanceOf(MemoryWriteBlocked);
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect(err.status).toBe(403);
    expect((err as MemoryWriteBlocked).memory!.items[0].reason).toBe('memory_sink_injection');
    expect(isShashuBlock(err)).toBe(false);
  });

  it('route_data_policy', async () => {
    const err = await thrown('route_blocked');
    expect(err).toBeInstanceOf(ShashuPolicyViolation);
    expect(err).not.toBeInstanceOf(MemoryWriteBlocked);
    expect(err.routePolicy!.route).toBe('general-chat');
    expect(err.routePolicy!.category).toBe('phi');
    expect(isShashuBlock(err)).toBe(false);
  });

  it('header only', async () => {
    serve('header_only');
    const d = shashuDecision(await client().fetch('/v1/chat/completions', REQ))!;
    expect(d.carriers).toEqual(['headers']);
    expect(d.attachments!.carrier).toBe('header');
    expect(d.memory!.carrier).toBe('header');
    expect(d.filesUnverified).toBe(2);
    expect(d.memoryRecallsFlagged).toBe(1);
  });
});
