/**
 * The in-repo mock gateway, and the schema validator the conformance apps
 * assert against.
 *
 * The mock IS a `fetch`, not a server: the suite-wide network guard
 * (`test/setup.ts`) fails any test that opens a real socket, and a gateway that
 * needed one would be a gateway the guard could not tell from a leak.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const SCHEMA_PATH = fileURLToPath(
  new URL('../../contracts/rag_context.v1.schema.json', import.meta.url)
);

/** The vendored `rag_context.v1` contract, read as bytes so its digest is checkable. */
export const SCHEMA_BYTES: Buffer = readFileSync(SCHEMA_PATH);

export const SCHEMA = JSON.parse(SCHEMA_BYTES.toString('utf8'));

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validator = ajv.compile(SCHEMA);

/** Throws with the schema's own message when `context` is not a valid v1 block. */
export function assertValidRagContext(context: unknown): void {
  if (!validator(context)) {
    throw new Error(
      `rag_context did not validate against rag_context.v1: ${ajv.errorsText(validator.errors)}\n` +
        JSON.stringify(context, null, 2)
    );
  }
}

export interface CapturedRequest {
  url: string;
  body: Record<string, unknown> | undefined;
  raw: string | undefined;
  headers: Record<string, string>;
}

export interface MockGateway {
  /** Hand this to a provider SDK's `fetch` option, or to `globalThis.fetch`. */
  fetch: (input: any, init?: any) => Promise<Response>;
  requests: CapturedRequest[];
  /** `trustgate_metadata.rag_context` off request `index`, or undefined. */
  ragContext(index?: number): Record<string, unknown> | undefined;
  /** True when the request carried no `trustgate_metadata` at all. */
  bare(index?: number): boolean;
}

/** The JSON body an OpenAI-shaped or Anthropic-shaped success response needs. */
function responseBody(url: string): unknown {
  if (url.includes('/messages')) {
    return {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** A gateway that records what arrived and answers 200 with a plausible body. */
export function mockGateway(): MockGateway {
  const requests: CapturedRequest[] = [];

  const fetchImpl = async (input: any, init?: any): Promise<Response> => {
    let url: string;
    let raw: string | undefined;
    const headers: Record<string, string> = {};

    if (typeof Request !== 'undefined' && input instanceof Request) {
      url = input.url;
      raw = await input.clone().text();
      input.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else {
      url = String(input);
      raw = typeof init?.body === 'string' ? init.body : undefined;
      const given = init?.headers;
      if (given instanceof Headers) given.forEach((v, k) => (headers[k.toLowerCase()] = v));
      else if (Array.isArray(given))
        for (const [k, v] of given) headers[String(k).toLowerCase()] = String(v);
      else if (given && typeof given === 'object') {
        for (const [k, v] of Object.entries(given)) headers[k.toLowerCase()] = String(v);
      }
    }

    let body: Record<string, unknown> | undefined;
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
      } catch {
        body = undefined;
      }
    }

    requests.push({ url, body, raw, headers });
    return new Response(JSON.stringify(responseBody(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    fetch: fetchImpl,
    requests,
    ragContext(index = 0) {
      const metadata = requests[index]?.body?.trustgate_metadata as
        Record<string, unknown> | undefined;
      return metadata?.rag_context as Record<string, unknown> | undefined;
    },
    bare(index = 0) {
      return requests[index]?.body?.trustgate_metadata === undefined;
    },
  };
}

/** A canary unique to one conformance app, so a leak between them is visible. */
export function nonce(label: string): string {
  return `TG-CANARY-${label}-${Math.random().toString(36).slice(2, 10)}`;
}
