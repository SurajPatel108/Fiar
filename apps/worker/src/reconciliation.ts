import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../gateway/src/db';
import type { ProviderLookupResult, RefundProviderConnector } from './connector';
import { insertWorkerAuditEvent } from './audit';
import { consumeExecutionReservation, releaseExecutionReservation } from './reservations';

interface ReconciliationClaim {
  outboxId: string;
  tenantId: string;
  actionId: string;
  attemptId: string;
  requestHash: string;
  providerIdempotencyKey: string;
  leaseOwner: string;
}

export type ReconciliationResult =
  | { kind: 'none' }
  | { kind: 'resolved'; outcome: 'success' | 'not_executed' | 'failure' }
  | { kind: 'pending' };

export async function reconcileNext(
  pool: Pool,
  connector: RefundProviderConnector,
  workerId: string,
  leaseSeconds: number,
): Promise<ReconciliationResult> {
  const claim = await claimReconciliation(pool, workerId, leaseSeconds);
  if (!claim) {
    return { kind: 'none' };
  }

  let result: ProviderLookupResult;
  try {
    result = await connector.lookupRefund(claim.providerIdempotencyKey);
  } catch {
    result = { outcome: 'unknown', providerRequestId: null };
  }
  return finalizeReconciliation(pool, claim, result);
}

async function claimReconciliation(
  pool: Pool,
  workerId: string,
  leaseSeconds: number,
): Promise<ReconciliationClaim | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{
      outbox_id: string;
      tenant_id: string;
      action_id: string;
      request_hash: string;
      attempt_id: string;
      provider_idempotency_key: string;
    }>(
      `
        select
          box.id as outbox_id,
          box.tenant_id,
          box.action_id,
          a.request_hash,
          attempt.id as attempt_id,
          attempt.provider_idempotency_key
        from outbox_entries box
        join actions a on a.id = box.action_id and a.tenant_id = box.tenant_id
        join lateral (
          select id, provider_idempotency_key
          from execution_attempts
          where outbox_entry_id = box.id and tenant_id = box.tenant_id
            and status = 'pending_reconciliation'
          order by attempt_number desc
          limit 1
        ) attempt on true
        where box.status = 'pending_reconciliation'
          and (box.lease_expires_at is null or box.lease_expires_at < now())
        order by box.updated_at asc, box.id asc
        for update of box skip locked
        limit 1
      `,
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    await client.query(
      `
        update outbox_entries
        set lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        where id = $3
      `,
      [workerId, leaseSeconds, row.outbox_id],
    );
    return {
      outboxId: row.outbox_id,
      tenantId: row.tenant_id,
      actionId: row.action_id,
      attemptId: row.attempt_id,
      requestHash: row.request_hash,
      providerIdempotencyKey: row.provider_idempotency_key,
      leaseOwner: workerId,
    };
  });
}

