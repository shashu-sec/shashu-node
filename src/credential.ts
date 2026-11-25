/**
 * SHASHU key vs cloud-pass credentials.
 *
 * The SDK never talks to Entra, Google or AWS. A tokenProvider returns the
 * current pass; this module caches it, refreshes it 60 seconds before exp,
 * and retries a request ONCE -- after fetching a new pass -- when the gateway
 * refuses the pass as expired.
 *
 * The gateway names every pass refusal with a fixed `error.code` (one of
 * {@link PASS_CODES}) on an HTTP 401, beside its own sentence. Only
 * `pass_expired` is worth a retry: a fresh pass fixes it. Every other code
 * throws ShashuAuthenticationError carrying `.code` and the gateway's message
 * unchanged. A 401 with no such code (an older gateway) is never retried.
 */

import { ShashuConfigError } from './exceptions.js';
import { envGet, API_KEY_ENV } from './config.js';

export const BOTH_OR_NEITHER = 'Give either a SHASHU key or a token provider, not both.';
export const KEY_ONLY_FOR_NOW =
  '{name} is key only for now: pass a SHASHU key, not a token provider.';
export const REFRESH_SKEW_SECONDS = 60;

/**
 * The gateway's pass refusal codes (`contracts/sdk-surface.v1.md`, "Signing in
 * with a cloud pass — the six refusal codes"). Arrive in `error.code` on an
 * HTTP 401, on the legacy body and every contract version.
 */
export const PASS_PROVIDER_NOT_SET_UP = 'pass_provider_not_set_up';
export const PASS_NOT_LICENSED = 'pass_not_licensed';
export const PASS_EXPIRED = 'pass_expired';
export const PASS_WRONG_AUDIENCE = 'pass_wrong_audience';
export const PASS_WRONG_ISSUER = 'pass_wrong_issuer';
export const PASS_UNKNOWN_AGENT = 'pass_unknown_agent';
export const PASS_CODES = [
  PASS_PROVIDER_NOT_SET_UP,
  PASS_NOT_LICENSED,
  PASS_EXPIRED,
  PASS_WRONG_AUDIENCE,
  PASS_WRONG_ISSUER,
  PASS_UNKNOWN_AGENT,
] as const;
export type PassRefusalCode = (typeof PASS_CODES)[number];
/** The one refusal a fresh pass fixes. */
const RETRY_CODES: ReadonlySet<string> = new Set([PASS_EXPIRED]);

export type TokenProvider = () => string | Promise<string>;

export function rejectKeyOnly(name: string, tokenProvider: unknown): void {
  if (tokenProvider != null) {
    throw new ShashuConfigError(KEY_ONLY_FOR_NOW.replace('{name}', name));
  }
}

export function jwtExpUnverified(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  const pad = '='.repeat((4 - (payload.length % 4)) % 4);
  try {
    const json = Buffer.from(payload + pad, 'base64url').toString('utf8');
    const data = JSON.parse(json) as { exp?: unknown };
    if (data.exp == null) return null;
    const exp = Number(data.exp);
    return Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** The gateway's pass refusal code in a 401 body (one of PASS_CODES), else null. */
export function passRefusalCodeFromText(text: string): PassRefusalCode | null {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    return typeof code === 'string' && (PASS_CODES as readonly string[]).includes(code)
      ? (code as PassRefusalCode)
      : null;
  } catch {
    return null;
  }
}

/** Retry once only for an expired pass, in pass mode, before any byte. */
export function shouldRetryPassRefused(opts: {
  usesProvider: boolean;
  status: number;
  code: string | null;
  bytesDelivered: boolean;
}): boolean {
  if (!opts.usesProvider || opts.bytesDelivered || opts.status !== 401) return false;
  return opts.code != null && RETRY_CODES.has(opts.code);
}

export class CredentialResolver {
  private readonly provider: TokenProvider | undefined;
  private readonly staticKey: string | undefined;
  private cached: string | undefined;
  private inflight: Promise<string | undefined> | undefined;

  constructor(opts: { apiKey?: string; tokenProvider?: TokenProvider; requireOne?: boolean }) {
    const envKey = envGet(API_KEY_ENV) ?? undefined;
    const hasKeyArg = opts.apiKey !== undefined;
    const hasProvider = opts.tokenProvider !== undefined;
    if (hasKeyArg && hasProvider) throw new ShashuConfigError(BOTH_OR_NEITHER);
    if (hasProvider && envKey && !hasKeyArg) throw new ShashuConfigError(BOTH_OR_NEITHER);
    if (opts.requireOne && !hasProvider && !hasKeyArg && !envKey) {
      throw new ShashuConfigError(BOTH_OR_NEITHER);
    }
    this.provider = opts.tokenProvider;
    this.staticKey = hasProvider ? undefined : hasKeyArg ? opts.apiKey : envKey;
  }

  get usesProvider(): boolean {
    return this.provider !== undefined;
  }

  async get(): Promise<string | undefined> {
    if (!this.provider) return this.staticKey;
    if (this.cached && !this.needsRefresh(this.cached)) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const token = await this.provider!();
      this.cached = String(token);
      this.inflight = undefined;
      return this.cached;
    })().catch((err) => {
      this.inflight = undefined;
      throw err;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private needsRefresh(token: string): boolean {
    const exp = jwtExpUnverified(token);
    if (exp == null) return true;
    return Date.now() / 1000 >= exp - REFRESH_SKEW_SECONDS;
  }
}
