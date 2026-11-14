/**
 * Gateway address resolution and the SDK kill switch.
 *
 * One place, because seven call sites need the same two decisions and a second
 * copy of either is a copy that drifts. (Before this module there were seven
 * copies, each ending in the same hardcoded vendor hostname.)
 *
 * * **There is no default gateway address.** SHASHU is self-hosted; the
 *   operator's gateway is on their network under their name. An SDK that fell
 *   back to a vendor hostname would send a misconfigured process's prompts to a
 *   host nobody in that organisation chose. Resolution is therefore
 *   `baseUrl` option -> environment -> {@link ShashuConfigError}.
 * * **`TRUSTGATE_DISABLE=1` turns the SDK off** without a code change, so a
 *   platform team can stop the instrumentation of a deployed service from its
 *   environment. It is checked at every entry point that configures a
 *   third-party client or sends telemetry.
 *
 * Sibling of the Python SDK's `trustgate/_config.py`, which is the reference
 * for this behaviour and for the error wording.
 *
 * Internal: not re-exported from ./index.ts. `ShashuConfigError` is the only
 * part of this contract that is public API.
 */

import { ShashuConfigError } from './exceptions.js';

/** Environment variable holding the gateway address for every provider. */
export const BASE_URL_ENV = 'SHASHU_BASE_URL';
export const BASE_URL_ENV_LEGACY = 'TRUSTGATE_BASE_URL';
export const API_KEY_ENV = 'SHASHU_API_KEY';
export const API_KEY_ENV_LEGACY = 'TRUSTGATE_API_KEY';

/** Set to one of {@link TRUTHY} to make every entry point a no-op. */
export const DISABLE_ENV = 'SHASHU_DISABLE';
export const DISABLE_ENV_LEGACY = 'TRUSTGATE_DISABLE';

const fallbackWarned = new Set<string>();

// Documented as "=1"; the rest are accepted because platform tooling emits them
// and a kill switch that silently ignores "true" is worse than a lenient one.
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * The environment, or an empty object where there is none.
 *
 * The SDK is used from edge and worker runtimes where `process` is absent; the
 * guard lives here once rather than at each call site (it was at one of the
 * seven before, and missing from the other six).
 */
function env(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

export function envGet(current: string, legacy: string): string | undefined {
  const e = env();
  const now = (e[current] ?? '').trim();
  if (now) return now;
  const old = (e[legacy] ?? '').trim();
  if (old) {
    if (!fallbackWarned.has(legacy)) {
      fallbackWarned.add(legacy);
      // eslint-disable-next-line no-console
      console.warn(
        `${legacy} is deprecated; set ${current} instead. The TRUSTGATE_* name still works for this release.`
      );
    }
    return old;
  }
  return undefined;
}

/** True when the operator has switched the SDK off via the environment. */
export function isDisabled(): boolean {
  return TRUTHY.has((envGet(DISABLE_ENV, DISABLE_ENV_LEGACY) ?? '').trim().toLowerCase());
}

/** First non-blank value from the option, then each env var in order. */
function firstConfigured(
  baseUrl: string | undefined,
  envVars: readonly string[]
): string | undefined {
  if (baseUrl && baseUrl.trim()) return baseUrl.trim().replace(/\/+$/, '');
  for (const name of envVars) {
    const current = name.startsWith('TRUSTGATE_') ? name.replace('TRUSTGATE_', 'SHASHU_') : name;
    const legacy = name.startsWith('SHASHU_')
      ? name.replace('SHASHU_', 'TRUSTGATE_')
      : name.startsWith('TRUSTGATE_')
        ? name
        : '';
    const value = legacy && legacy !== current ? envGet(current, legacy) : env()[name]?.trim();
    if (value) return value.replace(/\/+$/, '');
  }
  return undefined;
}

/** Resolve an address, or `undefined` when the caller may proceed without one. */
export function optionalBaseUrl(
  baseUrl?: string,
  envVars: readonly string[] = [BASE_URL_ENV, BASE_URL_ENV_LEGACY]
): string | undefined {
  return firstConfigured(baseUrl, envVars);
}

/**
 * Resolve the gateway address, or throw naming how to supply one.
 *
 * @param baseUrl - the explicit option, which always wins.
 * @param opts.entryPoint - the function to name in the error, e.g. `"new Shashu()"`.
 * @param opts.option - the option to name in the error. Defaults to `"baseUrl"`.
 * @param opts.envVars - environment variables to read, in precedence order.
 * @throws {ShashuConfigError} when nothing resolves. The message names the
 * environment variable and the option, and never a hostname — there is no
 * address to suggest.
 */
export function requireBaseUrl(
  baseUrl: string | undefined,
  opts: { entryPoint: string; option?: string; envVars?: readonly string[] }
): string {
  const envVars = opts.envVars ?? [BASE_URL_ENV, BASE_URL_ENV_LEGACY];
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
