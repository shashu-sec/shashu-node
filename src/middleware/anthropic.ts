/**
 * Anthropic middleware: use Shashu as the base URL for @anthropic-ai/sdk.
 *
 * Pass the returned config to the Anthropic client so all requests go through
 * Shashu with workflow context and x-api-key for Shadow AI detection.
 *
 * Example:
 *
 *   import Anthropic from '@anthropic-ai/sdk';
 *   import { createShashuAnthropicConfig } from '@shashu-ai/sdk/middleware/anthropic';
 *
 *   const config = createShashuAnthropicConfig({
 *     baseUrl: process.env.TRUSTGATE_BASE_URL!,
 *     apiKey: process.env.TRUSTGATE_API_KEY,
 *   });
 *
 *   const anthropic = new Anthropic(config);
 *   const message = await anthropic.messages.create({ model: 'claude-3-5-sonnet-20241022', ... });
 */

import { randomUUID } from 'node:crypto';
import type { ShashuConfig } from '../types.js';
import { isDisabled, requireBaseUrl } from '../config.js';
import {
  getWorkflowContextFromEnv,
  buildContextHeaders,
  applyContractVersion,
} from '../context.js';
import { withRetrievalJoiner, type FetchLike } from '../_joiner.js';
import {
  CredentialResolver,
  passRefusalCodeFromText,
  shouldRetryPassRefused,
} from '../credential.js';

/**
 * Returns headers compatible with @anthropic-ai/sdk. Uses x-api-key only (no
 * Authorization header). Use with defaultHeaders or when building requests manually.
 */
export function getAnthropicHeaders(config: ShashuConfig): Record<string, string> {
  const ctx = config.workflowContext ?? getWorkflowContextFromEnv();
  const headers: Record<string, string> = {
    ...config.headers,
    ...buildContextHeaders(ctx, { defaultSessionId: config.sessionId }),
  };
  if (config.apiKey) {
    headers['x-api-key'] = config.apiKey;
  }
  return applyContractVersion(headers, config.contractVersion);
}

/**
 * Returns a config object for the Anthropic SDK (baseURL, apiKey, defaultHeaders).
 * Injects Shashu context headers and x-api-key so requests go through the gateway.
 *
 * Returns `{}` when TRUSTGATE_DISABLE is set: the provider client is then left
 * exactly as it was — its own endpoint, its own credential, no Shashu context
 * headers — which is the same no-op the Python SDK's patchers perform. The
 * caller's tg_sk_ key is deliberately NOT handed back, since it would be sent to
 * the provider directly.
 *
 * @throws {ShashuConfigError} when no address is configured and the SDK is
 * not disabled. There is no default host. See ../config.ts.
 */
export function createShashuAnthropicConfig(config: ShashuConfig): {
  baseURL?: string;
  apiKey?: string | null;
  defaultHeaders?: Record<string, string>;
  fetch?: FetchLike;
} {
  if (isDisabled()) return {};
  const baseURL = requireBaseUrl(config.baseUrl, {
    entryPoint: 'createShashuAnthropicConfig()',
  });
  const resolver = new CredentialResolver({
    apiKey: config.apiKey ?? undefined,
    tokenProvider: config.tokenProvider,
  });
  const headers = getAnthropicHeaders({
    ...config,
    sessionId: config.sessionId ?? randomUUID(),
    apiKey: resolver.usesProvider ? undefined : config.apiKey,
  });
  const joining = withRetrievalJoiner();
  const fetch: FetchLike = async (input, init) => {
    const token = await resolver.get();
    const next = new Headers(init?.headers);
    if (token) next.set('x-api-key', token);
    const res = await joining(input, { ...init, headers: next });
    if (!resolver.usesProvider || res.status !== 401) return res;
    const code = passRefusalCodeFromText(await res.clone().text());
    if (
      !shouldRetryPassRefused({
        usesProvider: true,
        status: res.status,
        code,
        bytesDelivered: false,
      })
    ) {
      return res;
    }
    resolver.invalidate();
    const retryToken = await resolver.get();
    if (retryToken) next.set('x-api-key', retryToken);
    return joining(input, { ...init, headers: next });
  };
  return {
    baseURL,
    apiKey: resolver.usesProvider ? null : (config.apiKey ?? null),
    defaultHeaders: Object.keys(headers).length ? headers : undefined,
    fetch,
  };
}
