import { isDisabled } from './config.js';
import {
  MAX_CORPUS_CHARS,
  MAX_DOCS,
  push as busPush,
  runWith as busRunWith,
  snapshot as busSnapshot,
  type RetrievalEvent,
} from './_bus.js';
import { coerceDocs } from './rag.js';

export const MEMORY_SOURCES = [
  'sdk',
  'manual',
  'langchain',
  'llamaindex',
  'tool',
  'otel',
  'n8n',
  'provider',
  'hosted',
  'other',
] as const;
export const MEMORY_SCOPES = ['agent', 'crew', 'tenant'] as const;

export interface DeclareMemoryOptions {
  store: string;
  scope?: (typeof MEMORY_SCOPES)[number];
  source?: (typeof MEMORY_SOURCES)[number];
}

function requireStore(store: string): string {
  if (!store || !store.trim()) {
    throw new TypeError(
      'declareMemory needs a non-empty store: it is what the gateway records the items as having come from, and memory_context.v1 requires it.'
    );
  }
  return store.trim().slice(0, MAX_CORPUS_CHARS);
}

function requireScope(scope: string | undefined): string {
  const value = scope || 'agent';
  if (!(MEMORY_SCOPES as readonly string[]).includes(value)) {
    throw new TypeError(`declareMemory scope='${scope}' is not a memory_context.v1 value.`);
  }
  return value;
}

function requireSource(source: string | undefined): string {
  const value = source || 'sdk';
  if (!(MEMORY_SOURCES as readonly string[]).includes(value)) {
    throw new TypeError(`declareMemory source='${source}' is not a memory_context.v1 value.`);
  }
  return value;
}

export function declareMemory(items: unknown, options: DeclareMemoryOptions): void {
  if (isDisabled()) return;
  const docs = coerceDocs(items);
  if (docs.length === 0) return;
  busPush({
    kind: 'memory',
    corpus: requireStore(options.store),
    query: requireScope(options.scope),
    source: requireSource(options.source),
    docs,
  });
}

export async function memoryScope<T>(
  items: unknown,
  options: DeclareMemoryOptions,
  fn: () => T | Promise<T>
): Promise<T> {
  if (isDisabled()) return await fn();
  const before = busSnapshot();
  return await busRunWith(before, async () => {
    declareMemory(items, options);
    return await fn();
  });
}

export function buildMemoryContext(
  events: readonly RetrievalEvent[]
): Record<string, unknown> | undefined {
  const mem = events.filter((e) => e.kind === 'memory');
  const items = mem
    .flatMap((e) => e.docs.map((d) => ({ id: d.id, preview: d.preview })))
    .slice(-MAX_DOCS);
  if (items.length === 0) return undefined;
  const stores = [...new Set(mem.map((e) => e.corpus))];
  const sources = new Set(mem.map((e) => e.source));
  const scope = mem[mem.length - 1]?.query || 'agent';
  return {
    v: 1,
    store: stores.length === 1 ? stores[0] : stores.join('+').slice(0, MAX_CORPUS_CHARS),
    scope,
    source: sources.size === 1 ? [...sources][0] : 'other',
    items,
  };
}

export function attachMemoryContext<T extends Record<string, unknown>>(
  body: T,
  memoryContext: Record<string, unknown>
): T {
  const bag: Record<string, unknown> = body;
  const existing = bag.shashu_metadata;
  const metadata =
    existing !== null && typeof existing === 'object' ? (existing as Record<string, unknown>) : {};
  bag.shashu_metadata = { ...metadata, memory_context: memoryContext };
  return body;
}
