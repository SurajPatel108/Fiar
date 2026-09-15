import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import type { ApprovalResponse } from '../src/approvals';
import type { ActionResponse } from '../src/actions';
import { buildGatewayApp } from '../src/app';
import { createDatabasePool } from '../src/db';
import { createGatewayTestContext, createTestCredentialDirectory } from './integration-support';

let context: Awaited<ReturnType<typeof createGatewayTestContext>>;
let sequence = 0;

before(async () => {
  context = await createGatewayTestContext('gateway-approvals');
});

beforeEach(async () => {
  sequence = 0;
  await context.reset();
});

after(async () => {
  await context.cleanup();
});

async function createPendingApproval(
  token = 'alpha-agent',
  orderId = 'ord_demo_threshold',
): Promise<{ action: ActionResponse; approval: ApprovalResponse }> {
  sequence += 1;
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': token },
    payload: {
      tool: 'refund.create',
      orderId,
      amountMinor: 5000,
      currency: 'USD',
      idempotencyKey: `approval-${sequence}`,
    },
  });
  assert.equal(created.statusCode, 201);
  const action = JSON.parse(created.payload) as ActionResponse;
  assert.ok(action.approvalId);

  const detail = await context.app.inject({
    method: 'GET',
    url: `/v1/approvals/${action.approvalId}`,
    headers: { 'x-fiar-dev-credential': token === 'beta-agent' ? 'beta-manager' : 'alpha-manager' },
  });
  assert.equal(detail.statusCode, 200);
  return { action, approval: JSON.parse(detail.payload) as ApprovalResponse };
}

function decisionPayload(approval: ApprovalResponse, decision: 'approve' | 'reject', comment?: string) {
  return {
    decision,
    ...(comment === undefined ? {} : { comment }),
    expectedRequestHash: approval.requestHash,
    expectedPolicyVersion: approval.policyVersionId,
  };
}

async function decide(
  approval: ApprovalResponse,
  decision: 'approve' | 'reject',
  token = 'alpha-manager',
  comment?: string,
) {
  return context.app.inject({
    method: 'POST',
    url: `/v1/approvals/${approval.approvalId}/decision`,
    headers: { 'x-fiar-dev-credential': token },
    payload: decisionPayload(approval, decision, comment),
  });
}

async function count(table: string): Promise<number> {
  const result = await context.pool.query<{ count: string }>(`select count(*)::text as count from ${table}`);
  return Number(result.rows[0]?.count ?? '0');
}

