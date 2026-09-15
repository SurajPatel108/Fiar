import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import type { ActionResponse } from '../../gateway/src/actions';
import type { ApprovalResponse } from '../../gateway/src/approvals';
import { createGatewayTestContext } from '../../gateway/test/integration-support';
import {
  FakeRefundProvider,
  type FakeProviderBehavior,
  type RefundProviderConnector,
  type RefundProviderRequest,
} from '../src/connector';
import { ExecutionWorker } from '../src/worker';

let context: Awaited<ReturnType<typeof createGatewayTestContext>>;
let sequence = 0;

before(async () => {
  context = await createGatewayTestContext('worker-phase4');
});

beforeEach(async () => {
  sequence = 0;
  await context.reset();
});

after(async () => {
  await context.cleanup();
});

async function createQueuedAction(options: {
  amountMinor?: number;
  orderId?: string;
  approved?: boolean;
} = {}): Promise<ActionResponse> {
  sequence += 1;
  const amountMinor = options.amountMinor ?? (options.approved ? 5000 : 4900);
  const orderId = options.orderId ?? (options.approved ? 'ord_demo_threshold' : 'ord_demo_small');
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
    payload: {
      tool: 'refund.create',
      orderId,
      amountMinor,
      currency: 'USD',
      idempotencyKey: `worker-${sequence}`,
    },
  });
  assert.equal(created.statusCode, 201);
  const action = JSON.parse(created.payload) as ActionResponse;
  if (!options.approved) {
    assert.equal(action.status, 'queued');
    return action;
  }

  assert.ok(action.approvalId);
  const detail = await context.app.inject({
    method: 'GET',
    url: `/v1/approvals/${action.approvalId}`,
    headers: { 'x-fiar-dev-credential': 'alpha-manager' },
  });
  assert.equal(detail.statusCode, 200);
  const approval = JSON.parse(detail.payload) as ApprovalResponse;
  const decision = await context.app.inject({
    method: 'POST',
    url: `/v1/approvals/${approval.approvalId}/decision`,
    headers: { 'x-fiar-dev-credential': 'alpha-manager' },
    payload: {
      decision: 'approve',
      expectedRequestHash: approval.requestHash,
      expectedPolicyVersion: approval.policyVersionId,
    },
  });
  assert.equal(decision.statusCode, 200);
  return { ...action, status: 'queued' };
}

function worker(
  id: string,
  behavior: FakeProviderBehavior = 'success',
  options: { crashAfterProviderCall?: boolean; failAfterClaimPersist?: boolean; maxAttempts?: number } = {},
): ExecutionWorker {
  return new ExecutionWorker(context.pool, new FakeRefundProvider(context.pool, { behavior }), {
    workerId: id,
    leaseSeconds: 30,
    maxAttempts: options.maxAttempts ?? 3,
    ...(options.crashAfterProviderCall ? { crashAfterProviderCall: true } : {}),
    ...(options.failAfterClaimPersist ? { failAfterClaimPersist: true } : {}),
  });
}

async function state(actionId: string) {
  const result = await context.pool.query<{
    action_status: string;
    outbox_status: string;
    attempt_count: number;
    reservation_status: string | null;
  }>(
    `
      select
        a.status as action_status,
        box.status as outbox_status,
        box.attempt_count,
        reservation.status as reservation_status
      from actions a
      join outbox_entries box on box.action_id = a.id
      left join execution_reservations reservation on reservation.action_id = a.id
      where a.id = $1
    `,
    [actionId],
  );
  return result.rows[0];
}

async function count(table: string): Promise<number> {
  const result = await context.pool.query<{ count: string }>(`select count(*)::text as count from ${table}`);
  return Number(result.rows[0]?.count ?? '0');
}

test('one approved queued action executes exactly once', async () => {
  const action = await createQueuedAction({ approved: true });
  const result = await worker('worker-success').processOne();
  assert.equal(result.kind, 'executed');
  assert.deepEqual(await state(action.actionId), {
    action_status: 'completed',
    outbox_status: 'completed',
    attempt_count: 1,
    reservation_status: 'consumed',
  });
  assert.equal(await count('execution_attempts'), 1);
  assert.equal(await count('fake_provider_refunds'), 1);
  assert.equal((await worker('worker-no-repeat').processOne()).kind, 'none');
  assert.equal(await count('fake_provider_refunds'), 1);
});

