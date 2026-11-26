/**
 * The ambient retrieval bus: what was retrieved, waiting for the model call.
 *
 * A customer calls {@link declareRetrieval} where their retrieval happens — in a
 * repository method, a tool, a graph node — and the SDK carries that declaration
 * to the gateway on the next model call, wherever that call is made from. This
 * module is the carrier, and it is deliberately the smallest thing that can be:
 * an `AsyncLocalStorage` holding a frozen array of events.
 *
 * **Why a frozen array and `enterWith`, not a mutable one.** Node's
 * `AsyncLocalStorage` is not Python's `contextvars`, and the difference bites
 * here. `store.enterWith(v)` binds `v` for the current async resource and every
 * continuation of it, and — measured — that binding LEAKS UPWARD to the frame
 * that started the task. A shared *mutable* array is therefore a live
 * cross-request channel: a prototype-wrap design that mutated one was measured
 * handing eight concurrent requests each other's documents, every task seeing
 * every other task's nonce. Replacing the whole value instead keeps each task's
 * write in its own async resource.
 *
 * **What `enterWith` can and cannot reach.** Node binds a store to the current
 * async FRAME, not to a task the way Python binds a `ContextVar` to a coroutine
 * chain. Measured, that gives three rules a caller has to be able to predict:
 *
 * | where the declaration is made                              | reaches the model call |
 * | ---------------------------------------------------------- | ---------------------- |
 * | the same async function, before the call                     | yes                    |
 * | a helper called before it has suspended                       | yes                    |
 * | a helper that already `await`ed, then declared                | **no**                 |
 * | anywhere inside {@link runIsolated} / `retrievalScope()`       | yes                    |
 *
 * and one more, about fan-out: a task that pushes BEFORE its own first `await`
 * pushes into the frame it was started from, and a sibling started from that
 * same frame inherits it. `await` anything first — which every real retrieval
 * does — and the tasks are isolated. Node offers no way to tell an inherited
 * binding from one's own: an `executionAsyncId()` discriminator reads 0 unless a
 * global `async_hooks` hook is enabled, and an SDK must not turn one on. So the
 * boundary is explicit, and {@link runIsolated} is it.
 * `test/bus.test.ts` and `test/conformance/manual.test.ts` hold every row of
 * both tables, the unsafe ones included.
 *
 * **What this module will not do.** No disk, no network, no logging of document
 * text — not at DEBUG, not in an error path. The only place a preview ever goes
 * is the body of the request to the customer's own gateway.
 *
 * Caps are the contract's, not the gateway's current behaviour: previews are
 * bound at 2048 characters (`rag_context.v1`'s `maxLength`) rather than the 600
 * the gateway truncates at today, because that mismatch is a gateway-side defect
 * tracked separately and the SDK speaks the contract.
 *
 * Sibling of the Python SDK's `shashu/_bus.py`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * At most this many separate declarations are carried at once. A caller that
 * retrieves in a loop would otherwise grow the bus without bound.
 */
export const MAX_EVENTS = 8;

/**
 * `rag_context.v1` `docs.maxItems`. Counted across ALL carried events, not per
 * event, because the joiner emits one `docs` array.
 */
export const MAX_DOCS = 64;

/** `rag_context.v1` `docs.items.properties.preview.maxLength`. */
export const MAX_PREVIEW_CHARS = 2048;

/** `rag_context.v1` `corpus.maxLength`. */
export const MAX_CORPUS_CHARS = 256;

/** `rag_context.v1` `query.maxLength`. */
export const MAX_QUERY_CHARS = 4096;

/** One document as `rag_context.v1` spells it. */
export interface BusDoc {
  id: string;
  preview: string;
  score?: number;
  source_uri?: string;
  hash?: string;
}

/** One retrieval declaration. */
export interface RetrievalEvent {
  kind?: 'retrieval' | 'memory';
  corpus: string;
  query?: string;
  source: string;
  docs: BusDoc[];
}

const EMPTY: readonly RetrievalEvent[] = Object.freeze([]);

