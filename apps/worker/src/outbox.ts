import type { Pool, PoolClient } from 'pg';

import { createId } from '../../../packages/shared/src/ids';
import { withTransaction } from '../../gateway/src/db';
import type { ProviderExecutionResult, RefundProviderRequest } from './connector';
import { insertWorkerAuditEvent } from './audit';
import {
  consumeExecutionReservation,
  releaseExecutionReservation,
  reserveExecutionCapacity,
} from './reservations';

export interface ClaimedExecution {
  outboxId: string;
  tenantId: string;
  actionId: string;
  attemptId: string;
  attemptNumber: number;
  requestHash: string;
  leaseOwner: string;
  providerRequest: RefundProviderRequest;
}

export type ClaimResult =
  | { kind: 'claimed'; execution: ClaimedExecution }
  | { kind: 'reconciliation_required'; outboxId: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'none' };

export interface ClaimOptions {
  workerId: string;
  leaseSeconds: number;
  maxAttempts: number;
  providerName: string;
  failAfterClaimPersist?: boolean;
}

interface ClaimRow {
  outbox_id: string;
  outbox_status: string;
  payload: unknown;
  attempt_count: number;
  lease_expires_at: Date | string | null;
  tenant_id: string;
  tenant_status: string;
  execution_kill_switch_enabled: boolean;
  action_id: string;
  action_status: string;
  principal_id: string;
  principal_status: string;
  policy_version_id: string;
  current_policy_version_id: string | null;
  order_fact_id: string;
  tool: string;
  order_id: string;
  amount_minor: string | number;
  currency: 'USD';
  request_hash: string;
  action_decision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  approval_status: string | null;
  approval_policy_version_id: string | null;
  approval_request_hash: string | null;
}

interface AttemptRow {
  id: string;
  status: string;
}