test('concurrent workers cannot double execute one action', async () => {
  const action = await createQueuedAction({ approved: true });
  const results = await Promise.all([
    worker('worker-a').processOne(),
    worker('worker-b').processOne(),
  ]);
  assert.equal(results.filter((result) => result.kind === 'executed').length, 1);
  assert.equal(await count('execution_attempts'), 1);
  assert.equal(await count('fake_provider_refunds'), 1);
  assert.equal((await state(action.actionId))?.action_status, 'completed');
});

test('fake provider deduplicates duplicate delivery with a stable provider key', async () => {
  const provider = new FakeRefundProvider(context.pool);
  const request: RefundProviderRequest = {
    tenantId: 'ten_demo_alpha',
    actionId: 'act_external_duplicate_test',
    orderId: 'ord_demo_small',
    amountMinor: 100,
    currency: 'USD',
    providerIdempotencyKey: 'refund:act_external_duplicate_test',
  };
  const [first, second] = await Promise.all([provider.executeRefund(request), provider.executeRefund(request)]);
  assert.equal(first.outcome, 'confirmed_success');
  assert.equal(second.outcome, 'confirmed_success');
  assert.equal(
    'providerRequestId' in first && 'providerRequestId' in second
      ? first.providerRequestId
      : null,
    'providerRequestId' in second ? second.providerRequestId : null,
  );
  assert.equal(await count('fake_provider_refunds'), 1);
});

test('expired lease after provider success moves to reconciliation and converges once', async () => {
  const action = await createQueuedAction({ approved: true });
  const crashing = worker('worker-crash', 'success', { crashAfterProviderCall: true });
  await assert.rejects(crashing.processOne(), /Injected worker crash/);
  assert.deepEqual(await state(action.actionId), {
    action_status: 'dispatched',
    outbox_status: 'processing',
    attempt_count: 1,
    reservation_status: 'reserved',
  });
  assert.equal(await count('fake_provider_refunds'), 1);

  await context.pool.query(
    `update outbox_entries set lease_expires_at = now() - interval '1 second' where action_id = $1`,
    [action.actionId],
  );
  const recovery = worker('worker-recovery');
  assert.equal((await recovery.processOne()).kind, 'pending_reconciliation');
  assert.equal((await state(action.actionId))?.action_status, 'pending_reconciliation');
  assert.deepEqual(await recovery.reconcileOne(), { kind: 'resolved', outcome: 'success' });
  assert.equal((await state(action.actionId))?.action_status, 'completed');
  assert.equal(await count('fake_provider_refunds'), 1);
});

test('authorization re-check blocks tenant, principal, policy, and payload invalidation', async () => {
  const cases: Array<{
    name: string;
    invalidate: (action: ActionResponse) => Promise<void>;
    expectedActionStatus: string;
  }> = [
    {
      name: 'tenant',
      invalidate: async () => {
        await context.pool.query(`update tenants set status = 'suspended' where id = 'ten_demo_alpha'`);
      },
      expectedActionStatus: 'suspended',
    },
    {
      name: 'principal',
      invalidate: async () => {
        await context.pool.query(`update principals set status = 'suspended' where id = 'prn_demo_alpha_agent'`);
      },
      expectedActionStatus: 'suspended',
    },
    {
      name: 'policy',
      invalidate: async () => {
        await context.pool.query(`
          insert into policy_versions (
            id, tenant_id, version_number, status, ruleset, published_by, published_at
          ) values (
            'pol_worker_v2', 'ten_demo_alpha', 2, 'published',
            '{"workflow":"refund.create","approvalThresholdMinor":5000}'::jsonb,
            'prn_demo_alpha_manager', now()
          )
        `);
        await context.pool.query(
          `update tenants set active_policy_version_id = 'pol_worker_v2' where id = 'ten_demo_alpha'`,
        );
      },
      expectedActionStatus: 'failed',
    },
    {
      name: 'payload',
      invalidate: async (action) => {
        await context.pool.query(
          `update outbox_entries set payload = jsonb_set(payload, '{amountMinor}', '1'::jsonb) where action_id = $1`,
          [action.actionId],
        );
      },
      expectedActionStatus: 'failed',
    },
  ];

  for (const testCase of cases) {
    await context.reset();
    const action = await createQueuedAction({ approved: true });
    await testCase.invalidate(action);
    const result = await worker(`worker-invalid-${testCase.name}`).processOne();
    assert.equal(result.kind, 'blocked');
    assert.equal((await state(action.actionId))?.action_status, testCase.expectedActionStatus);
    assert.equal(await count('fake_provider_refunds'), 0);
    assert.equal(await count('execution_attempts'), 0);
  }
});

