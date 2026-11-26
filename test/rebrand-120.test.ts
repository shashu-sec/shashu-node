import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Shashu, ShashuAuthenticationError } from '../src/index';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASE = 'https://gateway.example';
const KEY = 'shashu_sk_rebrand_test_key_not_live';
const COPYRIGHT = 'Trustgate AI LLC';
const OLD_PREFIX = 'Trust' + 'Gate Provider Error:';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SDK 1.2.0 rebrand', () => {
  it('a: SHASHU Provider Error prefix is classified as pass-through', async () => {
    const err = new ShashuAuthenticationError(
      'SHASHU Provider Error: upstream refused the stored credential',
      401,
      { error: { type: 'invalid_request_error', message: 'SHASHU Provider Error: x' } }
    );
    expect(err.isProviderPassthrough).toBe(true);
    const legacy = new ShashuAuthenticationError(OLD_PREFIX + ' upstream refused', 401);
    expect(legacy.isProviderPassthrough).toBe(false);
  });

  it('a: HTTP pass-through raises authentication pass-through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(401, {
          error: {
            message: 'SHASHU Provider Error: Invalid API key',
            type: 'authentication_error',
            code: '401',
          },
          choices: [],
        })
      )
    );
    const client = new Shashu({ baseUrl: BASE, apiKey: KEY, retryPolicy: null });
    const caught = await client
      .fetch('/v1/chat/completions', { method: 'POST', body: '{}' })
      .catch((e) => e);
    expect(caught).toBeInstanceOf(ShashuAuthenticationError);
    expect((caught as ShashuAuthenticationError).isProviderPassthrough).toBe(true);
    expect(
      String(caught).startsWith('SHASHU Provider Error:') ||
        (caught as Error).message.startsWith('SHASHU Provider Error:')
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it('c: Authorization sends shashu_sk_ Bearer', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        id: 'c',
        choices: [{ message: { role: 'assistant', content: 'ok' }, index: 0 }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new Shashu({ baseUrl: BASE, apiKey: KEY, retryPolicy: null });
    await client.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(KEY.startsWith('shashu_sk_')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('d: no trustgate in shipped tree except Trustgate AI LLC', () => {
    const hits: string[] = [];
    const scan = (label: string, text: string) => {
      const stripped = text.replace(new RegExp(COPYRIGHT, 'gi'), '');
      const re = /trustgate/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped))) {
        hits.push(`${label}:${m.index}:${stripped.slice(Math.max(0, m.index - 12), m.index + 24)}`);
      }
    };
    for (const name of ['README.md', 'CHANGELOG.md', 'NOTICE', 'LICENSE', 'package.json']) {
      scan(name, readFileSync(join(ROOT, name), 'utf8'));
    }
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir)) {
        const p = join(dir, ent);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (p.endsWith('.ts') || p.endsWith('.md') || p.endsWith('.json')) {
          scan(relative(ROOT, p).replaceAll('\\', '/'), readFileSync(p, 'utf8'));
        }
      }
    };
    walk(join(ROOT, 'src'));
    walk(join(ROOT, 'contracts'));
    expect(hits).toEqual([]);
  });
});
