/**
 * Audit-event ingestion for vendor-controlled SaaS chokepoints.
 *
 * Mirrors the gateway's `POST /v1/audit/events` endpoint. Use this when you
 * have a connector (Microsoft Purview, Salesforce Event Bus, custom webhook)
 * that consumes vendor LLM events and needs to push them through Shashu's
 * scanner pipeline for audit-only logging — verdicts feed the audit log and
 * alerting but never block the originating request (the user already saw the
 * vendor's response).
 *
 * @example
 *   const tg = new Shashu({ baseUrl, apiKey });
 *   const result = await tg.audit.events({
 *     source: "ms_copilot",
 *     externalEventId: "evt_abc123",
 *     occurredAt: "2026-05-02T14:00:00Z",
 *     conversation: {
 *       messages: [{ role: "user", content: "summarize Q3 board minutes" }],
 *       response: "Q3 minutes summary: ...",
 *     },
 *     userContext: { user_id: "alice@example.com" },
 *   });
 *   if (result.is_threat) myAlertPipeline(result);
 */

import type { Shashu } from './client.js';
import type { RequestOptions } from './types.js';

export interface AuditConversation {
  messages?: Record<string, unknown>[];
  response?: string;
  trustgate_metadata?: Record<string, unknown>;
  /** Free-form passthrough preserved alongside the canonical conversation. */
  extra?: Record<string, unknown>;
}

export interface AuditEventInput {
  /** Connector identifier, e.g. "salesforce_einstein", "ms_copilot", "purview_dlp". */
  source: string;
  /** Vendor's event/transaction ID for cross-system correlation. */
  externalEventId?: string;
  /** ISO-8601 timestamp of the original LLM interaction. */
  occurredAt?: string;
  conversation: AuditConversation;
  /** Optional vendor-side user/tenant attribution for RBAC reporting. */
  userContext?: Record<string, unknown>;
  /**
   * Distributed trace ID linking related connector events. If absent, the
   * gateway falls back to the x-trustgate-trace-id header (auto-detected
   * from env or tracer context); without either, the AuditLog row will only
   * have transaction_id.
   */
  traceId?: string;
  /** Optional parent span ID for hierarchy reconstruction. */
  parentSpanId?: string;
  /**
   * Vendor session/conversation ID grouping multi-turn events. Connectors
   * should pass the vendor's session ID here so multi-turn flows cluster
   * correctly in the dashboard.
   */
  sessionId?: string;
}

export interface AuditVerdict {
  action?: string;
  severity?: string;
  pillars?: unknown;
  reason?: string;
  adapter?: string;
}

export interface AuditEventResult {
  transaction_id: string;
  mode: string;
  audit_action: string;
  severity: string;
  is_threat: boolean;
  ingress_verdict: AuditVerdict | null;
  egress_verdict: AuditVerdict | null;
  surface_verdicts: Record<string, unknown> | null;
}

export class Audit {
  constructor(private readonly client: Shashu) {}

  /**
   * POST a post-hoc audit event for scanning + audit-only logging.
   *
   * Non-2xx responses throw the typed exception hierarchy (e.g.
   * ShashuPolicyViolation on 403 when the connector key is invalid),
   * raised by `client.fetch`.
   */
  async events(input: AuditEventInput, options?: RequestOptions): Promise<AuditEventResult> {
    const body: Record<string, unknown> = {
      source: input.source,
      conversation: input.conversation,
    };
    if (input.externalEventId !== undefined) {
      body.external_event_id = input.externalEventId;
    }
    if (input.occurredAt !== undefined) {
      body.occurred_at = input.occurredAt;
    }
    if (input.userContext !== undefined) {
      body.user_context = input.userContext;
    }
    if (input.traceId !== undefined) {
      body.trace_id = input.traceId;
    }
    if (input.parentSpanId !== undefined) {
      body.parent_span_id = input.parentSpanId;
    }
    if (input.sessionId !== undefined) {
      body.session_id = input.sessionId;
    }

    // client.fetch throws the typed exception hierarchy on any non-2xx.
    const res = await this.client.fetch(
      '/v1/audit/events',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      options
    );

    return (await res.json()) as AuditEventResult;
  }
}