test('tenant kill switch blocks new provider calls without terminally failing the action', async () => {
  const action = await createQueuedAction({ approved: true });
  await context.pool.query(`
    update tenants
    set execution_kill_switch_enabled = true,
        execution_kill_switch_reason = 'test',
        execution_kill_switch_updated_at = now()
    where id = 'ten_demo_alpha'
  `);
  const result = await worker('worker-killed').processOne();
  assert.deepEqual(result, { kind: 'blocked', reason: 'KILL_SWITCH_ENABLED' });
  assert.deepEqual(await state(action.actionId), {
    action_status: 'queued',
    outbox_status: 'retryable_failure',
    attempt_count: 0,
    reservation_status: null,
  });
  assert.equal(await count('fake_provider_refunds'), 0);
  const audit = await context.pool.query<{ count: string }>(
    `select count(*)::text as count from audit_events where event_type = 'execution.kill_switch_blocked'`,
  );
  assert.equal(Number(audit.rows[0]?.count), 1);
});

test('kill switch enabled after a provider call begins does not guess or discard the in-flight result', async () => {
  const action = await createQueuedAction({ approved: true });
  const baseProvider = new FakeRefundProvider(context.pool);
  let notifyStarted!: () => void;
  let allowProvider!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const proceed = new Promise<void>((resolve) => { allowProvider = resolve; });
  const blockingProvider: RefundProviderConnector = {
    name: baseProvider.name,
    executeRefund: async (request) => {
      notifyStarted();
      await proceed;
      return baseProvider.executeRefund(request);
    },
    lookupRefund: (key) => baseProvider.lookupRefund(key),
  };
  const inFlightWorker = new ExecutionWorker(context.pool, blockingProvider, {
    workerId: 'worker-in-flight-kill',
    leaseSeconds: 30,
  });

  const processing = inFlightWorker.processOne();
  await started;
  await context.pool.query(`
    update tenants
    set execution_kill_switch_enabled = true,
        execution_kill_switch_reason = 'enabled while in flight',
        execution_kill_switch_updated_at = now()
    where id = 'ten_demo_alpha'
  `);
  allowProvider();
  assert.equal((await processing).kind, 'executed');
  assert.equal((await state(action.actionId))?.action_status, 'completed');
  assert.equal(await count('fake_provider_refunds'), 1);
});

test('confirmed failure is terminal and releases reserved capacity', async () => {
  const action = await createQueuedAction({ approved: true });
  await worker('worker-failure', 'confirmed_failure').processOne();
  assert.deepEqual(await state(action.actionId), {
    action_status: 'failed',
    outbox_status: 'failed',
    attempt_count: 1,
    reservation_status: 'released',
  });
  const attempt = await context.pool.query<{ status: string; error_classification: string }>(
    'select status, error_classification from execution_attempts where action_id = $1',
    [action.actionId],
  );
  assert.deepEqual(attempt.rows[0], {
    status: 'confirmed_failure',
    error_classification: 'FAKE_PROVIDER_REJECTED',
  });
});

