/**
 * Helpers for attaching structured RAG context to a chat-completion request body.
 *
 * The Shashu gateway scans retrieved documents on a dedicated `ingress-rag`
 * surface when the request body carries `trustgate_metadata.rag_context`.
 * This is materially better than letting retrieved documents be scanned as
 * plain user text — the rag scanner has access to corpus + per-doc scores +
 * per-doc previews, which dramatically reduces false-positives on legitimate
 * RAG flows.
 *
 * The gateway pops `trustgate_metadata` from the body before forwarding to
 * the LLM provider, so the upstream model never sees the control plane.
 *
 * @example
 *   import { attachRagContext } from "@trustgateai/sdk";
 *   const body = { model: "gpt-4o-mini", messages: [...] };
 *   attachRagContext(body, {
 *     corpus: "policy_docs_v2",
 *     query: "refinance eligibility",
 *     docs: [{ id: "POL-1", score: 0.92, preview: "..." }],
 *   });
 *   // POST `body` through your existing client (LangChain, ai-sdk, raw fetch).
 */

import { isDisabled } from './config.js';
import {
  MAX_CORPUS_CHARS,
  MAX_DOCS,
  MAX_PREVIEW_CHARS,
  MAX_QUERY_CHARS,
  push as busPush,
  runIsolated as busRunIsolated,
  runWith as busRunWith,
  snapshot as busSnapshot,
  type BusDoc,
  type RetrievalEvent,
} from './_bus.js';

export interface RagDoc {
  id?: string;
  score?: number;
  /** Doc body as seen by the rag scanner. `content` / `text` also accepted by the gateway. */
  preview?: string;
  [key: string]: unknown;
}

export interface RagContext {
  /** Contract version. Absent means 1. Emitted by {@link buildRagContext}. */
  v?: 1;
  corpus?: string;
  query?: string;
  /** A `rag_context.v1` `source` enum value — see {@link SOURCES}. */
  source?: RagSource;
  docs?: RagDoc[];
}

export function makeRagContext(input: RagContext): RagContext {
  const out: RagContext = {};
  if (input.corpus !== undefined) out.corpus = input.corpus;
  if (input.query !== undefined) out.query = input.query;
  if (input.docs !== undefined) out.docs = input.docs;
  return out;
}

/**
 * Merge a rag_context dict into `body.trustgate_metadata.rag_context`
 * without clobbering other trustgate_metadata fields the caller may have set.
 *
 * Returns the same body object (mutated) for chaining convenience.
 */
export function attachRagContext<T extends Record<string, unknown>>(
  body: T,
  ragContext: RagContext
): T {
  if (body === null || typeof body !== 'object') {
    throw new TypeError('body must be an object');
  }
  if (ragContext === null || typeof ragContext !== 'object') {
    throw new TypeError('ragContext must be an object');
  }
  const existing = body.trustgate_metadata;
  const meta: Record<string, unknown> =
    existing !== null && typeof existing === 'object' ? (existing as Record<string, unknown>) : {};
  meta.rag_context = ragContext;
  (body as Record<string, unknown>).trustgate_metadata = meta;
  return body;
}

// ---------------------------------------------------------------------------
// The ambient path: declareRetrieval() / retrievalScope()
// ---------------------------------------------------------------------------

/**
 * `rag_context.v1` `source.enum`. Restated here rather than read from the
 * vendored schema at import time: the SDK must not need a JSON file on disk to
 * make a call. `test/contract.test.ts` holds this tuple to the schema's enum, so
 * the two cannot drift apart unnoticed.
 */
export const SOURCES = [
  'manual',
  'langchain',
  'llamaindex',
  'tool',
  'otel',
  'n8n',
  'provider',
  'other',
] as const;

export type RagSource = (typeof SOURCES)[number];

/** `rag_context.v1` `docs.items.properties.hash.pattern`. */
const HEX = /^[0-9a-fA-F]{8,64}$/;

/**
 * `docs.items.properties.score` bounds. A store reporting a distance below -1 or
 * a score above a million is not describable in v1, so the score is dropped
 * rather than the whole document.
 */
const SCORE_MIN = -1;
const SCORE_MAX = 1000000;

/** `docs.items.properties.id.maxLength`. */
const MAX_ID_CHARS = 512;

/**
 * `docs.items.properties.source_uri` has no maximum; this one is ours, so a
 * retriever that puts a whole document in a URI field cannot bloat the body.
 */
const MAX_SOURCE_URI_CHARS = 2048;

