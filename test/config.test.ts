/**
 * Config guards: no default gateway address, fail loud, kill switch.
 *
 * Sibling of the Python SDK's tests/test_config_guards.py, which is the
 * reference for the behaviour and the error wording.
 *
 * SHASHU is self-hosted. An SDK that quietly falls back to a vendor-branded
 * hostname when the operator forgot to configure one sends that operator's
 * prompts to a host they never named. These tests pin the three behaviours that
 * make that impossible — resolution order, the loud failure, and the off switch
 * — at every one of the seven sites that used to carry the default.
 *
 * Nothing here touches the network: test/setup.ts makes any fetch or socket
 * connect an immediate test error.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Shashu, ShashuConfigError, ShashuError } from '../src/index';
import { createShashuAnthropicConfig } from '../src/middleware/anthropic';
import { createShashuGeminiConfig } from '../src/middleware/google';
import { createShashuLangChainConfig } from '../src/middleware/langchain';
import { createShashuOpenAIOptions } from '../src/middleware/vercel-ai';

const ENV_VARS = [
  'SHASHU_BASE_URL',
  'SHASHU_API_KEY',
  'SHASHU_DISABLE',
  'SHASHU_BASE_URL',
  'SHASHU_API_KEY',
  'SHASHU_DISABLE',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of ENV_VARS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.resetModules();
});

/**
 * Every entry point that must refuse to guess an address, with the entry-point
 * name its error is required to name. The tracer is deliberately absent: it
 * resolves OPTIONALLY (see its own describe block) because it is constructed at
 * module import, where throwing would break `import "@trustgateai/sdk"` itself.
 */
const REQUIRING_SITES: Array<[string, (baseUrl?: string) => { baseUrl?: string }]> = [
  [
    'new Shashu()',
    (baseUrl) => ({ baseUrl: new Shashu({ apiKey: 'shashu_sk_not_a_real_key', baseUrl }).baseUrl }),
  ],
  [
    'createShashuAnthropicConfig()',
    (baseUrl) => ({ baseUrl: createShashuAnthropicConfig({ baseUrl }).baseURL }),
  ],
  [
    'createShashuGeminiConfig()',
    (baseUrl) => ({ baseUrl: createShashuGeminiConfig({ baseUrl }).baseUrl }),
  ],
  [
    'createShashuLangChainConfig()',
    (baseUrl) => ({ baseUrl: createShashuLangChainConfig({ baseUrl }).baseURL }),
  ],
  [
    'createShashuOpenAIOptions()',
    (baseUrl) => ({ baseUrl: createShashuOpenAIOptions({ baseUrl }).baseURL }),
  ],
];

// --------------------------------------------------------------------------- //
// 1. The error type
// --------------------------------------------------------------------------- //

