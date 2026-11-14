import { describe, expect, it } from 'vitest';
import { tracer, buildContextHeaders, getWorkflowContextFromEnv } from '../src/index';

/**
 * Tracer header injection — Python-SDK wire parity (src/trustgate/context.py is the
 * reference): a trace id is ALWAYS emitted at origin, and inside a span the parent-id
 * header carries the REAL parent span ("" for a root), never the span's own id.
 *
 * Spans are opened via `await tracer.span(...)` and asserted INSIDE the callback so no
 * AsyncLocalStorage state leaks between cases (same discipline as a2a.test.ts).
 */

/** Minimal workflow context for header-builder assertions. */
const ctx = () => getWorkflowContextFromEnv();

describe('origin trace id', () => {
  it('emits a non-empty x-trustgate-trace-id with no active span (Python parity)', () => {
    const h = buildContextHeaders(ctx());
    expect(h['x-trustgate-trace-id']).toBeTruthy();
    expect(typeof h['x-trustgate-trace-id']).toBe('string');
    expect(h['x-trustgate-trace-id'].length).toBeGreaterThan(0);
  });
});

describe('span header injection', () => {
  it('root span: span-id is the root span, parent-id is empty, and they differ', async () => {
    await tracer.span('root', async (rootSpanId) => {
      const h = buildContextHeaders(ctx());
      expect(h['x-trustgate-span-id']).toBe(rootSpanId);
      expect(h['x-trustgate-parent-id']).toBe('');
      expect(h['x-trustgate-parent-id']).not.toBe(h['x-trustgate-span-id']);
    });
  });

  it('nested span: parent-id is the REAL outer span, distinct from span-id', async () => {
    await tracer.span('outer', async (outerSpanId) => {
      await tracer.span('inner', async (innerSpanId) => {
        const h = buildContextHeaders(ctx());
        expect(h['x-trustgate-span-id']).toBe(innerSpanId);
        expect(h['x-trustgate-parent-id']).toBe(outerSpanId);
        expect(h['x-trustgate-parent-id']).not.toBe(h['x-trustgate-span-id']);
      });
    });
  });
});
