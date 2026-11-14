# TrustGate SDK public surface, v1

The customer-facing surface of every TrustGate SDK. The code under the hood
differs per language and that is expected; **what a customer types must not.**

This file sits beside `rag_context.v1.schema.json` and
`memory_context.v1.schema.json` because that is the one place all four SDKs
already look. Java and .NET read it directly and implement against it. Python
and Node vendor it the way they vendor the schemas.

**This page governs the shared surface, not any SDK's whole export list.** Every
name on it, every SDK exports, in the form shown. Each SDK also exports names
this page does not list — Python's exception classes, `RetryPolicy`, its Gemini
client and its deprecated patch entry points among them — and those are not
internal. A name this page does not list is neither required of the other SDKs
nor forbidden to them, except where the page says so (there is no third
retrieval function, and no third memory function). What stops a name leaking is each SDK's own surface test,
which pins that SDK's complete export set (Python: `tests/test_surface.py`,
`EXPECTED_ALL`); that test, not this page, is the authority for what one SDK
exports.

---

## The two public retrieval functions

There are **two**. There is no third.

### `declare_retrieval(docs, corpus, query?, source?)`

Declares the documents bound into the prompt. Callable anywhere between the
retrieval and the model call — the customer does not have to be near either.

### `retrieval_scope(docs, corpus, query?, source?)` + the unit of work

Binds those documents to that unit of work, wherever it runs.

The name is the same in every language. The **form** is idiomatic per language:

| Language | Form |
|---|---|
| Python | `with retrieval_scope(docs, corpus=...): ...` |
| Node | `await retrievalScope(docs, {corpus}, fn)` |
| Java | `try (var s = Retrieval.retrievalScope(docs, corpus)) { ... }` |
| .NET | `using var s = Retrieval.RetrievalScope(docs, corpus);` |

What it **guarantees** is the same everywhere. **How** each language achieves
that differs, and that difference is expected, not a defect to be smoothed
over: nothing extra is required in Python, Node needs isolation, Java and .NET
need context propagation across an executor. A `with`-block and a callback are
the same concept correctly expressed.

The guarantee, in customer terms:

> **If the retrieval and the model call might not be in the same flow, wrap
> them in a scope.**

---

## How the two functions are qualified

Stated per language, because an unstated qualifier is what drifts when the next
language lands:

| Language | Qualifier | How the customer reaches the functions |
|---|---|---|
| Python | none — imported directly | `from trustgate import declare_retrieval, retrieval_scope` |
| Node | none — imported directly | `import { declareRetrieval, retrievalScope } from "@trustgateai/sdk"` |
| Java | static holder named `Retrieval` | `Retrieval.declareRetrieval(docs, corpus)` |
| .NET | static holder named `Retrieval` | `using static TrustGate.Retrieval;` then `DeclareRetrieval(docs, corpus: ...)`, or fully qualified `TrustGate.Retrieval.DeclareRetrieval(docs, corpus: ...)` |

Python and Node import functions directly and need no holder. Java and C# have
no free functions, so both require one — and it is named for what it does
rather than for the product, so the qualifier does not stutter
(`TrustGate.TrustGate`) and does not shadow the namespace it lives in.

---

## The two public memory functions

There are **two**. There is no third. They are a sibling pair of the retrieval
functions, not extra retrieval functions. Collectors that auto-declare framework
memory are not part of this surface (parked).

### `declare_memory(items, store, scope?, source?)`

Declares the memory items bound into the prompt. Callable anywhere between the
recall and the model call.

`scope` defaults to `"agent"`. `source` defaults to `"sdk"`.

### `memory_scope(items, store, scope?, source?)` + the unit of work

Binds those items to that unit of work, wherever it runs, in the same form as
`retrieval_scope`.

| Language | Form |
|---|---|
| Python | `with memory_scope(items, store=...): ...` |
| Node | `await memoryScope(items, {store}, fn)` |
| Java | `try (var s = Memory.memoryScope(items, store)) { ... }` |
| .NET | `using var s = Memory.MemoryScope(items, store);` |

