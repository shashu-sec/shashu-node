/**
 * Vercel AI SDK middleware: swap the provider to Shashu with one line.
 *
 * Use createOpenAI from @openai/api or the AI SDK's OpenAI provider, and point
 * baseURL to your Shashu gateway. This ensures all LLM calls go through
 * Shashu with workflow context for Shadow AI detection.
 *
 * Example:
 *
 *   import { createOpenAI } from '@ai-sdk/openai';
 *   import { createShashuOpenAI } from '@shashu-ai/sdk/middleware/vercel-ai';
 *
 *   const openai = createShashuOpenAI({
 *     baseUrl: process.env.SHASHU_BASE_URL!,
 *     apiKey: process.env.SHASHU_API_KEY,
 *   });
 *
 *   // Then use `openai` with streamText() as usual — requests go through Shashu.
 *   const result = streamText({ model: openai('gpt-4'), messages, ... });
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

export interface ShashuOpenAIOptions extends ShashuConfig {
  /**
   * Optional OpenAI-compatible API key (if your gateway expects it in addition to Shashu key).
   */
  openaiApiKey?: string;
}

/**
 * Returns extra headers (lowercase keys) to pass to the Vercel AI SDK OpenAI provider
 * so that requests sent to Shashu include workflow context and x-shashu-source-tool
 * JSON for Shadow AI detection. Use with createOpenAI({ baseURL, headers: getShashuHeaders() }).
 */
export function getShashuHeaders(
  workflowContext?: ShashuConfig['workflowContext'],
  sessionId?: string,
  contractVersion?: ShashuConfig['contractVersion']
): Record<string, string> {
  const ctx = workflowContext ?? getWorkflowContextFromEnv();
  return applyContractVersion(
    buildContextHeaders(ctx, sessionId ? { defaultSessionId: sessionId } : undefined),
    contractVersion
  );
}

/**
 * Creates options suitable for the Vercel AI SDK's OpenAI provider so that
 * you can swap the provider to Shashu in one line.
 *
 * Usage with AI SDK 3.x:
 *
 *   import { createOpenAI } from '@ai-sdk/openai';
 *   import { createShashuOpenAIOptions } from '@shashu-ai/sdk/middleware/vercel-ai';
 *
 *   const openaiOptions = createShashuOpenAIOptions({
 *     baseUrl: process.env.SHASHU_BASE_URL!,
 *     apiKey: process.env.SHASHU_API_KEY,
 *   });
 *
 *   const openai = createOpenAI(openaiOptions);
 *   // use openai('gpt-4') with streamText()
 *
 * Returns `{}` when SHASHU_DISABLE is set: the provider client is then left
 * exactly as it was — its own endpoint, its own credential, no Shashu context
 * headers — which is the same no-op the Python SDK's patchers perform. The
 * caller's shashu_sk_ key is deliberately NOT handed back, since it would be sent to
 * the provider directly.
 *
 * @throws {ShashuConfigError} when no address is configured and the SDK is
 * not disabled. There is no default host. See ../config.ts.
 */
export function createShashuOpenAIOptions(options: ShashuOpenAIOptions): {
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
} {
  if (isDisabled()) return {};
  const baseUrl = requireBaseUrl(options.baseUrl, {
    entryPoint: 'createShashuOpenAIOptions()',
  });
  const resolver = new CredentialResolver({
    apiKey: options.apiKey,
    tokenProvider: options.tokenProvider,
  });
  const headers: Record<string, string> = {
    ...options.headers,
    ...getShashuHeaders(options.workflowContext, options.sessionId ?? randomUUID(), null),
  };
  applyContractVersion(headers, options.contractVersion);
  const joining = withRetrievalJoiner();
  const fetch: FetchLike = async (input, init) => {
    const token = await resolver.get();
    const next = new Headers(init?.headers);
    if (token) next.set('authorization', `Bearer ${token}`);
    const send = () => joining(input, { ...init, headers: next });
    const res = await send();
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
    if (retryToken) next.set('authorization', `Bearer ${retryToken}`);
    return joining(input, { ...init, headers: next });
  };
  return {
    baseURL: baseUrl,
    apiKey: resolver.usesProvider ? undefined : (options.openaiApiKey ?? options.apiKey),
    headers: Object.keys(headers).length ? headers : undefined,
    fetch,
  };
}