test('manager and admin can list and inspect safe approval details while agents and services cannot', async () => {
  const { approval } = await createPendingApproval();

  assert.equal(approval.status, 'pending');
  assert.equal(approval.actionStatus, 'awaiting_approval');
  assert.equal(approval.tool, 'refund.create');
  assert.equal(approval.orderId, 'ord_demo_threshold');
  assert.equal(approval.amountMinor, 5000);
  assert.match(approval.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(approval.context.orderFactVersion, 'v1');

  for (const token of ['alpha-manager', 'alpha-admin']) {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/approvals?status=pending',
      headers: { 'x-fiar-dev-credential': token },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((JSON.parse(response.payload) as { items: ApprovalResponse[] }).items.length, 1);
  }

  for (const token of ['alpha-agent', 'alpha-service']) {
    for (const request of [
      { method: 'GET' as const, url: '/v1/approvals' },
      { method: 'GET' as const, url: `/v1/approvals/${approval.approvalId}` },
      { method: 'POST' as const, url: `/v1/approvals/${approval.approvalId}/decision`, payload: decisionPayload(approval, 'approve') },
    ]) {
      const response = await context.app.inject({
        ...request,
        headers: { 'x-fiar-dev-credential': token },
      });
      assert.equal(response.statusCode, 403);
    }
  }
});

test('tenant scoping hides approval detail and decisions from another tenant', async () => {
  const alpha = await createPendingApproval();
  const beta = await createPendingApproval('beta-agent', 'ord_beta_small');

  const alphaList = await context.app.inject({
    method: 'GET',
    url: '/v1/approvals',
    headers: { 'x-fiar-dev-credential': 'alpha-manager' },
  });
  const listed = (JSON.parse(alphaList.payload) as { items: ApprovalResponse[] }).items;
  assert.deepEqual(listed.map((item) => item.approvalId), [alpha.approval.approvalId]);

  const detail = await context.app.inject({
    method: 'GET',
    url: `/v1/approvals/${beta.approval.approvalId}`,
    headers: { 'x-fiar-dev-credential': 'alpha-manager' },
  });
  assert.equal(detail.statusCode, 404);

  const decision = await decide(beta.approval, 'approve', 'alpha-manager');
  assert.equal(decision.statusCode, 404);
});

test('approval queues one outbox item and duplicate approval conflicts', async () => {
  const { approval } = await createPendingApproval();
  const first = await decide(approval, 'approve', 'alpha-manager', 'Reviewed and approved');
  assert.equal(first.statusCode, 200);
  const body = JSON.parse(first.payload) as ApprovalResponse;
  assert.equal(body.status, 'approved');
  assert.equal(body.actionStatus, 'queued');
  assert.equal(body.decision, 'approve');
  assert.equal(body.comment, 'Reviewed and approved');
  assert.ok(body.resolvedAt);
  assert.equal(await count('outbox_entries'), 1);
  assert.equal(await count('audit_events'), 2);

  const approvedList = await context.app.inject({
    method: 'GET',
    url: '/v1/approvals?status=approved',
    headers: { 'x-fiar-dev-credential': 'alpha-manager' },
  });
  assert.equal(approvedList.statusCode, 200);
  assert.equal((JSON.parse(approvedList.payload) as { items: ApprovalResponse[] }).items.length, 1);

  const duplicate = await decide(approval, 'approve');
  assert.equal(duplicate.statusCode, 409);
  assert.equal(await count('outbox_entries'), 1);
  assert.equal(await count('audit_events'), 2);
});

test('admin can reject an approval without creating outbox work', async () => {
  const { approval } = await createPendingApproval();
  const response = await decide(approval, 'reject', 'alpha-admin', 'Does not meet exception criteria');
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.payload) as ApprovalResponse;
  assert.equal(body.status, 'rejected');
  assert.equal(body.actionStatus, 'denied');
  assert.equal(body.decision, 'reject');
  assert.equal(await count('outbox_entries'), 0);
  assert.equal(await count('audit_events'), 2);
});

test('two concurrent manager decisions produce one result and one conflict', async () => {
  const { approval } = await createPendingApproval();
  const [approve, reject] = await Promise.all([
    decide(approval, 'approve'),
    decide(approval, 'reject'),
  ]);
  assert.deepEqual([approve.statusCode, reject.statusCode].sort(), [200, 409]);
  assert.ok((await count('outbox_entries')) <= 1);
  assert.equal(await count('audit_events'), 2);

  const stored = await context.pool.query<{ status: string; decision: string }>(
    'select status, decision from pending_approval_requests where id = $1',
    [approval.approvalId],
  );
  assert.ok(stored.rows[0]?.status === 'approved' || stored.rows[0]?.status === 'rejected');
});

test('expired approval is durably expired and cannot become queued', async () => {
  const { approval } = await createPendingApproval();
  await context.pool.query(
    `update pending_approval_requests set expires_at = now() - interval '1 second' where id = $1`,
    [approval.approvalId],
  );

  const detail = await context.app.inject({
    method: 'GET',
    url: `/v1/approvals/${approval.approvalId}`,
    headers: { 'x-fiar-dev-credential': 'alpha-manager' },
  });
  const body = JSON.parse(detail.payload) as ApprovalResponse;
  assert.equal(body.status, 'expired');
  assert.equal(body.actionStatus, 'expired');
  assert.equal(body.resolutionReason, 'APPROVAL_EXPIRED');

  const response = await decide(approval, 'approve');
  assert.equal(response.statusCode, 409);
  assert.equal(await count('outbox_entries'), 0);
  assert.equal(await count('audit_events'), 2);
});