| Language | Qualifier | How the customer reaches the functions |
|---|---|---|
| Python | none — imported directly | `from trustgate import declare_memory, memory_scope` |
| Node | none — imported directly | `import { declareMemory, memoryScope } from "@trustgateai/sdk"` |
| Java | static holder named `Memory` | `Memory.declareMemory(items, store)` |
| .NET | static holder named `Memory` | `using static TrustGate.Memory;` then `DeclareMemory(items, store: ...)`, or fully qualified `TrustGate.Memory.DeclareMemory(items, store: ...)` |

---

## Arguments

Fixed in every language:

| Position | Name | Required | Default |
|---|---|---|---|
| 1 | `docs` | yes | — |
| 2 | `corpus` | yes | — |
| 3 | `query` | no | none |
| 4 | `source` | no | `"manual"` |

`docs` is first. `corpus` is required. `query` and `source` are optional.
Casing follows each language's convention (`declare_retrieval` in Python,
`declareRetrieval` in Node, `DeclareRetrieval` in .NET); the argument order and
the names themselves do not change.

How arguments after `docs` are passed is idiomatic — keyword-only in Python, an
options object in Node, positional or an overload in Java and .NET — but a
customer reading one language's call must recognise it in another.

---

## Reading the decision

Additive in v1, added 2026-09-08. The gateway emits one decision envelope into
three placements (`contracts/decision-envelope.v1.md`); two of them reach a
client. Every SDK exposes the same two names for reading it, plus the type they
return:

| Language | Read the decision | Recognise a block |
|---|---|---|
| Python | `trustgate_decision(result_or_error)` | `is_trustgate_block(err)` |
| Node | `trustgateDecision(resultOrError)` | `isTrustGateBlock(err)` |
| Java | `TrustGate.decisionOf(resultOrError)` | `TrustGate.isBlock(err)` |
| .NET | `TrustGate.DecisionOf(resultOrError)` | `TrustGate.IsBlock(err)` |

Three properties are fixed in every language:

1. **Absence returns nothing** — not a synthesised `allow`, not a `fail`. Most
   surfaces send no envelope today and must keep behaving exactly as they do.
2. **An unrecognised `decision` is a block.** The gateway's `decision_of()`
   rule, binding on the clients.
3. **No SDK holds a copy of the `code` vocabulary.** Block-ness is carried by
   `decision`; `code` grows, and four hardcoded copies would need four edits.

`is_trustgate_block` **fails closed** — a TrustGate block signal the SDK cannot
fully parse answers true. It replaces nothing, so the cost of a wrong "yes" is
one unnecessary review branch and the cost of a wrong "no" is blocked content
treated as delivered.

It reads the decision off **whatever the caller is actually holding**, which on
a framework path is the PROVIDER's error type, not ours — an
`openai.BadRequestError` raised through LangChain, say. Both the parsed body
and the response headers are read off it, under whichever attribute names that
SDK uses.

### The family rule — why an old SDK handles a new code

Added 2026-09-17, with the gateway-side fence that makes it true.

`code` grows; the six decisions do not. Every `code` the gateway may emit now
**declares which decision(s) it rides under** — its *family* — and
`contracts/decision-envelope.v1.md` publishes the table. Two CI checks in the
required `static fences` job hold it
(`scripts/ci/generate_envelope_codes.py`):

* a `code` with no declared family fails the build;
* a **seventh decision** fails the build. The six are frozen, and the failure
  says why: every shipped SDK reads an unrecognised decision as a BLOCK
  (`_coerce_decision`, `coerceDecision`, `!DELIVERED.contains(...)`), so a
  seventh would silently turn that traffic into a block for every customer who
  has not upgraded. A new coverage condition rides the existing `inspection`
  field as a **modifier beside** the decision, never as a new decision.

What that buys the client: an SDK from two years ago meets a code it has never
heard of, reads `decision`, and is right. So:

* **the raw `code` is passed through untouched** — no translation, no
  normalisation, no mapping table in any SDK;
* **an unrecognised `code` is not an error**; it arrives under a known
  decision and is handled by it;
* all six decisions are distinguishable by the caller. Python and Node expose
  `delivered` / `is_block` / `is_altered` / `unverified` beside the raw string;
  Java and .NET expose the raw string on `decision()` / `Decision`.

### Signing in with a cloud pass — the six refusal codes

