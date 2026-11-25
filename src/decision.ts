/**
 * Reading the gateway's decision — the six outcomes, from both carriers.
 *
 * Every name in this module is taken from `contracts/decision-envelope.v1.md`,
 * this repository's vendored copy of the gateway's
 * `core/app/contract/envelope.py`. Nothing here is retyped from prose.
 *
 * **The one thing a client does is read `decision`.** Not the message, which is
 * prose and gets reworded; not `code`, whose vocabulary grows and which four
 * SDKs would each have to edit if any of them branched on a hardcoded copy.
 *
 * Three properties, in this order:
 *
 * 1. **Absence is today's behaviour.** A response carrying neither carrier
 *    yields `undefined` — not a synthesised `allow`, not a `fail`.
 * 2. **An unrecognised `decision` is a BLOCK.** The gateway's own
 *    `decision_of()` fails closed and the contract binds the client libraries
 *    identically. The wire value is preserved on `Decision.rawDecision`.
 * 3. **Both carriers are read, and a disagreement is reported.** The body is
 *    the richer copy and wins; `carrierDisagreement` names any field the two
 *    placements did not agree on rather than smoothing it away.
 *
 * The decision is NEVER attached by mutating a response dict. Python's
 * `_ResponseWithDecision` subclass leaked upward when that shape was tried
 * here, and a shared mutable carrier handed concurrent tasks each other's
 * documents. A `WeakMap` keyed by the `Response` object holds the read, so a
 * response that carried neither carrier is the same object it has always been.
 */

import { ShashuContentFilterError } from './exceptions.js';

export const DECISION_ALLOW = 'allow';
export const DECISION_ALLOW_ALTERED = 'allow_altered';
export const DECISION_NOT_CHECKED = 'not_checked';
export const DECISION_BLOCK = 'block';
export const DECISION_REFUSE = 'refuse';
export const DECISION_FAIL = 'fail';

/** Every decision the wire may carry, in the contract's card order. */
export const DECISIONS = [
  DECISION_ALLOW,
  DECISION_ALLOW_ALTERED,
  DECISION_NOT_CHECKED,
  DECISION_BLOCK,
  DECISION_REFUSE,
  DECISION_FAIL,
] as const;

export type DecisionValue = (typeof DECISIONS)[number];

/** The three where the caller is holding the provider's content. */
export const DELIVERED_DECISIONS: ReadonlySet<string> = new Set([
  DECISION_ALLOW,
  DECISION_ALLOW_ALTERED,
  DECISION_NOT_CHECKED,
]);

/** Top-level on a 200 body; nested INSIDE `error` on an error body. */
export const BODY_KEY = 'shashu';

export const HEADER_DECISION = 'x-shashu-decision';
export const HEADER_CODE = 'x-shashu-code';
export const HEADER_INSPECTION = 'x-shashu-inspection';
export const HEADER_SHOULD_RETRY = 'x-should-retry';
export const HEADER_REQUEST_ID = 'x-request-id';
export const HEADER_SHASHU_REQUEST_ID = 'x-shashu-request-id';
export const HEADER_TRACE_ID = 'x-shashu-trace-id';
/** Counts only (`total=N;scanned=N;not_inspected=N;blocked=N`), only when one is above zero. */
export const HEADER_ATTACHMENTS = 'x-shashu-attachments';
/** Counts only (`writes=N;blocked=N;recalls=N;flagged=N`), only when one is above zero. */
export const HEADER_MEMORY = 'x-shashu-memory';

/**
 * What happened to one attached file. A closed set on the gateway; a value
 * this SDK does not know arrives as `"unknown"`, with the wire string kept on
 * `Attachment.rawState` — never thrown on.
 */
export type AttachmentState =
  'scanned' | 'scanned_partial' | 'not_inspected' | 'blocked' | 'unknown';

const ATTACHMENT_STATES: ReadonlySet<string> = new Set([
  'scanned',
  'scanned_partial',
  'not_inspected',
  'blocked',
]);

