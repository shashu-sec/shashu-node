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
  it('emits a non-empty x-shashu-trace-id with no active span (Python parity)', () => {
    const h = buildContextHeaders(ctx());
    expect(h['x-shashu-trace-id']).toBeTruthy();
    expect(typeof h['x-shashu-trace-id']).toBe('string');
    expect(h['x-shashu-trace-id'].length).toBeGreaterThan(0);
  });
});

describe('span header injection', () => {
  it('root span: span-id is the root span, parent-id is empty, and they differ', async () => {
    await tracer.span('root', async (rootSpanId) => {
      const h = buildContextHeaders(ctx());
      expect(h['x-shashu-span-id']).toBe(rootSpanId);
      expect(h['x-shashu-parent-id']).toBe('');
      expect(h['x-shashu-parent-id']).not.toBe(h['x-shashu-span-id']);
    });
  });

  it('nested span: parent-id is the REAL outer span, distinct from span-id', async () => {
    await tracer.span('outer', async (outerSpanId) => {
      await tracer.span('inner', async (innerSpanId) => {
        const h = buildContextHeaders(ctx());
        expect(h['x-shashu-span-id']).toBe(innerSpanId);
        expect(h['x-shashu-parent-id']).toBe(outerSpanId);
        expect(h['x-shashu-parent-id']).not.toBe(h['x-shashu-span-id']);
      });
    });
  });
});
