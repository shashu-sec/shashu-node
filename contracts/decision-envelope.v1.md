# SHASHU decision envelope, v1

**This is the canonical copy.** It lives here because the single definition it
describes lives here: `core/app/contract/envelope.py`, with the worked wire
samples at `docs/contracts/MESSAGE-FORMAT.md`. The four SDKs vendor it the way
they vendor `rag_context.v1.schema.json` beside it.

The refresh is manual for the same reason the schema's is — there is no
cross-repo credential (see `contracts/README.md`). Whoever changes the envelope
in `core/app/contract/envelope.py` refreshes this page and the four SDK copies.

Added here on **2026-09-08**. It existed only as the Python SDK's vendored copy
until then, which is backwards: the SDKs were reading a name the repo that
authors it did not write down.

> **The `code` list below is generated, not typed** (2026-09-13). It was
> hand-maintained until then and its count was wrong three separate times — as
> was this note's own earlier tally of what the SDK copies were missing. The
> list and the sentence that counts it are written by
> `scripts/ci/generate_envelope_codes.py` from `CODES` in the module, and the
> required `static fences` job fails if they drift. Compare a vendored copy
> against this page, not against any number quoted elsewhere. **No SDK is wrong
> because a copy is stale** — the rule below is that no client may hold a copy
> of this list or branch on it, so a stale copy changes no behaviour.

---

## The one thing a client does

**Read `decision`. Do not parse the message.**

## The six decisions

Source: `core/app/contract/envelope.py`, `DECISIONS`.

| `decision` | Caller got content | Meaning |
|---|---|---|
| `allow` | yes | A normal answer. Everything configured ran. |
| `allow_altered` | yes, **edited** | Policy changed the text. `altered` carries the counts. |
| `not_checked` | yes, **unverified** | Delivered before an inspection finished, or with one that could not run. |
| `block` | no | Blocked on content. |
| `refuse` | no | Refused by policy. Not about the content. |
| `fail` | no | Nobody decided. Gateway's fault, or an inspector's. |

`DELIVERED_DECISIONS` = `{allow, allow_altered, not_checked}` — the three where
the caller holds the provider's content.

**An unrecognised `decision` value MUST be treated as a block — fail closed.**
That is the gateway's own `decision_of()` and it binds the client libraries
identically.

## The two carriers a client can read

Three placements exist; a client sees two of them.

| Placement | Key | Present on |
|---|---|---|
| 200 body | top-level `shashu` | every 200 |
| 4xx/5xx body | `error.shashu` — nested INSIDE `error`, never beside it | every error |
| Response headers | `x-shashu-*`, below | **every** response |

Neither body placement is sufficient alone: two of the four first-party SDKs
drop unknown body keys entirely. Headers are the only carrier that always
survives.

## Envelope fields

Source: `Envelope.to_dict()`.

| Field | Always present | Notes |
|---|---|---|
| `decision` | yes | one of the six above |
| `retryable` | yes | boolean |
| `id` | yes | resolves to the stored audit record |
| `inspection` | yes | `{input, output, reason?, detectors?}` |
| `versions` | yes | `{contract, policy_id, policy, fail_posture}` |
| `message` | yes | prose. **Not a discriminator.** |
| `code` | required unless `decision == "allow"` | see below |
| `retry_after_ms` | only when `retryable` | integer milliseconds |
| `altered` | only on `allow_altered` | counts, e.g. `{"input_spans": 1}` |
| `attachments` | only when files were present | `{total, scanned, scanned_partial, not_inspected, blocked, items}` (2026-10-01) |
| `memory` | only when memory writes/recalls were present | `{coverage, writes, writes_blocked, recalls, recalls_flagged, items}` (2026-10-01) |
| `route_policy` | only when a route-data reason fired | `{route, category, reason, requested_route?, degraded_route?}` (2026-10-01) |

## Response headers

Source: `Envelope.headers()`.

