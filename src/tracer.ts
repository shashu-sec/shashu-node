import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDisabled, optionalBaseUrl, envGet, API_KEY_ENV, API_KEY_ENV_LEGACY } from './config.js';

// Types
export interface SpanContext {
  traceId: string;
  spanId: string;
  parentId?: string;
}

export interface SpanData {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  start_time: number; // Unix timestamp (seconds)
  end_time: number;
  duration: number;
  metadata?: Record<string, unknown>;
}

// Global Context Storage
const spanStorage = new AsyncLocalStorage<SpanContext>();

/**
 * Captured inbound A2A flow (WP-A2A-4 / ADR-007 §0, §4.1). When this agent is SERVING
 * a request, captureIncoming() stores the inbound flow here so a downstream gateway call
 * made through the SDK PROPAGATES the same flow (trace + session + hop + caller lineage)
 * instead of minting a fresh one. Held in its own AsyncLocalStorage so it composes with —
 * but is independent of — span context. Absent store ⇒ origin (non-A2A behavior unchanged).
 */
export interface A2ACapture {
  /** The flow id, propagated unchanged on the outbound gateway call. */
  traceId: string;
  /** The captured inbound session id, if any. */
  sessionId?: string;
  /** Advisory inbound hop depth from x-trustgate-hop-depth (0 if absent). */
  inboundHopDepth: number;
  /** The upstream agent that INVOKED this hop (x-trustgate-caller-agent-id), FORWARDED
   *  on the outbound gateway call — never this agent's own id (§4.1). */
  inboundCallerAgentId?: string;
}

const a2aStorage = new AsyncLocalStorage<A2ACapture | undefined>();

/** Lowercase-keyed string map from any headers shape (plain object, Headers, Map, or
 *  array of pairs). Tolerant + never throws so inbound capture can't break a request. */
function coerceHeaderMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  try {
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && pair.length >= 2 && pair[0] != null) {
          out[String(pair[0]).toLowerCase()] = String(pair[1]);
        }
      }
      return out;
    }
    if (headers instanceof Map) {
      for (const [k, v] of headers) out[String(k).toLowerCase()] = String(v);
      return out;
    }
    // Web Headers (and other forEach-iterables of (value, key)).
    if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
      (headers as { forEach: (cb: (v: unknown, k: unknown) => void) => void }).forEach((v, k) => {
        if (k != null) out[String(k).toLowerCase()] = String(v);
      });
      return out;
    }
    if (typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        if (v !== undefined && v !== null) out[k.toLowerCase()] = String(v);
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** Inbound hop depth as a non-negative int; 0 on absent/garbage. Advisory — the gateway
 *  recounts authoritatively from its a2a:hop:{traceId} counter. */
function parseHopDepth(raw: unknown): number {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Build the capture record from a header map; null when no inbound trace (origin). */
function captureFromHeaders(h: Record<string, string>): A2ACapture | undefined {
  const trace = (h['x-trustgate-trace-id'] ?? '').trim();
  if (!trace) return undefined;
  const session = (h['x-trustgate-session-id'] ?? '').trim();
  const caller = (h['x-trustgate-caller-agent-id'] ?? '').trim();
  return {
    traceId: trace,
    sessionId: session || undefined,
    inboundHopDepth: parseHopDepth(h['x-trustgate-hop-depth']),
    inboundCallerAgentId: caller || undefined,
  };
}

class Tracer {
  private buffer: SpanData[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private _gatewayUrl?: string;
  private _apiKey?: string;

  /**
   * Resolves the address OPTIONALLY, unlike every other entry point.
   *
   * The module exports a singleton (`export const tracer = new Tracer()`), so
   * this constructor runs on `import "@shashu-ai/sdk"`. Throwing here would
   * make importing the SDK fail for anyone who has not set the variable, which
   * is a far worse failure than the one this is fixing. Instead the address
   * stays undefined and {@link flush} posts nothing — the same shape as the
   * Python SDK's telemetry path, which resolves with optional_base_url and
   * no-ops the flush.
   */
  constructor() {
    this._gatewayUrl = optionalBaseUrl();
    this._apiKey = envGet(API_KEY_ENV, API_KEY_ENV_LEGACY);
  }

  /**
   * Current gateway base URL (respects configure()), or undefined when none is
   * configured. Undefined means telemetry is not sent — never a default host.
   */
  public get gatewayUrl(): string | undefined {
    return this._gatewayUrl;
  }

  /** Current API key (respects configure()). */
  public get apiKey(): string | undefined {
    return this._apiKey;
  }

  /**
   * Update gateway URL and/or API key at runtime (e.g. for scripts switching agents).
   * baseUrl has its trailing slash stripped to match constructor behavior.
   */
  public configure(opts: { baseUrl?: string; apiKey?: string }): void {
    if (opts.baseUrl !== undefined) {
      this._gatewayUrl = opts.baseUrl.replace(/\/$/, '');
    }
    if (opts.apiKey !== undefined) {
      this._apiKey = opts.apiKey;
    }
  }

  // --- Context Accessors ---

  public get traceId(): string | undefined {
    // A span trace wins (it inherits any captured trace); otherwise the captured
    // mid-flow trace, so a downstream gateway call propagates the flow even with no span.
    return spanStorage.getStore()?.traceId ?? a2aStorage.getStore()?.traceId;
  }

  public get currentSpanId(): string | undefined {
    const store = spanStorage.getStore();
    return store?.spanId;
  }

  /** The current span's PARENT span id; undefined at origin or for a root span. */
  public get parentSpanId(): string | undefined {
    const store = spanStorage.getStore();
    return store?.parentId;
  }

  public get isActive(): boolean {
    return !!spanStorage.getStore();
  }

  // --- A2A inbound-capture + outbound propagation (ADR-007 §0, §4.1 locked) ---

  /** True when this context CAPTURED an inbound flow — so a downstream gateway call
   *  PROPAGATES the trace and attaches caller/session/hop lineage rather than originate
   *  a new flow. False = origin (header set unchanged). */
  public get isA2aHop(): boolean {
    const s = a2aStorage.getStore();
    return !!(s && s.traceId);
  }

  /** The captured inbound session id, or undefined when none was propagated. */
  public get sessionId(): string | undefined {
    return a2aStorage.getStore()?.sessionId || undefined;
  }

  /** Advisory inbound hop depth captured from x-trustgate-hop-depth (0 if absent). */
  public get inboundHopDepth(): number {
    return a2aStorage.getStore()?.inboundHopDepth ?? 0;
  }

  /** Hop depth to advertise on the next downstream call = inbound + 1 (advisory; the
   *  gateway recounts authoritatively). */
  public get outboundHopDepth(): number {
    return this.inboundHopDepth + 1;
  }

  /** The captured inbound x-trustgate-caller-agent-id — the upstream agent that INVOKED
   *  this hop. The SDK FORWARDS this on the outbound gateway call so the gateway records
   *  the real (invoker -> this agent) edge, NEVER this agent's own id (§4.1). undefined at
   *  origin / caller-stripped. */
  public get inboundCallerAgentId(): string | undefined {
    return a2aStorage.getStore()?.inboundCallerAgentId || undefined;
  }

  /**
   * Capture an inbound flow from the headers of a request this agent is SERVING into the
   * AsyncLocalStorage store, so a downstream call made through the SDK propagates the SAME
   * flow (WP-A2A-4 / ADR-007 §0). Reads (case-insensitively) x-trustgate-trace-id (the flow
   * id), -session-id, -hop-depth, and -caller-agent-id (the upstream INVOKER). The captured
   * trace is PROPAGATED on the next outbound call (never re-minted); the session, inbound hop
   * depth, and inbound caller ride along — the caller is FORWARDED on the gateway call (§4.1),
   * never replaced by self.
   *
   * Uses enterWith, so the capture persists for the remainder of the current async execution
   * (one-shot, for a script serving a single inbound call). Servers handling many requests
   * should prefer {@link incoming} so one flow's lineage never leaks into the next. No inbound
   * trace ⇒ origin: the ambient capture is cleared and false is returned (non-A2A unaffected).
   * Never throws — telemetry must not break a request.
   */
  public captureIncoming(headers: unknown): boolean {
    const capture = captureFromHeaders(coerceHeaderMap(headers));
    a2aStorage.enterWith(capture); // undefined => origin (clears any ambient capture)
    return capture !== undefined;
  }

  /**
   * Scoped inbound capture: capture for the duration of serving ONE request, then restore
   * the prior context on exit — so a long-lived worker does not leak one flow's lineage into
   * the next. Prefer this in servers; {@link captureIncoming} is the one-shot for scripts.
   *
   * @example
   *   await tracer.incoming(req.headers, async () => {
   *     await tg.fetch("/v1/chat/completions", { ... }); // propagates the captured flow
   *   });
   */
  public incoming<T>(headers: unknown, callback: () => T): T {
    const capture = captureFromHeaders(coerceHeaderMap(headers));
    return a2aStorage.run(capture, callback);
  }

  // --- Main Logic ---

  /**
   * Wraps a callback in a new Span Context.
   * Automatically handles Header injection for any internal calls.
   */
  public async span<T>(
    name: string,
    callback: (spanId: string) => Promise<T>,
    metadata?: Record<string, unknown>
  ): Promise<T> {
    const parent = spanStorage.getStore();

    // Resolve Context. A span inside a captured A2A flow inherits the captured trace so
    // the flow stays one lineage (parity with the Python reference).
    const traceId = parent?.traceId ?? a2aStorage.getStore()?.traceId ?? randomUUID();
    const spanId = randomUUID();
    const parentId = parent?.spanId;

    const context: SpanContext = { traceId, spanId, parentId };

    const startTime = Date.now() / 1000; // Seconds

    // Run callback within context
    try {
      return await spanStorage.run(context, async () => {
        return await callback(spanId);
      });
    } finally {
      // Record Span
      const endTime = Date.now() / 1000;
      this.record({
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentId,
        name,
        start_time: startTime,
        end_time: endTime,
        duration: endTime - startTime,
        metadata,
      });
    }
  }

  // --- Telemetry Transport ---

  private record(span: SpanData) {
    // Buffering is gated too, not just the flush: with the SDK switched off
    // nothing drains the buffer, so appending would grow it for the life of the
    // process. Span context (AsyncLocalStorage, in span()) is still maintained,
    // so a disabled SDK does not break an app that reads tracer.traceId.
    if (isDisabled()) return;
    this.buffer.push(span);
    if (this.buffer.length >= 10) {
      this.flush();
    } else if (!this.flushTimer) {
      // Auto-flush after 1 second if not full
      this.flushTimer = setTimeout(() => this.flush(), 1000);
      this.flushTimer.unref(); // Don't block process exit
    }
  }

  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // No address configured -> nothing is sent. There is no default host to
    // post span telemetry to, and a disabled SDK sends nothing at all.
    if (isDisabled()) return;
    if (this.buffer.length === 0 || !this._apiKey || !this._gatewayUrl) return;

    const batch = [...this.buffer];
    this.buffer = [];

    try {
      // Fire and forget fetch
      await fetch(`${this._gatewayUrl}/api/telemetry/spans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify(batch),
      });
    } catch {
      // Silently fail to avoid crashing app
    }
  }
}

export const tracer = new Tracer();

/**
 * Module-level convenience for {@link Tracer.captureIncoming} on the global tracer
 * (WP-A2A-4 / ADR-007 §0). Call at the start of serving an inbound request so a
 * downstream call made through the SDK propagates the same flow:
 *
 *   import { captureIncoming } from "@shashu-ai/sdk";
 *   captureIncoming(req.headers);            // this agent is now mid-flow
 *   await tg.fetch("/v1/chat/completions", { ... }); // propagates trace + lineage
 *
 * Returns true if a trace was captured (mid-flow hop), false at origin.
 */
export function captureIncoming(headers: unknown): boolean {
  return tracer.captureIncoming(headers);
}