/** One finding inside a file. `detector` and `category` are open sets. */
export interface AttachmentFinding {
  readonly detector: string | undefined;
  readonly category: string | undefined;
  /** The finding's reason code, passed through raw. Never branch on it. */
  readonly code: string | undefined;
  readonly severity: string | undefined;
  readonly locator: string | undefined;
}

/** One attached file, as the gateway reported it. */
export interface Attachment {
  readonly state: AttachmentState;
  /** The verbatim wire value of `state`, known or not. */
  readonly rawState: string | undefined;
  /** Passed through raw: a reason this SDK has never heard of is still a string. */
  readonly reason: string | undefined;
  readonly filename: string | undefined;
  readonly declaredType: string | undefined;
  readonly sniffedType: string | undefined;
  readonly sha256: string | undefined;
  readonly bytes: number | undefined;
  readonly source: string | undefined;
  readonly index: number | undefined;
  readonly path: string | undefined;
  readonly findings: readonly AttachmentFinding[];
}

/** The `attachments` block, or its header counts when that is all there is. */
export interface Attachments {
  readonly total: number;
  readonly scanned: number;
  readonly scannedPartial: number;
  readonly notInspected: number;
  readonly blocked: number;
  /** Empty when read off the header, which never carries per-file detail. */
  readonly items: readonly Attachment[];
  /** Which placement these came from. */
  readonly carrier: 'body' | 'header';
}

/** One memory write or recall. Every field is passed through raw. */
export interface MemoryItem {
  /** `write` or `recall` today; a new kind is still just a string. */
  readonly kind: string | undefined;
  readonly state: string | undefined;
  readonly reason: string | undefined;
  readonly tool: string | undefined;
  readonly store: string | undefined;
  readonly scope: string | undefined;
  readonly source: string | undefined;
  readonly enforcement: string | undefined;
  readonly memoryRef: string | undefined;
  readonly writeRef: string | undefined;
  readonly seenBefore: boolean | undefined;
}

/** The `memory` block, or its header counts when that is all there is. */
export interface MemoryActivity {
  readonly writes: number;
  readonly writesBlocked: number;
  readonly recalls: number;
  readonly recallsFlagged: number;
  /** `gateway` / `observed` / `hosted` / `mixed`, raw; undefined off a header. */
  readonly coverage: string | undefined;
  readonly items: readonly MemoryItem[];
  readonly carrier: 'body' | 'header';
}

/** Why a route was refused for the data in the request. */
export interface RoutePolicy {
  readonly route: string | undefined;
  readonly category: string | undefined;
  readonly reason: string | undefined;
  readonly requestedRoute: string | undefined;
  readonly degradedRoute: string | undefined;
}

export interface Decision {
  /** One of `DECISIONS`. An unrecognised wire value arrives here as `"block"`. */
  readonly decision: string;
  /** The verbatim wire value, whether or not it was recognised. */
  readonly rawDecision: string | undefined;
  /** The reason code. **Never branch on it** — the vocabulary grows. */
  readonly code: string | undefined;
  readonly retryable: boolean;
  /** Resolves to the stored audit record. Same value as `x-request-id`. */
  readonly id: string | undefined;
  /** The per-hop request id (`x-shashu-request-id`), or undefined. */
  readonly requestId: string | undefined;
  /** The flow's trace id — the same value as `id`, under its own name. */
  readonly traceId: string | undefined;
  readonly inspection: Record<string, unknown> | undefined;
  readonly versions: Record<string, string> | undefined;
  /** Prose. Present so it can be logged, never so it can be parsed. */
  readonly message: string | undefined;
  readonly retryAfterMs: number | undefined;
  /** Counts of what policy edited. Present only on `allow_altered`. */
  readonly altered: Record<string, unknown> | undefined;
  /** `"body"`, `"headers"`, or both. */
  readonly carriers: readonly string[];
  /** `{field: [bodyValue, headerValue]}` for anything the two disagreed on. */
  readonly carrierDisagreement: Record<string, [unknown, unknown]>;
  /**
   * What happened to each attached file; undefined when the request had none.
   * Read off the body; off the `x-shashu-attachments` counts when the body
   * carried no envelope. `attachments.carrier` says which.
   */
  readonly attachments: Attachments | undefined;
  /** Memory writes and recalls; undefined when there were none. Same carrier rule. */
  readonly memory: MemoryActivity | undefined;
  /** Why a route was refused for the data in the request. Body only. */
  readonly routePolicy: RoutePolicy | undefined;
  /** Files the model received without a complete inspection. */
  readonly filesUnverified: number;
  readonly filesBlocked: number;
  /** Memory writes the gateway refused to store. */
  readonly memoryBlocked: number;
  readonly memoryRecallsFlagged: number;
  readonly memoryCoverage: string | undefined;
  readonly delivered: boolean;
  readonly isBlock: boolean;
  readonly isAltered: boolean;
  readonly unverified: boolean;
}