describe('ShashuConfigError', () => {
  it('is a ShashuError, so existing catch clauses still see it', () => {
    const err = new ShashuConfigError('x');
    expect(err).toBeInstanceOf(ShashuError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ShashuConfigError');
  });

  it('survives the prototype dance, so instanceof works across bundles', () => {
    try {
      new Shashu({ apiKey: 'shashu_sk_not_a_real_key' });
      expect.unreachable('expected a ShashuConfigError');
    } catch (e) {
      expect(e).toBeInstanceOf(ShashuConfigError);
    }
  });

  it('carries status 0 — nothing was sent, so there is no HTTP status', () => {
    expect(new ShashuConfigError('x').status).toBe(0);
  });
});

// --------------------------------------------------------------------------- //
// 2. Unset address + no option -> loud failure that names how to fix it
// --------------------------------------------------------------------------- //

describe.each(REQUIRING_SITES)('%s with nothing configured', (entryPoint, call) => {
  it('throws ShashuConfigError rather than resolving to a host', () => {
    expect(() => call()).toThrow(ShashuConfigError);
  });

  it('names the env var, the option and the entry point', () => {
    try {
      call();
      expect.unreachable('expected a ShashuConfigError');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('SHASHU_BASE_URL');
      expect(message).toContain('baseUrl');
      expect(message).toContain(entryPoint);
    }
  });

  it('hands the operator no hostname to copy-paste', () => {
    try {
      call();
      expect.unreachable('expected a ShashuConfigError');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toContain('trustgate.ai');
      expect(message).not.toContain('://');
    }
  });
});

// --------------------------------------------------------------------------- //
// 3. Resolution order: explicit option -> env -> throw
// --------------------------------------------------------------------------- //

describe.each(REQUIRING_SITES)('%s resolution order', (_entryPoint, call) => {
  it('prefers the explicit option over the environment', () => {
    process.env.SHASHU_BASE_URL = 'https://from-env.invalid';
    expect(call('https://from-argument.invalid').baseUrl).toBe('https://from-argument.invalid');
  });

  it('uses the environment when no option is passed', () => {
    process.env.SHASHU_BASE_URL = 'https://from-env.invalid';
    expect(call().baseUrl).toBe('https://from-env.invalid');
  });

  it('strips a trailing slash, as before', () => {
    expect(call('https://gw.invalid/').baseUrl).toBe('https://gw.invalid');
  });

  it('treats a blank env var as unset rather than as an address', () => {
    process.env.SHASHU_BASE_URL = '   ';
    expect(() => call()).toThrow(ShashuConfigError);
  });
});

// --------------------------------------------------------------------------- //
// 4. The tracer — the one site that resolves optionally
// --------------------------------------------------------------------------- //

describe('tracer', () => {
  /** Fresh module: the Tracer reads the environment in its constructor. */
  async function freshTracer() {
    vi.resetModules();
    return (await import('../src/tracer')).tracer;
  }

  it('has no gateway url when nothing is configured', async () => {
    const tracer = await freshTracer();
    expect(tracer.gatewayUrl).toBeUndefined();
  });

  it('posts nothing when it has no address, instead of guessing one', async () => {
    const tracer = await freshTracer();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    tracer.configure({ apiKey: 'shashu_sk_not_a_real_key' });
    await tracer.span('unit-test-span', async () => {});
    await tracer.flush();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads SHASHU_BASE_URL when it is set', async () => {
    process.env.SHASHU_BASE_URL = 'https://from-env.invalid/';
    const tracer = await freshTracer();
    expect(tracer.gatewayUrl).toBe('https://from-env.invalid');
  });

  it('configure() still wins over the environment', async () => {
    process.env.SHASHU_BASE_URL = 'https://from-env.invalid';
    const tracer = await freshTracer();
    tracer.configure({ baseUrl: 'https://configured.invalid/' });
    expect(tracer.gatewayUrl).toBe('https://configured.invalid');
  });
});

// --------------------------------------------------------------------------- //
// 5. SHASHU_DISABLE — the kill switch
// --------------------------------------------------------------------------- //

describe('SHASHU_DISABLE=1', () => {
  const MIDDLEWARES: Array<[string, () => Record<string, unknown>]> = [
    ['createShashuAnthropicConfig()', () => createShashuAnthropicConfig({ apiKey: 'shashu_sk_x' })],
    ['createShashuGeminiConfig()', () => createShashuGeminiConfig({ apiKey: 'shashu_sk_x' })],
    ['createShashuLangChainConfig()', () => createShashuLangChainConfig({ apiKey: 'shashu_sk_x' })],
    ['createShashuOpenAIOptions()', () => createShashuOpenAIOptions({ apiKey: 'shashu_sk_x' })],
  ];

  it.each(MIDDLEWARES)('%s returns cleanly with no address configured at all', (_name, call) => {
    process.env.SHASHU_DISABLE = '1';
    expect(() => call()).not.toThrow();
  });

  it.each(MIDDLEWARES)(
    '%s hands back nothing that re-points the provider client',
    (_name, call) => {
      process.env.SHASHU_DISABLE = '1';
      process.env.SHASHU_BASE_URL = 'https://gw.invalid';

      // A disabled SDK leaves the provider client exactly as it was: no base URL
      // override, no Shashu context headers, and NOT the caller's shashu_sk_ key
      // (which would then be sent to the provider directly).
      expect(call()).toEqual({});
    }
  );

  it.each([
    ['true', 'true'],
    ['yes', 'yes'],
    ['on', 'on'],
    ['uppercase TRUE', 'TRUE'],
  ])('accepts %s as off, because platform tooling emits it', (_label, value) => {
    process.env.SHASHU_DISABLE = value;
    expect(createShashuAnthropicConfig({ apiKey: 'shashu_sk_x' })).toEqual({});
  });

  it('does not read an unrelated value as off', () => {
    process.env.SHASHU_DISABLE = '0';
    expect(() => createShashuAnthropicConfig({ apiKey: 'shashu_sk_x' })).toThrow(ShashuConfigError);
  });

  it('stops the tracer flushing even with an address and a key', async () => {
    process.env.SHASHU_DISABLE = '1';
    process.env.SHASHU_BASE_URL = 'https://gw.invalid';
    vi.resetModules();
    const { tracer } = await import('../src/tracer');
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    tracer.configure({ apiKey: 'shashu_sk_not_a_real_key' });
    await tracer.span('unit-test-span', async () => {});
    await tracer.flush();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still gives a disabled app its trace context, so reading it does not break', async () => {
    process.env.SHASHU_DISABLE = '1';
    vi.resetModules();
    const { tracer } = await import('../src/tracer');

    await tracer.span('unit-test-span', async (spanId) => {
      expect(spanId).toBeTruthy();
      expect(tracer.traceId).toBeTruthy();
    });
  });

  it('does NOT switch off the direct client, which has no other destination', () => {
    // Parity with Python: the kill switch covers the instrumentation entry
    // points (the middlewares, the tracer). `new Shashu()` is an explicit
    // "send this to my gateway" and there is nothing for it to no-op INTO, so
    // it still refuses an unnamed address rather than silently doing nothing.
    process.env.SHASHU_DISABLE = '1';
    expect(() => new Shashu({ apiKey: 'shashu_sk_not_a_real_key' })).toThrow(ShashuConfigError);
  });
});

// --------------------------------------------------------------------------- //
// 6. The default host is gone from every runtime path
// --------------------------------------------------------------------------- //

describe('the vendor hostname', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');

  /** Every file that ships or runs: all of src/, plus the root-level scripts. */
  function runtimeFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|js|mjs|cjs)$/.test(entry)) out.push(full);
      }
    };
    walk(path.join(repoRoot, 'src'));
    for (const entry of readdirSync(repoRoot)) {
      const full = path.join(repoRoot, entry);
      if (statSync(full).isFile() && /\.(js|mjs|cjs)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('scans a non-empty set of files, so a green result cannot be silence', () => {
    const files = runtimeFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('types.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('credential.ts'))).toBe(true);
  });

  it('appears in no runtime code path', () => {
    const offenders = runtimeFiles().filter((f) =>
      readFileSync(f, 'utf8').includes('trustgate.ai')
    );
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it('is not re-exported as DEFAULT_GATEWAY_URL', async () => {
    const index = (await import('../src/index')) as Record<string, unknown>;
    expect(Object.keys(index)).not.toContain('DEFAULT_GATEWAY_URL');
  });
});

// --------------------------------------------------------------------------- //
// 7. The guard itself
// --------------------------------------------------------------------------- //

describe('network guard', () => {
  it('makes a fetch from a test an immediate failure', async () => {
    await expect(fetch('https://should-never-be-reached.invalid')).rejects.toThrow(
      /attempted to reach the network/
    );
  });
});
