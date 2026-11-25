/**
 * Join the carried retrieval declaration onto the outgoing request.
 *
 * The Python SDK patches its own httpx transport, so it sees every outgoing
 * request whoever made it. Node has no such chokepoint: our own client owns its
 * `fetch`, and the middlewares only RETURN a config object the customer hands to
 * THEIR SDK. What makes this work is that the OpenAI, Anthropic, LangChain and
 * Vercel AI SDKs all accept a `fetch` in exactly that config, so the joiner is
 * supplied there and runs inside the provider client. `@google/generative-ai`
 * does not (its `RequestOptions` carries `timeout`, `apiVersion`, `apiClient`,
 * `baseUrl` and `customHeaders`, and nothing else), so the Gemini path is
 * declaration-only -- see `src/middleware/google.ts`.
 *
 * Four properties it has to hold, in this order:
 *
 * 1. **Zero cost when nothing was retrieved.** The first thing it does is a
 *    single `AsyncLocalStorage.getStore()`. With an empty bus it forwards the
 *    caller's own `input` and `init` OBJECT REFERENCES untouched, so the bytes
 *    on the wire are the bytes the unwrapped client produced -- asserted by
 *    reference identity in `test/joiner.test.ts`.
 * 2. **Explicit always wins.** A body already carrying
 *    `shashu_metadata.rag_context` is left exactly as the caller built it.
 *    The ambient declaration is consumed and discarded, not deferred: a
 *    declaration that lost this call must not turn up on the next one.
 * 3. **Snapshot and clear.** The bus is emptied the moment it is written to a
 *    request. Retrieval declared for request N never reaches request N+1.
 * 4. **Never corrupt a body it does not understand.** A non-JSON body, a
 *    non-object JSON body, or a stream upload is passed through untouched and
 *    does NOT consume the bus -- the next real model call still carries the
 *    declaration, and a multi-gigabyte file upload does not eat it.
 *
 * Sibling of the Python SDK's `trustgate/_joiner.py`.
 */

import { clear, hasEvents, snapshot } from './_bus.js';
import { isDisabled } from './config.js';
import { attachMemoryContext, buildMemoryContext } from './memory.js';
import { attachRagContext, buildRagContext } from './rag.js';

/** The `fetch` shape every provider SDK's option accepts. */
export type FetchLike = (input: any, init?: any) => Promise<Response>;

/** Late-bound so a test (or a runtime) that swaps `globalThis.fetch` is honoured. */
const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/**
 * A JSON object body's parsed form, or undefined to leave the request alone.
 *
 * Only an in-memory string body is considered. A `ReadableStream`, a `Blob`, a
 * `FormData` or a typed array is a body we would have to consume to inspect,
 * and consuming it breaks the upload.
 */
function parseJsonObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'string') return undefined;
  if (!/^[\s]*\{/.test(body)) return undefined;
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** True when the caller built the `rag_context` themselves. */
function metadataBag(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = body.shashu_metadata;
  if (metadata !== null && typeof metadata === 'object') {
    return metadata as Record<string, unknown>;
  }
  return undefined;
}

function hasExplicitRagContext(body: Record<string, unknown>): boolean {
  const metadata = metadataBag(body);
  return metadata?.rag_context !== undefined && metadata?.rag_context !== null;
}

function hasExplicitMemoryContext(body: Record<string, unknown>): boolean {
  const metadata = metadataBag(body);
  return metadata?.memory_context !== undefined && metadata?.memory_context !== null;
}

/**
 * Rewrite a `content-length` the caller had already computed.
 *
 * Only when it is already there: adding one to a request that had none would
 * change the framing of a request the SDK meant to send chunked.
 */
function fixContentLength(headers: unknown, byteLength: number): unknown {
  const value = String(byteLength);
  if (headers instanceof Headers) {
    if (headers.has('content-length')) headers.set('content-length', value);
    return headers;
  }
  if (Array.isArray(headers)) {
    return headers.map((pair) =>
      Array.isArray(pair) && String(pair[0]).toLowerCase() === 'content-length'
        ? [pair[0], value]
        : pair
    );
  }
  if (headers !== null && typeof headers === 'object') {
    const out: Record<string, unknown> = { ...(headers as Record<string, unknown>) };
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === 'content-length') out[key] = value;
    }
    return out;
  }
  return headers;
}