Added 2026-11-12 (I13-FIX). An agent that signs in with a short-lived pass from
its identity provider (Microsoft Entra, Google Cloud, AWS) instead of a SHASHU
key is refused for one of six reasons, and each needs a different action from
the caller. Each arrives as HTTP **401** under decision `refuse`, with a fixed
`code` in the error body's `code` field — on the legacy body **and** on every
contract version — and its approved sentence as the message:

| `code` | Message | What the caller does |
|---|---|---|
| `pass_provider_not_set_up` | No identity provider is set up for agents. | Operator: add the Agents connection. |
| `pass_not_licensed` | Pass sign-in needs the Enterprise plan. | Operator: licence; or sign in with a SHASHU key. |
| `pass_expired` | This pass has expired. Fetch a new one. | Fetch a new pass from the provider, retry once. |
| `pass_wrong_audience` | This pass is meant for a different audience. | Request the pass for the gateway's audience. |
| `pass_wrong_issuer` | This pass comes from an unknown issuer. | Use the identity provider the gateway is set up for. |
| `pass_unknown_agent` | No agent matches this pass. | Operator: register (or switch back on) the agent. |

This is the one place an SDK **may** match on `code` values: a token provider
that sees `pass_expired` fetches a new pass and retries once; every other code
is surfaced to the caller unchanged, with the gateway's message. Any other
`pass_*` code an older SDK does not know is still a `refuse` and is surfaced the
same way (the family rule above). The six are generated into
`contracts/decision-envelope.v1.md` from `app.contract.envelope.PASS_CODES`.

### The block helper means `block`, and nothing else

Settled 2026-09-17, replacing a recorded divergence.

`is_trustgate_block` / `isTrustGateBlock` / `TrustGate.isBlock` /
`TrustGate.IsBlock` answer **one** question: is `decision` the value `block`?
It reads `decision` and never `code`, in all four languages.

It is deliberately NOT "did the caller get content". Java and .NET used to
answer that — `!DELIVERED.contains(decision)` — so a `refuse` (a policy
refusal: a missing key, a disabled feature, an address we do not serve) and a
`fail` (we broke; nobody decided) both came back as blocks. The function is
named for a block, so it must mean a block; answering the other question under
this name tells a customer refused on policy that a guardrail fired on their
content, and sends them to review a prompt nothing inspected.

**No "was it delivered" accessor exists.** The question is a real one and is
answerable today by comparing the raw decision against `allow` /
`allow_altered` / `not_checked`; adding a named helper for it is additive and
has not been ruled on.

Fail-closed is unchanged and is part of the rule, not an exception to it: an
unrecognised `decision` is **coerced to `block`** and only then compared, so a
decision the gateway invents after an SDK ships is still a block. That is
`_coerce_decision` (Python), `coerceDecision` (Node), `coerceDecision`
(Java) and `CoerceDecision` (.NET) — four implementations of one rule.
Absence still returns nothing, and a TrustGate block signal that cannot be
parsed is still `true`.

### The 400 path — headers are the discriminator

On an error response, what says the response is OURS is the presence of the
`x-trustgate-*` headers, **not** the value of any code. Headers present means
it passed through the gateway. Headers absent means it is not ours — most
likely the caller's own malformed request — and no SDK may claim it as a
TrustGate block. Every builder in `app/contract/responses.py` attaches
`Envelope.headers()`, including the 400 refusal path, so the discriminator is
present on every contract response and cannot be switched off.

Through LangChain the header carrier is **load-bearing**: LangChain drops the
body carrier in both Python and JS, so `include_response_headers=True` is
mandatory or every decision reads as absence, silently.

### Reading a decision the caller's object cannot carry

Additive in v1, added 2026-09-08 alongside the client factory below.

A framework can drop the envelope between the wire and the caller. Measured
against langchain-openai 1.6.1: `openai` keeps the top-level `trustgate` object
on `ChatCompletion.model_extra`, but LangChain's `_create_chat_result` builds
`response_metadata` from a fixed key list, so the body carrier does not reach
the caller at all. The HEADERS do (`ChatOpenAI(include_response_headers=True)`).

