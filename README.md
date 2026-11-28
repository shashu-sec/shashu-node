# @shashu-ai/sdk

Node.js client for **SHASHU**, a self-hosted AI security gateway for
regulated industries. There is no default gateway hostname — you point the
client at your own address, and it raises a configuration error rather than
guessing. After the first mention, this document says **SHASHU**.

Wire names `x-shashu-*`, `shashu_metadata`, and the `shashu_sk_` key prefix
are protocol names and are unchanged.

Requires Node.js 18 or later.

The library declares retrieval (explicitly or ambiently), carries session and
trace on every request, surfaces the gateway's decision (`allow`,
`allow_altered`, `not_checked`, `block`, `refuse`, `fail`), and recognises a
block. The block-recognition helper fails closed on an unknown code.

## Install

```bash
npm install @shashu-ai/sdk
```

Optional peer dependencies for middleware:

```bash
npm install ai @ai-sdk/openai          # Vercel AI SDK
npm install @langchain/openai         # LangChain
```

## Quick start

Key:

```ts
import { Shashu } from '@shashu-ai/sdk';
const client = new Shashu({
  baseUrl: 'https://your-shashu-gateway.example',
  apiKey: 'shashu_sk_...',
});
```

Cloud pass (the function is yours; SHASHU never calls Entra, Google or AWS):

```ts
import { Shashu } from '@shashu-ai/sdk';
const client = new Shashu({
  baseUrl: 'https://your-shashu-gateway.example',
  tokenProvider: getPass,
});
```

## Pass refusal codes

A cloud-pass 401 names the reason in `error.code`. Only `pass_expired` is retried
(once, after fetching a new pass). Every other code is raised as
`ShashuAuthenticationError` with `.code` set.

| Code                       | Meaning                                                 |
| -------------------------- | ------------------------------------------------------- |
| `pass_expired`             | Cached pass expired; SDK retries once with a fresh pass |
| `pass_provider_not_set_up` | This gateway has no identity provider configured        |
| `pass_not_licensed`        | Cloud pass is not licensed on this gateway              |
| `pass_wrong_audience`      | Pass audience does not match this gateway               |
| `pass_wrong_issuer`        | Pass issuer does not match this gateway                 |
| `pass_unknown_agent`       | The pass does not map to a known agent                  |

Plain OpenAI client, when that client accepts a function as the key:

```ts
import OpenAI from 'openai';
const openai = new OpenAI({ baseURL: 'https://your-shashu-gateway.example/v1', apiKey: getPass });
```

## Core client

```ts
import { Shashu, getWorkflowContextFromEnv } from '@shashu-ai/sdk';

const client = new Shashu({
  baseUrl: process.env.SHASHU_BASE_URL!,
  apiKey: process.env.SHASHU_API_KEY,
  // workflowContext optional; otherwise read from process.env (n8n, Vercel, GitHub)
});

// Non-streaming
const res = await client.fetch('/v1/chat/completions', {
  method: 'POST',
  body: JSON.stringify({ model: 'gpt-4', messages: [...] }),
});

// Streaming (server-sent events)
const streamRes = await client.fetchStream('/v1/chat/completions', {
  method: 'POST',
  body: JSON.stringify({ model: 'gpt-4', messages: [...], stream: true }),
});
// Read streamRes.body (a ReadableStream of SSE events) as usual
```

## Configuring the gateway address

**There is no default gateway address.** SHASHU is self-hosted: your gateway
is on your network, under your name, and the SDK will not guess a host for you.
Every entry point resolves the address the same way:

1. the explicit `baseUrl` option, then
2. the `SHASHU_BASE_URL` environment variable, then
3. a `ShashuConfigError`.

```ts
import { Shashu, ShashuConfigError } from '@shashu-ai/sdk';

try {
  const client = new Shashu({ apiKey: process.env.SHASHU_API_KEY });
} catch (e) {
  if (e instanceof ShashuConfigError) {
    // "SHASHU gateway address is not configured, so new Shashu() has
    //  nothing to route to. Pass baseUrl to new Shashu(), or set the
    //  SHASHU_BASE_URL environment variable. ..."
  }
}
```