/**
 * The declaration this request should carry, or undefined for "send it as is".
 *
 * Consumes the bus as a side effect in exactly the two cases that must consume
 * it: an explicit `rag_context` on the body (the ambient one lost, and is
 * dropped rather than deferred) and a successful attach.
 */
/**
 * True when a snapshot holds declarations from more than one corpus.
 *
 * A declaration made before the first `await` in a fan-out can SHARE, putting
 * one task's documents on another's audit row. That inverts prefer-a-miss.
 * Refusing to attach is a miss; merging would be a lie. The common shape
 * (parallel searches against different indexes) becomes a miss rather than a
 * merge. Cheaper than a Set: one event cannot conflict, and the second
 * differing corpus is enough.
 */
function hasConflictingCorpora(events: readonly { corpus: string }[]): boolean {
  if (events.length <= 1) return false;
  const first = events[0].corpus;
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].corpus !== first) return true;
  }
  return false;
}

function takeContextFor(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const events = snapshot();
  const ragEvents = events.filter((e) => e.kind !== 'memory');
  const memEvents = events.filter((e) => e.kind === 'memory');
  const explicitRag = hasExplicitRagContext(body);
  const explicitMem = hasExplicitMemoryContext(body);
  clear();
  let mutated = false;
  if (!explicitRag) {
    if (hasConflictingCorpora(ragEvents)) {
      // prefer a miss over a merge
    } else {
      const context = buildRagContext(ragEvents);
      if (context !== undefined) {
        attachRagContext(body, context);
        mutated = true;
      }
    }
  }
  if (!explicitMem) {
    const memoryContext = buildMemoryContext(memEvents);
    if (memoryContext !== undefined) {
      attachMemoryContext(body, memoryContext);
      mutated = true;
    }
  }
  return mutated ? body : undefined;
}

/**
 * Wrap a `fetch` so the carried declaration rides the next JSON model call.
 *
 * ```ts
 * const openai = new OpenAI({ baseURL, fetch: withRetrievalJoiner() });
 * ```
 *
 * Never throws on the SDK's behalf: any failure to understand a request means
 * that request goes out exactly as the caller built it.
 */
/** Consume the bus once and return init whose body already carries the declaration. */
export function pinOutgoing(input: any, init?: any): { input: any; init: any } {
  if (!hasEvents()) return { input, init };
  if (isDisabled()) {
    clear();
    return { input, init };
  }
  const body = parseJsonObject(init?.body);
  if (body === undefined) return { input, init };
  const merged = takeContextFor(body);
  if (merged === undefined) return { input, init };
  const encoded = JSON.stringify(merged);
  return {
    input,
    init: {
      ...init,
      body: encoded,
      headers: fixContentLength(init?.headers, byteLength(encoded)),
    },
  };
}

export function withRetrievalJoiner(underlying: FetchLike = globalFetch): FetchLike {
  return async function trustgateJoiningFetch(input: any, init?: any): Promise<Response> {
    // The zero-cost guard: one getStore(), before anything is touched.
    if (!hasEvents()) return underlying(input, init);

    // Checked second, so the kill switch costs nothing on the common path. A bus
    // populated before the switch flipped is dropped, not sent.
    if (isDisabled()) {
      clear();
      return underlying(input, init);
    }

    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        // A Request carries its own body, so reading it is the only way to see
        // it -- which is why this branch sits behind the emptiness guard.
        const body = parseJsonObject(await input.clone().text());
        if (body === undefined) return underlying(input, init);
        const merged = takeContextFor(body);
        if (merged === undefined) return underlying(input, init);
        const encoded = JSON.stringify(merged);
        const replacement = new Request(input, { body: encoded });
        if (replacement.headers.has('content-length')) {
          replacement.headers.set('content-length', String(byteLength(encoded)));
        }
        return underlying(replacement, init);
      }

      const body = parseJsonObject(init?.body);
      if (body === undefined) return underlying(input, init);
      const merged = takeContextFor(body);
      if (merged === undefined) return underlying(input, init);
      const encoded = JSON.stringify(merged);
      return underlying(input, {
        ...init,
        body: encoded,
        headers: fixContentLength(init?.headers, byteLength(encoded)),
      });
    } catch {
      // A joiner that broke a customer's model call would be worse than one
      // that failed to annotate it.
      return underlying(input, init);
    }
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
