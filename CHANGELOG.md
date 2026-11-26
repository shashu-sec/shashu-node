# Changelog

All notable changes to SHASHU (Node.js SDK, `@shashu-ai/sdk`) are
documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] — 2026-11-26

BREAKING: framework state keys are now `shashu_session_id` / `shashu_trace_id`.
The previous names are not read.

Provider pass-through errors are recognised by `SHASHU Provider Error:` (needs a
gateway that sends it). There is no fallback to the previous prefix.

SHASHU keys start `shashu_sk_`. Metadata, docs, and package URLs no longer
carry the previous product name.

Fixed: after a request has been sent, a dropped connection is
no longer retried automatically (avoids running the same request twice).

## [1.1.1] — 2026-11-25

Fixed: when the gateway was busy and the SDK retried, the retry could be sent
without the retrieval declaration. The request (body, headers, and
`shashu_metadata`) is now built once per logical call and only re-sent.

## [1.1.0] — 2026-11-25

Wire names moved to SHASHU (requires a SHASHU gateway); key prefix `tg_sk_` unchanged.

Retries when the gateway says busy (Retry-After + jitter, default 2 retries, configurable).

The one-shot `pass_expired` retry is unchanged and does not stack with busy-retry.
`x-shashu-hop-ticket` is not sent (never sent in 1.0.0). Planned later.

### Breaking

- Environment variables are `SHASHU_API_KEY` / `SHASHU_BASE_URL` / `SHASHU_DISABLE` only. The old environment-variable names are no longer read.
- Wire names are SHASHU only (`x-shashu-*`, `Shashu-Version`, `shashu_metadata`, body `shashu` / `error.shashu`). Old wire names are neither sent nor read.

## [1.0.0] — 2026-11-14

Rename and cloud-pass sign-in. Keys (`tg_sk_…`) keep working exactly as before.

### Fixed: the pass retry now fires (pass refusals are read by code)

The gateway refuses a cloud pass with HTTP 401, a fixed `error.code` and its own
sentence. The SDK used to look for six "Pass refused: …" sentences the gateway
never sends, so the one-time retry on an expired pass never happened.

- `pass_expired` (pass mode only): the cached pass is dropped, a new one is
  fetched, and the request is retried **once** (streaming: only before any byte
  has arrived).
- Every other pass refusal (`pass_provider_not_set_up`, `pass_not_licensed`,
  `pass_wrong_audience`, `pass_wrong_issuer`, `pass_unknown_agent`) is raised as
  `ShashuAuthenticationError` with `.code` set and the gateway's message
  unchanged. No retry.
- A 401 with no such code (an older gateway) is not retried. Key mode is
  unchanged.
- New constants: `PASS_CODES` and `PASS_PROVIDER_NOT_SET_UP`, `PASS_NOT_LICENSED`,
  `PASS_EXPIRED`, `PASS_WRONG_AUDIENCE`, `PASS_WRONG_ISSUER`, `PASS_UNKNOWN_AGENT`.

### Added: `tokenProvider` (cloud pass)

`Shashu`, `shashuFetch`, and the Vercel AI, LangChain and Anthropic
middlewares take a function that returns the current short-lived pass (or a
Promise). The SDK never calls Entra, Google or AWS. Give either a SHASHU key or
a token provider, not both. The pass is cached until 60 seconds before JWT
`exp`, refreshed once under concurrency, and retried once on an HTTP 401 whose
body is one of the six gateway `Pass refused:` messages. Streaming retries only
if no bytes have arrived. Policy blocks (403) are never retried.

`createShashuGeminiConfig` is key only for now. `getN8nHeaderSnippet` is a
paste-once header list (key only).

### Changed: package name, licence, env, public names

Package is `@shashu-ai/sdk`, version `1.0.0`, Apache-2.0.
Environment variables are `SHASHU_*` first, then `shashu_*` (warn once).
Public type, function and exception names are SHASHU (`Shashu`, `ShashuError`,
`shashuFetch`, `createShashuLangChainConfig`, …). Wire names (`x-shashu-*`,
`shashu_metadata`, `tg_sk_`) are unchanged.

## [4.0.0] — unreleased

One behaviour change, plus everything merged since `3.0.1`. Read the first
section before upgrading.

### Behaviour change: `shashu-version: 2026-09-01` is sent by default

Every request this SDK makes now carries `shashu-version: 2026-09-01`, the
same value the shashu AI Python SDK has sent since `0.15.2`. That covers the
`Shashu` client (`fetch` and `fetchStream`), `shashuFetch()`, and the
headers built by the Anthropic, Gemini, LangChain and Vercel AI middleware.

Without that header the gateway served this SDK its `legacy` contract. With
it:

- **Refusals arrive as errors, not as 200 replies.** A content block is an
  HTTP **400** (`error.type: "content_filter"`, `error.code` naming the
  finding). A policy refusal is a **403**, and a blocked memory write is
  `MemoryWriteBlocked`. Plan limits are **402**, quota is **429**, and a
  fail-closed scan is **503**. Under `legacy` each of these was a 200 with
  `finish_reason: "content_filter"`.
- **`ShashuContentFilterError` is still the type for a content block, but
  its fields change.** `status` is `400` instead of `200`, `finishReason` is
  `null` instead of `"content_filter"`, `message` is the gateway's own plain
  sentence (`error.message`), and `code` names the finding. Code that catches
  the type keeps working. Code that reads `err.status === 200` or
  `err.finishReason` does not.
- **Refusals that are not content blocks now raise their own types.** Under
  `legacy`, every refusal was a `ShashuContentFilterError`. Now a policy
  refusal is `ShashuPolicyViolation` (`error.type: "permission_error"`,
  `error.code` a reason such as `tool_policy` rather than `"403"`), a quota
  refusal is `ShashuRateLimitError`, and a fail-closed scan is
  `ShashuProviderError`.