export async function claimNextExecution(pool: Pool, options: ClaimOptions): Promise<ClaimResult> {
  return withTransaction(pool, async (client) => {
    const selected = await client.query<ClaimRow>(
      `
        select
          box.id as outbox_id,
          box.status as outbox_status,
          box.payload,
          box.attempt_count,
          box.lease_expires_at,
          a.tenant_id,
          t.status as tenant_status,
          t.execution_kill_switch_enabled,
          a.id as action_id,
          a.status as action_status,
          a.principal_id,
          p.status as principal_status,
          a.policy_version_id,
          t.active_policy_version_id as current_policy_version_id,
          a.order_fact_id,
          a.tool,
          a.order_id,
          a.amount_minor,
          a.currency,
          a.request_hash,
          a.decision as action_decision,
          apr.status as approval_status,
          apr.policy_version_id as approval_policy_version_id,
          apr.request_hash as approval_request_hash
        from outbox_entries box
        join actions a on a.id = box.action_id and a.tenant_id = box.tenant_id
        join tenants t on t.id = a.tenant_id
        join principals p on p.id = a.principal_id and p.tenant_id = a.tenant_id
        left join pending_approval_requests apr on apr.action_id = a.id and apr.tenant_id = a.tenant_id
        where (
          (box.status in ('ready', 'retryable_failure') and (box.next_attempt_at is null or box.next_attempt_at <= now()))
          or (box.status = 'processing' and box.lease_expires_at < now())
        )
        order by box.created_at asc, box.id asc
        for update of box, a skip locked
        limit 1
      `,
    );
    const row = selected.rows[0];
    if (!row) {
      return { kind: 'none' };
    }

    if (row.outbox_status === 'processing') {
      const latestAttempt = await client.query<AttemptRow>(
        `
          select id, status
          from execution_attempts
          where outbox_entry_id = $1 and tenant_id = $2
          order by attempt_number desc
          limit 1
          for update
        `,
        [row.outbox_id, row.tenant_id],
      );
      const attempt = latestAttempt.rows[0];
      if (attempt?.status === 'started') {
        await client.query(
          `
            update execution_attempts
            set status = 'pending_reconciliation',
                error_classification = 'WORKER_LEASE_EXPIRED',
                updated_at = now()
            where id = $1
          `,
          [attempt.id],
        );
        await client.query(
          `
            update outbox_entries
            set status = 'pending_reconciliation', lease_owner = null, lease_expires_at = null,
                last_error = 'WORKER_LEASE_EXPIRED', updated_at = now()
            where id = $1
          `,
          [row.outbox_id],
        );
        await client.query(
          `update actions set status = 'pending_reconciliation', updated_at = now() where id = $1`,
          [row.action_id],
        );
        await insertWorkerAuditEvent(client, {
          tenantId: row.tenant_id,
          actionId: row.action_id,
          requestHash: row.request_hash,
          eventType: 'execution.pending_reconciliation',
          outcome: 'PENDING_RECONCILIATION',
          reason: 'WORKER_LEASE_EXPIRED',
          payload: { outboxId: row.outbox_id, attemptId: attempt.id },
        });
        return { kind: 'reconciliation_required', outboxId: row.outbox_id };
      }

      await client.query(
        `
          update outbox_entries
          set status = 'ready', lease_owner = null, lease_expires_at = null, updated_at = now()
          where id = $1
        `,
        [row.outbox_id],
      );
      await client.query(`update actions set status = 'queued', updated_at = now() where id = $1`, [row.action_id]);
      return { kind: 'blocked', reason: 'EXPIRED_LEASE_RECOVERED_WITHOUT_ATTEMPT' };
    }

    if (row.attempt_count >= options.maxAttempts) {
      await failAuthorization(client, row, 'MAX_ATTEMPTS_EXHAUSTED', 'failed');
      return { kind: 'blocked', reason: 'MAX_ATTEMPTS_EXHAUSTED' };
    }

    const authorizationFailure = getAuthorizationFailure(row);
    if (authorizationFailure) {
      const actionStatus = ['TENANT_NOT_ACTIVE', 'PRINCIPAL_NOT_ACTIVE'].includes(authorizationFailure)
        ? 'suspended'
        : 'failed';
      await failAuthorization(client, row, authorizationFailure, actionStatus);
      return { kind: 'blocked', reason: authorizationFailure };
    }

    if (row.execution_kill_switch_enabled) {
      await client.query(
        `
          update outbox_entries
          set status = 'retryable_failure', next_attempt_at = now() + interval '30 seconds',
              lease_owner = null, lease_expires_at = null, last_error = 'KILL_SWITCH_ENABLED', updated_at = now()
          where id = $1
        `,
        [row.outbox_id],
      );
      await insertWorkerAuditEvent(client, {
        tenantId: row.tenant_id,
        actionId: row.action_id,
        requestHash: row.request_hash,
        eventType: 'execution.kill_switch_blocked',
        outcome: 'BLOCKED',
        reason: 'KILL_SWITCH_ENABLED',
        payload: { outboxId: row.outbox_id },
      });
      return { kind: 'blocked', reason: 'KILL_SWITCH_ENABLED' };
    }

    const providerRequest = parseAndVerifyOutboxPayload(row);
    if (!providerRequest) {
      await failAuthorization(client, row, 'OUTBOX_PAYLOAD_MISMATCH', 'failed');
      return { kind: 'blocked', reason: 'OUTBOX_PAYLOAD_MISMATCH' };
    }

    const reservation = await reserveExecutionCapacity(client, {
      tenantId: row.tenant_id,
      actionId: row.action_id,
      orderFactId: row.order_fact_id,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
    });
    if (!reservation.reserved) {
      await failAuthorization(client, row, reservation.reason, 'failed');
      return { kind: 'blocked', reason: reservation.reason };
    }

    const attemptNumber = row.attempt_count + 1;
    const attemptId = createId('exa');
    await client.query(
      `
        insert into execution_attempts (
          id, tenant_id, action_id, outbox_entry_id, attempt_number,
          provider_name, provider_idempotency_key, status
        ) values ($1, $2, $3, $4, $5, $6, $7, 'started')
      `,
      [
        attemptId,
        row.tenant_id,
        row.action_id,
        row.outbox_id,
        attemptNumber,
        options.providerName,
        providerRequest.providerIdempotencyKey,
      ],
    );
    await client.query(
      `
        update outbox_entries
        set status = 'processing', lease_owner = $1,
            lease_expires_at = now() + make_interval(secs => $2),
            attempt_count = $3, next_attempt_at = null, last_error = null, updated_at = now()
        where id = $4
      `,
      [options.workerId, options.leaseSeconds, attemptNumber, row.outbox_id],
    );
    await client.query(
      `update actions set status = 'dispatched', updated_at = now() where id = $1`,
      [row.action_id],
    );
    await insertWorkerAuditEvent(client, {
      tenantId: row.tenant_id,
      actionId: row.action_id,
      requestHash: row.request_hash,
      eventType: 'worker.claimed',
      outcome: 'CLAIMED',
      reason: 'OUTBOX_LEASE_ACQUIRED',
      payload: { outboxId: row.outbox_id, attemptId, attemptNumber },
    });
    await insertWorkerAuditEvent(client, {
      tenantId: row.tenant_id,
      actionId: row.action_id,
      requestHash: row.request_hash,
      eventType: 'execution.started',
      outcome: 'STARTED',
      reason: 'AUTHORIZATION_RECHECK_PASSED',
      payload: { outboxId: row.outbox_id, attemptId, attemptNumber },
    });

    if (options.failAfterClaimPersist) {
      throw new Error('Injected worker claim transaction failure');
    }

    return {
      kind: 'claimed',
      execution: {
        outboxId: row.outbox_id,
        tenantId: row.tenant_id,
        actionId: row.action_id,
        attemptId,
        attemptNumber,
        requestHash: row.request_hash,
        leaseOwner: options.workerId,
        providerRequest,
      },
    };
  });
}

