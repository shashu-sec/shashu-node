import type { N8nHeaderSnippet } from './types.js';
import { envGet, API_KEY_ENV, BASE_URL_ENV } from './config.js';
import { getWorkflowContextFromEnv, buildContextHeaders, HEADER_PREFIX } from './context.js';
import { tracer } from './tracer.js';

/**
 * Returns a pre-formatted JSON object of headers for use in n8n "HTTP Request" nodes.
 * Header keys are lowercase for gateway parity. Includes Shashu auth and workflow
 * context (workflow_id, execution_id, source, x-shashu-source-tool JSON).
 *
 * Resolution order: (1) arguments apiKey/baseUrl, (2) tracer.configure() values, (3) process.env.
 * When tracer.isActive, context headers include x-shashu-trace-id, x-shashu-span-id,
 * and x-shashu-parent-id so the n8n workflow appears as a child of the current span.
 *
 * Use in n8n:
 * 1. Add an "HTTP Request" node.
 * 2. In "Send Headers" (or equivalent), use the returned `headers` array
 *    or paste the `json` string into a "JSON" header configuration.
 *
 * @param apiKey - Optional Shashu API key (Priority 1; else tracer.apiKey, else env).
 * @param baseUrl - Optional gateway base URL (Priority 1; else tracer.gatewayUrl, else env).
 * @returns Headers as name/value list and as a JSON string for n8n.
 */
export function getN8nHeaderSnippet(apiKey?: string, baseUrl?: string): N8nHeaderSnippet {
  // Priority 1: arguments, Priority 2: tracer (dynamic config), Priority 3: process.env
  const key = apiKey ?? tracer.apiKey ?? envGet(API_KEY_ENV) ?? '';
  const url = baseUrl ?? tracer.gatewayUrl ?? envGet(BASE_URL_ENV) ?? '';
  const ctx = getWorkflowContextFromEnv();
  const contextHeaders = buildContextHeaders(ctx);

  const headers: Array<{ name: string; value: string }> = [];

  if (url) {
    headers.push({ name: `${HEADER_PREFIX}-gateway-url`, value: url });
  }
  if (key) {
    headers.push({ name: 'authorization', value: `Bearer ${key}` });
    headers.push({ name: 'x-api-key', value: key });
  }

  for (const [name, value] of Object.entries(contextHeaders)) {
    headers.push({ name, value });
  }

  const json = JSON.stringify(
    headers.reduce<Record<string, string>>((acc, { name, value }) => {
      acc[name] = value;
      return acc;
    }, {}),
    null,
    2
  );

  return { headers, json };
}
