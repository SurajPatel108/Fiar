import type { Pool, PoolClient } from 'pg';
import { createId } from '../../../packages/shared/src/ids';
import { sanitizeAuditPayload } from '../../../packages/shared/src/audit-redaction';

export type SecurityEventType =
  | 'authentication.failed' | 'authentication.succeeded'
  | 'credential.created' | 'credential.rotated' | 'credential.revoked'
  | 'identity.mapped'
  | 'session.created' | 'session.revoked' | 'session.expired'
  | 'oidc.failed' | 'oidc.succeeded';

const ALLOWED = new Set(['channel', 'category', 'mappingId', 'principalType', 'replacementPresent']);

export async function insertSecurityAuditEvent(client: Pool | PoolClient, input: {
  tenantId?: string | null; principalId?: string | null; eventType: SecurityEventType;
  outcome: string; reason: string; correlationId: string; payload?: Record<string, unknown>;
}): Promise<void> {
  const payload = sanitizeAuditPayload(input.payload ?? {}, ALLOWED);
  await client.query(`
    insert into security_audit_events (
      id, tenant_id, principal_id, event_type, outcome, reason, redacted_payload, correlation_id
    ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
  `, [createId('sae'), input.tenantId ?? null, input.principalId ?? null, input.eventType,
    input.outcome, input.reason, JSON.stringify(payload), input.correlationId]);
}