// --- The coercion table ----------------------------------------------------
//
// Every framework's document type is ONE entry in COERCIONS plus one case in
// test/coercion.test.ts's CASES; "every coercion rule has a case" fails if an
// entry is added without one. Field names come from the shared key tables
// below, so a type that spells its fields the usual way needs no new reader
// function at all.
//
// Order is specificity, not preference: a LlamaIndex NodeWithScore carries both
// a `.node` and a delegated `.text`, so the unwrapping rule has to be tried
// before the plain-text one or the score is lost.

const PREVIEW_KEYS = ['preview', 'text', 'content', 'pageContent', 'page_content', 'body'] as const;
const ID_KEYS = [
  'id',
  'doc_id',
  'docId',
  'documentId',
  'document_id',
  'nodeId',
  'node_id',
  'id_',
  '_id',
] as const;
const SCORE_KEYS = ['score', 'similarity', 'relevance'] as const;
const SOURCE_URI_KEYS = [
  'source_uri',
  'sourceUri',
  'url',
  'uri',
  'source',
  'file_path',
  'filePath',
  'file_name',
  'fileName',
] as const;
const HASH_KEYS = ['hash', 'sha256', 'digest'] as const;

/** The five fields a coercion rule may produce, before normalisation. */
interface ReadDoc {
  preview?: unknown;
  id?: unknown;
  score?: unknown;
  source_uri?: unknown;
  hash?: unknown;
}

const FIELD_KEYS: ReadonlyArray<readonly [keyof ReadDoc, readonly string[]]> = [
  ['preview', PREVIEW_KEYS],
  ['id', ID_KEYS],
  ['score', SCORE_KEYS],
  ['source_uri', SOURCE_URI_KEYS],
  ['hash', HASH_KEYS],
];

/** One recognised document shape: how to spot it and how to read it. */
interface Coercion {
  name: string;
  matches: (doc: unknown) => boolean;
  read: (doc: any) => ReadDoc;
}

/** Match any object carrying all of `props` -- the framework-shape probe. */
function has(...props: string[]): (doc: unknown) => boolean {
  return (doc) =>
    typeof doc === 'object' && doc !== null && props.every((p) => (doc as any)[p] !== undefined);
}

const isObject = (doc: unknown): boolean => typeof doc === 'object' && doc !== null;

/** Read the five fields off `doc`, filling gaps from `doc.metadata`. */
function gather(doc: any): ReadDoc {
  const found: ReadDoc = {};
  for (const [field, keys] of FIELD_KEYS) {
    for (const key of keys) {
      const value = doc[key];
      if (value !== undefined && value !== null) {
        (found as any)[field] = value;
        break;
      }
    }
  }
  const metadata = doc.metadata;
  if (isObject(metadata)) {
    for (const [field, keys] of FIELD_KEYS) {
      // Metadata never supplies the text; a retriever that put the body in
      // metadata would double it into the payload.
      if (found[field] !== undefined || field === 'preview') continue;
      for (const key of keys) {
        const value = (metadata as any)[key];
        if (value !== undefined && value !== null) {
          (found as any)[field] = value;
          break;
        }
      }
    }
  }
  return found;
}

/** LlamaIndex `NodeWithScore`: read the wrapped node, keep the outer score. */
function fromScoredNode(doc: any): ReadDoc {
  const inner = readDocument(doc.node);
  return doc.score !== undefined && doc.score !== null ? { ...inner, score: doc.score } : inner;
}

export const COERCIONS: readonly Coercion[] = [
  { name: 'string', matches: (d) => typeof d === 'string', read: (d) => ({ preview: d }) },
  { name: 'scored_node', matches: has('node'), read: fromScoredNode },
  { name: 'langchain_document', matches: has('pageContent'), read: gather },
  { name: 'preview_object', matches: has('preview'), read: gather },
  { name: 'text_node', matches: has('text'), read: gather },
  { name: 'object', matches: isObject, read: gather },
];

/** The first matching rule's reading of `doc`; `{}` when none matches. */
function readDocument(doc: unknown): ReadDoc {
  for (const rule of COERCIONS) {
    if (rule.matches(doc)) return rule.read(doc);
  }
  return {};
}

// --- Normalisation to the wire shape ---------------------------------------

function asText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, limit) || undefined;
}

/** A stable id, else a positional one. Never derived from document text. */
function asId(value: unknown, position: number): string {
  if (typeof value === 'string') {
    const cleaned = value.trim().slice(0, MAX_ID_CHARS);
    if (cleaned) return cleaned;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `doc-${position}`;
}

function asScore(value: unknown): number | undefined {
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    if (!candidate.trim()) return undefined;
    const parsed = Number(candidate);
    if (Number.isNaN(parsed)) return undefined;
    candidate = parsed;
  }
  if (typeof candidate !== 'number') return undefined;
  if (!Number.isFinite(candidate) || candidate < SCORE_MIN || candidate > SCORE_MAX) {
    return undefined;
  }
  return candidate;
}

