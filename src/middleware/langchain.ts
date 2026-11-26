/**
 * Shashu <-> LangChain: capture the retrieval, declare it for the next model call.
 *
 * Two separate things live here.
 *
 * **The endpoint config.** `createShashuLangChainConfig()` points ChatOpenAI
 * (and the other OpenAI-shaped LangChain integrations) at your Shashu gateway
 * and injects workflow context so Shadow AI detection can attribute requests. It
 * also supplies the retrieval joiner as the client's `fetch`, which is what
 * carries a declaration onto the outgoing request.
 *
 * **The collector.** One line turns it on:
 *
 * ```ts
 * import { install } from "@shashu-ai/sdk/middleware/langchain";
 * await install({ corpus: "policy_docs_v2" });
 * ```
 *
 * From then on every LangChain retriever that runs inside a chain in this
 * process declares what it returned, and the joiner attaches that declaration to
 * the model call that follows. Nothing needs to be passed to `invoke()`, no
 * `{ callbacks: [...] }`, and the collector never touches the outgoing request.
 *
 * ---------------------------------------------------------------------------
 * Why this is not simply "push to the bus at handleRetrieverEnd"
 * ---------------------------------------------------------------------------
 *
 * Measured against @langchain/core 1.2.9 and @langchain/openai 1.5.11 (the probe
 * is reproduced as `test/conformance/lcel.test.ts`):
 *
 * * A `Runnable` step runs in its own async context. An
 *   `AsyncLocalStorage.enterWith()` performed from `handleRetrieverEnd` is
 *   invisible to the `llm` step and to the caller -- the write lands in a
 *   sibling frame that is discarded when the step returns. This is the same
 *   isolation Python's LCEL gets from `contextvars.copy_context()`, and a
 *   collector that only pushed to the bus there would be **silently inert for
 *   LCEL**, the exact shape this module exists to support.
 * * Callback handlers are worse than isolated: unless `awaitHandlers` is set
 *   they are dispatched onto a `p-queue` (`consumeCallback` in
 *   `@langchain/core/singletons/callbacks`), so they may run *after* the model
 *   step has already sent its request. A handler-based delivery happens to work
 *   while that queue is idle and silently drops the declaration when it is not.
 * * Seeding a shared *mutable* carrier instead is not a fix: `enterWith` leaks
 *   upward into the frame that started the task, so eight concurrent requests
 *   find one another's carrier. Measured, that design handed every one of eight
 *   tasks every other task's documents.
 *
 * So capture and delivery are done where each is deterministic, by wrapping the
 * `CallbackManager` methods themselves rather than by registering a handler:
 *
 * * **Capture** wraps `CallbackManagerForRetrieverRun.handleRetrieverEnd`, which
 *   runs inline before the retriever step returns. It records documents against
 *   the run they belong to -- data only, no context, no ordering assumption.
 * * **Delivery** wraps `CallbackManager.handleChatModelStart` /
 *   `handleLLMStart`, which run inline in the model step's own async context --
 *   the same context the HTTP call is made in. Delivery calls
 *   {@link declareRetrieval}, so the caps, the coercion table and
 *   `SHASHU_DISABLE` are the one implementation shared with the manual path.
 *
 * `install()` also has to force a `CallbackManager` to exist at all:
 * `CallbackManager.configure()` returns `undefined` when a chain is invoked with
 * no callbacks configured, and then none of the wrapped methods is ever reached.
 * {@link ShashuLangChainCallback} is injected there for that reason and does
 * nothing else.
 *
 * **What this does not cover.** A retriever invoked outside any chain
 * (`await retriever.invoke(q)` on its own, then a model call) is declaration-
 * only: its run has no parent to associate a later model call with, and every
 * context-based seam out of the callback was measured not to reach the caller.
 * Use {@link declareRetrieval} there. `test/conformance/outside-chain.test.ts`
 * holds both halves of that.
 */

import { randomUUID } from 'node:crypto';
import type { ShashuConfig } from '../types.js';
import { isDisabled, requireBaseUrl } from '../config.js';
import {
  getWorkflowContextFromEnv,
  buildContextHeaders,
  applyContractVersion,
} from '../context.js';
import { pinOutgoing, type FetchLike } from '../_joiner.js';
import { executeWithRetry, resolveRetryPolicy } from '../retry.js';
import {
  CredentialResolver,
  passRefusalCodeFromText,
  shouldRetryPassRefused,
} from '../credential.js';
import { MAX_EVENTS } from '../_bus.js';
import { declareRetrieval, type RagContext, type RagDoc } from '../rag.js';