test('active policy change expires stale authority', async () => {
  const { approval } = await createPendingApproval();
  await context.pool.query(`
    insert into policy_versions (
      id, tenant_id, version_number, status, ruleset, published_by, published_at
    ) values (
      'pol_demo_alpha_v2', 'ten_demo_alpha', 2, 'published',
      '{"workflow":"refund.create","approvalThresholdMinor":5000}'::jsonb,
      'prn_demo_alpha_manager', now()
    )
  `);
  await context.pool.query(
    `update tenants set active_policy_version_id = 'pol_demo_alpha_v2' where id = 'ten_demo_alpha'`,
  );

  const response = await decide(approval, 'approve');
  assert.equal(response.statusCode, 409);
  const stored = await context.pool.query<{ status: string; resolution_reason: string; action_status: string }>(`
    select apr.status, apr.resolution_reason, a.status as action_status
    from pending_approval_requests apr join actions a on a.id = apr.action_id
    where apr.id = $1
  `, [approval.approvalId]);
  assert.deepEqual(stored.rows[0], {
    status: 'expired',
    resolution_reason: 'POLICY_VERSION_CHANGED',
    action_status: 'expired',
  });
  assert.equal(await count('outbox_entries'), 0);
});

test('incorrect request hash or policy version conflicts without changing state', async () => {
  const { approval } = await createPendingApproval();
  for (const payload of [
    { ...decisionPayload(approval, 'approve'), expectedRequestHash: '0'.repeat(64) },
    { ...decisionPayload(approval, 'approve'), expectedPolicyVersion: 'pol_wrong' },
  ]) {
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.approvalId}/decision`,
      headers: { 'x-fiar-dev-credential': 'alpha-manager' },
      payload,
    });
    assert.equal(response.statusCode, 409);
  }

  const stored = await context.pool.query<{ approval_status: string; action_status: string }>(`
    select apr.status as approval_status, a.status as action_status
    from pending_approval_requests apr join actions a on a.id = apr.action_id
    where apr.id = $1
  `, [approval.approvalId]);
  assert.deepEqual(stored.rows[0], { approval_status: 'pending', action_status: 'awaiting_approval' });
  assert.equal(await count('audit_events'), 1);
  assert.equal(await count('outbox_entries'), 0);
});

test('suspended managers and tenants are forbidden while suspended requesters expire approval authority', async () => {
  const managerCase = await createPendingApproval();
  await context.pool.query(`update principals set status = 'suspended' where id = 'prn_demo_alpha_manager'`);
  assert.equal((await decide(managerCase.approval, 'approve')).statusCode, 403);

  await context.reset();
  const tenantCase = await createPendingApproval();
  await context.pool.query(`update tenants set status = 'suspended' where id = 'ten_demo_alpha'`);
  assert.equal((await decide(tenantCase.approval, 'approve')).statusCode, 403);

  await context.reset();
  const requesterCase = await createPendingApproval();
  await context.pool.query(`update principals set status = 'suspended' where id = 'prn_demo_alpha_agent'`);
  assert.equal((await decide(requesterCase.approval, 'approve')).statusCode, 409);
  const stored = await context.pool.query<{ status: string }>(
    'select status from pending_approval_requests where id = $1',
    [requesterCase.approval.approvalId],
  );
  assert.equal(stored.rows[0]?.status, 'expired');
  assert.equal(await count('outbox_entries'), 0);
});

test('forced decision failure rolls back approval, action, audit, and outbox changes', async () => {
  const { approval } = await createPendingApproval();
  const failurePool = createDatabasePool(context.databaseUrl);
  const failureApp = await buildGatewayApp({
    pool: failurePool,
    devCredentials: createTestCredentialDirectory(),
    approvalExpiryHours: 12,
    testHooks: { failAfterApprovalDecisionPersist: true },
  });
  try {
    const response = await failureApp.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.approvalId}/decision`,
      headers: { 'x-fiar-dev-credential': 'alpha-manager' },
      payload: decisionPayload(approval, 'approve'),
    });
    assert.equal(response.statusCode, 500);
  } finally {
    await failureApp.close();
  }

  const stored = await context.pool.query<{ approval_status: string; action_status: string }>(`
    select apr.status as approval_status, a.status as action_status
    from pending_approval_requests apr join actions a on a.id = apr.action_id
    where apr.id = $1
  `, [approval.approvalId]);
  assert.deepEqual(stored.rows[0], { approval_status: 'pending', action_status: 'awaiting_approval' });
  assert.equal(await count('audit_events'), 1);
  assert.equal(await count('outbox_entries'), 0);
});

