/**
 * Gateway responses, captured verbatim. The only bodies these tests may assert.
 *
 * Source of truth: `sdks/e2e/capture_error_contract.py` in the trustgate-ai
 * repo, which drives a live gateway and records status, headers and body for
 * every refusal the `/v1/*` routes produce. Captured 2026-09-01; the committed
 * output is `reports/error-contract/error-contract-captures.json` there, and
 * each constant below names the scenario it came from.
 *
 * **Why this file exists.** These tests stub `fetch`, so they return whatever
 * they are handed and will pass against a body no gateway has ever sent. That is
 * not hypothetical: until 1.7.3 this suite asserted a flat `error.scope` on a
 * 429 (the gateway nests it two levels down), a `/budget/i` split of 403s (the
 * gateway sends nothing to split on), and `type="authentication_error"` on the
 * gateway's own 401 (that value means the *provider* rejected the gateway's
 * credential). All three passed for months.
 *
 * So: do not hand-write a body here. Re-run the harness and paste what it
 * recorded. If a scenario is not in the harness output, there is no fixture for
 * it and the behaviour is not asserted — the provider pass-throughs for
 * 401/403/429 and the 5xx family are in that category (they need a deliberately
 * broken or throttled provider credential, which the harness must not create).
 */

// --- Authentication: the gateway's own key check ---------------------------
// scenario: 401_invalid_agent_key
// Note `type` is "invalid_request_error", NOT "authentication_error".
export const AUTH_401_INVALID_KEY = {
  error: {
    message: 'Invalid TrustGate API Key',
    type: 'invalid_request_error',
    param: null,
    code: '401',
  },
  choices: [],
};

// scenario: 401_no_authorization_header — served with `WWW-Authenticate: Bearer`
export const AUTH_401_NO_HEADER = {
  error: {
    message: 'Not authenticated',
    type: 'invalid_request_error',
    param: null,
    code: '401',
  },
  choices: [],
};

// --- Access decisions ------------------------------------------------------
// scenario: 403_model_not_in_allowed_routes
export const ACCESS_403_MODEL_NOT_ALLOWED = {
  error: {
    message:
      "Access Denied: Model 'claude-3-opus-20240229' is not in the allowed routes for this agent.",
    type: 'invalid_request_error',
    param: null,
    code: '403',
  },
  choices: [],
};

// scenario: 403_model_not_in_allowed_routes_messages_wire — the same decision on
// /v1/messages with TRUSTGATE_WIRE_SHAPE_MESSAGES=enforce. No `code` field at
// all, which is why dispatch falls back to the transport status.
export const ACCESS_403_MESSAGES_WIRE = {
  type: 'error',
  error: {
    type: 'permission_error',
    message:
      "Access Denied: Model 'claude-3-opus-20240229' is not in the allowed routes for this agent.",
  },
};

// --- The two 429s ----------------------------------------------------------
// scenario: 429_rate_limit_token_bucket — served with `Retry-After: 1`.
// The outer error.message is the literal string "error"; scope,
// retry_after_seconds and the readable message are under error.details.error.
export const RATE_LIMIT_429 = {
  error: {
    message: 'error',
    type: 'invalid_request_error',
    param: null,
    code: '429',
    details: {
      error: {
        type: 'rate_limit_exceeded',
        scope: 'agent',
        retry_after_seconds: 1,
        message: 'Rate limit exceeded (agent). Retry after 1 second(s).',
      },
    },
  },
  choices: [],
};

// scenario: 429_identical_request_breaker — NO Retry-After header, no details.
// Retrying re-trips the breaker and refreshes its window.
export const LOOP_BREAKER_429 = {
  error: {
    message: 'Infinite Loop Detected',
    type: 'invalid_request_error',
    param: null,
    code: '429',
  },
  choices: [],
};

// --- Provider failures, passed through -------------------------------------
// scenario: 404_provider_model_not_found_passthrough
export const PROVIDER_404 = {
  error: {
    message: 'TrustGate Provider Error: Model not found (404)',
    type: 'ProviderModelNotFoundError',
    param: null,
    code: '404',
  },
  choices: [],
};

// scenario: 400_provider_invalid_request_passthrough
export const PROVIDER_400 = {
  error: {
    message: 'TrustGate Provider Error: Invalid request (400)',
    type: 'ProviderInvalidRequestError',
    param: null,
    code: '400',
  },
  choices: [],
};

// --- Everything else -------------------------------------------------------
// scenario: 422_empty_messages_array
export const VALIDATION_422 = {
  error: {
    message: 'messages array must contain at least one message',
    type: 'invalid_request_error',
    param: null,
    code: '422',
  },
  choices: [],
};

