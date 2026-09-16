import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import { OperationalMetrics } from '../src/metrics';
import { createGatewayTestContext, type GatewayTestContext } from './integration-support';

let context: GatewayTestContext;
const metrics = new OperationalMetrics();
before(async () => { context = await createGatewayTestContext('fiar_phase6_metrics', { metrics, metricsSecret: 'metrics-secret' }); });
beforeEach(async () => { await context.reset(); });
after(async () => { await context.cleanup(); });

async function action(idempotencyKey: string, orderId: string, amountMinor: number) {
  return context.app.inject({ method: 'POST', url: '/v1/actions', headers: { 'x-fiar-dev-credential': 'alpha-agent' }, payload: { tool: 'refund.create', orderId, amountMinor, currency: 'USD', idempotencyKey } });
}

async function decide(approval: Record<string, unknown>, decision: 'approve' | 'reject') {
  return context.app.inject({ method: 'POST', url: `/v1/approvals/${approval.approvalId as string}/decision`, headers: { 'x-fiar-dev-credential': 'alpha-manager' }, payload: { decision, expectedRequestHash: approval.requestHash, expectedPolicyVersion: approval.policyVersionId } });
}

test('real gateway paths update bounded policy, auth, idempotency, approval, readiness, and backlog metrics', async () => {
  const allowed = await action('metrics-allow', 'ord_demo_small', 4900);
  assert.equal(allowed.statusCode, 201);
  assert.equal((await action('metrics-allow', 'ord_demo_small', 4900)).statusCode, 200);
  assert.equal((await action('metrics-deny', 'ord_demo_denied', 2000)).statusCode, 201);
  const pending = await action('metrics-approval', 'ord_demo_threshold', 5000);
  assert.equal(pending.statusCode, 201);
  const approvalId = (pending.json() as { approvalId: string }).approvalId;
  const detail = await context.app.inject({ method: 'GET', url: `/v1/approvals/${approvalId}`, headers: { 'x-fiar-dev-credential': 'alpha-manager' } });
  assert.equal((await decide(detail.json() as Record<string, unknown>, 'approve')).statusCode, 200);
  assert.equal((await decide(detail.json() as Record<string, unknown>, 'approve')).statusCode, 409);
  const rejected = await action('metrics-rejected', 'ord_demo_small', 5000);
  const rejectedId = (rejected.json() as { approvalId: string }).approvalId;
  const rejectedDetail = await context.app.inject({ method: 'GET', url: `/v1/approvals/${rejectedId}`, headers: { 'x-fiar-dev-credential': 'alpha-manager' } });
  assert.equal((await decide(rejectedDetail.json() as Record<string, unknown>, 'reject')).statusCode, 200);
  assert.equal((await context.app.inject({ method: 'GET', url: '/v1/actions', headers: { 'x-fiar-dev-credential': 'bad-development-token' } })).statusCode, 401);
  assert.equal((await context.app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);

  const response = await context.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-secret' } });
  assert.equal(response.statusCode, 200);
  const body = response.body;
  for (const expected of [
    'fiar_action_decisions_total{decision="ALLOW"} 2',
    'fiar_action_decisions_total{decision="DENY"} 1',
    'fiar_action_decisions_total{decision="REQUIRE_APPROVAL"} 2',
    'fiar_authentication_successes_total{channel="DEVELOPMENT"}',
    'fiar_authentication_failures_total{category="INVALID",channel="DEVELOPMENT"} 1',
    'fiar_idempotency_preventions_total{layer="ACTION"} 1',
    'fiar_approval_outcomes_total{outcome="APPROVED"} 1',
    'fiar_approval_outcomes_total{outcome="REJECTED"} 1',
    'fiar_approval_conflicts_total{category="RESOLVED"} 1',
    'fiar_readiness{component="DATABASE",service="GATEWAY"} 1',
    'fiar_readiness{component="AUTHENTICATION",service="GATEWAY"} 1',
    'fiar_oldest_pending_approval_age_seconds', 'fiar_oldest_queued_age_seconds', 'fiar_oldest_reconciliation_age_seconds',
  ]) assert.match(body, new RegExp(expected.replace(/[{}]/g, '\\$&')));
  const declarations = body.split('\n').filter((line) => line.startsWith('# HELP') || line.startsWith('# TYPE'));
  assert.equal(new Set(declarations).size, declarations.length);
  assert.doesNotMatch(body, /ten_demo|prn_demo|ord_demo|act_|sha256|https?:\/\//);
});

test('expired and policy-stale decision paths emit their bounded outcomes', async () => {
  const expired = await action('metrics-expired', 'ord_demo_threshold', 5000);
  const expiredId = (expired.json() as { approvalId: string }).approvalId;
  await context.pool.query(`update pending_approval_requests set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = $1`, [expiredId]);
  const expiredDetail = await context.pool.query<{ request_hash: string; policy_version_id: string }>(`select request_hash, policy_version_id from pending_approval_requests where id = $1`, [expiredId]);
  const expiredDecision = await context.app.inject({ method: 'POST', url: `/v1/approvals/${expiredId}/decision`, headers: { 'x-fiar-dev-credential': 'alpha-manager' }, payload: { decision: 'approve', expectedRequestHash: expiredDetail.rows[0]?.request_hash, expectedPolicyVersion: expiredDetail.rows[0]?.policy_version_id } });
  assert.equal(expiredDecision.statusCode, 409);

  const stale = await action('metrics-stale', 'ord_demo_small', 5000);
  const staleId = (stale.json() as { approvalId: string }).approvalId;
  const staleDetail = await context.pool.query<{ request_hash: string; policy_version_id: string }>(`select request_hash, policy_version_id from pending_approval_requests where id = $1`, [staleId]);
  await context.pool.query(`insert into policy_versions (id, tenant_id, version_number, status, ruleset, published_by, published_at) values ('pol_metrics_v2', 'ten_demo_alpha', 2, 'published', '{"workflow":"refund.create","approvalThresholdMinor":5000}'::jsonb, 'prn_demo_alpha_manager', now())`);
  await context.pool.query(`update tenants set active_policy_version_id = 'pol_metrics_v2' where id = 'ten_demo_alpha'`);
  const staleDecision = await context.app.inject({ method: 'POST', url: `/v1/approvals/${staleId}/decision`, headers: { 'x-fiar-dev-credential': 'alpha-manager' }, payload: { decision: 'approve', expectedRequestHash: staleDetail.rows[0]?.request_hash, expectedPolicyVersion: staleDetail.rows[0]?.policy_version_id } });
  assert.equal(staleDecision.statusCode, 409);
  const rendered = await metrics.render(context.pool);
  assert.match(rendered, /fiar_approval_outcomes_total\{outcome="EXPIRED"\} 1/);
  assert.match(rendered, /fiar_approval_outcomes_total\{outcome="STALE"\} 1/);
  assert.match(rendered, /fiar_approval_conflicts_total\{category="STALE"\} 2/);
});
