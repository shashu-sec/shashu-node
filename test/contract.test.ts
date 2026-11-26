/**
 * The vendored contract is the gateway's file, byte for byte.
 *
 * A copy that drifts is worse than no copy: the SDK would keep validating its
 * payloads against a schema the gateway no longer enforces, and the mismatch
 * would only show up as a rejection in a customer's stack. The digest is pinned
 * here, and `.gitattributes` marks `contracts/**` as `-text` so a Windows
 * checkout cannot silently rewrite the LFs and change it.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_CORPUS_CHARS, MAX_DOCS, MAX_PREVIEW_CHARS, MAX_QUERY_CHARS } from '../src/_bus.js';
import { SOURCES } from '../src/rag.js';
import { SCHEMA, SCHEMA_BYTES } from './helpers/gateway.js';

/** contracts/rag_context.v1.schema.json in the gateway repo, at v1. */
const DIGEST = '4cf08786149c40c3a046787f5bcbf1cde9e780bb25008a0abbc894237c8a4b3f';

describe('rag_context.v1 contract', () => {
  it("is the gateway's file byte for byte", () => {
    expect(createHash('sha256').update(SCHEMA_BYTES).digest('hex')).toBe(DIGEST);
  });

  it("SOURCES is exactly the schema's source enum", () => {
    expect([...SOURCES]).toEqual(SCHEMA.properties.source.enum);
  });

  it("the bus caps are the schema's caps", () => {
    expect(MAX_DOCS).toBe(SCHEMA.properties.docs.maxItems);
    expect(MAX_PREVIEW_CHARS).toBe(SCHEMA.properties.docs.items.properties.preview.maxLength);
    expect(MAX_CORPUS_CHARS).toBe(SCHEMA.properties.corpus.maxLength);
    expect(MAX_QUERY_CHARS).toBe(SCHEMA.properties.query.maxLength);
  });

  it('names corpus and docs as required, which is why declareRetrieval demands a corpus', () => {
    expect(SCHEMA.required).toEqual(['corpus', 'docs']);
    expect(SCHEMA.properties.docs.items.required).toEqual(['id', 'preview']);
  });
});