- **Provider SDKs raise their own errors.** A provider SDK given
  `shashuFetch()` or a middleware config (raw `openai`, Vercel AI,
  LangChain, Anthropic, Gemini) now raises its own 400 or 403 error on a
  refusal (`BadRequestError`, `PermissionDeniedError`, …). Under `legacy` it
  returned the refusal as an ordinary 200 reply. The
  `shashu-block-encoding: explicit` header `shashuFetch()` already sent
  now takes effect, because the gateway ignores it without a version.
- **Full memory and inspection details are in the body.** A reply carries the
  `shashu` block, so `decision.memory.items` lists each memory save and
  recall (`kind`, `state`, `reason`, `tool`, `store`, …). Before, a flagged
  save under Monitor was counted in `x-shashu-memory` but not listed.
  `decision.memory.carrier` is now `"body"`.
- **Unchanged by design:** under Block mode, a memory save the gateway strips
  from a reply is still a normal delivered reply, with `memoryBlocked === 1`
  and no exception. `MemoryWriteBlocked` is raised only for a 403 refusal.

**To turn it off**, pass `contractVersion: null` to `new Shashu({...})`,
`shashuFetch({...})` or any middleware config. The SDK then sends no
`shashu-version` header and the gateway serves the account default,
`legacy` unless an operator changed it. Pass `contractVersion: "<date>"` to pin
another version. A `shashu-version` entry you put in `headers` yourself
always wins.

New public names: `DEFAULT_CONTRACT_VERSION`, `CONTRACT_VERSION_HEADER`, and
the `contractVersion` option on `ShashuConfig` and `ShashuFetchOptions`.
`getShashuHeaders()` (Vercel AI middleware) takes an optional third
argument, `contractVersion`.

### Added: `declareMemory()` / `memoryScope()` (`memory_context.v1`)

These sit beside `declareRetrieval()` / `retrievalScope()`. An app declares
the items it recalled from memory, and the next model call carries them to the
gateway as `memory_context.v1` (`contracts/memory_context.v1.schema.json`), so
memory checks can run on them.

- `declareMemory(items, { store, scope?, source? })` declares for the current
  async context. `memoryScope(items, options, fn)` declares for the duration
  of `fn` only.
- `store` is required. `scope` is `agent` (default), `crew` or `tenant`.
  `source` is one of the `memory_context.v1` values (default `sdk`). Anything
  else throws `TypeError`.
- A no-op under `shashu_DISABLE`. No collectors are included: a framework's
  memory is not captured automatically.

### Added: reading file, memory and route-policy results (FILE-06)

The gateway's decision now carries per-file results, memory results and a
route-policy block (`contracts/decision-envelope.v1.md`, contract
`2026-10-01`). They are readable, read-only, off the decision:

- **Files** — `d.attachments`, `d.filesUnverified`, `d.filesBlocked`. Body first; on a header-only (streaming) response the
  counts come from `x-shashu-attachments` and `attachments.carrier` says
  `"header"`. `files_unverified` is `not_inspected + scanned_partial`.
- **Memory** — `d.memory`, `d.memoryBlocked`, `d.memoryRecallsFlagged`, `d.memoryCoverage`.
- **Route policy** — `d.routePolicy`, and `err.routePolicy` on the refusal, so an app can
  say "route X is not approved for PHI" without parsing the message.
- **`MemoryWriteBlocked`** — a subclass of `ShashuPolicyViolation`, raised for a 403 whose
  decision reports a blocked memory write. Existing `catch` clauses for the
  parent still catch it.
- **Nothing unknown throws.** An unknown code, reason, field or attachment
  state is read, not raised on: an unknown state is `AttachmentState`
  unknown with the wire value on `rawState`. No reason vocabulary is held.

New public names: `MemoryWriteBlocked`, `HEADER_ATTACHMENTS`, `HEADER_MEMORY` (values) and the types `Attachments`, `Attachment`, `AttachmentFinding`, `AttachmentState`, `MemoryActivity`, `MemoryItem`, `RoutePolicy`. The block helper is unchanged — every new refusal
is `refuse`, not `block`. `contracts/sdk-surface.v1.md` is amended to match.

## [3.0.1] — 2026-09-15

Package metadata only. No code change from `3.0.0`.

- The npm page no longer lists a source repository link. Shashu is closed
  source, and the link pointed at a private repository that returned 404.

### Release pipeline: one publish gate removed

`npm-publish.yml` no longer runs the step **"package.json must declare its
repository (npm provenance needs it)"**. That gate refused to publish unless
`repository.url` named this GitHub repository, because `npm publish
--provenance` needs it. Two things made it obsolete:

- Provenance is off. npm refuses it for a private source repository (HTTP 422,
  measured on the `v3.0.0` tag), so `3.0.0` already published without it.
- This release removes the `repository` field, so the gate would fail every
  build.

All other gates are unchanged: tag matches `package.json`, `src/version.ts`
matches `package.json`, type-check, tests, build, and the built bundle carries
the release version.

## [3.0.0] — 2026-09-14

Three behaviour changes. Read these before upgrading from `1.8.0`.
(`2.0.0` was cut in git and never published; npm `latest` is still `1.8.0`.)

### Upgrading from 1.8.0: `isolateRetrieval()` is gone

**`isolateRetrieval()` is no longer exported.** `retrievalScope()` is the
replacement. Call sites that import `isolateRetrieval` from this package will
fail to compile. See the removal section below for the before/after.

### Upgrading from 1.8.0: a 400 content block is no longer a `ShashuBadRequestError`