export async function finalizeExecution(
  pool: Pool,
  execution: ClaimedExecution,
  result: ProviderExecutionResult,
  maxAttempts: number,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const locked = await client.query<{ outbox_status: string; attempt_status: string }>(
      `
        select box.status as outbox_status, attempt.status as attempt_status
        from outbox_entries box
        join execution_attempts attempt on attempt.id = $1 and attempt.outbox_entry_id = box.id
        where box.id = $2 and box.tenant_id = $3 and box.lease_owner = $4
        for update of box, attempt
      `,
      [execution.attemptId, execution.outboxId, execution.tenantId, execution.leaseOwner],
    );
    const row = locked.rows[0];
    if (!row || row.outbox_status !== 'processing' || row.attempt_status !== 'started') {
      throw new Error('Execution lease is no longer owned by this worker');
    }

    const finishedAt = new Date().toISOString();
    if (result.outcome === 'confirmed_success') {
      await updateAttempt(client, execution.attemptId, 'succeeded', result.providerRequestId, null, finishedAt);
      await completeOutboxAndAction(client, execution, 'completed', 'completed', finishedAt, null);
      await consumeExecutionReservation(client, execution.tenantId, execution.actionId);
      await auditOutcome(client, execution, 'execution.succeeded', 'SUCCEEDED', 'PROVIDER_CONFIRMED_SUCCESS');
      return;
    }

    if (result.outcome === 'confirmed_failure') {
      await updateAttempt(
        client,
        execution.attemptId,
        'confirmed_failure',
        result.providerRequestId,
        result.errorClassification,
        finishedAt,
      );
      await completeOutboxAndAction(client, execution, 'failed', 'failed', finishedAt, result.errorClassification);
      await releaseExecutionReservation(client, execution.tenantId, execution.actionId);
      await auditOutcome(client, execution, 'execution.failed', 'FAILED', result.errorClassification);
      return;
    }

    if (result.outcome === 'retryable_failure') {
      const exhausted = execution.attemptNumber >= maxAttempts;
      await updateAttempt(
        client,
        execution.attemptId,
        'retryable_failure',
        null,
        result.errorClassification,
        finishedAt,
      );
      await releaseExecutionReservation(client, execution.tenantId, execution.actionId);
      if (exhausted) {
        await completeOutboxAndAction(client, execution, 'failed', 'failed', finishedAt, 'MAX_ATTEMPTS_EXHAUSTED');
        await auditOutcome(client, execution, 'execution.failed', 'FAILED', 'MAX_ATTEMPTS_EXHAUSTED');
      } else {
        await client.query(
          `
            update outbox_entries
            set status = 'retryable_failure', lease_owner = null, lease_expires_at = null,
                next_attempt_at = now() + interval '1 second', last_error = $1, updated_at = now()
            where id = $2
          `,
          [result.errorClassification, execution.outboxId],
        );
        await client.query(`update actions set status = 'queued', updated_at = now() where id = $1`, [execution.actionId]);
        await auditOutcome(
          client,
          execution,
          'execution.retryable_failure',
          'RETRYABLE_FAILURE',
          result.errorClassification,
        );
      }
      return;
    }

    await updateAttempt(
      client,
      execution.attemptId,
      'pending_reconciliation',
      result.providerRequestId,
      result.errorClassification,
      null,
    );
    await client.query(
      `
        update outbox_entries
        set status = 'pending_reconciliation', lease_owner = null, lease_expires_at = null,
            last_error = $1, updated_at = now()
        where id = $2
      `,
      [result.errorClassification, execution.outboxId],
    );
    await client.query(
      `update actions set status = 'pending_reconciliation', updated_at = now() where id = $1`,
      [execution.actionId],
    );
    await auditOutcome(
      client,
      execution,
      'execution.pending_reconciliation',
      'PENDING_RECONCILIATION',
      result.errorClassification,
    );
  });
}