const carried = new WeakMap<object, Decision>();

/** Attach a decision to a Response (or similar) without mutating it. */
export function rememberDecision(obj: object, decision: Decision): void {
  carried.set(obj, decision);
}

function coerceDecision(raw: unknown): string {
  if (typeof raw === 'string' && (DECISIONS as readonly string[]).includes(raw)) {
    return raw;
  }
  return DECISION_BLOCK;
}

function parseInspectionHeader(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const out: Record<string, unknown> = {};
  const detectors: Record<string, string> = {};
  for (const part of value.split(';')) {
    if (!part.includes('=')) continue;
    const eq = part.indexOf('=');
    const name = part.slice(0, eq).trim();
    const state = part.slice(eq + 1).trim();
    if (name === 'input' || name === 'output' || name === 'reason') out[name] = state;
    else if (name) detectors[name] = state;
  }
  if (Object.keys(detectors).length) out.detectors = detectors;
  return Object.keys(out).length ? out : undefined;
}

function headerGet(headers: unknown, name: string): string | undefined {
  if (headers == null) return undefined;
  try {
    if (typeof (headers as Headers).get === 'function') {
      const v = (headers as Headers).get(name);
      return v == null ? undefined : v;
    }
    const rec = headers as Record<string, unknown>;
    const direct = rec[name];
    if (typeof direct === 'string') return direct;
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(rec)) {
      if (k.toLowerCase() === lower && typeof v === 'string') return v;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function fromBody(body: unknown): Record<string, unknown> | undefined {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const rec = body as Record<string, unknown>;
  const top = rec[BODY_KEY];
  if (top != null && typeof top === 'object' && !Array.isArray(top)) {
    return top as Record<string, unknown>;
  }
  const err = rec.error;
  if (err != null && typeof err === 'object' && !Array.isArray(err)) {
    const nested = (err as Record<string, unknown>)[BODY_KEY];
    if (nested != null && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return undefined;
}

function fromHeaders(headers: unknown): Record<string, unknown> | undefined {
  const raw = headerGet(headers, HEADER_DECISION);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const env: Record<string, unknown> = { decision: raw.trim() };
  const code = headerGet(headers, HEADER_CODE);
  if (typeof code === 'string' && code.trim()) env.code = code.trim();
  const recordId = headerGet(headers, HEADER_REQUEST_ID);
  if (typeof recordId === 'string' && recordId.trim()) env.id = recordId.trim();
  const hopId = headerGet(headers, HEADER_SHASHU_REQUEST_ID);
  if (typeof hopId === 'string' && hopId.trim()) env.request_id = hopId.trim();
  const trace = headerGet(headers, HEADER_TRACE_ID);
  if (typeof trace === 'string' && trace.trim()) env.trace_id = trace.trim();
  const shouldRetry = headerGet(headers, HEADER_SHOULD_RETRY);
  if (typeof shouldRetry === 'string') env.retryable = shouldRetry.trim().toLowerCase() === 'true';
  const inspection = parseInspectionHeader(headerGet(headers, HEADER_INSPECTION));
  if (inspection) env.inspection = inspection;
  return env;
}

const SHARED_FIELDS = ['decision', 'code', 'id', 'retryable'] as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) ? v : undefined;
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);
const records = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isRecord) : [];

function readAttachment(item: Record<string, unknown>): Attachment {
  const rawState = str(item.state);
  return Object.freeze({
    state: (rawState !== undefined && ATTACHMENT_STATES.has(rawState)
      ? rawState
      : 'unknown') as AttachmentState,
    rawState,
    reason: str(item.reason),
    filename: str(item.filename),
    declaredType: str(item.declared_type),
    sniffedType: str(item.sniffed_type),
    sha256: str(item.sha256),
    bytes: int(item.bytes),
    source: str(item.source),
    index: int(item.index),
    path: str(item.path),
    findings: Object.freeze(
      records(item.findings).map((f) =>
        Object.freeze({
          detector: str(f.detector),
          category: str(f.category),
          code: str(f.code),
          severity: str(f.severity),
          locator: str(f.locator),
        })
      )
    ),
  });
}

function attachmentsFromBody(block: unknown): Attachments | undefined {
  if (!isRecord(block)) return undefined;
  return Object.freeze({
    total: count(block.total),
    scanned: count(block.scanned),
    scannedPartial: count(block.scanned_partial),
    notInspected: count(block.not_inspected),
    blocked: count(block.blocked),
    items: Object.freeze(records(block.items).map(readAttachment)),
    carrier: 'body' as const,
  });
}

function memoryFromBody(block: unknown): MemoryActivity | undefined {
  if (!isRecord(block)) return undefined;
  return Object.freeze({
    writes: count(block.writes),
    writesBlocked: count(block.writes_blocked),
    recalls: count(block.recalls),
    recallsFlagged: count(block.recalls_flagged),
    coverage: str(block.coverage),
    items: Object.freeze(
      records(block.items).map((i) =>
        Object.freeze({
          kind: str(i.kind),
          state: str(i.state),
          reason: str(i.reason),
          tool: str(i.tool),
          store: str(i.store),
          scope: str(i.scope),
          source: str(i.source),
          enforcement: str(i.enforcement),
          memoryRef: str(i.memory_ref),
          writeRef: str(i.write_ref),
          seenBefore: typeof i.seen_before === 'boolean' ? i.seen_before : undefined,
        })
      )
    ),
    carrier: 'body' as const,
  });
}

function routePolicyFromBody(block: unknown): RoutePolicy | undefined {
  if (!isRecord(block)) return undefined;
  return Object.freeze({
    route: str(block.route),
    category: str(block.category),
    reason: str(block.reason),
    requestedRoute: str(block.requested_route),
    degradedRoute: str(block.degraded_route),
  });
}

/** `a=1;b=2` -> `{a: 1, b: 2}`; unknown names kept, junk dropped. */
function countsHeader(value: string | undefined): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  const out: Record<string, number> = {};
  let any = false;
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const n = part.slice(eq + 1).trim();
    if (name && /^[0-9]+$/.test(n)) {
      out[name] = Number(n);
      any = true;
    }
  }
  return any ? out : undefined;
}

