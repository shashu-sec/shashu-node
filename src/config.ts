/**
 * Gateway address resolution and the SDK kill switch.
 *
 * From 1.1.0 the SDK reads only `SHASHU_*` names. The old environment-variable names are no longer read.
 */

import { ShashuConfigError } from './exceptions.js';

/** Environment variable holding the gateway address for every provider. */
export const BASE_URL_ENV = 'SHASHU_BASE_URL';
export const API_KEY_ENV = 'SHASHU_API_KEY';

/** Set to one of {@link TRUTHY} to make every entry point a no-op. */
export const DISABLE_ENV = 'SHASHU_DISABLE';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function env(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

export function envGet(current: string, _legacy?: string): string | undefined {
  const now = (env()[current] ?? '').trim();
  return now || undefined;
}

/** True when the operator has switched the SDK off via the environment. */
export function isDisabled(): boolean {
  return TRUTHY.has((envGet(DISABLE_ENV) ?? '').trim().toLowerCase());
}

function firstConfigured(
  baseUrl: string | undefined,
  envVars: readonly string[]
): string | undefined {
  if (baseUrl && baseUrl.trim()) return baseUrl.trim().replace(/\/+$/, '');
  for (const name of envVars) {
    const value = env()[name]?.trim();
    if (value) return value.replace(/\/+$/, '');
  }
  return undefined;
}

export function optionalBaseUrl(
  baseUrl?: string,
  envVars: readonly string[] = [BASE_URL_ENV]
): string | undefined {
  return firstConfigured(baseUrl, envVars);
}

export function requireBaseUrl(
  baseUrl: string | undefined,
  opts: { entryPoint: string; option?: string; envVars?: readonly string[] }
): string {
  const envVars = opts.envVars ?? [BASE_URL_ENV];
  const resolved = firstConfigured(baseUrl, envVars);
  if (resolved) return resolved;

  const option = opts.option ?? 'baseUrl';
  const envHint =
    envVars.length === 1
      ? `set the ${envVars[0]} environment variable`
      : `set one of the ${envVars.join(' or ')} environment variables`;

  throw new ShashuConfigError(
    `SHASHU gateway address is not configured, so ${opts.entryPoint} has ` +
      `nothing to route to. Pass ${option} to ${opts.entryPoint}, or ${envHint}. ` +
      `SHASHU is self-hosted: the SDK has no default address and will not guess one.`
  );
}