test('approval pagination and validation are bounded and strict', async () => {
  for (let index = 0; index < 5; index += 1) {
    await createPendingApproval();
  }
  const first = await context.app.inject({
    method: 'GET',
    url: '/v1/approvals?limit=2&status=pending',
    headers: { 'x-fiar-dev-credential': 'alpha-manager' },
  });
  assert.equal(first.statusCode, 200);
  const firstPage = JSON.parse(first.payload) as { items: ApprovalResponse[]; nextCursor: string | null };
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.nextCursor);

  const second = await context.app.inject({
    method: 'GET',
    url: `/v1/approvals?limit=2&status=pending&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    headers: { 'x-fiar-dev-credential': 'alpha-manager' },
  });
  assert.equal(second.statusCode, 200);
  const secondPage = JSON.parse(second.payload) as { items: ApprovalResponse[] };
  assert.equal(secondPage.items.length, 2);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.approvalId)).size, 4);

  const approval = firstPage.items[0];
  assert.ok(approval);
  const invalidRequests = [
    { method: 'GET' as const, url: '/v1/approvals?limit=101' },
    { method: 'GET' as const, url: '/v1/approvals?status=unknown' },
    { method: 'GET' as const, url: '/v1/approvals?unexpected=true' },
    { method: 'GET' as const, url: '/v1/approvals?cursor=not-json' },
    {
      method: 'POST' as const,
      url: `/v1/approvals/${approval.approvalId}/decision`,
      payload: { ...decisionPayload(approval, 'approve'), unexpected: true },
    },
    {
      method: 'POST' as const,
      url: `/v1/approvals/${approval.approvalId}/decision`,
      payload: { ...decisionPayload(approval, 'approve'), comment: 'x'.repeat(1001) },
    },
    {
      method: 'POST' as const,
      url: `/v1/approvals/${approval.approvalId}/decision`,
      payload: { ...decisionPayload(approval, 'approve'), expectedRequestHash: 'not-a-hash' },
    },
  ];
  for (const request of invalidRequests) {
    const response = await context.app.inject({
      ...request,
      headers: { 'x-fiar-dev-credential': 'alpha-manager' },
    });
    assert.equal(response.statusCode, 400);
  }
});

test('approval responses and audit events exclude credentials and raw comments', async () => {
  const { approval } = await createPendingApproval();
  const credential = 'manager-credential-secret';
  const comment = 'audit-comment-secret';
  const secretPool = createDatabasePool(context.databaseUrl);
  const secretApp = await buildGatewayApp({
    pool: secretPool,
    devCredentials: new Map([[credential, 'prn_demo_alpha_manager']]),
    approvalExpiryHours: 12,
  });
  let payload: string;
  try {
    const response = await secretApp.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.approvalId}/decision`,
      headers: { 'x-fiar-dev-credential': credential },
      payload: decisionPayload(approval, 'reject', comment),
    });
    assert.equal(response.statusCode, 200);
    payload = response.payload;
  } finally {
    await secretApp.close();
  }
  assert.ok(!payload.includes(credential));
  assert.ok(!payload.includes('approval-1'));
  assert.ok(!payload.includes('providerIdempotencyKey'));

  const audits = await context.pool.query<{ redacted_payload: unknown }>(
    `select redacted_payload from audit_events where event_type = 'approval.rejected'`,
  );
  const stored = JSON.stringify(audits.rows[0]?.redacted_payload);
  assert.ok(!stored.includes(credential));
  assert.ok(!stored.includes(comment));
  assert.match(stored, /"commentPresent":true/);
});

test('database constraints prevent changed action or approval bindings from being reused', async () => {
  const { approval } = await createPendingApproval();
  await assert.rejects(
    context.pool.query(`update actions set amount_minor = amount_minor + 1 where id = $1`, [approval.actionId]),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23000',
  );
  await assert.rejects(
    context.pool.query(`update pending_approval_requests set request_hash = $1 where id = $2`, [
      '0'.repeat(64),
      approval.approvalId,
    ]),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503',
  );
});
