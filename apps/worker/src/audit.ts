import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { createId } from '../../../packages/shared/src/ids';
import { sanitizeAuditPayload } from '../../../packages/shared/src/audit-redaction';

export interface WorkerAuditInput {
  tenantId: string;
  actionId: string;
  requestHash: string;
  eventType:
    | 'worker.claimed'
    | 'execution.started'
    | 'execution.succeeded'
    | 'execution.failed'
    | 'execution.retryable_failure'
    | 'execution.pending_reconciliation'
    | 'execution.reconciled'
    | 'execution.kill_switch_blocked'
    | 'execution.authorization_failed';
  outcome: string;
  reason: string;
  payload: Record<string, unknown>;
}

export async function insertWorkerAuditEvent(client: PoolClient, input: WorkerAuditInput): Promise<void> {
  const payload = sanitizeAuditPayload(input.payload, new Set([
    'outboxId', 'attemptId', 'attemptNumber', 'actionStatus',
  ]));
  await client.query(
    `
      insert into audit_events (
        id, tenant_id, action_id, event_type, actor_type, request_hash,
        decision, reason, redacted_payload, correlation_id
      ) values ($1, $2, $3, $4, 'service', $5, $6, $7, $8::jsonb, $9)
    `,
    [
      createId('aud'),
      input.tenantId,
      input.actionId,
      input.eventType,
      input.requestHash,
      input.outcome,
      input.reason,
      JSON.stringify(payload),
      randomUUID(),
    ],
  );
}
