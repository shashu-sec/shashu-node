/**
 * The vendored contract pages are the gateway's pages, byte for byte.
 *
 * `contracts/rag_context.v1.schema.json` has been pinned since it was vendored
 * (`test/contract.test.ts`). The two markdown contracts beside it were not, and
 * both had drifted by 2026-09-17:
 *
 * - `decision-envelope.v1.md` said `CODES` was thirty-six values. It is
 *   thirty-eight; `reasoning_not_representable` and
 *   `provider_state_uninspectable` had landed since. That page is generated in
 *   the gateway repo from `app.contract.envelope.CODES`.
 * - `sdk-surface.v1.md` carried a LangChain carve-out paragraph the canonical
 *   page does not have, pointing at `docs/RULING-RUNTIME-REWIRING.md` — a path
 *   that resolves in THIS repository and nowhere else. It was dropped on
 *   refresh; that ruling document is its home and states it in full. Its
 *   session-table row was the reverse case — a real gap in the canonical page —
 *   and was added there rather than dropped here.
 *
 * What this half can and cannot prove: nothing here can reach the gateway
 * repository, so it cannot prove the copy is CURRENT. It proves it is
 * UNMODIFIED. The other half runs in the gateway repo, where
 * `contracts/VENDORED-DIGESTS.md` records these same digests and
 * `scripts/ci/check_vendored_contracts.py` — a step of the REQUIRED
 * `static fences` job — fails when a contract changes and these copies are not
 * refreshed in the same change.
 *
 * Digests are over LF-normalised bytes, so a CRLF checkout cannot change them.
 * `.gitattributes` marks `contracts/**` as `-text` for the same reason; the
 * normalisation means the pin holds even if that ever lapses.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isShashuBlock } from '../src/index.js';

/** Recorded in the gateway repo at contracts/VENDORED-DIGESTS.md. */
const PINNED: Record<string, string> = {
  'sdk-surface.v1.md': '166630b34367bfec8499c996badaece5250102d4aa71f68be6519b243e75008f',
  'decision-envelope.v1.md': 'fa98318efb952ff586116adaf5cd2b6f067f5847bbfd475f16b46dd38e56ca78',
  'rag_context.v1.schema.json': '8c9729f6c243061710387d63f8f43301bb2472abffdf3aa2808979dce6305b26',
  'memory_context.v1.schema.json':
    'b77034e097648bed41d44d1733dd673b45133cc15fbbf937338231bc9d9edd49',
};

function read(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../contracts/${name}`, import.meta.url)));
}

function digest(name: string): string {
  const normalised = Buffer.from(read(name).toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(normalised).digest('hex');
}

describe('vendored contracts', () => {
  for (const [name, expected] of Object.entries(PINNED)) {
    it(`${name} is unmodified`, () => {
      expect(digest(name)).toBe(expected);
    });
  }

  it('the envelope page carries the generated code list, not a hand-typed count', () => {
    const text = read('decision-envelope.v1.md').toString('utf8');
    expect(text).toContain('BEGIN GENERATED CODES');
    // 46 since gateway identity/i13-fix (fc32a87eb) added the six pass_* refusal codes.
    expect(text).toContain('`CODES` today is 46 values');
    expect(text).toContain('pass_expired');
    expect(text).toContain('reasoning_not_representable');
    expect(text).toContain('provider_state_uninspectable');
  });

  it("the surface page names this SDK's session form", () => {
    // The row that was missing from the canonical page, added there in the
    // same pass that refreshed this copy.
    const text = read('sdk-surface.v1.md').toString('utf8');
    expect(text).toContain('| Node | `new TrustGate({ sessionId })`');
  });

  it('the block predicate asks the decision, and holds no copy of the code list', () => {
    // The contract forbids a client holding or branching on `code`. This is
    // why a stale vendored code list changed no behaviour — and it is the
    // property the refresh must not have disturbed.
    //
    // Node's predicate is not decision-ONLY, and that is by design: it asks
    // `shashuDecision` first, then falls back to the provider's own
    // content_filter shapes for an error that never carried a Shashu
    // envelope. What it must never do is branch on a `code` value.
    const source = isShashuBlock.toString();
    expect(source).toContain('shashuDecision');
    for (const code of ['prompt_injection', 'jailbreak', 'dlp', 'egress_denied', 'CODES']) {
      expect(source).not.toContain(code);
    }
  });
});
