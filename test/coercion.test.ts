/**
 * The coercion table, exercised as data.
 *
 * Every entry in `COERCIONS` needs a case here; the last test in the file fails
 * if one is added without one, which is what stops a new framework's document
 * type from being "supported" by a rule nothing ever ran.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clear, snapshot, MAX_DOCS, MAX_PREVIEW_CHARS } from '../src/_bus.js';
import { COERCIONS, buildRagContext, declareRetrieval, SOURCES } from '../src/rag.js';
import { assertValidRagContext } from './helpers/gateway.js';

/** Declare one document and read back the single `docs[]` entry it produced. */
function coerceOne(doc: unknown): Record<string, unknown> {
  clear();
  declareRetrieval(doc, { corpus: 'c' });
  const context = buildRagContext(snapshot());
  expect(context).toBeDefined();
  assertValidRagContext(context);
  return (context!.docs as Record<string, unknown>[])[0];
}

/** rule name -> a document that rule is the one to match, and what it must read. */
const CASES: Array<{ rule: string; doc: unknown; expected: Record<string, unknown> }> = [
  {
    rule: 'string',
    doc: 'a plain string document',
    expected: { id: 'doc-1', preview: 'a plain string document' },
  },
  {
    rule: 'scored_node',
    // LlamaIndex NodeWithScore: the outer score wins over anything on the node.
    doc: { node: { id_: 'N-7', text: 'node text', metadata: { score: 0.11 } }, score: 0.91 },
    expected: { id: 'N-7', preview: 'node text', score: 0.91 },
  },
  {
    rule: 'langchain_document',
    // `metadata.source` is provenance, not identity: it lands in `source_uri`
    // and the id stays positional, which is what the Python table does too.
    // The legacy `lcDocumentsToRagContext()` helper spells this differently, and
    // is left alone because it is published API.
    doc: { pageContent: 'lc body', metadata: { source: 'POL-1', score: 0.42 } },
    expected: { id: 'doc-1', preview: 'lc body', score: 0.42, source_uri: 'POL-1' },
  },
  {
    rule: 'langchain_document_with_id',
    doc: { pageContent: 'lc body', id: 'POL-9', metadata: { score: 0.42 } },
    expected: { id: 'POL-9', preview: 'lc body', score: 0.42 },
  },
  {
    rule: 'preview_object',
    doc: { preview: 'already a preview', id: 'P-1' },
    expected: { id: 'P-1', preview: 'already a preview' },
  },
  {
    rule: 'text_node',
    doc: { text: 'bare text node', node_id: 'T-1' },
    expected: { id: 'T-1', preview: 'bare text node' },
  },
  {
    rule: 'object',
    doc: { content: 'content-keyed body', doc_id: 'O-1', similarity: 0.5 },
    expected: { id: 'O-1', preview: 'content-keyed body', score: 0.5 },
  },
];

beforeEach(() => clear());

describe('coercion table', () => {
  for (const { rule, doc, expected } of CASES) {
    it(`reads a ${rule}`, () => {
      expect(coerceOne(doc)).toEqual(expected);
    });
  }

  it('every coercion rule has a case', () => {
    const covered = new Set(CASES.map((c) => c.rule));
    expect(COERCIONS.filter((rule) => !covered.has(rule.name)).map((r) => r.name)).toEqual([]);
  });

  it('reads a `body` key and a `pageContent` key alike', () => {
    expect(coerceOne({ body: 'body-keyed' }).preview).toBe('body-keyed');
    expect(coerceOne({ pageContent: 'page-keyed' }).preview).toBe('page-keyed');
  });

  it('never takes the preview from metadata, which would double the body', () => {
    const doc = coerceOne({ pageContent: 'real body', metadata: { text: 'metadata body' } });
    expect(doc.preview).toBe('real body');
  });

  it("truncates a preview to the contract's cap", () => {
    const doc = coerceOne('x'.repeat(MAX_PREVIEW_CHARS + 500));
    expect((doc.preview as string).length).toBe(MAX_PREVIEW_CHARS);
  });

  it('assigns a positional id when the document has none', () => {
    clear();
    declareRetrieval(['one', 'two'], { corpus: 'c' });
    const docs = buildRagContext(snapshot())!.docs as Record<string, unknown>[];
    expect(docs.map((d) => d.id)).toEqual(['doc-1', 'doc-2']);
  });

  it('drops a document with no readable text rather than sending it', () => {
    clear();
    declareRetrieval([{ metadata: { source: 'S' } }, 'kept'], { corpus: 'c' });
    const docs = buildRagContext(snapshot())!.docs as Record<string, unknown>[];
    expect(docs).toHaveLength(1);
    expect(docs[0].preview).toBe('kept');
  });

  it('drops a score the contract cannot describe, keeping the document', () => {
    expect(coerceOne({ text: 't', score: 1e9 })).toEqual({ id: 'doc-1', preview: 't' });
    expect(coerceOne({ text: 't', score: Number.NaN })).toEqual({ id: 'doc-1', preview: 't' });
    expect(coerceOne({ text: 't', score: true })).toEqual({ id: 'doc-1', preview: 't' });
    expect(coerceOne({ text: 't', score: '0.25' })).toMatchObject({ score: 0.25 });
  });

  it('keeps a hex hash and drops one that is not', () => {
    expect(coerceOne({ text: 't', hash: 'deadbeef' })).toMatchObject({ hash: 'deadbeef' });
    expect(coerceOne({ text: 't', hash: 'not-a-digest' }).hash).toBeUndefined();
  });

  it('treats a single unwrapped document as one document, not one per character', () => {
    clear();
    declareRetrieval('abc', { corpus: 'c' });
    expect(buildRagContext(snapshot())!.docs).toHaveLength(1);
  });
});

