/** The retrieval bus: caps, trimming, isolation, and the zero-cost guard. */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_DOCS,
  MAX_EVENTS,
  clear,
  hasEvents,
  push,
  runIsolated,
  runWith,
  snapshot,
  type RetrievalEvent,
} from '../src/_bus.js';

function event(corpus: string, count: number, source = 'manual'): RetrievalEvent {
  return {
    corpus,
    source,
    docs: Array.from({ length: count }, (_, i) => ({ id: `${corpus}-${i}`, preview: `p${i}` })),
  };
}

beforeEach(() => clear());

describe('bus', () => {
  it('is empty until something is pushed', () => {
    expect(hasEvents()).toBe(false);
    expect(snapshot()).toEqual([]);
  });

  it('ignores an event with no documents', () => {
    push({ corpus: 'c', source: 'manual', docs: [] });
    expect(hasEvents()).toBe(false);
  });

  it('keeps the newest MAX_EVENTS declarations', () => {
    for (let i = 0; i < MAX_EVENTS + 3; i += 1) push(event(`c${i}`, 1));
    const kept = snapshot();
    expect(kept).toHaveLength(MAX_EVENTS);
    expect(kept[0].corpus).toBe('c3');
    expect(kept[kept.length - 1].corpus).toBe(`c${MAX_EVENTS + 2}`);
  });

  it('caps documents across all events at MAX_DOCS, newest kept', () => {
    push(event('old', 40));
    push(event('new', 40));
    const docs = snapshot().flatMap((e) => e.docs);
    expect(docs).toHaveLength(MAX_DOCS);
    // The newest event survives whole; the older one is trimmed from its head.
    expect(docs.filter((d) => d.id.startsWith('new-'))).toHaveLength(40);
    expect(docs[0].id).toBe('old-16');
  });

  it('keeps the tail of a single oversized declaration', () => {
    push(event('big', 100));
    const docs = snapshot().flatMap((e) => e.docs);
    expect(docs).toHaveLength(MAX_DOCS);
    expect(docs[docs.length - 1].id).toBe('big-99');
  });

  it('clear() empties it', () => {
    push(event('c', 1));
    clear();
    expect(hasEvents()).toBe(false);
  });

  it('runWith seeds a scope and nothing inside it escapes', async () => {
    push(event('first', 1));
    await runWith(snapshot(), async () => {
      push(event('second', 1));
      expect(snapshot()).toHaveLength(2);
    });
    expect(snapshot().map((e) => e.corpus)).toEqual(['first']);
  });

  it('clear() empties the store the CALLER holds, from wherever it is called', async () => {
    push(event('c', 1));
    // The joiner runs deep inside a provider SDK; this is that shape.
    await (async () => {
      await new Promise((r) => setTimeout(r, 1));
      clear();
    })();
    expect(hasEvents()).toBe(false);
  });

  it('a declaration made in a helper that already awaited does NOT reach the caller', async () => {
    // Measured, and the reason isolateRetrieval() exists. Node binds a store to
    // the current async frame, where Python binds a ContextVar to the task.
    await (async () => {
      await new Promise((r) => setTimeout(r, 1));
      push(event('in-helper', 1));
    })();
    expect(hasEvents()).toBe(false);
  });

  it("a helper's push does not write into a store the caller is already holding", async () => {
    // The difference between replacing the store and mutating it. Mutating an
    // inherited one is how a fan-out ends up sharing a single events array, so
    // this is asserted directly rather than raced for.
    push(event('caller', 1));
    await (async () => {
      await new Promise((r) => setTimeout(r, 1));
      push(event('helper', 1));
    })();
    expect(snapshot().map((e) => e.corpus)).toEqual(['caller']);
  });

  it('...but it does inside a scope, because the store is shared there', async () => {
    await runIsolated(async () => {
      await (async () => {
        await new Promise((r) => setTimeout(r, 1));
        push(event('in-helper', 1));
      })();
      expect(snapshot().map((e) => e.corpus)).toEqual(['in-helper']);
    });
  });

  it('keeps eight interleaved tasks isolated once each has crossed an await', async () => {
    // The ordinary shape: documents come from an awaited retrieval, so the
    // declaration that follows is already past the task's first suspension.
    const seen = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (async () => {
          await new Promise((r) => setTimeout(r, (8 - i) * 3));
          push(event(`task-${i}`, 1));
          await new Promise((r) => setTimeout(r, 1));
          return snapshot().map((e) => e.corpus);
        })()
      )
    );
    expect(seen).toEqual(Array.from({ length: 8 }, (_, i) => [`task-${i}`]));
  });

  it('runIsolated gives a hard boundary an enterWith cannot leak out of', async () => {
    await runIsolated(async () => {
      push(event('inside', 1));
      expect(hasEvents()).toBe(true);
    });
    expect(hasEvents()).toBe(false);
  });

  it('stores an immutable snapshot, so a caller cannot reach in and mutate it', () => {
    push(event('c', 1));
    expect(() => (snapshot() as RetrievalEvent[]).push(event('x', 1))).toThrow();
  });
});