async function finalizeReconciliation(
  pool: Pool,
  claim: ReconciliationClaim,
  result: ProviderLookupResult,
): Promise<ReconciliationResult> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<{ outbox_status: string; attempt_status: string }>(
      `
        select box.status as outbox_status, attempt.status as attempt_status
        from outbox_entries box
        join execution_attempts attempt on attempt.id = $1 and attempt.outbox_entry_id = box.id
        where box.id = $2 and box.tenant_id = $3 and box.lease_owner = $4
        for update of box, attempt
      `,
      [claim.attemptId, claim.outboxId, claim.tenantId, claim.leaseOwner],
    );
    const row = locked.rows[0];
    if (!row || row.outbox_status !== 'pending_reconciliation' || row.attempt_status !== 'pending_reconciliation') {
      throw new Error('Reconciliation lease is no longer owned by this worker');
    }

    if (result.outcome === 'confirmed_success') {
      await finishAttempt(client, claim.attemptId, 'reconciled_succeeded', result.providerRequestId, null);
      await finishActionAndOutbox(client, claim, 'completed', 'completed', null);
      await consumeExecutionReservation(client, claim.tenantId, claim.actionId);
      await auditReconciliation(client, claim, 'RECONCILED_SUCCESS', 'PROVIDER_LOOKUP_CONFIRMED_SUCCESS');
      return { kind: 'resolved', outcome: 'success' };
    }

    if (result.outcome === 'confirmed_failure') {
      await finishAttempt(
        client,
        claim.attemptId,
        'reconciled_failure',
        result.providerRequestId,
        result.errorClassification,
      );
      await finishActionAndOutbox(client, claim, 'failed', 'failed', result.errorClassification);
      await releaseExecutionReservation(client, claim.tenantId, claim.actionId);
      await auditReconciliation(client, claim, 'RECONCILED_FAILURE', result.errorClassification);
      return { kind: 'resolved', outcome: 'failure' };
    }

    if (result.outcome === 'confirmed_not_executed') {
      await finishAttempt(client, claim.attemptId, 'reconciled_not_executed', null, 'PROVIDER_CONFIRMED_NOT_EXECUTED');
      await releaseExecutionReservation(client, claim.tenantId, claim.actionId);
      await client.query(
        `
          update outbox_entries
          set status = 'ready', lease_owner = null, lease_expires_at = null,
              next_attempt_at = null, last_error = null, updated_at = now()
          where id = $1
        `,
        [claim.outboxId],
      );
      await client.query(`update actions set status = 'queued', updated_at = now() where id = $1`, [claim.actionId]);
      await auditReconciliation(client, claim, 'RECONCILED_NOT_EXECUTED', 'SAFE_TO_RETRY_WITH_STABLE_KEY');
      return { kind: 'resolved', outcome: 'not_executed' };
    }

    await client.query(
      `
        update outbox_entries
        set lease_owner = null, lease_expires_at = null,
            last_error = 'PROVIDER_OUTCOME_UNKNOWN', updated_at = now()
        where id = $1
      `,
      [claim.outboxId],
    );
    await client.query(
      `
        update execution_attempts
        set provider_request_id = coalesce(provider_request_id, $1),
            error_classification = 'PROVIDER_OUTCOME_UNKNOWN', updated_at = now()
        where id = $2
      `,
      [result.providerRequestId, claim.attemptId],
    );
    await auditReconciliation(client, claim, 'RECONCILIATION_PENDING', 'PROVIDER_OUTCOME_UNKNOWN');
    return { kind: 'pending' };
  });
}

async function finishAttempt(
  client: PoolClient,
  attemptId: string,
  status: string,
  providerRequestId: string | null,
  errorClassification: string | null,
): Promise<void> {
  await client.query(
    `
      update execution_attempts
      set status = $1, provider_request_id = coalesce(provider_request_id, $2),
          error_classification = $3, finished_at = now(), updated_at = now()
      where id = $4
    `,
    [status, providerRequestId, errorClassification, attemptId],
  );
}

async function finishActionAndOutbox(
  client: PoolClient,
  claim: ReconciliationClaim,
  outboxStatus: 'completed' | 'failed',
  actionStatus: 'completed' | 'failed',
  lastError: string | null,
): Promise<void> {
  await client.query(
    `
      update outbox_entries
      set status = $1, lease_owner = null, lease_expires_at = null,
          completed_at = now(), last_error = $2, updated_at = now()
      where id = $3
    `,
    [outboxStatus, lastError, claim.outboxId],
  );
  await client.query(`update actions set status = $1, updated_at = now() where id = $2`, [actionStatus, claim.actionId]);
}

async function auditReconciliation(
  client: PoolClient,
  claim: ReconciliationClaim,
  outcome: string,
  reason: string,
): Promise<void> {
  await insertWorkerAuditEvent(client, {
    tenantId: claim.tenantId,
    actionId: claim.actionId,
    requestHash: claim.requestHash,
    eventType: 'execution.reconciled',
    outcome,
    reason,
    payload: { outboxId: claim.outboxId, attemptId: claim.attemptId },
  });
}
