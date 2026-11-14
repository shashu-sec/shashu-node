/**
 * IDENTITY S1 step 0 — prove today's SDK cannot take a cloud pass.
 *
 * Fails on origin/main: there is no tokenProvider option, and shashuFetch
 * bakes Authorization at construction.
 */
import { describe, expect, it } from 'vitest';
import { Shashu } from '../src/client.js';
import { shashuFetch } from '../src/fetch.js';
import type { ShashuConfig } from '../src/types.js';
import type { ShashuFetchOptions } from '../src/fetch.js';

describe('IDENTITY S1 step 0', () => {
  it('Shashu config accepts tokenProvider', () => {
    const sample: ShashuConfig = {
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: () => 'pass',
    };
    expect(sample.tokenProvider).toBeTypeOf('function');
    const tg = new Shashu({
      baseUrl: 'http://127.0.0.1:9',
      tokenProvider: () => 'pass',
      retryPolicy: null,
    });
    expect(tg).toBeInstanceOf(Shashu);
  });

  it('shashuFetch does not bake authorization at construction', async () => {
    let n = 0;
    const fetch = shashuFetch({
      tokenProvider: () => {
        n += 1;
        return `pass-${n}`;
      },
    });
    expect(fetch).toBeTypeOf('function');
  });
});

// Compile-time: these lines fail `tsc` until the options exist. Runtime:
type _FetchHasProvider = ShashuFetchOptions['tokenProvider'];
type _ConfigHasProvider = ShashuConfig['tokenProvider'];
void 0 as unknown as _FetchHasProvider;
void 0 as unknown as _ConfigHasProvider;