So every SDK also exposes the parser over the two PLAIN carriers, for the case
where there is no object of ours to hand it:

| Language | Read from a body and/or headers |
|---|---|
| Python | `decision_from(body, headers)` |
| Node | `decisionFrom(body, headers)` |
| Java | `TrustGate.decisionFrom(body, headers)` |
| .NET | `TrustGate.DecisionFrom(body, headers)` |

Either argument may be absent. Absence in both returns nothing — property 1
above, unchanged.

### Reading files, memory and route policy

Additive in v1, added 2026-09-25 (FILE-06). The envelope's three optional
blocks — `attachments`, `memory`, `route_policy`
(`contracts/decision-envelope.v1.md`) — are read off the same decision object,
read-only, in every language:

| Language | Files | Memory | Route policy |
|---|---|---|---|
| Python | `d.attachments`, `d.files_unverified`, `d.files_blocked` | `d.memory`, `d.memory_blocked`, `d.memory_recalls_flagged`, `d.memory_coverage` | `d.route_policy` |
| Node | `d.attachments`, `d.filesUnverified`, `d.filesBlocked` | `d.memory`, `d.memoryBlocked`, `d.memoryRecallsFlagged`, `d.memoryCoverage` | `d.routePolicy` |
| Java | `d.attachments()`, `d.filesUnverified()`, `d.filesBlocked()` | `d.memory()`, `d.memoryBlocked()`, `d.memoryRecallsFlagged()`, `d.memoryCoverage()` | `d.routePolicy()` |
| .NET | `d.Attachments`, `d.FilesUnverified`, `d.FilesBlocked` | `d.Memory`, `d.MemoryBlocked`, `d.MemoryRecallsFlagged`, `d.MemoryCoverage` | `d.RoutePolicy` |

The record types are `Attachments` (with `Attachment` items and their
`AttachmentFinding`s), `AttachmentState`, `MemoryActivity` (with `MemoryItem`
items) and `RoutePolicy` — the same names in all four. A refused memory write
raises `MemoryWriteBlocked`, a subclass of each SDK's existing 403 type
(`TrustGatePolicyViolation`); the route policy is also readable off that
exception (`route_policy` / `routePolicy` / `routePolicy()` / `RoutePolicy`).

Five properties are fixed in every language:

1. **Absent means absent.** A response with no files has no `attachments`
   (nothing, not an empty block), and every counter reads zero. The same for
   memory and route policy.
2. **Body first, header counts as the fallback, carrier recorded.** When the
   body carried no envelope — a streaming or header-only reader — the counts
   come from `x-trustgate-attachments` / `x-trustgate-memory`, `items` is empty,
   and `carrier` says `"header"` rather than `"body"`. Nothing per-file and no
   route policy ever rides a header. The header does not carry
   `scanned_partial`; it is the remainder of `total` after the other three
   states, which errs toward counting a file as unverified.
3. **`files_unverified` is `not_inspected + scanned_partial`**: the files the
   model received without a complete inspection.
4. **Nothing unknown throws.** An unknown `code`, reason, field, memory kind or
   coverage is passed through as its raw string; an unknown attachment state is
   `AttachmentState` **unknown**, with the wire value on `raw_state` /
   `rawState` / `rawState()` / `RawState`. Attachment state is the only closed
   set an SDK holds, because the contract closes it; **no SDK holds a copy of
   the reason vocabulary**, for the same reason it holds no copy of `code`.
5. **`MemoryWriteBlocked` is chosen from the memory block, not from `code`** —
   a 403 whose decision reports a blocked write (`memory_blocked > 0`). The
   block helper is unchanged: every new refusal is `refuse`, so it answers
   false. The gateway's memory refusals today refuse a **recall**, a request
   that relies on provider-kept history, or a suspicious instruction change; a
   blocked **write** is stripped from a delivered reply (`memory_blocked` = 1),
   not refused. So those refusals raise the parent `TrustGatePolicyViolation`,
   whose decision carries the memory block (a `recall` item in state `blocked`)
   and whose message is the memory sentence.

---

## Integrating a framework's own client

Additive in v1, added 2026-09-08.