function attachmentsFromHeader(value: string | undefined): Attachments | undefined {
  const c = countsHeader(value);
  if (!c) return undefined;
  const total = c.total ?? 0;
  const scanned = c.scanned ?? 0;
  const notInspected = c.not_inspected ?? 0;
  const blocked = c.blocked ?? 0;
  return Object.freeze({
    total,
    scanned,
    // The header does not carry it. The four states partition `total`, so the
    // remainder is scanned_partial — which errs, if the header is ever wrong,
    // toward counting a file as unverified rather than as checked.
    scannedPartial: Math.max(0, total - scanned - notInspected - blocked),
    notInspected,
    blocked,
    items: Object.freeze([]) as readonly Attachment[],
    carrier: 'header' as const,
  });
}

function memoryFromHeader(value: string | undefined): MemoryActivity | undefined {
  const c = countsHeader(value);
  if (!c) return undefined;
  return Object.freeze({
    writes: c.writes ?? 0,
    writesBlocked: c.blocked ?? 0,
    recalls: c.recalls ?? 0,
    recallsFlagged: c.flagged ?? 0,
    coverage: undefined,
    items: Object.freeze([]) as readonly MemoryItem[],
    carrier: 'header' as const,
  });
}

/**
 * Where the file / memory / route blocks come from: the body envelope, or the
 * raw headers when the body carried none. Parsed on FIRST READ, not on every
 * parse, so a response that never had a file — nearly every response — and a
 * caller who never asks both pay nothing for it.
 */