describe('declareRetrieval', () => {
  it('refuses a blank corpus, because the contract requires one', () => {
    expect(() => declareRetrieval('d', { corpus: '  ' })).toThrow(/non-empty corpus/);
  });

  it("refuses a source outside the contract's enum", () => {
    expect(() => declareRetrieval('d', { corpus: 'c', source: 'vector-db' as never })).toThrow(
      /not a rag_context.v1 value/
    );
    for (const source of SOURCES) {
      clear();
      expect(() => declareRetrieval('d', { corpus: 'c', source })).not.toThrow();
    }
  });

  it('defaults source to manual', () => {
    declareRetrieval('d', { corpus: 'c' });
    expect(buildRagContext(snapshot())!.source).toBe('manual');
  });

  it('declares nothing when every document was unreadable', () => {
    declareRetrieval([{ metadata: {} }], { corpus: 'c' });
    expect(snapshot()).toHaveLength(0);
  });
});

describe('buildRagContext', () => {
  it('folds one event into a valid v1 block', () => {
    declareRetrieval(['a'], { corpus: 'policy_docs_v2', query: 'eligibility' });
    const context = buildRagContext(snapshot())!;
    assertValidRagContext(context);
    expect(context).toMatchObject({ v: 1, corpus: 'policy_docs_v2', query: 'eligibility' });
  });

  it('joins distinct corpora rather than misattributing one to the other', () => {
    declareRetrieval(['a'], { corpus: 'policies' });
    declareRetrieval(['b'], { corpus: 'contracts' });
    expect(buildRagContext(snapshot())!.corpus).toBe('policies+contracts');
  });

  it('falls back to source=other when the events disagree', () => {
    declareRetrieval(['a'], { corpus: 'c', source: 'manual' });
    declareRetrieval(['b'], { corpus: 'c', source: 'langchain' });
    expect(buildRagContext(snapshot())!.source).toBe('other');
  });

  it('takes the query nearest the call', () => {
    declareRetrieval(['a'], { corpus: 'c', query: 'first' });
    declareRetrieval(['b'], { corpus: 'c', query: 'second' });
    expect(buildRagContext(snapshot())!.query).toBe('second');
  });

  it('dedupes by (id, preview), first occurrence kept, both events surviving', () => {
    declareRetrieval([{ id: 'D1', text: 'same' }], { corpus: 'c' });
    declareRetrieval(
      [
        { id: 'D1', text: 'same' },
        { id: 'D2', text: 'new' },
      ],
      { corpus: 'c' }
    );
    expect(snapshot()).toHaveLength(2);
    const docs = buildRagContext(snapshot())!.docs as Record<string, unknown>[];
    expect(docs.map((d) => d.id)).toEqual(['D1', 'D2']);
  });

  it('does not dedupe two positional doc-1s from unrelated retrievals', () => {
    declareRetrieval(['alpha'], { corpus: 'c' });
    declareRetrieval(['beta'], { corpus: 'c' });
    const docs = buildRagContext(snapshot())!.docs as Record<string, unknown>[];
    expect(docs.map((d) => d.preview)).toEqual(['alpha', 'beta']);
  });

  it('returns undefined rather than an empty docs array', () => {
    expect(buildRagContext([])).toBeUndefined();
  });

  it("never emits more than the contract's maxItems", () => {
    declareRetrieval(
      Array.from({ length: 200 }, (_, i) => ({ id: `D${i}`, text: `t${i}` })),
      { corpus: 'c' }
    );
    const context = buildRagContext(snapshot())!;
    expect(context.docs).toHaveLength(MAX_DOCS);
    assertValidRagContext(context);
  });
});