/**
 * Configuration to pass to LangChain's ChatOpenAI (or other OpenAI-based classes).
 * Sets baseURL and defaultHeaders (lowercase keys) so requests go through Shashu
 * with workflow context and x-shashu-source-tool JSON for Shadow AI detection,
 * and a `fetch` that attaches any declared retrieval to the outgoing body.
 *
 * Returns `{}` when SHASHU_DISABLE is set: the provider client is then left
 * exactly as it was — its own endpoint, its own credential, no Shashu context
 * headers — which is the same no-op the Python SDK's patchers perform. The
 * caller's shashu_sk_ key is deliberately NOT handed back, since it would be sent to
 * the provider directly.
 *
 * @throws {ShashuConfigError} when no address is configured and the SDK is
 * not disabled. There is no default host. See ../config.ts.
 */
export function createShashuLangChainConfig(config: ShashuConfig): {
  configuration?: {
    baseURL: string;
    defaultHeaders?: Record<string, string>;
    fetch?: FetchLike;
  };
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
} {
  if (isDisabled()) return {};
  const baseUrl = requireBaseUrl(config.baseUrl, {
    entryPoint: 'createShashuLangChainConfig()',
  });
  const ctx = config.workflowContext ?? getWorkflowContextFromEnv();
  const resolver = new CredentialResolver({
    apiKey: config.apiKey,
    tokenProvider: config.tokenProvider,
  });
  const headers: Record<string, string> = {
    ...config.headers,
    ...buildContextHeaders(ctx, { defaultSessionId: config.sessionId ?? randomUUID() }),
  };
  applyContractVersion(headers, config.contractVersion);
  const fetch: FetchLike = async (input, init) => {
    const baseHeaders = new Headers(init?.headers);
    baseHeaders.delete('authorization');
    const headerObj: Record<string, string> = {};
    baseHeaders.forEach((v, k) => {
      headerObj[k] = v;
    });
    const pinned = pinOutgoing(input, { ...init, headers: headerObj });
    const send = async (): Promise<Response> => {
      const token = await resolver.get();
      const headers = { ...((pinned.init?.headers as Record<string, string>) || {}) };
      if (token) headers.authorization = `Bearer ${token}`;
      return globalThis.fetch(pinned.input, { ...pinned.init, headers });
    };
    const res = await executeWithRetry(send, resolveRetryPolicy(config.retryPolicy));
    if (!resolver.usesProvider || res.status !== 401) return res;
    const code = passRefusalCodeFromText(await res.clone().text());
    if (
      !shouldRetryPassRefused({
        usesProvider: true,
        status: res.status,
        code,
        bytesDelivered: false,
      })
    ) {
      return res;
    }
    resolver.invalidate();
    return send();
  };

  return {
    baseURL: baseUrl,
    defaultHeaders: Object.keys(headers).length ? headers : undefined,
    configuration: {
      baseURL: baseUrl,
      defaultHeaders: Object.keys(headers).length ? headers : undefined,
      fetch,
    },
  };
}

/**
 * Convert a list of LangChain `Document` objects into Shashu's canonical
 * rag_context shape.
 */
export function lcDocumentsToRagContext(
  documents: Array<{ pageContent?: string; metadata?: Record<string, unknown> }>,
  options: { corpus?: string; query?: string; maxDocs?: number; previewChars?: number } = {}
): RagContext {
  const maxDocs = options.maxDocs ?? 32;
  const previewChars = options.previewChars ?? 600;
  const docs: RagDoc[] = [];
  for (const doc of documents.slice(0, maxDocs)) {
    const page = doc.pageContent ?? String(doc);
    const entry: RagDoc = { preview: String(page).slice(0, previewChars) };
    const metadata = doc.metadata ?? {};
    if (metadata && typeof metadata === 'object') {
      const docId = (metadata.source ?? metadata.id) as string | undefined;
      if (docId) entry.id = String(docId);
      const score = (metadata.score ?? metadata.relevance) as number | undefined;
      if (typeof score === 'number') entry.score = score;
    }
    docs.push(entry);
  }
  const out: RagContext = { docs };
  if (options.corpus !== undefined) out.corpus = options.corpus;
  if (options.query !== undefined) out.query = options.query;
  return out;
}