type BlockSource = { body: Record<string, unknown> } | { headers: unknown } | undefined;

function blockSource(bodyEnv: Record<string, unknown> | undefined, headers: unknown): BlockSource {
  if (bodyEnv != null) {
    return 'attachments' in bodyEnv || 'memory' in bodyEnv || 'route_policy' in bodyEnv
      ? { body: bodyEnv }
      : undefined;
  }
  return headers != null ? { headers } : undefined;
}

type DecisionFields = {
  decision: string;
  rawDecision: string | undefined;
  code: string | undefined;
  retryable: boolean;
  id: string | undefined;
  requestId: string | undefined;
  traceId: string | undefined;
  inspection: Record<string, unknown> | undefined;
  versions: Record<string, string> | undefined;
  message: string | undefined;
  retryAfterMs: number | undefined;
  altered: Record<string, unknown> | undefined;
  carriers: readonly string[];
  carrierDisagreement: Record<string, [unknown, unknown]>;
};

const SOURCE = Symbol('trustgate.decision.blocks');
const ATTACHMENTS = Symbol('trustgate.decision.attachments');
const MEMORY = Symbol('trustgate.decision.memory');
const UNREAD = Symbol('trustgate.decision.unread');

/**
 * One decision. A class, not an object literal with getters: a literal pays
 * for every getter it declares on every parse (~0.5 µs measured on Node 24),
 * a class pays once. The four predicates are computed at construction as
 * plain values, so a decision's keys and its JSON are exactly what the
 * literal produced. The file / memory / route accessors live on the
 * prototype and parse their block on first read; the source sits under a
 * symbol, which neither `Object.keys` nor `JSON.stringify` sees.
 */
class DecisionRecord implements Decision {
  readonly decision: string;
  readonly rawDecision: string | undefined;
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly id: string | undefined;
  readonly requestId: string | undefined;
  readonly traceId: string | undefined;
  readonly inspection: Record<string, unknown> | undefined;
  readonly versions: Record<string, string> | undefined;
  readonly message: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly altered: Record<string, unknown> | undefined;
  readonly carriers: readonly string[];
  readonly carrierDisagreement: Record<string, [unknown, unknown]>;
  readonly delivered: boolean;
  readonly isBlock: boolean;
  readonly isAltered: boolean;
  readonly unverified: boolean;
  private readonly [SOURCE]: BlockSource;
  private [ATTACHMENTS]: Attachments | undefined | typeof UNREAD = UNREAD;
  private [MEMORY]: MemoryActivity | undefined | typeof UNREAD = UNREAD;

  constructor(f: DecisionFields, source: BlockSource) {
    this.decision = f.decision;
    this.rawDecision = f.rawDecision;
    this.code = f.code;
    this.retryable = f.retryable;
    this.id = f.id;
    this.requestId = f.requestId;
    this.traceId = f.traceId;
    this.inspection = f.inspection;
    this.versions = f.versions;
    this.message = f.message;
    this.retryAfterMs = f.retryAfterMs;
    this.altered = f.altered;
    this.carriers = f.carriers;
    this.carrierDisagreement = f.carrierDisagreement;
    this.delivered = DELIVERED_DECISIONS.has(f.decision);
    this.isBlock = f.decision === DECISION_BLOCK;
    this.isAltered = f.decision === DECISION_ALLOW_ALTERED;
    this.unverified = f.decision === DECISION_NOT_CHECKED;
    this[SOURCE] = source;
  }