// scenario: 500_malformed_json_body — `error` is a STRING here, not an object,
// so there is no error.message and no error.code to dispatch on.
export const CRASH_500 = {
  error: 'Internal Server Error',
  detail: 'Internal error',
  request_id: 'dfeffdc1-aedd-4759-b160-dd85fd4cb0a0',
};

// scenario: 200_security_block_chat_wire — a refusal served as HTTP 200.
export const SECURITY_BLOCK_200 = {
  id: 'chatcmpl-c0f7013f70444f46b1f69d3b',
  object: 'chat.completion',
  created: 1788295344,
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content:
          "I cannot fulfill this request because it violates the organization's security policy.",
      },
      finish_reason: 'content_filter',
    },
  ],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
};

// ---------------------------------------------------------------------------
// Contract 2026-09-01 — bodies generated from the gateway's OWN builders
// ---------------------------------------------------------------------------
// Provenance differs from everything above and the difference is stated rather
// than blurred: these four were not taken with `capture_error_contract.py`
// against a live stack. They were produced on 2026-09-07 by driving
// `app.contract.responses.build_block` / `build_refusal` in-process from the
// trustgate-ai checkout — the same two functions the gateway's `/v1` hot path
// calls to serialise a refusal, with the same `make_envelope` and the same
// `SECURITY_REFUSAL_MESSAGE`. Nothing here is hand-written.
//
// That is weaker evidence than a live capture (it does not prove the hot path
// REACHES those builders) and stronger than a hand-typed body (it proves what
// they emit). The reachability half is already covered by the 200/legacy
// captures above, which came off the wire from the same emitter.

const REFUSAL =
  "I cannot fulfill this request because it violates the organization's security policy.";

// The `explicit` block encoding — the DEFAULT at contract 2026-09-01. Same
// event as SECURITY_BLOCK_200 above, different serialisation: 400 instead of
// 200, `error.type` "content_filter" instead of `finish_reason`, and
// `error.code` naming the finding instead of restating the status.
export const SECURITY_BLOCK_400_JAILBREAK = {
  error: {
    message: REFUSAL,
    type: 'content_filter',
    param: null,
    code: 'jailbreak',
    trustgate: {
      decision: 'block',
      retryable: false,
      id: '9f4c1c2e-6b3d-4a51-9c0e-2a7f8b1d4e30',
      inspection: { input: 'checked', output: 'checked' },
      versions: { contract: '2026-09-01' },
      message: REFUSAL,
      code: 'jailbreak',
    },
  },
  choices: [],
};

export const SECURITY_BLOCK_400_DLP = {
  error: {
    message: REFUSAL,
    type: 'content_filter',
    param: null,
    code: 'dlp',
    trustgate: {
      decision: 'block',
      retryable: false,
      id: '9f4c1c2e-6b3d-4a51-9c0e-2a7f8b1d4e30',
      inspection: { input: 'checked', output: 'checked' },
      versions: { contract: '2026-09-01' },
      message: REFUSAL,
      code: 'dlp',
    },
  },
  choices: [],
};

// A policy refusal on the contract version. `error.code` is a §3 REASON the
// SDK's dispatcher does not recognise as a status — which is exactly the case
// that must still land on ShashuPolicyViolation.
export const POLICY_403_EGRESS_DENIED = {
  error: {
    message:
      'A2A cross-tenant call blocked: the calling agent belongs to a different tenant and cross-tenant calls are not allowed.',
    type: 'permission_error',
    param: null,
    code: 'egress_denied',
    trustgate: {
      decision: 'refuse',
      retryable: false,
      id: '9f4c1c2e-6b3d-4a51-9c0e-2a7f8b1d4e30',
      inspection: { input: 'checked', output: 'checked' },
      versions: { contract: '2026-09-01' },
      message:
        'A2A cross-tenant call blocked: the calling agent belongs to a different tenant and cross-tenant calls are not allowed.',
      code: 'egress_denied',
    },
  },
  choices: [],
};

// A schema-invalid body on the LLM wire. `error.code` is neither a §3 reason
// nor a status — the third thing the field can hold. Read from
// `app.main.validation_exception_handler`, which serves this on every /v1/*
// path (the contract forbids 422 there).
export const SCHEMA_INVALID_400 = {
  error: {
    message: 'The request body is not valid for this endpoint.',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_request',
  },
  choices: [],
  detail: [
    {
      type: 'missing',
      loc: ['body', 'messages'],
      msg: 'Field required',
      input: { model: 'gpt-4o' },
    },
  ],
};
