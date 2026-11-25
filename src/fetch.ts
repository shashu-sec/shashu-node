/**
 * A `fetch` carrying Shashu's joiner and headers, for a provider SDK we
 * do not own.
 *
 * The seam every OpenAI-compatible SDK already offers is a caller-supplied
 * `fetch`. This is that: no patching, no wrapper class.
 *
 *     import { shashuFetch } from "@shashu-ai/sdk";
 *     const openai = new OpenAI({ baseURL, apiKey, fetch: shashuFetch({ apiKey }) });
 *
 * Two things ride on it:
 *
 * 1. **The joiner** — the same `withRetrievalJoiner` `Shashu` mounts,
 *    imported, not reimplemented. A caller-supplied `fetch` is the underlying
 *    transport (never replaced); when omitted, `globalThis.fetch` is the
 *    default.
 * 2. **The headers** — whatever `buildContextHeaders` builds, including a
 *    session minted ONCE at construction, so every hop of a tool loop lands
 *    in one session.
 */

import { randomUUID } from 'node:crypto';
import type { WorkflowContext } from './types.js';
import { getWorkflowContextFromEnv, buildContextHeaders, applyContractVersion } from './context.js';
import { withRetrievalJoiner, type FetchLike } from './_joiner.js';
import {
  CredentialResolver,
  passRefusalCodeFromText,
  shouldRetryPassRefused,
} from './credential.js';

/** How the gateway should encode a block. A default, not a hardcode. */
export const DEFAULT_BLOCK_ENCODING = 'explicit';

/** The header `DEFAULT_BLOCK_ENCODING` is sent under. Lowercase. */
export const BLOCK_ENCODING_HEADER = 'shashu-block-encoding';

export interface ShashuFetchOptions {
  /** Session every request this fetch makes joins. Minted once when omitted. */
  sessionId?: string;
  /**
   * Underlying `fetch`. Never replaced: the joiner wraps it. Omit to default
   * to `globalThis.fetch` at call time.
   */
  fetch?: FetchLike;
  workflowContext?: WorkflowContext;
  headers?: Record<string, string>;
  apiKey?: string;
  /** Callable returning the current cloud pass. Mutually exclusive with apiKey. */
  tokenProvider?: () => string | Promise<string>;
  /**
   * `Shashu-Block-Encoding`. Default `explicit`. Pass `null` to send no
   * such header.
   */
  blockEncoding?: string | null;
  /**
   * `shashu-version`. Default `DEFAULT_CONTRACT_VERSION` (`"2026-09-01"`).
   * Without it the gateway serves its legacy contract and discards the block
   * encoding above. Pass `null` to send no such header.
   */
  contractVersion?: string | null;
}

/**
 * A `fetch` to hand to a provider SDK's `fetch` option.
 *
 * Carries the retrieval joiner and the `x-shashu-*` header set, so a
 * LangChain / Vercel AI / raw-`openai` call made through it is attributed,
 * traced and able to declare its retrieval — with nothing patched.
 */
export function shashuFetch(options: ShashuFetchOptions = {}): FetchLike {
  const resolver = new CredentialResolver({
    apiKey: options.apiKey,
    tokenProvider: options.tokenProvider,
  });
  const defaultSessionId = options.sessionId ?? randomUUID();
  const underlying: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const joining = withRetrievalJoiner(underlying);
  const baked = buildContextHeaders(options.workflowContext ?? getWorkflowContextFromEnv(), {
    defaultSessionId,
  });
  if (options.blockEncoding !== null) {
    baked[BLOCK_ENCODING_HEADER] = options.blockEncoding ?? DEFAULT_BLOCK_ENCODING;
  }
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) baked[k.toLowerCase()] = v;
  }

  return async function trustgateFetching(input: any, init?: any): Promise<Response> {
    const send = async (): Promise<Response> => {
      const headers = { ...baked };
      const extra = init?.headers;
      if (extra instanceof Headers) extra.forEach((v, k) => (headers[k.toLowerCase()] = v));
      else if (Array.isArray(extra)) {
        for (const [k, v] of extra) headers[String(k).toLowerCase()] = String(v);
      } else if (extra && typeof extra === 'object') {
        for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = String(v);
      }
      const token = await resolver.get();
      if (token) headers.authorization = `Bearer ${token}`;
      return joining(input, {
        ...init,
        headers: applyContractVersion(headers, options.contractVersion),
      });
    };

    const res = await send();
    if (!resolver.usesProvider || res.status !== 401) return res;
    const text = await res.clone().text();
    const code = passRefusalCodeFromText(text);
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
    return send();
  };
}