// --- The collector ---------------------------------------------------------

/** `rag_context.v1` `source` for everything this module declares. */
export const SOURCE = 'langchain';

/**
 * Used when the caller names no corpus. `rag_context.v1` requires a non-empty
 * `corpus` and the retriever callback carries no index name, so the honest
 * answer is "a LangChain retriever, index unnamed" rather than a guess that
 * would misattribute the documents to a real index.
 */
export const DEFAULT_CORPUS = 'langchain-retriever';

/**
 * How many chain runs may be tracked at once.
 *
 * An entry is dropped when its outermost chain ends or errors; this cap is what
 * keeps a run that does neither from growing the map for the life of the
 * process.
 */
const MAX_TRACKED_RUNS = 64;

/** One retriever's output, waiting for the model call in the same chain run. */
interface Capture {
  documents: unknown[];
  query?: string;
}

/** Keyed by the run id shared by every step of one chain run. */
const captured = new Map<string, Capture[]>();

/** Where `handleRetrieverStart` parks the query for `handleRetrieverEnd`. */
const QUERY = Symbol.for('shashu.langchain.query');

let enabled = false;
let patched = false;
let corpusName = DEFAULT_CORPUS;

/** The one gate both capture and delivery consult. */
function active(): boolean {
  return enabled && !isDisabled();
}

function record(key: string, capture: Capture): void {
  const list = captured.get(key) ?? [];
  list.push(capture);
  // Newest kept, matching the bus's own trimming rule.
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  captured.set(key, list);
  if (captured.size > MAX_TRACKED_RUNS) {
    const oldest = captured.keys().next();
    if (!oldest.done) captured.delete(oldest.value);
  }
}

/**
 * Declare everything this chain run has retrieved so far.
 *
 * The captures are NOT dropped: a chain that calls the model twice bound the
 * same retrieved documents into both prompts, and both calls should say so. The
 * bus is snapshot-and-cleared per request, so each call carries them once.
 *
 * Never throws into the customer's chain.
 */
function deliver(key: unknown): void {
  if (!active() || typeof key !== 'string') return;
  const captures = captured.get(key);
  if (!captures || captures.length === 0) return;
  for (const capture of captures) {
    try {
      declareRetrieval(capture.documents, {
        corpus: corpusName,
        query: capture.query,
        source: SOURCE,
      });
    } catch (err) {
      // Type name only. Neither the documents nor the query is ever logged; the
      // one place document text goes is the request to the customer's gateway.
      // eslint-disable-next-line no-console
      console.warn(
        `SHASHU LangChain collector dropped a retrieval: ${
          err instanceof Error ? err.name : typeof err
        }`
      );
    }
  }
}

/**
 * The handler `install()` injects so a `CallbackManager` exists at all.
 *
 * `CallbackManager.configure()` returns `undefined` for a chain invoked with no
 * callbacks, and then none of the wrapped manager methods is reached. This
 * carries no capture logic of its own — the wrapped methods do that, where their
 * ordering and async context are guaranteed. It is shaped as LangChain requires
 * a handler to be (`ensureHandler` accepts any object with a `name`) rather than
 * extending `BaseCallbackHandler`, so this module stays importable with
 * @langchain/core absent.
 */
export class ShashuLangChainCallback {
  readonly name = 'ShashuLangChainCallback';
  readonly raiseError = false;
  readonly awaitHandlers = false;
  readonly ignoreLLM = false;
  readonly ignoreChain = false;
  readonly ignoreAgent = false;
  readonly ignoreRetriever = false;
  readonly ignoreCustomEvent = false;
  copy(): this {
    return this;
  }
}

const PRESENCE = new ShashuLangChainCallback();

