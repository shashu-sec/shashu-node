/**
 * Shashu Node.js SDK
 *
 * Provides a TypeScript client, workflow context from n8n/Vercel/GitHub env vars,
 * middleware for Vercel AI SDK and LangChain, n8n header snippet helper, and
 * SSE streaming with workflow_id preserved for Shadow AI detection.
 */

export { Shashu } from './client.js';
export { ShashuError } from './types.js';
export {
  BODY_KEY,
  DECISIONS,
  DECISION_ALLOW,
  DECISION_ALLOW_ALTERED,
  DECISION_BLOCK,
  DECISION_FAIL,
  DECISION_NOT_CHECKED,
  DECISION_REFUSE,
  DELIVERED_DECISIONS,
  HEADER_ATTACHMENTS,
  HEADER_CODE,
  HEADER_DECISION,
  HEADER_INSPECTION,
  HEADER_MEMORY,
  HEADER_REQUEST_ID,
  HEADER_SHOULD_RETRY,
  HEADER_TRACE_ID,
  HEADER_SHASHU_REQUEST_ID,
  decisionFrom,
  isShashuBlock,
  shashuDecision,
  type Attachment,
  type AttachmentFinding,
  type AttachmentState,
  type Attachments,
  type Decision,
  type MemoryActivity,
  type MemoryItem,
  type RoutePolicy,
} from './decision.js';
export { shashuFetch, DEFAULT_BLOCK_ENCODING, BLOCK_ENCODING_HEADER } from './fetch.js';
export {
  PASS_CODES,
  PASS_EXPIRED,
  PASS_NOT_LICENSED,
  PASS_PROVIDER_NOT_SET_UP,
  PASS_UNKNOWN_AGENT,
  PASS_WRONG_AUDIENCE,
  PASS_WRONG_ISSUER,
  type PassRefusalCode,
} from './credential.js';
export { DEFAULT_CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from './context.js';
export {
  ShashuConfigError,
  ShashuAuthenticationError,
  ShashuBadRequestError,
  ShashuContextWindowExceeded,
  ShashuRateLimitError,
  ShashuPermissionError,
  ShashuBudgetExceededError,
  ShashuPolicyViolation,
  MemoryWriteBlocked,
  ShashuProviderError,
  ShashuContentFilterError,
  raiseForResponse,
  raiseIfContentFiltered,
  parseRetryAfter,
  gatewayRetryAfter,
} from './exceptions.js';
export {
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  resolveRetryPolicy,
  executeWithRetry,
} from './retry.js';
export {
  getWorkflowContextFromEnv,
  buildContextHeaders,
  buildSourceToolJson,
  buildInvocationHeaders,
  type InvocationHeaderOptions,
  HEADER_PREFIX,
  SOURCE_TOOL_HEADER,
  TRUSTLOG_HEADER_PREFIX,
} from './context.js';
export { tracer, captureIncoming, type A2ACapture } from './tracer.js';
export { getN8nHeaderSnippet } from './n8n.js';
export {
  Audit,
  type AuditConversation,
  type AuditEventInput,
  type AuditEventResult,
  type AuditVerdict,
} from './audit.js';
export {
  attachRagContext,
  makeRagContext,
  declareRetrieval,
  retrievalScope,
  buildRagContext,
  SOURCES,
  type RagContext,
  type RagDoc,
  type RagSource,
  type DeclareRetrievalOptions,
} from './rag.js';
export { declareMemory, memoryScope, type DeclareMemoryOptions } from './memory.js';
export { withRetrievalJoiner, type FetchLike } from './_joiner.js';
export {
  getShashuHeaders,
  createShashuOpenAIOptions,
  type ShashuOpenAIOptions,
} from './middleware/vercel-ai.js';
export { createShashuLangChainConfig } from './middleware/langchain.js';

export { getAnthropicHeaders, createShashuAnthropicConfig } from './middleware/anthropic.js';
export { getGeminiHeaders, createShashuGeminiConfig } from './middleware/google.js';

export type {
  WorkflowContext,
  RuntimeMetadata,
  ShashuConfig,
  RequestOptions,
  N8nHeaderSnippet,
  Provider,
} from './types.js';