/**
 * What the AsyncLocalStorage holds.
 *
 * `shared` is set only by {@link runIsolated} / {@link runWith}, which establish
 * the store with `AsyncLocalStorage.run` — a boundary nothing outside can see
 * into and nothing inside can leak out of. Inside such a store a push MUTATES
 * `events`, so a declaration made in a helper that has already suspended is
 * still seen by the caller, the way a Python coroutine's `ContextVar.set` is.
 * Without one, a push REPLACES the whole store, which is what keeps concurrent
 * tasks from writing into each other.
 */
interface BusStore {
  events: readonly RetrievalEvent[];
  readonly shared: boolean;
}

const BUS = new AsyncLocalStorage<BusStore>();

function current(): readonly RetrievalEvent[] {
  return BUS.getStore()?.events ?? EMPTY;
}

/**
 * Append one declaration, then trim to the caps, newest first.
 *
 * Trimming keeps the MOST RECENT and drops the oldest, never the reverse: the
 * declaration nearest the model call is the one that describes the prompt being
 * sent. Applied uniformly, that means an oversized single declaration keeps its
 * tail — 100 documents in one call are carried as the last 64.
 */
export function push(event: RetrievalEvent): void {
  if (!event.docs || event.docs.length === 0) return;
  const store = BUS.getStore();
  const next = trim([...(store?.events ?? EMPTY), event]);
  if (store?.shared) {
    store.events = next;
    return;
  }
  BUS.enterWith({ events: next, shared: false });
}

/** The declarations carried right now, already trimmed to the caps. */
export function snapshot(): readonly RetrievalEvent[] {
  return current();
}

/**
 * Drop everything carried. Called by the joiner once it has consumed.
 *
 * This MUTATES the store rather than rebinding, and it has to. The joiner runs
 * deep inside the provider SDK's own frames; an `enterWith` there would empty a
 * store only that frame can see, and the caller — who still holds the store the
 * declaration was written into — would carry it onto the NEXT request too.
 * Emptying in place is what makes "retrieval declared for request N never
 * reaches request N+1" true from wherever the joiner happens to run.
 */
export function clear(): void {
  const store = BUS.getStore();
  if (store) {
    store.events = EMPTY;
    return;
  }
  BUS.enterWith({ events: EMPTY, shared: false });
}

/**
 * Cheap emptiness check — the joiner's zero-cost guard.
 *
 * One `AsyncLocalStorage.getStore()` and a length test. Nothing here reads a
 * request, a header or a body, which is what makes the no-retrieval path free.
 */
export function hasEvents(): boolean {
  return current().length > 0;
}

/**
 * Run `fn` with a retrieval bus of its own.
 *
 * `enterWith` leaks upward and is frame-scoped; `run` is neither. Inside this
 * boundary a declaration made anywhere — a helper that has already awaited, a
 * nested call — is seen by everything else in the block, and nothing in the
 * block is seen outside it. Reached through `isolateRetrieval` in rag.ts,
 * which is internal: it is not re-exported from ./index.ts. Its
 * customer-facing job is `retrievalScope`.
 */
export function runIsolated<T>(fn: () => T): T {
  return BUS.run({ events: EMPTY, shared: true }, fn);
}

/** {@link runIsolated}, seeded with declarations already carried. */
export function runWith<T>(state: readonly RetrievalEvent[], fn: () => T): T {
  return BUS.run({ events: state, shared: true }, fn);
}

/** Enforce MAX_EVENTS then MAX_DOCS, keeping the newest of each. */
function trim(events: RetrievalEvent[]): readonly RetrievalEvent[] {
  const recent = events.slice(-MAX_EVENTS);

  let budget = MAX_DOCS;
  const kept: RetrievalEvent[] = [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (budget <= 0) break;
    const event = recent[i];
    if (event.docs.length > budget) {
      kept.push({ ...event, docs: event.docs.slice(-budget) });
      budget = 0;
    } else {
      budget -= event.docs.length;
      kept.push(event);
    }
  }
  kept.reverse();
  return Object.freeze(kept);
}