Most agents are not written against a TrustGate client. They are written
against `ChatOpenAI`, `LlamaIndex`'s `OpenAI`, or a bare provider SDK, and
those never call our client — so our retrieval joiner is not mounted and our
`x-trustgate-*` headers are never built.

Every OpenAI-compatible SDK already accepts a caller-supplied HTTP client. That
is the seam, and each SDK exposes a factory for it. **The factory patches
nothing**, and it is the integration this contract specifies.

**Run-time patching still ships today, and a reviewer should know exactly
where.** Nothing is patched by importing an SDK; each of these acts only when
the application calls it:

- **Python — deprecated, not removed.** `patch_openai`, `patch_anthropic`,
  `patch_google_generativeai` and `patch_all` are exported from `trustgate`.
  Called, they rebind methods on the installed `openai`, `anthropic` and
  `google.generativeai` libraries in that process. They have been deprecated
  since Python SDK 0.13.0 — every call emits a `DeprecationWarning` — and the
  SDK schedules their removal for a future major release. They still work
  unchanged until then.
- **Node — the LangChain collector.** `install()` from
  `@trustgateai/sdk/middleware/langchain` rebinds `CallbackManager` and
  retriever-run methods in `@langchain/core`, so retrievals are declared
  without a `callbacks` argument. It is not deprecated.

No new SDK surface may integrate by patching.

| Language | Factory |
|---|---|
| Python | `trustgate_http_client(...)` / `trustgate_async_http_client(...)` |
| Node | `trustgateFetch(...)` |
| Java | `TrustGate.httpClient(...)` |
| .NET | `TrustGate.HttpClient(...)` |

Three properties are fixed in every language:

1. **It carries the same transport/interceptor the SDK's own client carries.**
   One implementation, not a second copy — a joiner that behaved differently on
   the framework path is a joiner that would be found to behave differently in
   production.
2. **Trace and session are minted ONCE, at construction**, so every hop of an
   agent's tool loop lands in one session.
3. **A caller-supplied transport is never replaced**, only defaulted.

### `TrustGate-Version`

Every SDK sends `TrustGate-Version: 2026-09-01` on every request by default:
its own client, its streaming call, and every path that routes a provider
client through the gateway (the transport, interceptor, handler or fetch it
hands out). Python since 0.15.2; Node since 4.0.0; Java and .NET since
0.3.0-alpha. A request without it is served the gateway's `legacy` contract
unless the account has a default of its own.

What the version changes for the caller:

* **Refusals arrive as errors.** A content block is a 400 with
  `error.type: "content_filter"`; a policy refusal a 403; a plan limit,
  quota or unfinished inspection a 402, 429 or 503. On `legacy` every one of
  them is a 200 whose content is the refusal sentence. Each SDK raises its
  existing types for these, with the gateway's sentence as the message.
* **The decision is in the body.** A delivered reply carries the `trustgate`
  envelope, so `memory`, `attachments`, `inspection` and `route_policy` are read
  from the body with their items. On `legacy` only the counts in the
  `x-trustgate-*` headers arrive.
* **The A2A depth and loop breakers are a 403**, not a retried 429.

It is a **default, not a hardcode.** Every SDK lets the caller pin another
date or send no version at all: `contract_version=None` (Python),
`contractVersion: null` (Node), `.contractVersion(null)` (Java),
`ContractVersion = null` (.NET). A version the caller set on the request
itself is never replaced.

### `TrustGate-Block-Encoding`

The factory sends `TrustGate-Block-Encoding: explicit` by default: a block
comes back as a **4xx whose body names the finding code**, rather than a 200
whose `finish_reason` is `content_filter`. Through a framework, the 200 shape
is the dangerous one — the caller is handed an empty answer and no exception,
so a block looks like a model that had nothing to say.

It is a **default, not a hardcode.** Every SDK lets the caller choose another
encoding or send no such header at all. The gateway reads it only on a
non-legacy version, which is why `TrustGate-Version` is sent with it.

---

## Which session a request joins

Additive in v1, added 2026-09-13. Python ships it in 0.16.0; Node in 3.0.0;
.NET and Java in this pass.

The session is what the gateway's Sessions screen groups on. A request that
carries no `x-trustgate-session-id` gets one derived by the gateway from the
agent id and the first system-or-user message, so every run of an agent whose
first message is a static system prompt lands in the SAME session. So every
client shape sends one, from the first request, including at origin.