Under the gateway's `explicit` block encoding, a content block arrives as
HTTP 400 with `error.type: "content_filter"`. This SDK used to throw
`ShashuBadRequestError` for that. It now throws `ShashuContentFilterError`.
**`catch (e) { if (e instanceof ShashuBadRequestError) }` no longer catches
a content block.** Adapters must add a `ShashuContentFilterError` branch
before their bad-request one. This change is on the `Shashu` client, not
the middleware path.

### Upgrading from 1.8.0: session limits can start firing, with no change on your side

**`new Shashu()` traffic now carries a client-sent `x-shashu-session-id`.**
Until now it carried none, and the gateway filled in a derived id for display
only. The gateway's session-window scan and per-session scan budget act only
on a client-sent session id. From `3.0.0` they do. An application you have not
changed can, after upgrading, see blocks or refusals that never occurred on
`1.8.0` — most likely on a long-lived client whose requests all share one
session. A long-lived client shared across users must pass a per-request
`sessionId`.

### Added — session at origin, the gateway's decision, `isShashuBlock`

The constructed client now sends `x-shashu-session-id` on every request,
including at origin. One client is one session; a captured A2A session
overrides the construction-time default; a per-request `sessionId` is an
instruction that wins. Without this header the gateway synthesises
`derived-` + sha256(agent + first message), so every run of an agent whose
first message is a static system prompt collapses into one Sessions row.

`shashuDecision` / `decisionFrom` read all six outcomes (`allow`,
`allow_altered`, `not_checked`, `block`, `refuse`, `fail`) from both
carriers (`body.shashu` and the `x-shashu-*` headers). Absence is
today's behaviour: a response with neither carrier is unchanged.
`isShashuBlock(err)` inspects an error and answers yes or no. It
replaces nothing and fails closed; `raiseForResponse` still fails open as
to block-ness, because it _does_ replace. Block-ness is carried by
`decision` alone — there is no copy of the `code` list.

`shashuFetch(...)` is the factory for a provider SDK's `fetch` option.
LangChain `install()` stays and is not deprecated: the standing rewiring
ruling covers provider clients, not a framework the customer chose. See
`docs/RULING-RUNTIME-REWIRING.md`.

The joiner refuses to attach when a snapshot holds conflicting corpora, so
a fan-out that shared a declaration before its first `await` becomes a
miss rather than a merge.

### Fixed — BREAKING for adapters: a 400 content block is no longer a `ShashuBadRequestError`

Under the gateway's `explicit` block encoding (the default at contract version
`2026-09-01`) a DLP, jailbreak or prompt-injection block arrives as **HTTP 400**
with `error.type: "content_filter"`. This SDK threw `ShashuBadRequestError`
for it — "your request was malformed" — so a caller with correct code was sent
to fix a payload that was never the problem, and the block never reached
whatever handles blocks.

It now throws **`ShashuContentFilterError`**: the same type the 200 +
`finish_reason: "content_filter"` encoding has always thrown. The two are one
event on two serialisations, and which one a caller sees is chosen by a request
header or an account default the calling code may not control — so throwing
different types would break a `catch` clause on the day an operator moved the
default, with no change on the customer's side. `finishReason` is now
`string | null` (`null` on the 400 encoding), `status` is the real status
instead of a hardcoded 200, and `error.code` carries the finding: `jailbreak`,
`dlp`, `pii_output`, `secret`, `prompt_injection`.

**`catch (e) { if (e instanceof ShashuBadRequestError) }` no longer catches a
content block.** That is the point of the change and it is the thing that
breaks: an adapter that funnels blocks through its bad-request branch stops
seeing them there, and — because `ShashuContentFilterError` and
`ShashuBadRequestError` are siblings under `ShashuError`, not parent and
child — an unchanged adapter falls through to whatever handles the base class.
Adapters must add a `ShashuContentFilterError` branch **before** their
`ShashuBadRequestError` one. Callers who already narrow on `ShashuError`,
or who already have a content-filter branch for the 200 encoding, need no
change.

`context_window_exceeded` is unchanged. The `ShashuContentFilterError`
constructor gained two optional trailing parameters (`status`, `details`) and
`finishReason` became optional; existing three-argument calls are unaffected.

### Known limitation — this fix is on the `Shashu` client, not the middleware path

`createShashuOpenAIOptions()`, `createShashuAnthropicConfig()`,
`createShashuGeminiConfig()` and `createShashuLangChainConfig()` return
_configuration_ — a base URL, headers and a `fetch`. They have never thrown a
Shashu exception and still do not: through a patched provider client a
refusal reaches the caller as that provider's own error. Measured in-process on
2026-09-07 against `openai` and `@anthropic-ai/sdk`:

| through a middleware-configured provider client | thrown                  |
| ----------------------------------------------- | ----------------------- |
| 403                                             | `PermissionDeniedError` |
| 400 + `content_filter`                          | `BadRequestError`       |

The `fetch` seam cannot fix this: both provider SDKs wrap the whole fetch call
in `catch -> APIConnectionError`, so a `ShashuPolicyViolation` thrown from
inside it reaches the caller as `APIConnectionError` with the real error only on
`.cause` — measured, both SDKs. Making a block catchable as a Shashu type on
that path needs a seam at the method the customer calls, which this package does
not have (there is no `patchOpenAI()` in the Node SDK, unlike the Python one).
That is tracked separately rather than half-built here.

### Fixed — `error.code` dispatch describes, and accepts, what the field holds

`dispatchCode` preferred `error.code` over the transport status, "a string like
`"403"`". That is no longer the only thing the field can hold. Measured against
the gateway on 2026-09-07 it is one of four:

- a §3 **reason** — `jailbreak`, `dlp`, `egress_denied`, `auth_expired`, … — on
  every path served under contract `2026-09-01`;
- the **HTTP status as a string** — still live, and still the default: an
  account that sets no `SHASHU-Version` is served `legacy`, and every refusal
  the gateway's `HTTPException` handler renders carries `str(status_code)`
  whatever the version;
- the literal `"invalid_request"`, on a schema-invalid body on the LLM wire;
- **absent** — the 500 crash handler sends `error` as a bare string, and the
  Anthropic-shaped envelope on `/v1/messages` drops the field.

The preference is **kept**, because the second case is the default path. What
changed is that it is now honoured only for a value matching `/^[0-9]{3}$/` in
100–599, instead of anything `parseInt` would swallow. `parseInt` reads a
numeric PREFIX and discards the rest, so `parseInt("403_policy", 10) === 403`
would have dispatched a content block on a 400 as a policy refusal nobody
raised, and `parseInt("4_0_3", 10) === 4` as a status that exists nowhere. The
fail-closed property now belongs to the function rather than to what `parseInt`
happens to reject, and `test/exceptions.test.ts` pins all five cases:
content-filter 400, an unrecognised code on a 403, an unrecognised code on a
400, no code at all, and a numeric-looking one.

### Removed — `isolateRetrieval()`, so the surface carries two retrieval functions

**Breaking, and the version line moves 2.0.0 -> 3.0.0.**
`isolateRetrieval()` is no longer exported from the package root.
**`retrievalScope()` is the replacement**, for every shape `isolateRetrieval()`
was offered for:

```ts
// before
await Promise.all(
  batches.map((b) =>
    isolateRetrieval(async () => {
      declareRetrieval(b.docs, { corpus: 'policy_docs_v2' });
      return openai.chat.completions.create({ model, messages: b.messages });
    })
  )
);

// after
await Promise.all(
  batches.map((b) =>
    retrievalScope(b.docs, { corpus: 'policy_docs_v2' }, () =>
      openai.chat.completions.create({ model, messages: b.messages })
    )
  )
);
```

**Why.** `contracts/sdk-surface.v1.md` in the gateway repo now freezes the
customer-facing surface of all four SDKs: **two** public retrieval functions and
no third. Four SDKs will exist and two do; the code under the hood differs per
language and that is fine, but what a customer types must not. Node was the one
that diverged -- Python already conformed -- and `isolateRetrieval()` was the
divergence. Its whole customer-facing job was already `retrievalScope()`'s, which
the source said itself.

**No published release carried it.** npm `latest` is 1.8.0; 2.0.0 was cut but
never published, and this function only ever existed in `[Unreleased]`. So the
major bump records a deliberate freeze of the public surface, **not** a
migration anyone on npm has to perform. If you are building against this repo
rather than the registry, the rewrite above is the whole change.

**Nothing else moved.** No behaviour, no cap, no wire output. The implementation
stays in `src/rag.ts` as internal -- `retrievalScope()` reaches the same
`AsyncLocalStorage.run` boundary, and `test/bus.test.ts` and
`test/conformance/manual.test.ts` still drive it directly by its internal path to
prove the isolation `retrievalScope()` depends on.

`test/surface.test.ts` now asserts the exported name set exactly, so the next
name that leaks fails the build instead of reaching a customer. It also measures
-- rather than assumes -- that `retrievalScope()` covers both shapes:
per-task isolation in a fan-out, and a helper that declares after it has already
awaited.

### Added — declare retrieval once, anywhere

`declareRetrieval(docs, { corpus, query })` records what a retrieval returned
wherever it happened, and the SDK attaches it to the next model call as
`shashu_metadata.rag_context`. `retrievalScope()` bounds one declaration to a
block, including a `Promise.all` fan-out where each task declares before its
first `await`. The contract
(`contracts/rag_context.v1.schema.json`) is vendored byte-for-byte from the
gateway repo, digest-pinned in `test/contract.test.ts` and held to LF by
`.gitattributes`; the caps come from it (64 documents, 2048-character previews,
8 declarations, newest kept).

Sibling of the Python SDK's `2c9c36e` and `12b6156`, with two differences that
are Node's, not ours, and are measured rather than assumed:

- **LCEL isolates its steps, as Python's does.** An `AsyncLocalStorage.enterWith`
  from `handleRetrieverEnd` is invisible to the `llm` step and to the caller.
  Worse than Python's, in fact: LangChain JS dispatches handlers through
  `consumeCallback`, which either wraps them in `asyncLocalStorage.run(undefined,
…)` or defers them onto a `p-queue` — both of which discard the write. So the
  collector wraps `CallbackManager` itself: capture at
  `CallbackManagerForRetrieverRun.handleRetrieverEnd` (inline, ordering
  guaranteed) and delivery at `CallbackManager.handleChatModelStart` (inline, in
  the model step's own context). `install()` is one line and needs nothing passed
  to `invoke()`.
- **A retriever invoked outside any chain is declaration-only.** Its run has no
  parent to associate a later model call with, and three separate context seams
  were measured not to reach the caller. A prototype wrap that did reach the
  caller was rejected for handing eight concurrent tasks each other's documents.

### Added — the joiner, on every client that offers a `fetch`

`withRetrievalJoiner()` wraps a `fetch` and attaches the carried declaration to
the outgoing JSON body. It is supplied automatically by
`createShashuLangChainConfig()`, `createShashuAnthropicConfig()`,
`createShashuOpenAIOptions()` and `new Shashu()`. With an empty bus it
forwards the caller's own `input`/`init` object references untouched. An explicit
`rag_context` on the body always wins. The bus is emptied the moment it is
written to a request, so declaration N never reaches request N+1.

**`createShashuGeminiConfig()` is the exception and is documented as such.**
`@google/generative-ai`'s `RequestOptions` carries `timeout`, `apiVersion`,
`apiClient`, `baseUrl` and `customHeaders` and nothing else; a `fetch` put in
that bag is ignored and the SDK calls the global one. That path is
declaration-only, and `test/conformance/seams.test.ts` asserts it.

### Changed — the LangChain callback

`ShashuLangChainCallback` no longer injects into
`invocationParams.extra_body`, which never reached an LCEL chain. It is now the
presence handler `install()` registers so a `CallbackManager` exists at all
(`CallbackManager.configure()` returns `undefined` for a chain invoked with no
callbacks, and then nothing can be observed). `lcDocumentsToRagContext()` is
unchanged and still exported.

### Added — CI

This repository had no test workflow: `npm-publish.yml` ran the gates, but only
on a `v*` tag push, so nothing in a pull request was ever checked.
`.github/workflows/ci.yml` runs type-check, build and the test suite (Node 20 and 22) on a bare `pull_request:` — no `paths:` filter, no `branches:` filter, no
job-level `if:`, each of which produces a check-run indistinguishable from a
pass. Nothing is marked required; `main` is unprotected on this repository, and
adding protection is a separate change.

## [2.0.0] — 2026-09-05

> **Why a major bump.** Two breaking changes, and both are the point of the
> release. A process that never configured a gateway address used to work — it
> silently sent its prompts to a vendor-branded host — and now throws. The
> `DEFAULT_GATEWAY_URL` export that held that host is gone.

Sibling of the Python SDK's `b3a92fb`, which made the same change there. The
Python `shashu/_config.py` is the reference this implementation matches,
down to the error wording.

### Removed — the default gateway host, at all seven sites

SHASHU is self-hosted. The operator's gateway is on their network, under
their name. An SDK that falls back to a vendor hostname when nobody configured
one does not fail — it succeeds, at the wrong destination, and the operator has
no signal that it happened. That fallback was present at **seven** places:

| Site                            | Was                                       |
| ------------------------------- | ----------------------------------------- |
| `new Shashu()`                  | `baseUrl` ?? env ?? default host          |
| `tracer` (constructor)          | env ?? default host                       |
| `createShashuAnthropicConfig()` | option ?? env ?? default host             |
| `createShashuGeminiConfig()`    | option ?? env ?? default host             |
| `createShashuLangChainConfig()` | option ?? env ?? default host             |
| `createShashuOpenAIOptions()`   | option ?? env ?? default host             |
| `types.ts`                      | the `DEFAULT_GATEWAY_URL` constant itself |

All six call sites now route through **one** helper (`src/config.ts`), rather
than six copies of the same expression that had already drifted — only the
client guarded `typeof process !== "undefined"`; the other five would throw in
an edge runtime. Resolution is now, everywhere:

**explicit `baseUrl` option → `shashu_BASE_URL` → `ShashuConfigError`.**

A blank or whitespace-only env var counts as unset. Trailing slashes are still
stripped.

### Removed — `DEFAULT_GATEWAY_URL` (breaking)

The constant is no longer exported from the package root.

**Deleted rather than deprecated.** A deprecation notice does not stop
`new Shashu({ baseUrl: DEFAULT_GATEWAY_URL })` from compiling and running, so
keeping the export would keep the exact string this release exists to remove
available to consumers — and it would keep it in the shipped bundle, which is
the thing being removed. With no consumer left inside the SDK it would also be
dead code. The behaviour change above is breaking on its own, so removing the
export costs no additional version increment.

If you were importing it, replace it with your own gateway address — passed as
`baseUrl` or set as `shashu_BASE_URL`.

### Added — `ShashuConfigError`

```ts
import { ShashuConfigError } from '@shashu-ai/sdk';
```

A `ShashuError` subclass, so existing `catch (e) { e instanceof ShashuError }`
code already sees it. It is the odd one out in `exceptions.ts`: every other class
there is HTTP-status shaped and describes a response, while this one is thrown
before any request. Its `status` is **`0`** — not an HTTP status, but the honest
statement that nothing was sent.

Its message names the environment variable, the option and the entry point, and
deliberately names **no hostname**: there is no address to suggest.

### Added — `shashu_DISABLE`

Set `shashu_DISABLE=1` (or `true` / `yes` / `on`, any case) to make the SDK a
no-op without a code change, matching the Python SDK. The four middleware
helpers then return `{}` and throw nothing even with no address configured —
your provider client keeps its own endpoint, its own credential and no Shashu
headers, which is exactly what Python's patchers do when disabled. The tracer
records and flushes no spans, while still maintaining trace context so an app
reading `tracer.traceId` keeps working.

It does **not** disable `new Shashu({...})`, matching Python: that client
exists only to call your gateway, so there is nothing for it to no-op into.

### Changed — middleware return types (breaking)

`baseURL` / `baseUrl` and `apiKey` are now optional on the four middleware
return types, because `{}` is what a disabled SDK returns. Code that read
`config.baseURL` as a `string` needs a null check.

### Changed — `tracer.gatewayUrl` is `string | undefined` (breaking)

The tracer resolves its address **optionally**, unlike every other entry point.
It is constructed when the module is imported (`export const tracer = new Tracer()`),
so throwing there would make `import '@shashu-ai/sdk'` fail for anyone who has
not set the variable — a far worse failure than the one being fixed. Unconfigured,
it holds no address and posts no span telemetry. Same shape as the Python SDK's
telemetry path.

### Tests

`test/config.test.ts` — 62 cases: the loud failure and its wording at each of the
five requiring entry points, resolution order at each, the tracer's optional
path, the kill switch, and a repo-wide assertion that the vendor hostname appears
in no runtime code path (it states its own denominator, so a green result cannot
be silence). `test/setup.ts` makes any `fetch` or socket connect from any test in
the suite an immediate failure, so a regression that resolves to a host cannot
quietly succeed against a real gateway.

Both directions were proven: reintroducing the fallback in `requireBaseUrl`
fails 19 of them, and reintroducing it in the tracer fails 3.

## [1.8.0] — 2026-09-01

> **Why a minor bump and not a patch.** A patch release announces "nothing
> observable changed", and that is not true here: `ShashuBudgetExceededError`
> is no longer thrown, the 401 documentation was inverted, the `/budget/i`
> dispatch is gone from the shipped bundles, the retry policy now declines a
> status it used to accept, and outgoing header NAMES change case in managed
> runtimes. One `instanceof` check can stop matching. The version number says so.

**Three of these are wrong-since-`1.6.0`, published to npm on 2026-05-29** — 95
days. One field the SDK advertised has been `undefined` that whole time, one
class of refusal has been misclassified, and one kind of 429 has been retried in
a way that made it worse. If you wrote error handling against this SDK, read
_[If you built against the old behaviour](#if-you-built-against-the-old-behaviour)_
below.

Error-contract corrections. Everything below was verified against
`sdks/e2e/capture_error_contract.py` in the gateway repo, which drives a
live gateway and records what it actually sends. Nothing here is asserted from
reading gateway source. Sibling of the Python SDK 0.10.0 change.

### Fixed — `scope` and `retry_after_seconds` were read one level too shallow

The 429 dispatch read `error.scope` and `error.retry_after_seconds`. The gateway
nests both under **`error.details.error`**: the rate limiter hands FastAPI a dict
detail and the gateway's `HTTPException` handler repackages any dict detail
there. Captured body:

```json
{
  "error": {
    "message": "error",
    "type": "invalid_request_error",
    "param": null,
    "code": "429",
    "details": {
      "error": {
        "type": "rate_limit_exceeded",
        "scope": "agent",
        "retry_after_seconds": 1,
        "message": "Rate limit exceeded (agent). Retry after 1 second(s)."
      }
    }
  },
  "choices": []
}
```

Measured against a live gateway before this change:

- **`ShashuRateLimitError.scope` was `undefined` on every rate-limit
  rejection.** Nothing else populated it — a field the SDK advertised and never
  filled.
- `retryAfterSeconds` looked correct only by luck: the body read returned
  `undefined` and the `Retry-After` header fallback supplied the value. It now
  comes from the captured field, with the header still used as a fallback.
- **`err.message` was the literal string `"error"`.** The outer `error.message`
  on a token-bucket rejection is that literal; the readable sentence is inside
  the detail, and is now what the error carries.

### Changed — 403 is no longer split by matching words in the message

`ShashuBudgetExceededError` was thrown when `/budget/i` matched the 403
message. That is guessing from prose: measured before this change, a policy
denial worded _"Access Denied: this agent has no budget headroom for that
route."_ was thrown as a budget error. It would equally miss a real budget denial
the moment someone reworded the message.

The gateway sends **no** discriminator — every 403 it raises carries an identical
`{type: "invalid_request_error", code: "403"}` envelope — so the split cannot be
made correctly and is gone.

Dispatch now keys on **`error.code`**, the one field the gateway populates
consistently (the HTTP status as a string), falling back to the transport status
when the body omits it — which the 500 crash handler and the Anthropic-shaped
`/v1/messages` envelope both do. Both fallbacks are covered by tests.

**Breaking for one narrow case.** `ShashuBudgetExceededError` is still
exported and still extends `ShashuPermissionError`, so imports and
`catch (e) { e instanceof ShashuPermissionError }` are unaffected — but
nothing throws it any more. Code that checks _only_ for the budget subclass will
now see `ShashuPolicyViolation`. Check the parent to cover both. The class
becomes reachable again if the gateway ships a real discriminator (ticket
[`the 403 discriminator ticket`](https://the gateway repository/issues/736)).

### Fixed — a 401 was documented as the gateway's own auth failure

The module header mapped `401 -> type="authentication_error"`. That is backwards.
The gateway's own agent-key failure sends `type="invalid_request_error"` with
message `"Invalid SHASHU API Key"` (or `"Not authenticated"`, plus a
`WWW-Authenticate: Bearer` header). Both captured.

`authentication_error` is what a **provider pass-through** carries: the gateway's
own stored provider credential was rejected upstream, and the message is prefixed
`SHASHU Provider Error:`. The caller's `tg_sk_` key is fine in that case and
rotating it fixes nothing — a gateway operator has to replace the provider
secret. The old header pointed every reader at the wrong credential. The same
applies to 403 (`ProviderPermissionError`), 404, 429 and the 5xx family.

- New: **`ShashuAuthenticationError.isProviderPassthrough`** — reads
  `error.type`, falling back to the message prefix, so the two cases can be told
  apart in code rather than by eye.
- Also corrected: there is no `"provider_error"` error type. Provider failures
  carry the gateway's own provider-error class name (`ProviderServerError`,
  `ProviderModelNotFoundError`, …). The dead `type === "provider_error"`
  dispatch condition is removed.

### Fixed — a 429 the gateway marked permanent was retried, and made worse

The retry policy treated 429 as categorically retryable. The gateway returns 429
for two unrelated reasons:

- the **token bucket** sends `Retry-After` and `retry_after_seconds`. It is
  telling you when to come back — retryable, at that time.
- the **identical-request breaker** (the same body repeated inside one trace id)
  sends **no** `Retry-After` and no detail. Retrying it was actively harmful: the
  gateway increments the breaker's counter on every hit and refreshes its
  60-second window from the last one, so the SDK held the caller inside the block
  it was trying to escape. Measured before this change: **3 gateway calls** for
  one caller request — the original plus two backoff retries, each one extending
  the block.

The rule is now **retry a refusal only when the gateway named a time to come
back** — `gatewayRetryAfter()` returns `undefined` when it did not, and
`undefined` is a decision, not a missing value. Status alone no longer authorizes
a retry. Measured after: **1 gateway call**.

- New: `gatewayRetryAfter(res, parsedBody)`, exported from the package root.
- The retry loop reads the body from `res.clone()`, so a 429 the caller receives
  is still readable — covered by a test.
- This also declines to retry a provider rate limit passed through from upstream,
  which carries no retry time either. Deliberate, and consistent with 5xx being
  off by default: by the time a provider error reaches you, the gateway has
  already spent its own three attempts on it.

### Fixed — header names were uppercase inside GitHub Actions, n8n and Vercel

`buildContextHeaders()` built its metadata header names straight from
environment-variable names, so a process running in a managed environment sent
keys like `x-trustlog-GITHUB-ACTION`, `x-trustlog-N8N-WORKFLOW-ID` or
`x-trustlog-VERCEL-URL`. Every header name is now lowercased on the way out,
matching the Python SDK, which has always done this in both of its header
builders.

**This is a correctness fix, not cosmetics.** HTTP/2 requires header field names
to be lowercase and treats a request carrying an uppercase one as **malformed**
(RFC 9113 §8.2.1), and the gateway parses these names literally.

**What changes for you:** if you run this SDK inside GitHub Actions, n8n or
Vercel, the `x-trustlog-*` metadata header **names** change case — six of them
under GitHub Actions, measured. Values are untouched, and no header is added or
removed. Nothing changes at all for a local process or an unmanaged runtime,
where the metadata keys were already lowercase. If you have gateway-side rules,
log queries or dashboards matching those names case-sensitively, they need the
lowercase form.

The bug dates to `dd7a33e` (2026-02-13). The test that catches it was written on
2026-06-22 and had been failing ever since — invisibly, because this repository
had no CI until 1.8.0 added a publish pipeline, whose first run caught it.

### Tests

Bodies now come from `test/captured.ts` — verbatim harness recordings, one
constant per captured scenario. Stubbed `fetch` returns whatever it is handed,
which is exactly how the three wrong shapes above stayed green for months.

**Not covered, and deliberately so:** provider pass-throughs for 401 / 403 / 429
and the whole 5xx family. The harness cannot produce them without a deliberately
broken or throttled provider credential, so there is no captured body to assert
and no test pretending otherwise. The 5xx retry tests assert call counts and
sleeps only, never an envelope; `isProviderPassthrough` has negative coverage
only (captured gateway 401s, asserting `false`).

### If you built against the old behaviour

**1. Stop catching `ShashuBudgetExceededError` on its own.** It is still
exported and still extends `ShashuPermissionError`, so imports keep working —
but nothing throws it any more. Since 1.6.0 it was thrown whenever the 403
message happened to match `/budget/i`, which caught ordinary policy denials and
would have missed a reworded budget denial. Check the parent:

```ts
catch (e) {
  if (e instanceof ShashuPermissionError) { /* policy AND budget */ }
}
```

This is the one source-compatible break in the release. An
`instanceof ShashuBudgetExceededError` check will stop matching.

**2. `err.scope` works now — and if you logged it, your logs say `undefined`.**
It was read from `error.scope`, which the gateway has never populated; the real
value is at `error.details.error.scope`. Every rate-limit rejection this SDK
threw since 1.6.0 carried `scope === undefined`, so any dashboard or alert keyed
on tenant-vs-agent rate limiting has been blind. It now reports `"tenant"`,
`"agent"` or `"tpm"`. Nothing to change in your code — but re-read any conclusion
you drew from that field.

**3. `err.message` on a 429 was the literal string `"error"`.** The readable
sentence lives in the nested detail and is now what the error carries. If you
matched on the message text, that match was against `"error"`.

**4. If you disabled retries because they made 429s worse, re-enable them.**
The gateway sends two unrelated 429s. The token bucket names a retry time; the
identical-request breaker does not, and refreshes its 60-second window on every
hit — so the old policy's backoff retries held you inside the block. Retry now
happens only when the gateway named a time to come back, via the newly exported
`gatewayRetryAfter()`. Measured: 3 gateway calls for one caller request before,
1 after.

**5. A 401 does not mean your API key is wrong.** The module header mapped
`401 -> type="authentication_error"`; backwards. Your own key failing sends
`type="invalid_request_error"` with `"Invalid SHASHU API Key"`.
`authentication_error` means the **gateway's stored provider credential** was
rejected upstream — rotating your `tg_sk_` key fixes nothing, an operator has to
replace the provider secret. Use the new
`ShashuAuthenticationError.isProviderPassthrough` to tell them apart before
sending a user to regenerate a key that was never the problem.

**6. If you read the response body of a 429 after a retry**, it still works —
the retry loop now reads via `res.clone()`, so the body the caller finally
receives is unconsumed. Covered by a test.

## [1.7.2] — 2026-07-30

Wire-parity fixes vs the Python SDK reference (`shashu` `context.py`).

### Fixed

- **`x-shashu-parent-id` no longer equals `x-shashu-span-id`.** The header
  block set both to the current span's id, so every span reported itself as its
  own parent on the wire. `x-shashu-parent-id` now carries the REAL parent
  span id via the new `tracer.parentSpanId` getter — `""` for a root span
  (Python parity).
- **A trace id is now ALWAYS emitted at origin.** With no active span and no
  captured A2A flow, no `x-shashu-trace-id` was emitted at all. Origin now
  resolves one mirroring Python `_get_trace_id()`: `N8N_EXECUTION_ID` →
  `GITHUB_RUN_ID` → `CI_PIPELINE_ID` (when `GITLAB_CI` is set) → a fresh UUID.
  The mid-flow (`isA2aHop`) and in-span branches are unchanged.

### Added

- `tracer.parentSpanId` — the current span's parent span id (`undefined` at
  origin or for a root span).

## [1.7.1] — 2026-06-22

### Fixed

- **Package entry points now resolve under ESM** (long-standing packaging bug, present
  since ≤1.4.0). With `"type": "module"` the build emits `dist/index.js` (ESM) and
  `dist/index.cjs` (CJS), but `main` / `module` / `exports` pointed `import` at a
  non-existent `dist/index.mjs` and `require` at the ESM `dist/index.js`. `import` from
  an ESM project therefore threw `ERR_MODULE_NOT_FOUND`. The `exports` map (root + all
  middleware subpaths), `main`, and `module` are corrected to the emitted files
  (`import` → `.js`, `require` → `.cjs`). No source/behavior change.

## [1.7.0] — 2026-06-22

Mirrors the Python SDK v0.9.1 — agent-to-agent (A2A) flow propagation with the
locked ADR-007 §4.1 caller semantics.

### Added

- **A2A inbound-capture + outbound propagation.** When your agent is SERVING a
  request, capture the inbound flow so a downstream call through the SDK PROPAGATES
  it (one lineage / one session across hops) instead of minting a fresh trace per process.
  - `captureIncoming(headers)` and the scoped `tracer.incoming(headers, fn)` read
    `x-shashu-trace-id` / `-session-id` / `-hop-depth` **and `-caller-agent-id`**
    (the upstream invoker) into the `AsyncLocalStorage` tracer (case-insensitive;
    plain objects, `Headers`, `Map`, or pair-arrays).
  - The outbound **gateway** call propagates the captured trace (minted only at
    origin), and attaches `x-shashu-session-id`, `x-shashu-hop-depth` (inbound+1),
    and `x-shashu-caller-agent-id` = **the FORWARDED inbound caller** — the upstream
    invoker, NEVER this agent's own id (so the gateway records the real invoker→callee
    edge, not a self-edge). Origin / caller-stripped ⇒ the caller header is omitted.
  - `buildInvocationHeaders({ callerAgentId })` (and `Shashu.buildInvocationHeaders()`,
    which uses the client's cached self-id) build the lineage headers for the **invoking**
    side — the one place caller = self: the message this agent sends to a downstream agent.
  - `Shashu` gained an `agentId` option; the client caches this agent's id from each
    gateway response's `x-shashu-agent-id` header (incl. 4xx) for use as the invocation caller.

### Notes

- **Origin (non-A2A) behavior is unchanged** — no A2A headers are emitted unless an inbound
  flow was captured. This release corrects the caller semantics to ADR-007 §4.1 (matching the
  shared SDK wire-contract and the Python 0.9.1 reference).

## [1.6.0] — 2026-05-28

Mirrors the Python SDK v0.8.0 (typed exceptions + conservative retries).

### Added

- **Typed exception hierarchy** (`src/exceptions.ts`), mapped to the error bodies
  the gateway actually returns. `ShashuError` remains the base (still exported
  from the same path), so existing `catch (e) { e instanceof ShashuError }`
  keeps working — every typed error is a subclass:
  - `ShashuAuthenticationError` (401), `ShashuBadRequestError` (400),
    `ShashuContextWindowExceeded` (400), `ShashuRateLimitError` (429 —
    with `.scope` and `.retryAfterSeconds`), `ShashuPermissionError` (403)
    with `ShashuBudgetExceededError` and `ShashuPolicyViolation` under it,
    `ShashuProviderError` (502/503/504), and `ShashuContentFilterError`.
- **Conservative client-side retries** (`src/retry.ts`, `RetryPolicy`). Defaults:
  retry connection errors + HTTP 429 (honoring `Retry-After`), `maxRetries: 2`,
  exponential backoff. **5xx OFF by default** (the gateway already retries
  providers). Configure via `new Shashu({ retryPolicy: {...} })` or disable
  with `retryPolicy: null`.

### Changed (behavior — why this is a minor bump)

- **`client.fetch()` now throws typed exceptions on all non-2xx** responses
  (previously it only threw on 403 and returned the `Response` for other errors).
- **A 200 with `finish_reason="content_filter"` now throws
  `ShashuContentFilterError`** (detected via a non-consuming `Response.clone()`
  peek, so the returned `Response` body is still readable). Previously a
  content-filtered response passed through silently.

### Backwards compatibility

- `ShashuError` keeps its import path and `(message, status, body)` constructor
  (a 4th optional `details` argument was added). All new errors subclass it.

### Known limitations

- **403 budget-vs-policy split is best-effort** (matches `/budget/i` in the
  message) because every soft-block 403 shares
  `{type:"invalid_request_error", code:"403"}`. Replaced once the gateway emits a
  stable discriminator (ticket `the 403 discriminator ticket`).
- Streaming (`fetchStream`) remains inert against the current gateway (it
  force-buffers chat responses and emits no chat SSE regardless of the `stream`
  flag or DLP settings). `fetchStream` now carries a NOTICE in its docstring and
  logs a one-time `console.warn` on first use; it degrades to the buffered JSON
  response. The method is retained (not removed) for forward compatibility once
  gateway streaming lands.

### Dev

- Added `vitest` and `npm test` / `npm run test:watch`. Tests mock global `fetch`.