function getAuthorizationFailure(row: ClaimRow): string | null {
  if (row.tenant_status !== 'active') {
    return 'TENANT_NOT_ACTIVE';
  }
  if (row.principal_status !== 'active') {
    return 'PRINCIPAL_NOT_ACTIVE';
  }
  if (row.action_status !== 'queued') {
    return 'ACTION_NOT_QUEUED';
  }
  if (row.current_policy_version_id !== row.policy_version_id) {
    return 'POLICY_VERSION_CHANGED';
  }
  if (
    row.action_decision === 'REQUIRE_APPROVAL' &&
    (
      row.approval_status !== 'approved' ||
      row.approval_policy_version_id !== row.policy_version_id ||
      row.approval_request_hash !== row.request_hash
    )
  ) {
    return 'APPROVAL_NOT_VALID';
  }
  if (row.action_decision !== 'ALLOW' && row.action_decision !== 'REQUIRE_APPROVAL') {
    return 'ACTION_NOT_AUTHORIZED';
  }
  return null;
}

function parseAndVerifyOutboxPayload(row: ClaimRow): RefundProviderRequest | null {
  if (typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload)) {
    return null;
  }
  const payload = row.payload as Record<string, unknown>;
  const expectedKeys = [
    'actionId',
    'tenantId',
    'orderId',
    'amountMinor',
    'currency',
    'providerIdempotencyKey',
  ];
  if (Object.keys(payload).length !== expectedKeys.length || Object.keys(payload).some((key) => !expectedKeys.includes(key))) {
    return null;
  }
  const expectedProviderKey = `refund:${row.action_id}`;
  if (
    payload.actionId !== row.action_id ||
    payload.tenantId !== row.tenant_id ||
    payload.orderId !== row.order_id ||
    payload.amountMinor !== Number(row.amount_minor) ||
    payload.currency !== row.currency ||
    payload.providerIdempotencyKey !== expectedProviderKey ||
    row.tool !== 'refund.create'
  ) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    actionId: row.action_id,
    orderId: row.order_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    providerIdempotencyKey: expectedProviderKey,
  };
}

async function failAuthorization(
  client: PoolClient,
  row: ClaimRow,
  reason: string,
  actionStatus: 'failed' | 'suspended',
): Promise<void> {
  await client.query(
    `
      update outbox_entries
      set status = 'failed', lease_owner = null, lease_expires_at = null,
          last_error = $1, completed_at = now(), updated_at = now()
      where id = $2
    `,
    [reason, row.outbox_id],
  );
  await client.query(`update actions set status = $1, updated_at = now() where id = $2`, [actionStatus, row.action_id]);
  await insertWorkerAuditEvent(client, {
    tenantId: row.tenant_id,
    actionId: row.action_id,
    requestHash: row.request_hash,
    eventType: 'execution.authorization_failed',
    outcome: 'BLOCKED',
    reason,
    payload: { outboxId: row.outbox_id, actionStatus },
  });
}

async function updateAttempt(
  client: PoolClient,
  attemptId: string,
  status: string,
  providerRequestId: string | null,
  errorClassification: string | null,
  finishedAt: string | null,
): Promise<void> {
  await client.query(
    `
      update execution_attempts
      set status = $1, provider_request_id = $2, error_classification = $3,
          finished_at = $4, updated_at = now()
      where id = $5
    `,
    [status, providerRequestId, errorClassification, finishedAt, attemptId],
  );
}

async function completeOutboxAndAction(
  client: PoolClient,
  execution: ClaimedExecution,
  outboxStatus: 'completed' | 'failed',
  actionStatus: 'completed' | 'failed',
  completedAt: string,
  lastError: string | null,
): Promise<void> {
  await client.query(
    `
      update outbox_entries
      set status = $1, lease_owner = null, lease_expires_at = null,
          completed_at = $2, last_error = $3, updated_at = $2
      where id = $4
    `,
    [outboxStatus, completedAt, lastError, execution.outboxId],
  );
  await client.query(`update actions set status = $1, updated_at = $2 where id = $3`, [
    actionStatus,
    completedAt,
    execution.actionId,
  ]);
}

async function auditOutcome(
  client: PoolClient,
  execution: ClaimedExecution,
  eventType:
    | 'execution.succeeded'
    | 'execution.failed'
    | 'execution.retryable_failure'
    | 'execution.pending_reconciliation',
  outcome: string,
  reason: string,
): Promise<void> {
  await insertWorkerAuditEvent(client, {
    tenantId: execution.tenantId,
    actionId: execution.actionId,
    requestHash: execution.requestHash,
    eventType,
    outcome,
    reason,
    payload: {
      outboxId: execution.outboxId,
      attemptId: execution.attemptId,
      attemptNumber: execution.attemptNumber,
    },
  });
}