| Language | On the constructed client | Per request |
|---|---|---|
| Python | `TrustGate(..., session_id=None)` / `AsyncTrustGate(..., session_id=None)` | `create(..., session_id=None)` |
| Node | `new TrustGate({ sessionId })` / `trustgateFetch({ sessionId })` | `fetch(path, init, { sessionId })` |
| .NET | `new TrustGateClient(new TrustGateClientOptions { SessionId = ... })` | `CreateAsync(..., sessionId: ...)` / `CreateStreamAsync(..., sessionId: ...)` |
| Java | `TrustGateClient.builder().sessionId(...)` | `create(..., sessionId)` / `createStream(..., sessionId)` |

The factory's `session_id=` (above) is the same argument; its headers are fixed
when the client is built, so it has no per-request form and its `session_id=`
ranks as the per-request one in property 2 below.

Three properties are fixed:

1. **One client is one session.** Omitted, the session is minted once when the
   client is constructed, so every request that client makes — every hop of a
   tool loop — joins it, and two clients are two sessions. Passed, it is used
   verbatim.
2. **A captured inbound session wins over the client's own.** A process serving
   an inbound A2A flow propagates that flow's session rather than starting its
   own. Only a per-request `session_id=` overrides it.
3. **A per-request `session_id=` applies to that request only.** It does not
   change the client's session, so the next request is back on it.

Which to use: a client constructed per agent run (a script, a job, one
conversation) needs nothing — the minted session is the run. A long-lived client
shared across many users or conversations (a web service) must pass
`session_id=` per request; otherwise every user's traffic joins the one session
the client minted at startup.

Trace is unchanged by this section: the constructed client resolves a trace per
request, as it did before, and only the factory fixes its trace at construction.

---

## Config surface

Fixed:

- `TRUSTGATE_BASE_URL` — the gateway address. **There is no default and no SDK
  may guess one.** TrustGate is self-hosted; a vendor hostname fallback would
  send a misconfigured process's prompts to a host nobody in that organisation
  chose.
- `TRUSTGATE_DISABLE` — set to `1` to make every entry point a no-op, without a
  code change.
- A `TrustGateConfigError` equivalent — raised/thrown when no address resolves.

### The frozen error message

When nothing resolves, the message is, verbatim:

```
TrustGate gateway address is not configured, so {entry_point} has nothing to
route to. Pass {argument} to {entry_point}, or set the TRUSTGATE_BASE_URL
environment variable. TrustGate is self-hosted: the SDK has no default address
and will not guess one.
```

(One line in the SDKs; wrapped here to fit the page.)

Two substitutions, and **only** two:

- `{entry_point}` — the function the customer called, named as they would write
  it: `patch_all()`, `new TrustGate()`.
- `{argument}` — the argument that would have supplied the address, rendered
  the way that language passes it. This is the one place the two shipping SDKs
  differ today, and the difference is idiomatic, not drift:
  - Python renders the keyword form: `Pass base_url=... to patch_all()`
  - Node renders the option name: `Pass baseUrl to new TrustGate()`

When more than one variable is read, `set the TRUSTGATE_BASE_URL environment
variable` becomes `set one of the X or Y environment variables`. That branch is
part of the frozen text too.

Two properties hold in every language and are asserted by each SDK's surface
test:

1. The message **names `TRUSTGATE_BASE_URL`**.
2. The message **contains no hostname.** There is no address to suggest, so
   suggesting one is a bug.

---

## What is frozen

Adding a name to the shared surface is a change to this contract, not an
implementation detail. Adding any public name to one SDK is a change to that
SDK's surface test, which asserts its exported names are exactly the expected
set, so a new export fails the build. That test
exists because a name did leak: Node exported a third retrieval function,
`isolateRetrieval`, whose customer-facing job `retrievalScope` already covered.
It was removed in Node 3.0.0 and the implementation kept internal.

Changes within v1 are **additive only** — a new optional argument, a new
optional function outside the retrieval surface. Anything that would break a
v1 call site (a renamed function, a reordered argument, a new required
argument, changed error wording) is v2, in a new file.
