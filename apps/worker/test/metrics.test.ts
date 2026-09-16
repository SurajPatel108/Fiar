import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { OperationalMetrics } from '../../gateway/src/metrics';
import { createGatewayTestContext, type GatewayTestContext } from '../../gateway/test/integration-support';
import { FakeRefundProvider } from '../src/connector';
import { ExecutionWorker } from '../src/worker';
import { recordExecutionMetrics, recordReconciliationMetrics } from '../src/worker-metrics';

let context: GatewayTestContext;
before(async () => { context = await createGatewayTestContext('fiar_worker_metrics'); });
after(async () => { await context.cleanup(); });

test('real worker execution and reconciliation paths update bounded metrics', async () => {
  const created = await context.app.inject({ method: 'POST', url: '/v1/actions', headers: { 'x-fiar-dev-credential': 'alpha-agent' }, payload: { tool: 'refund.create', orderId: 'ord_demo_small', amountMinor: 4900, currency: 'USD', idempotencyKey: 'worker-metrics' } });
  assert.equal(created.statusCode, 201);
  const metrics = new OperationalMetrics('WORKER');
  const worker = new ExecutionWorker(context.pool, new FakeRefundProvider(context.pool), { workerId: 'metrics-worker' });
  const execution = await worker.processOne();
  recordExecutionMetrics(metrics, execution);
  const reconciliation = await worker.reconcileOne();
  recordReconciliationMetrics(metrics, reconciliation);
  metrics.setReadiness('WORKER', 'DATABASE', true);
  metrics.setReadiness('WORKER', 'CONNECTOR', true);
  const rendered = await metrics.render(context.pool);
  assert.match(rendered, /fiar_worker_claims_total\{result="EXECUTED"\} 1/);
  assert.match(rendered, /fiar_execution_outcomes_total\{outcome="CONFIRMED_SUCCESS"\} 1/);
  assert.match(rendered, /fiar_readiness\{component="CONNECTOR",service="WORKER"\} 1/);
  assert.doesNotMatch(rendered, /ten_demo|prn_demo|ord_demo|act_/);
});

test('provider idempotency prevention is counted on a real ledger replay', async () => {
  let prevented = 0;
  const provider = new FakeRefundProvider(context.pool, { onIdempotencyPrevention: () => { prevented += 1; } });
  const action = await context.pool.query<{ id: string }>(`select id from actions where tenant_id = 'ten_demo_alpha' order by created_at limit 1`);
  assert.ok(action.rows[0]?.id);
  const request = { tenantId: 'ten_demo_alpha', actionId: action.rows[0].id, orderId: 'ord_demo_small', amountMinor: 1, currency: 'USD' as const, providerIdempotencyKey: 'provider-metric-replay' };
  await provider.executeRefund(request);
  await provider.executeRefund(request);
  assert.equal(prevented, 1);
});

test('real retry, reconciliation, failure, and kill-switch paths emit bounded worker metrics', async () => {
  const metrics = new OperationalMetrics('WORKER');
  const submit = (idempotencyKey: string) => context.app.inject({ method: 'POST', url: '/v1/actions', headers: { 'x-fiar-dev-credential': 'alpha-agent' }, payload: { tool: 'refund.create', orderId: 'ord_demo_small', amountMinor: 100, currency: 'USD', idempotencyKey } });

  assert.equal((await submit('worker-metric-retry')).statusCode, 201);
  const retryWorker = new ExecutionWorker(context.pool, new FakeRefundProvider(context.pool, { behavior: 'retryable_failure' }), { workerId: 'metric-retry' });
  recordExecutionMetrics(metrics, await retryWorker.processOne());

  assert.equal((await submit('worker-metric-ambiguous')).statusCode, 201);
  const reconcileWorker = new ExecutionWorker(context.pool, new FakeRefundProvider(context.pool, { behavior: 'ambiguous_success' }), { workerId: 'metric-reconcile' });
  recordExecutionMetrics(metrics, await reconcileWorker.processOne());
  recordReconciliationMetrics(metrics, await reconcileWorker.reconcileOne());

  assert.equal((await submit('worker-metric-kill')).statusCode, 201);
  await context.pool.query(`update tenants set execution_kill_switch_enabled = true, execution_kill_switch_reason = 'metric test' where id = 'ten_demo_alpha'`);
  try {
    const blockedWorker = new ExecutionWorker(context.pool, new FakeRefundProvider(context.pool), { workerId: 'metric-blocked' });
    recordExecutionMetrics(metrics, await blockedWorker.processOne());
  } finally {
    await context.pool.query(`update tenants set execution_kill_switch_enabled = false, execution_kill_switch_reason = null where id = 'ten_demo_alpha'`);
  }

  const rendered = await metrics.render(context.pool);
  assert.match(rendered, /fiar_worker_retries_total\{reason="PRE_PROVIDER"\} 1/);
  assert.match(rendered, /fiar_worker_failures_total\{reason="CONNECTOR_EXCEPTION"\} 1/);
  assert.match(rendered, /fiar_reconciliation_attempts_total 1/);
  assert.match(rendered, /fiar_reconciliation_outcomes_total\{outcome="SUCCESS"\} 1/);
  assert.match(rendered, /fiar_kill_switch_blocks_total 1/);
});