`ShashuConfigError` is a `ShashuError`, raised before any request is sent
(its `status` is `0`, not an HTTP status). The tracer is the one exception to
rule 3: it is constructed when the module is imported, so an unset address
leaves it with no gateway and it simply sends no span telemetry rather than
breaking `import`.

### Turning the SDK off: `SHASHU_DISABLE`

Set `SHASHU_DISABLE=1` to make the SDK a no-op without a code change, so a
platform team can stop a deployed service's instrumentation from its
environment. `1`, `true`, `yes` and `on` are all accepted (any case).

```bash
SHASHU_DISABLE=1 node ./my-service.js
```

When it is set:

- the four middleware helpers return `{}` and throw nothing, even with no
  address configured — your provider client is left exactly as it was, talking
  to its own endpoint with its own credential and no Shashu headers;
- the tracer records and flushes no spans, while still maintaining trace context
  so an app that reads `tracer.traceId` keeps working.

It does **not** switch off `new Shashu({...})`. That client exists only to
call your gateway, so there is nothing for it to no-op into; it still requires
an address.

## Reading the gateway's decision

The gateway answers with a **decision**, not just content. Read it with
`shashuDecision()`, which takes the returned response or an error you
caught:

```ts
import { Shashu, shashuDecision, isShashuBlock } from '@shashu-ai/sdk';

const response = await client.fetch('/v1/chat/completions', { method: 'POST', body });
const decision = shashuDecision(response);
if (decision !== undefined && decision.isAltered) {
  // Delivered, but policy edited it. Log decision.altered / decision.code.
}

try {
  await client.fetch('/v1/chat/completions', { method: 'POST', body });
} catch (err) {
  if (isShashuBlock(err)) {
    return "That request was blocked by your organization's policy.";
  }
  throw err;
}
```

Six values, and the split that matters is whether you got the model's content:
`allow`, `allow_altered`, `not_checked` (content delivered) versus `block`,
`refuse`, `fail` (no content). `shashuDecision()` returns nothing when the
gateway did not send a decision — that is not `allow`. `isShashuBlock()`
inspects; it patches nothing. An unrecognised decision fails closed (`true`).

**This SDK sends `shashu-version: 2026-09-01` by default** (since 4.0.0), the
same value as the shashu AI Python SDK. The `Shashu` client,
`shashuFetch()` and the middleware configs all send it. With it, the body of
every reply carries the full `shashu` block, so `decision.memory.items` lists
each memory save and recall and you get the inspection detail, not just header
counts. A refusal arrives as an error instead of a 200 reply: a content block is
an HTTP **400** (`ShashuContentFilterError`), a policy refusal a **403**
(`ShashuPolicyViolation`, or `MemoryWriteBlocked` for a blocked memory write),
and a provider SDK given `shashuFetch()` raises its own 400 or 403 error. To
turn it off, pass `contractVersion: null` to `new Shashu({...})`,
`shashuFetch({...})` or a middleware config. The gateway then serves your
account default, which is the `legacy` contract (a block is a 200 with
`finish_reason: "content_filter"`, and memory detail is header counts only)
unless an operator changed it.

## Context provider

Workflow metadata is read from `process.env` so Shashu can attribute traffic
to the workflow that produced it:

| Source     | Example env vars                                                         |
| ---------- | ------------------------------------------------------------------------ |
| **n8n**    | `N8N_WORKFLOW_ID`, `N8N_EXECUTION_ID`, `N8N_WORKFLOW_NAME`               |
| **Vercel** | `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_*`                     |
| **GitHub** | `GITHUB_ACTION`, `GITHUB_WORKFLOW`, `GITHUB_RUN_ID`, `GITHUB_REPOSITORY` |

```ts
import { getWorkflowContextFromEnv } from '@shashu-ai/sdk';

const ctx = getWorkflowContextFromEnv();
// { source: 'n8n', workflow_id: '...', execution_id: '...', metadata: {...} }
```

## One trace for a run of calls

Each call made outside a span starts its own trace. To keep a run of calls (a
conversation, an agent run) in one trace, make them inside `tracer.span()`:

```ts
import { tracer } from '@shashu-ai/sdk';

await tracer.span('support-conversation', async () => {
  await client.fetch('/v1/chat/completions', { method: 'POST', body: turn1 });
  await client.fetch('/v1/chat/completions', { method: 'POST', body: turn2 });
});
```

Every call inside the callback sends the same `x-shashu-trace-id`. Trace ids the
SDK creates are 32 lowercase hex characters. A trace id you bring in, for
example from an incoming request with `tracer.incoming(headers, () => ...)`, is
sent unchanged.

## Middleware: Vercel AI SDK

Works with the Vercel AI SDK (`ai`) 3 to 7. Point the OpenAI provider at Shashu so all calls go through the gateway with workflow context:

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { createShashuOpenAIOptions } from '@shashu-ai/sdk/middleware/vercel-ai';

const openai = createOpenAI(
  createShashuOpenAIOptions({
    baseUrl: process.env.SHASHU_BASE_URL!,
    apiKey: process.env.SHASHU_API_KEY,
  })
);

// Use with streamText / generateText as usual
import { streamText } from 'ai';
const result = streamText({
  model: openai('gpt-4'),
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## Middleware: LangChain

Use Shashu as the OpenAI endpoint for LangChain with one config object:

```ts
import { ChatOpenAI } from '@langchain/openai';
import { createShashuLangChainConfig } from '@shashu-ai/sdk/middleware/langchain';

const config = createShashuLangChainConfig({
  baseUrl: process.env.SHASHU_BASE_URL!,
  apiKey: process.env.SHASHU_API_KEY,
});

const llm = new ChatOpenAI({
  ...config,
  modelName: 'gpt-4',
  temperature: 0,
});
```

The returned `configuration` also carries a `fetch` that attaches any declared
retrieval to the outgoing body — see [Declaring retrieval](#declaring-retrieval-rag).

## Declaring retrieval (RAG)

The gateway scans retrieved documents on a dedicated `ingress-rag` surface when
the request body carries `shashu_metadata.rag_context` — with the corpus, the
per-document previews and the scores, rather than as an undifferentiated wall of
user text. Declare what you retrieved **where you retrieved it**; the SDK carries
the declaration to the gateway on the next model call.

```ts
import { declareRetrieval } from '@shashu-ai/sdk';

const docs = await vectorstore.similaritySearch(question, 5);
declareRetrieval(docs, { corpus: 'policy_docs_v2', query: question });

// ...any amount of unrelated code...

await openai.chat.completions.create({ model: 'gpt-4o-mini', messages });
```

`docs` may be plain strings, plain objects (`text` / `content` / `pageContent` /
`body`, with `id`, `score`, `source_uri`, `hash` read from the object or its
`metadata`), LangChain `Document`s or LlamaIndex nodes. The payload is capped at
the contract's limits: 64 documents, 2048-character previews, 8 declarations,
newest kept. An explicit `attachRagContext()` on the body always wins, and
`SHASHU_DISABLE=1` makes the whole path inert.

### Where the declaration reaches

The declaration rides an `AsyncLocalStorage` store, which Node binds to the
current async **frame** rather than to a task the way Python binds a
`ContextVar`. Three rules follow, and they are the ones worth knowing:

| where you declare                                  | reaches the model call |
| -------------------------------------------------- | ---------------------- |
| the same async function, before the call           | yes                    |
| a helper called before it has suspended            | yes                    |
| a helper that already `await`ed, and then declared | **no**                 |
| anywhere inside `retrievalScope()`                 | yes                    |

`retrievalScope()` is the answer to both of the rows above that say **no** — a
helper that declares after awaiting, and a `Promise.all` fan-out where each
task declares before its first `await`. It gives the block a retrieval bus of
its own, so a declaration made anywhere inside reaches the model call and
nothing inside is seen by a sibling task or by anything after the block:

```ts
import { retrievalScope } from '@shashu-ai/sdk';

// One declaration bound to one block:
await retrievalScope(docs, { corpus: 'policy_docs_v2', query }, () => chain.invoke(query));

// A fan-out: one scope per task, each with its own documents.
await Promise.all(
  batches.map((b) =>
    retrievalScope(b.docs, { corpus: 'policy_docs_v2' }, () =>
      openai.chat.completions.create({ model, messages: b.messages })
    )
  )
);
```

> **Removed in 3.0.0.** `isolateRetrieval()` was a third public function for
> exactly these two shapes. `retrievalScope()` covers both, so the surface now
> carries two retrieval functions and no third — see
> `contracts/sdk-surface.v1.md`. Replace
> `isolateRetrieval(() => { declareRetrieval(docs, opts); ... })` with
> `retrievalScope(docs, opts, () => ...)`.

### Which clients carry it

The joiner rides the `fetch` the middleware hands back, so it works with any SDK
that accepts one:

| middleware                      | seam                                            | automatic |
| ------------------------------- | ----------------------------------------------- | --------- |
| `new Shashu()`                  | the client's own `fetch`                        | yes       |
| `createShashuLangChainConfig()` | `configuration.fetch`                           | yes       |
| `createShashuAnthropicConfig()` | client option `fetch`                           | yes       |
| `createShashuOpenAIOptions()`   | provider option `fetch`                         | yes       |
| `createShashuGeminiConfig()`    | none — `@google/generative-ai` takes no `fetch` | **no**    |

On the Gemini path, route the call through Shashu's own client or wrap your
own fetch with `withRetrievalJoiner()`. `test/conformance/seams.test.ts` asserts
every row of this table against the real SDKs.

### LangChain: no line at all

Install the collector once and every retriever that runs inside a chain declares
what it returned:

```ts
import { install } from '@shashu-ai/sdk/middleware/langchain';

await install({ corpus: 'policy_docs_v2' });
// LCEL, RetrievalQA-shaped chains, nested chains — nothing passed to invoke().
```

`install()` returns `false` and does nothing at all when `@langchain/core` is not
installed. `uninstall()` turns the collecting off.

One case is **not** automatic: a retriever invoked outside any chain
(`await retriever.invoke(q)` on its own). Its run has no parent to associate a
later model call with, and LangChain dispatches callbacks through a queue that
discards the async context they would need. Call `declareRetrieval(docs, …)`
there. `test/conformance/outside-chain.test.ts` holds both halves of that.

## n8n HTTP Request node: header snippet

Get a pre-formatted JSON object of headers for n8n “HTTP Request” nodes so each request includes Shashu auth and workflow context:

```ts
import { getN8nHeaderSnippet } from '@shashu-ai/sdk';

const { headers, json } = getN8nHeaderSnippet();
// headers: [ { name: 'X-Shashu-Source', value: 'n8n' }, ... ]
// json: '{"X-Shashu-Source":"n8n","X-Shashu-Workflow-Id":"...", ...}'
```

In n8n, set **Send Headers** (or equivalent) to the `headers` array or paste the `json` into your node config. You can pass `apiKey` and `baseUrl` explicitly or rely on `SHASHU_API_KEY` and `SHASHU_BASE_URL` in the environment.

## Streaming (SSE)

Send `stream: true` in the body and call `client.fetchStream(path, init, options)`.
The gateway streams the answer back as server-sent events in the chat streaming
format; read `response.body` with `getReader()` or hand it to your framework.

- **Checked first, then streamed.** The gateway inspects the whole answer before
  any of it reaches you, then sends it as a stream of events. The events arrive
  one by one, but the first one arrives only after the model has finished.
- **A security block is an error, not a broken stream.** Whether the gateway
  blocks the request (for example an injected prompt) or the answer (for
  example a leaked secret), it answers with an error before any event, and
  `fetchStream` throws the typed exception, as `fetch` does:
  `ShashuContentFilterError` (400) or `ShashuPolicyViolation` (403).
- A refused pass is retried once, before anything is read. A stream is never
  re-sent once it has started.

## License

MIT

## Documentation and support

Product documentation: [https://shashu.ai/docs](https://shashu.ai/docs).

Support is through your Shashu administrator.
