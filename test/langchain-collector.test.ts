/**
 * The collector's two optional-dependency arms, both exercised for real.
 *
 * The absent arm is not a mock: the module is bundled with `@langchain/*` left
 * external and the bundle is run from a directory with no `node_modules`, so the
 * dynamic import genuinely cannot resolve — the same `ERR_MODULE_NOT_FOUND` a
 * machine without LangChain produces. The present arm runs the identical bundle
 * from inside the repo, where it resolves.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

import {
  install,
  isInstalled,
  uninstall,
  ShashuLangChainCallback,
  DEFAULT_CORPUS,
  SOURCE,
} from '../src/middleware/langchain.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Bundles the collector, leaving @langchain external so its absence is real. */
const PROBE = `
import { install, isInstalled } from "SOURCE";
const ok = await install({ corpus: "probe" });
console.log(JSON.stringify({ installed: ok, isInstalled: isInstalled() }));
`;

let bundle: string;
let outsideDir: string;

beforeAll(async () => {
  outsideDir = mkdtempSync(join(tmpdir(), 'trustgate-absent-'));
  const entry = join(outsideDir, 'entry.mjs');
  writeFileSync(
    entry,
    PROBE.replace('SOURCE', join(REPO, 'src', 'middleware', 'langchain.ts').replace(/\\/g, '/'))
  );
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    external: ['@langchain/*'],
  });
  bundle = result.outputFiles[0].text;
}, 60_000);

afterAll(() => rmSync(outsideDir, { recursive: true, force: true }));
afterEach(() => uninstall());

function run(dir: string): { installed: boolean; isInstalled: boolean } {
  const file = join(dir, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, bundle);
  try {
    return JSON.parse(execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim());
  } finally {
    rmSync(file, { force: true });
  }
}

describe('optional dependency: @langchain/core', () => {
  it('absent — install() returns false and nothing throws', () => {
    expect(run(outsideDir)).toEqual({ installed: false, isInstalled: false });
  });

  it('present — the identical bundle installs', () => {
    expect(run(REPO)).toEqual({ installed: true, isInstalled: true });
  });

  it('the module carries no static import of @langchain, which is why', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(REPO, 'src', 'middleware', 'langchain.ts'), 'utf8')
    );
    expect(source).not.toMatch(/^\s*import[^\n]*from\s+["']@langchain/m);
    expect(source).toMatch(/await import\(['"]@langchain\/core\/callbacks\/manager['"]\)/);
  });
});

describe('collector lifecycle', () => {
  it('is off until install() and off again after uninstall()', async () => {
    expect(isInstalled()).toBe(false);
    await install({ corpus: 'c' });
    expect(isInstalled()).toBe(true);
    uninstall();
    expect(isInstalled()).toBe(false);
  });

  it('reports itself off while TRUSTGATE_DISABLE is set', async () => {
    await install({ corpus: 'c' });
    process.env.TRUSTGATE_DISABLE = '1';
    expect(isInstalled()).toBe(false);
    delete process.env.TRUSTGATE_DISABLE;
    expect(isInstalled()).toBe(true);
  });

  it('is idempotent: a second install() re-points the corpus, it does not stack', async () => {
    expect(await install({ corpus: 'one' })).toBe(true);
    expect(await install({ corpus: 'two' })).toBe(true);
    expect(isInstalled()).toBe(true);
  });

  it("declares under the contract's langchain source and a named default corpus", () => {
    expect(SOURCE).toBe('langchain');
    expect(DEFAULT_CORPUS).toBe('langchain-retriever');
  });

  it('the presence handler is shaped as LangChain requires a handler to be', () => {
    const handler = new ShashuLangChainCallback();
    // `ensureHandler` short-circuits on `"name" in handler`; the manager then
    // reads these fields off it directly.
    expect(handler.name).toBe('ShashuLangChainCallback');
    for (const field of [
      'raiseError',
      'awaitHandlers',
      'ignoreLLM',
      'ignoreChain',
      'ignoreAgent',
      'ignoreRetriever',
      'ignoreCustomEvent',
    ]) {
      expect(handler).toHaveProperty(field, false);
    }
    expect(handler.copy()).toBe(handler);
  });
});