  get attachments(): Attachments | undefined {
    if (this[ATTACHMENTS] === UNREAD) {
      const src = this[SOURCE];
      this[ATTACHMENTS] =
        src === undefined
          ? undefined
          : 'body' in src
            ? attachmentsFromBody(src.body.attachments)
            : attachmentsFromHeader(headerGet(src.headers, HEADER_ATTACHMENTS));
    }
    return this[ATTACHMENTS];
  }

  get memory(): MemoryActivity | undefined {
    if (this[MEMORY] === UNREAD) {
      const src = this[SOURCE];
      this[MEMORY] =
        src === undefined
          ? undefined
          : 'body' in src
            ? memoryFromBody(src.body.memory)
            : memoryFromHeader(headerGet(src.headers, HEADER_MEMORY));
    }
    return this[MEMORY];
  }

  get routePolicy(): RoutePolicy | undefined {
    const src = this[SOURCE];
    return src !== undefined && 'body' in src
      ? routePolicyFromBody(src.body.route_policy)
      : undefined;
  }

  get filesUnverified(): number {
    const a = this.attachments;
    return a ? a.notInspected + a.scannedPartial : 0;
  }

  get filesBlocked(): number {
    return this.attachments?.blocked ?? 0;
  }

  get memoryBlocked(): number {
    return this.memory?.writesBlocked ?? 0;
  }

  get memoryRecallsFlagged(): number {
    return this.memory?.recallsFlagged ?? 0;
  }

  get memoryCoverage(): string | undefined {
    return this.memory?.coverage;
  }
}

function makeDecision(fields: DecisionFields, source: BlockSource): Decision {
  return new DecisionRecord(fields, source);
}

function build(
  bodyEnv: Record<string, unknown> | undefined,
  headerEnv: Record<string, unknown> | undefined,
  headers?: unknown
): Decision | undefined {
  if (bodyEnv == null && headerEnv == null) return undefined;
  const carriers = [
    ...(bodyEnv != null ? ['body'] : []),
    ...(headerEnv != null ? ['headers'] : []),
  ];
  const merged: Record<string, unknown> = { ...(headerEnv ?? {}), ...(bodyEnv ?? {}) };
  const disagreement: Record<string, [unknown, unknown]> = {};
  if (bodyEnv != null && headerEnv != null) {
    for (const name of SHARED_FIELDS) {
      if (name in bodyEnv && name in headerEnv && bodyEnv[name] !== headerEnv[name]) {
        disagreement[name] = [bodyEnv[name], headerEnv[name]];
      }
    }
  }
  const raw = merged.decision;
  const retryAfterMs = merged.retry_after_ms;
  const versions = merged.versions;
  return makeDecision(
    {
      decision: coerceDecision(raw),
      rawDecision: typeof raw === 'string' ? raw : undefined,
      code: typeof merged.code === 'string' ? merged.code : undefined,
      retryable: Boolean(merged.retryable),
      id: typeof merged.id === 'string' ? merged.id : undefined,
      requestId: typeof merged.request_id === 'string' ? merged.request_id : undefined,
      traceId:
        typeof merged.trace_id === 'string'
          ? merged.trace_id
          : typeof merged.id === 'string'
            ? merged.id
            : undefined,
      inspection:
        merged.inspection != null &&
        typeof merged.inspection === 'object' &&
        !Array.isArray(merged.inspection)
          ? (merged.inspection as Record<string, unknown>)
          : undefined,
      versions:
        versions != null && typeof versions === 'object' && !Array.isArray(versions)
          ? (versions as Record<string, string>)
          : undefined,
      message: typeof merged.message === 'string' ? merged.message : undefined,
      retryAfterMs: typeof retryAfterMs === 'number' ? retryAfterMs : undefined,
      altered:
        merged.altered != null &&
        typeof merged.altered === 'object' &&
        !Array.isArray(merged.altered)
          ? (merged.altered as Record<string, unknown>)
          : undefined,
      carriers,
      carrierDisagreement: disagreement,
    },
    blockSource(bodyEnv, headers)
  );
}

/**
 * The decision carried by a parsed body and a headers mapping, or `undefined`.
 *
 * Either argument may be absent. Absence in both is `undefined`, never a
 * synthesised `allow`.
 */