function patchConfigure(CallbackManager: any): void {
  for (const name of ['configure', '_configureSync'] as const) {
    const original = CallbackManager[name];
    if (typeof original !== 'function') continue;
    CallbackManager[name] = function (this: unknown, inheritable: any, ...rest: any[]) {
      if (!active()) return original.call(this, inheritable, ...rest);
      let next = inheritable;
      if (next === undefined || next === null) next = [PRESENCE];
      else if (Array.isArray(next)) next = next.includes(PRESENCE) ? next : [...next, PRESENCE];
      const manager = original.call(this, next, ...rest);
      // `Callbacks` may also be a CallbackManager, which the array path above
      // cannot extend.
      if (
        manager &&
        !Array.isArray(inheritable) &&
        inheritable &&
        typeof inheritable.addHandler === 'function' &&
        !manager.handlers.includes(PRESENCE)
      ) {
        manager.addHandler(PRESENCE, true);
      }
      return manager;
    };
  }
}

function patchCapture(CallbackManager: any, CallbackManagerForRetrieverRun: any): void {
  const originalStart = CallbackManager.prototype.handleRetrieverStart;
  CallbackManager.prototype.handleRetrieverStart = async function (
    this: any,
    retriever: any,
    query: any,
    ...rest: any[]
  ) {
    const runManager = await originalStart.call(this, retriever, query, ...rest);
    // Parked on the run manager rather than in a map: it is the same object
    // handleRetrieverEnd is called on, so nothing has to be evicted later.
    if (active() && runManager && typeof query === 'string') runManager[QUERY] = query;
    return runManager;
  };

  const originalEnd = CallbackManagerForRetrieverRun.prototype.handleRetrieverEnd;
  CallbackManagerForRetrieverRun.prototype.handleRetrieverEnd = function (
    this: any,
    documents: any,
    ...rest: any[]
  ) {
    if (active() && Array.isArray(documents) && documents.length > 0) {
      record(this._parentRunId, { documents, query: this[QUERY] });
    }
    return originalEnd.call(this, documents, ...rest);
  };
}

function patchDelivery(CallbackManager: any): void {
  for (const name of ['handleChatModelStart', 'handleLLMStart'] as const) {
    const original = CallbackManager.prototype[name];
    if (typeof original !== 'function') continue;
    CallbackManager.prototype[name] = function (this: any, ...args: any[]) {
      deliver(this._parentRunId);
      return original.apply(this, args);
    };
  }
}

function patchCleanup(CallbackManagerForChainRun: any): void {
  for (const name of ['handleChainEnd', 'handleChainError'] as const) {
    const original = CallbackManagerForChainRun.prototype[name];
    if (typeof original !== 'function') continue;
    CallbackManagerForChainRun.prototype[name] = function (this: any, ...args: any[]) {
      // `_parentRunId === undefined` identifies the outermost run, the one whose
      // id every step of the chain was keyed under.
      if (this._parentRunId === undefined) captured.delete(this.runId);
      return original.apply(this, args);
    };
  }
}

/**
 * Collect every LangChain retrieval in this process and declare it for the model
 * call that follows.
 *
 * Returns true when the collector is live, false when @langchain/core is not
 * installed — in which case this is a clean no-op, not an error. A library that
 * made `import` fail on a machine without LangChain would be worse than one that
 * quietly has nothing to collect.
 *
 * Idempotent: calling it again re-points the corpus and does not stack a second
 * set of wrappers.
 */
export async function install(options: { corpus?: string } = {}): Promise<boolean> {
  if (options.corpus !== undefined) corpusName = options.corpus || DEFAULT_CORPUS;

  if (!patched) {
    let manager: {
      CallbackManager: unknown;
      CallbackManagerForRetrieverRun: unknown;
      CallbackManagerForChainRun: unknown;
    };
    try {
      manager = (await import('@langchain/core/callbacks/manager')) as typeof manager;
    } catch {
      return false;
    }
    patchConfigure(manager.CallbackManager);
    patchCapture(manager.CallbackManager, manager.CallbackManagerForRetrieverRun);
    patchDelivery(manager.CallbackManager);
    patchCleanup(manager.CallbackManagerForChainRun);
    patched = true;
  }

  enabled = true;
  return true;
}

/**
 * Stop declaring: every capture and delivery point becomes a no-op.
 *
 * The wrappers stay in place — unwrapping a prototype that a later import may
 * have wrapped again is how you delete somebody else's patch — and anything
 * captured so far is dropped.
 */
export function uninstall(): void {
  enabled = false;
  captured.clear();
}

/** True when retrievals in this process are being declared. */
export function isInstalled(): boolean {
  return active();
}
