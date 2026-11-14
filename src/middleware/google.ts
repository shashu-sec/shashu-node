/**
 * Google Gemini middleware: use Shashu with @google/generative-ai.
 *
 * Pass the returned config when creating the client or when making requests.
 * The legacy @google/generative-ai SDK constructor accepts (apiKey); use the
 * returned apiKey to point at Shashu (gateway key), and pass headers via
 * a custom fetch if your setup supports it.
 *
 * Example (gateway as proxy; SDK may require custom fetch for full header control):
 *
 *   import { GoogleGenerativeAI } from '@google/generative-ai';
 *   import { createShashuGeminiConfig } from '@shashu-ai/sdk/middleware/google';
 *
 *   const config = createShashuGeminiConfig({
 *     baseUrl: process.env.TRUSTGATE_BASE_URL!,
 *     apiKey: process.env.TRUSTGATE_API_KEY,
 *   });
 *
 *   const genAI = new GoogleGenerativeAI(config.apiKey ?? '');
 *   const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
 *
 * For full Shashu header injection (x-trustgate-source-tool, etc.), use
 * the Shashu client's fetch with provider: 'google' or pass config.headers
 * via a custom fetch implementation if the SDK supports it.
 */

import { randomUUID } from 'node:crypto';
import type { ShashuConfig } from '../types.js';
import { isDisabled, requireBaseUrl } from '../config.js';
import { rejectKeyOnly } from '../credential.js';
import {
  getWorkflowContextFromEnv,
  buildContextHeaders,
  applyContractVersion,
} from '../context.js';

/**
 * Returns headers compatible with @google/generative-ai. Uses x-api-key and
 * Shashu context. Use when building requests or with a custom fetch.
 */
export function getGeminiHeaders(config: ShashuConfig): Record<string, string> {
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
 * Returns a config object for use with @google/generative-ai (or compatible clients).
 * Injects Shashu context headers and x-api-key. Use apiKey for the gateway and
 * baseUrl/headers when using a custom fetch or wrapper.
 *
 * Returns `{}` when TRUSTGATE_DISABLE is set: the provider client is then left
 * exactly as it was — its own endpoint, its own credential, no Shashu context
 * headers — which is the same no-op the Python SDK's patchers perform. The
 * caller's tg_sk_ key is deliberately NOT handed back, since it would be sent to
 * the provider directly.
 *
 * @throws {ShashuConfigError} when no address is configured and the SDK is
 * not disabled. There is no default host. See ../config.ts.
 *
 * **No retrieval joiner on this path.** The other three middlewares hand back a
 * `fetch` the provider SDK will use, which is where a `declareRetrieval()` is
 * attached to the outgoing body. `@google/generative-ai` has no such seam: its
 * `RequestOptions` carries `timeout`, `apiVersion`, `apiClient`, `baseUrl` and
 * `customHeaders` and nothing else, and it calls the global `fetch` directly
 * (measured — a client built with a `fetch`/`customFetch` in that bag ignored
 * both and went to the network). Retrieval on the Gemini path is therefore
 * DECLARATION-ONLY: it reaches the gateway when the call is made through
 * Shashu's own client, or through a fetch the caller wraps with
 * `withRetrievalJoiner()` themselves. It is not automatic, and must not be
 * described as if it were.
 *
 * Note the divergence from the Python SDK, whose Gemini PATCHER resolves the
 * address optionally and leaves an unconfigured client talking to Google with
 * only headers added. This function has no such half-state: its whole return
 * contract is a Shashu baseUrl, and its caller asked for one by name.
 */
export function createShashuGeminiConfig(config: ShashuConfig): {
  baseUrl?: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
} {
  if (isDisabled()) return {};
  rejectKeyOnly('createShashuGeminiConfig', config.tokenProvider);
  const baseUrl = requireBaseUrl(config.baseUrl, {
    entryPoint: 'createShashuGeminiConfig()',
  });
  const headers = getGeminiHeaders({ ...config, sessionId: config.sessionId ?? randomUUID() });
  return {
    baseUrl,
    apiKey: config.apiKey ?? null,
    headers: Object.keys(headers).length ? headers : undefined,
  };
}