test('retryable pre-provider failure safely retries with the same provider key', async () => {
  const action = await createQueuedAction({ approved: true });
  await worker('worker-retryable', 'retryable_failure').processOne();
  assert.deepEqual(await state(action.actionId), {
    action_status: 'queued',
    outbox_status: 'retryable_failure',
    attempt_count: 1,
    reservation_status: 'released',
  });
  assert.equal(await count('fake_provider_refunds'), 0);

  await context.pool.query(`update outbox_entries set next_attempt_at = now() where action_id = $1`, [action.actionId]);
  await worker('worker-retry-success').processOne();
  assert.equal((await state(action.actionId))?.action_status, 'completed');
  assert.equal(await count('execution_attempts'), 2);
  assert.equal(await count('fake_provider_refunds'), 1);
});

test('ambiguous success reconciles to completed and confirmed non-execution returns safely to ready', async () => {
  const successAction = await createQueuedAction({ approved: true });
  const ambiguousSuccess = worker('worker-amb-success', 'ambiguous_success');
  assert.equal((await ambiguousSuccess.processOne()).kind, 'pending_reconciliation');
  assert.equal((await state(successAction.actionId))?.action_status, 'pending_reconciliation');
  assert.deepEqual(await ambiguousSuccess.reconcileOne(), { kind: 'resolved', outcome: 'success' });
  assert.equal((await state(successAction.actionId))?.action_status, 'completed');

  await context.reset();
  const noEffectAction = await createQueuedAction({ approved: true });
  const ambiguousNoEffect = worker('worker-amb-none', 'ambiguous_not_executed');
  assert.equal((await ambiguousNoEffect.processOne()).kind, 'pending_reconciliation');
  assert.deepEqual(await ambiguousNoEffect.reconcileOne(), { kind: 'resolved', outcome: 'not_executed' });
  assert.deepEqual(await state(noEffectAction.actionId), {
    action_status: 'queued',
    outbox_status: 'ready',
    attempt_count: 1,
    reservation_status: 'released',
  });

  await worker('worker-after-reconcile').processOne();
  assert.equal((await state(noEffectAction.actionId))?.action_status, 'completed');
});

test('unresolved ambiguous result remains pending reconciliation', async () => {
  const action = await createQueuedAction({ approved: true });
  const unresolved = worker('worker-unknown', 'ambiguous_unknown');
  await unresolved.processOne();
  assert.deepEqual(await unresolved.reconcileOne(), { kind: 'pending' });
  assert.equal((await state(action.actionId))?.action_status, 'pending_reconciliation');
  assert.equal((await state(action.actionId))?.reservation_status, 'reserved');
});

test('claim transaction rollback leaves no partial worker state or provider call', async () => {
  const action = await createQueuedAction({ approved: true });
  await assert.rejects(
    worker('worker-rollback', 'success', { failAfterClaimPersist: true }).processOne(),
    /Injected worker claim transaction failure/,
  );
  assert.deepEqual(await state(action.actionId), {
    action_status: 'queued',
    outbox_status: 'ready',
    attempt_count: 0,
    reservation_status: null,
  });
  assert.equal(await count('execution_attempts'), 0);
  assert.equal(await count('fake_provider_refunds'), 0);
  const workerAudit = await context.pool.query<{ count: string }>(
    `select count(*)::text as count from audit_events where event_type like 'execution.%' or event_type = 'worker.claimed'`,
  );
  assert.equal(Number(workerAudit.rows[0]?.count), 0);
});

test('capacity reservation prevents two queued actions from exceeding the remaining balance', async () => {
  const first = await createQueuedAction({ amountMinor: 3000, orderId: 'ord_demo_small' });
  const second = await createQueuedAction({ amountMinor: 3000, orderId: 'ord_demo_small' });
  await context.pool.query(`
    update order_facts
    set refundable_remaining_minor = 5000, budget_available_minor = 5000
    where external_order_id = 'ord_demo_small' and tenant_id = 'ten_demo_alpha'
  `);

  await Promise.all([
    worker('worker-capacity-a').processOne(),
    worker('worker-capacity-b').processOne(),
  ]);
  const states = await context.pool.query<{ id: string; status: string }>(
    `select id, status from actions where id = any($1::text[]) order by id`,
    [[first.actionId, second.actionId]],
  );
  assert.deepEqual(states.rows.map((row) => row.status).sort(), ['completed', 'failed']);
  assert.equal(await count('fake_provider_refunds'), 1);
});