export function decisionFrom(body: unknown, headers: unknown): Decision | undefined {
  return build(fromBody(body), fromHeaders(headers), headers);
}

/**
 * Read both carriers off a `Response` without consuming the caller's body.
 */
export async function decisionFromResponse(response: Response): Promise<Decision | undefined> {
  let body: unknown;
  try {
    const ct = response.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) body = await response.clone().json();
  } catch {
    body = undefined;
  }
  return decisionFrom(body, response.headers);
}

const BODY_ATTRIBUTES = ['response_body', 'body'] as const;

function parsedBodyEnvelope(obj: unknown): Record<string, unknown> | undefined {
  if (obj == null || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const attribute of BODY_ATTRIBUTES) {
    const found = fromBody(rec[attribute]);
    if (found) return found;
  }
  return undefined;
}

/**
 * The gateway's decision about a request, or `undefined` if it did not say one.
 *
 * Give it a `Response`, a parsed body, or an error. Never throws. Anything it
 * cannot read is `undefined`.
 */
export function shashuDecision(obj: unknown): Decision | undefined {
  try {
    if (obj == null) return undefined;
    if (typeof obj === 'object') {
      const remembered = carried.get(obj);
      if (remembered) return remembered;
      const cached = (obj as { decision?: unknown }).decision;
      if (cached && typeof cached === 'object' && cached !== null && 'decision' in cached) {
        return cached as Decision;
      }
      if (obj instanceof Response) {
        return build(undefined, fromHeaders(obj.headers), obj.headers);
      }
      if (!Array.isArray(obj)) {
        const bodyEnv = fromBody(obj) ?? parsedBodyEnvelope(obj);
        const headers =
          (obj as { responseHeaders?: unknown }).responseHeaders ??
          (obj as { headers?: unknown }).headers ??
          ((obj as { response?: { headers?: unknown } }).response ?? {}).headers;
        return build(bodyEnv, fromHeaders(headers), headers);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * True when `err` is Shashu blocking content. Inspects; changes nothing.
 *
 * It patches nothing, wraps nothing and replaces nothing.
 *
 * **It FAILS CLOSED, and that is the opposite direction to
 * {@link raiseForResponse}. Both are correct, because they are answering
 * different questions:**
 *
 * - `raiseForResponse` decides whether to REPLACE a provider's own error with
 *   a Shashu type. Turning a genuine provider 400 into a fake block would
 *   break `catch` clauses a customer already has, so it needs a positive
 *   signal to act and fails OPEN as to block-ness — silence leaves the
 *   provider's error alone.
 * - `isShashuBlock` is called on an error the customer already holds and
 *   replaces nothing. The cost of a wrong answer is asymmetric: calling a
 *   block "not a block" sends blocked content down a path that assumes it was
 *   delivered, while calling a non-block a block costs one unnecessary trip
 *   through a review branch. So a Shashu block signal we cannot fully
 *   parse — an unrecognised `decision`, an unrecognised `code` — answers true.
 *
 * **There is no copy of the block-code list here, deliberately.** `code` is a
 * growing vocabulary; block-ness is carried by `decision` and by nothing else.
 *
 * @see raiseForResponse — the matching fail-open statement, on the function
 *      that replaces.
 */
export function isShashuBlock(err: unknown): boolean {
  try {
    const found = shashuDecision(err);
    if (found != null) return found.isBlock;

    if (err instanceof ShashuContentFilterError) return true;

    if (err != null && typeof err === 'object') {
      for (const attribute of BODY_ATTRIBUTES) {
        const body = (err as Record<string, unknown>)[attribute];
        if (body == null || typeof body !== 'object') continue;
        const rec = body as Record<string, unknown>;
        for (const candidate of [rec, rec.error]) {
          if (
            candidate != null &&
            typeof candidate === 'object' &&
            (candidate as Record<string, unknown>).type === 'content_filter'
          ) {
            return true;
          }
        }
        const choices = rec.choices;
        if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
          if ((choices[0] as { finish_reason?: unknown }).finish_reason === 'content_filter') {
            return true;
          }
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}