/**
 * One coerced document as `rag_context.v1` `docs[]`, or undefined to drop.
 *
 * A document with no readable text is dropped rather than sent: `preview` has
 * `minLength: 1`, and text the SDK cannot read is text the gateway cannot scan.
 * Optional fields are omitted unless they are valid, because
 * `additionalProperties: false` makes a malformed one reject the whole payload.
 */
function normalise(raw: ReadDoc, position: number): BusDoc | undefined {
  const preview = asText(raw.preview, MAX_PREVIEW_CHARS);
  if (preview === undefined) return undefined;
  const out: BusDoc = { id: asId(raw.id, position), preview };
  const score = asScore(raw.score);
  if (score !== undefined) out.score = score;
  const sourceUri = asText(raw.source_uri, MAX_SOURCE_URI_CHARS);
  if (sourceUri !== undefined) out.source_uri = sourceUri;
  if (typeof raw.hash === 'string' && HEX.test(raw.hash)) out.hash = raw.hash;
  return out;
}

/**
 * Treat a single document as a one-element list.
 *
 * A bare string is iterable, and iterating it would declare one document per
 * CHARACTER -- a wall of single-letter previews instead of one document.
 */
function asDocumentList(docs: unknown): unknown[] {
  if (typeof docs === 'string') return [docs];
  if (Array.isArray(docs)) return docs;
  if (isObject(docs) && typeof (docs as any)[Symbol.iterator] === 'function') {
    return Array.from(docs as Iterable<unknown>);
  }
  return [docs];
}

export function coerceDocs(docs: unknown): BusDoc[] {
  const out: BusDoc[] = [];
  let position = 0;
  for (const doc of asDocumentList(docs)) {
    position += 1;
    const normalised = normalise(readDocument(doc), position);
    if (normalised !== undefined) out.push(normalised);
  }
  return out;
}

function requireCorpus(corpus: unknown): string {
  if (typeof corpus !== 'string' || !corpus.trim()) {
    throw new TypeError(
      'declareRetrieval() needs a non-empty corpus: it is what the gateway ' +
        'records the documents as having come from, and rag_context.v1 requires it.'
    );
  }
  return corpus.trim().slice(0, MAX_CORPUS_CHARS);
}

function requireSource(source: unknown): RagSource {
  if (!SOURCES.includes(source as RagSource)) {
    throw new TypeError(
      `declareRetrieval() source=${JSON.stringify(source)} is not a rag_context.v1 ` +
        `value. Use one of: ${SOURCES.join(', ')}. A new integration adds its ` +
        `value to the contract first.`
    );
  }
  return source as RagSource;
}

export interface DeclareRetrievalOptions {
  /** The index the documents came from. Required by the contract. */
  corpus: string;
  /** The retrieval query, for the gateway's audit record. */
  query?: string;
  /** What produced the declaration; a `rag_context.v1` enum value. */
  source?: RagSource;
}

/**
 * Declare what was retrieved, wherever the retrieval happened.
 *
 * The declaration rides an `AsyncLocalStorage` store and is attached to the NEXT
 * outgoing model call from this async context, by any client the SDK supplies a
 * `fetch` to -- you do not have to be anywhere near that call.
 *
 * ```ts
 * const docs = await vectorstore.similaritySearch(question, 5);
 * declareRetrieval(docs, { corpus: "policy_docs_v2", query: question });
 * ```
 *
 * `docs` may be plain strings, plain objects, or LangChain / LlamaIndex document
 * objects (see {@link COERCIONS}). A single document may be passed unwrapped.
 * Anything the table cannot read is dropped rather than stringified.
 *
 * @throws {TypeError} on a blank `corpus`, or a `source` outside the contract's
 * enum. Both are call-site mistakes, and throwing here is the only place they
 * can be seen -- the alternative is a payload the gateway rejects at the far end
 * of a customer's stack.
 *
 * A no-op when `TRUSTGATE_DISABLE=1`.
 */
export function declareRetrieval(docs: unknown, options: DeclareRetrievalOptions): void {
  if (isDisabled()) return;
  const corpus = requireCorpus(options.corpus);
  const source = requireSource(options.source ?? 'manual');
  busPush({
    corpus,
    query: asText(options.query, MAX_QUERY_CHARS),
    source,
    docs: coerceDocs(docs),
  });
}

