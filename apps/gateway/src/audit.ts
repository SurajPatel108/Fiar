import type { PoolClient } from 'pg';

import { createId } from '../../../packages/shared/src/ids';

export interface AuditEventInput {
  tenantId: string;
  actionId: string;
  actorType: 'agent' | 'manager' | 'admin' | 'service';
  requestHash: string;
  eventType?: 'action.recorded' | 'approval.approved' | 'approval.rejected' | 'approval.expired';
  decision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  reason: string;
  correlationId: string;
  payload: Record<string, unknown>;
}

export async function insertAuditEvent(client: PoolClient, input: AuditEventInput): Promise<string> {
  const auditId = createId('aud');
  await client.query(
    `
      insert into audit_events (
        id,
        tenant_id,
        action_id,
        event_type,
        actor_type,
        request_hash,
        decision,
        reason,
        redacted_payload,
        correlation_id
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
    `,
    [
      auditId,
      input.tenantId,
      input.actionId,
      input.eventType ?? 'action.recorded',
      input.actorType,
      input.requestHash,
      input.decision,
      input.reason,
      JSON.stringify(input.payload),
      input.correlationId,
    ],
  );
  return auditId;
}