| Header | Always present | Value |
|---|---|---|
| `x-request-id` | yes | same value as `id` |
| `x-shashu-decision` | yes | the decision string |
| `x-shashu-inspection` | yes | `input=checked;output=skipped;reason=...;<detector>=<state>` |
| `x-should-retry` | yes | `"true"` / `"false"` |
| `x-shashu-code` | only when a `code` is set | the code string |
| `Retry-After` | only when retryable with a time | **seconds** |
| `x-shashu-attachments` | only when a file count is above zero | `total=N;scanned=N;not_inspected=N;blocked=N` |
| `x-shashu-memory` | only when a memory count is above zero | `writes=N;blocked=N;recalls=N;flagged=N` |
| `Access-Control-Expose-Headers` | yes | the sorted list of the above |

## `inspection`

`input` and `output` each carry one of `checked`, `skipped`, `partial`,
`streamed_async` (`INSPECTION_STATES`). Complete means both are `checked`.
`decision: "allow"` with an incomplete inspection is forbidden at construction —
that outcome is `not_checked`.

## `code`

<!-- BEGIN GENERATED CODES: scripts/ci/generate_envelope_codes.py -->
`CODES` today is 46 values, in the module's order. Each declares the decision(s) it rides under -- its **family** -- so a client that meets an unfamiliar code still knows what happened, from `decision`:

| `code` | rides under |
|---|---|
| `prompt_injection` | `block` |
| `jailbreak` | `block` |
| `indirect_injection` | `block` |
| `tool_injection` | `block` |
| `pii_output` | `block` |
| `dlp` | `block`, `allow_altered` |
| `secret` | `block` |
| `egress_denied` | `refuse` |
| `retrieval_policy` | `refuse` |
| `tool_policy` | `refuse` |
| `agent_depth_exceeded` | `refuse` |
| `plan_limit` | `refuse` |
| `feature_disabled` | `refuse` |
| `quota_exceeded` | `refuse` |
| `inspector_timeout` | `fail`, `not_checked` |
| `upstream_error` | `fail` |
| `internal_error` | `fail` |
| `auth_missing` | `refuse` |
| `auth_invalid` | `refuse` |
| `auth_expired` | `refuse` |
| `auth_revoked` | `refuse` |
| `pass_provider_not_set_up` | `refuse` |
| `pass_not_licensed` | `refuse` |
| `pass_expired` | `refuse` |
| `pass_wrong_audience` | `refuse` |
| `pass_wrong_issuer` | `refuse` |
| `pass_unknown_agent` | `refuse` |
| `not_found` | `refuse` |
| `payload_too_large` | `refuse` |
| `unsupported_api_version` | `refuse` |
| `capability_mismatch` | `refuse` |
| `provider_guardrail` | `block`, `allow_altered` |
| `attachment_uninspected` | `refuse`, `not_checked` |
| `reasoning_not_representable` | `refuse` |
| `provider_state_uninspectable` | `refuse` |
| `tool_call_limit` | `fail` |
| `session_turn_limit` | `fail` |
| `session_time_limit` | `fail` |
| `prompt_size_limit` | `fail` |
| `response_size_limit` | `fail` |
| `retrieved_doc_limit` | `fail` |
| `unverified_result_limit` | `fail` |
| `scan_chunk_limit` | `fail` |
| `capacity_limit` | `fail` |
| `file_policy` | `refuse` |
| `route_data_policy` | `refuse` |
<!-- END GENERATED CODES -->

**This list is reproduced for the reader, and an SDK must not branch on it.**
The vocabulary grows — a new condition goes in `code`, never in a reused number
— so any client predicate written over a hardcoded copy of these strings
is wrong the day the next one ships, in four languages at once.
Block-ness is carried by `decision`, and `decision` alone is what a client
reads.

## Absence

**A response with no envelope and no headers is today's behaviour, everywhere.**
The four grammar flips that emit the envelope have not landed on every surface,
and a `legacy` account is served the headers with the body object withheld. A
reader that requires the envelope breaks every request currently in production.
Absence is not a decision, is not `fail`, and must not be coerced into one.