/**
 * {@link declareRetrieval} bounded to a block, and isolated from everything
 * outside it.
 *
 * The declaration applies to model calls made inside `fn`, and the bus is
 * returned to its prior state on the way out — so a retrieval that ended up not
 * being used cannot attach itself to a later, unrelated call.
 *
 * ```ts
 * await retrievalScope(docs, { corpus: "policy_docs_v2", query }, () => chain.invoke(query));
 * ```
 *
 * This is also the answer to the one fan-out shape a bare `declareRetrieval()`
 * cannot isolate: several tasks started from one frame, each declaring before
 * its own first `await`. It is built on `AsyncLocalStorage.run`, which does not
 * leak into the frame that started the task, where `enterWith` does. See
 * `_bus.ts` for the measured table.
 *
 * A no-op wrapper when `TRUSTGATE_DISABLE=1`: `fn` still runs, nothing is
 * declared.
 */
export async function retrievalScope<T>(
  docs: unknown,
  options: DeclareRetrievalOptions,
  fn: () => T | Promise<T>
): Promise<T> {
  if (isDisabled()) return await fn();
  const before = busSnapshot();
  return await busRunWith(before, async () => {
    declareRetrieval(docs, options);
    return await fn();
  });
}

/**
 * Run `fn` with a retrieval bus of its own.
 *
 * INTERNAL. Not exported from ./index.ts and not part of the public surface
 * frozen in `contracts/sdk-surface.v1.md`, which says there are TWO public
 * retrieval functions and no third. Customers reach this behaviour through
 * {@link retrievalScope}, which is the documented answer to the same fan-out
 * shape. It was public through 2.0.0 and was removed in 3.0.0; the
 * implementation stays because the bus tests drive it directly, by the shape
 * below, to prove the isolation `retrievalScope` depends on.
 *
 * Use it around each task of a fan-out that declares before its first `await`:
 * that is the one shape in which a bare {@link declareRetrieval} is inherited by
 * a sibling task rather than kept to itself. Everything else is already
 * isolated — see the table in `_bus.ts`.
 *
 * ```ts
 * await Promise.all(batches.map((b) => isolateRetrieval(async () => {
 *   declareRetrieval(b.docs, { corpus: "policy_docs_v2" });
 *   return client.chat.completions.create({ model, messages: b.messages });
 * })));
 * ```
 */
export function isolateRetrieval<T>(fn: () => T): T {
  return busRunIsolated(fn);
}

/**
 * Drop repeats of `(id, preview)`, keeping the first one seen.
 *
 * The pair, not the id alone: a positional id (`doc-1`) is assigned per event,
 * so two unrelated retrievals both produce a `doc-1` and matching on the id
 * would silently discard the second one's first document.
 */
function dedupe(docs: BusDoc[]): BusDoc[] {
  const seen = new Set<string>();
  const out: BusDoc[] = [];
  for (const doc of docs) {
    const key = `${doc.id} ${doc.preview}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
  }
  return out;
}

/**
 * Fold carried declarations into one `rag_context.v1` block.
 *
 * The contract carries a single `corpus`, `query` and `source` for the whole
 * declaration, so multiple events have to be reconciled:
 *
 * * `corpus` -- the one they share, or the distinct ids joined with `+`. A
 *   hybrid retrieval across two indexes is a real shape, and naming only one of
 *   them would misattribute the other's documents.
 * * `source` -- the one they share, else `other`, the enum value that exists for
 *   exactly this.
 * * `query` -- the most recent non-empty one: the query nearest the call.
 *
 * Documents are de-duplicated by `(id, preview)`, first occurrence kept. Two
 * events CAN legitimately describe the same retrieval: a customer who installs
 * the LangChain collector and also calls {@link declareRetrieval} for the same
 * documents produces both. Both events are kept -- only the repeated documents
 * go, so a second event carrying anything new still contributes it.
 *
 * Returns undefined when nothing survived, so the joiner never writes an empty
 * `docs` array (`minItems: 1`).
 */
export function buildRagContext(events: readonly RetrievalEvent[]): RagContext | undefined {
  events = events.filter((event) => event.kind !== 'memory');
  const docs = dedupe(events.flatMap((event) => event.docs)).slice(-MAX_DOCS);
  if (docs.length === 0) return undefined;

  const corpora = [...new Set(events.map((event) => event.corpus))];
  const corpus =
    corpora.length === 1
      ? corpora[0]
      : corpora.join('+').slice(0, MAX_CORPUS_CHARS).replace(/\++$/, '');

  const sources = new Set(events.map((event) => event.source));
  const queries = events.map((event) => event.query).filter((q): q is string => !!q);

  const context: RagContext = {
    v: 1,
    corpus,
    source: (sources.size === 1 ? [...sources][0] : 'other') as RagSource,
    docs: docs as RagDoc[],
  };
  if (queries.length) context.query = queries[queries.length - 1];
  return context;
}
