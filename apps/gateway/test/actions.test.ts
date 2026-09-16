import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import type { ActionResponse } from '../src/actions';
import { createGatewayTestContext } from './integration-support';

let context: Awaited<ReturnType<typeof createGatewayTestContext>>;

async function queryCount(tableName: string): Promise<number> {
  const result = await context.pool.query<{ count: string }>(`select count(*)::text as count from ${tableName}`);
  return Number(result.rows[0]?.count ?? '0');
}

async function postAction<T = unknown>(token: string, body: Record<string, unknown>): Promise<{ statusCode: number; body: T }> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': token },
    payload: body,
  });

  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.payload) as T,
  };
}

before(async () => {
  context = await createGatewayTestContext('gateway-actions');
});

beforeEach(async () => {
  await context.reset();
});

after(async () => {
  await context.cleanup();
});

test('creates an allow action exactly once and enqueues one outbox entry', async () => {
  const request = {
    tool: 'refund.create',
    orderId: 'ord_demo_small',
    amountMinor: 4900,
    currency: 'USD',
    idempotencyKey: 'allow-once',
  };

  const first = await postAction<ActionResponse>('alpha-agent', request);
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.decision, 'ALLOW');
  assert.equal(first.body.status, 'queued');

  const second = await postAction<ActionResponse>('alpha-agent', request);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.actionId, first.body.actionId);

  assert.equal(await queryCount('actions'), 1);
  assert.equal(await queryCount('outbox_entries'), 1);
  assert.equal(await queryCount('pending_approval_requests'), 0);
  assert.equal(await queryCount('audit_events'), 1);
});

test('creates a pending approval record without enqueueing the worker path', async () => {
  const response = await postAction<ActionResponse>('alpha-agent', {
    tool: 'refund.create',
    orderId: 'ord_demo_threshold',
    amountMinor: 5000,
    currency: 'USD',
    idempotencyKey: 'needs-approval',
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.decision, 'REQUIRE_APPROVAL');
  assert.equal(response.body.status, 'awaiting_approval');
  assert.ok(response.body.approvalId);

  assert.equal(await queryCount('actions'), 1);
  assert.equal(await queryCount('pending_approval_requests'), 1);
  assert.equal(await queryCount('outbox_entries'), 0);
  assert.equal(await queryCount('audit_events'), 1);

  const expiry = await context.pool.query<{ hours: string }>(`
    select (extract(epoch from (expires_at - created_at)) / 3600)::text as hours
    from pending_approval_requests
  `);
  assert.equal(Number(expiry.rows[0]?.hours), 12);
});

test('allows an additional partial refund when remaining balance, exposure, and budget permit it', async () => {
  const before = await context.pool.query<{
    previous_refund_total_minor: string;
    refundable_remaining_minor: string;
    order_exposure_minor: string;
    budget_available_minor: string;
  }>(`
    select
      previous_refund_total_minor::text,
      refundable_remaining_minor::text,
      order_exposure_minor::text,
      budget_available_minor::text
    from order_facts
    where tenant_id = 'ten_demo_alpha' and external_order_id = 'ord_demo_threshold'
  `);
  assert.deepEqual(before.rows[0], {
    previous_refund_total_minor: '100',
    refundable_remaining_minor: '20000',
    order_exposure_minor: '100',
    budget_available_minor: '50000',
  });

  const response = await postAction<ActionResponse>('alpha-agent', {
    tool: 'refund.create',
    orderId: 'ord_demo_threshold',
    amountMinor: 100,
    currency: 'USD',
    idempotencyKey: 'additional-partial-refund',
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.decision, 'ALLOW');
  assert.equal(response.body.reason, 'WITHIN_POLICY');
  assert.equal(response.body.status, 'queued');
  assert.equal(await queryCount('outbox_entries'), 1);
  assert.equal(await queryCount('pending_approval_requests'), 0);
});

test('returns a conflict when the same idempotency key is replayed with different content', async () => {
  const first = await postAction<ActionResponse>('alpha-agent', {
    tool: 'refund.create',
    orderId: 'ord_demo_small',
    amountMinor: 4900,
    currency: 'USD',
    idempotencyKey: 'conflict-key',
  });

  assert.equal(first.statusCode, 201);

  const second = await postAction<{ error: string; message: string }>('alpha-agent', {
    tool: 'refund.create',
    orderId: 'ord_demo_small',
    amountMinor: 4800,
    currency: 'USD',
    idempotencyKey: 'conflict-key',
  });

  assert.equal(second.statusCode, 409);
  assert.equal(second.body.error, 'CONFLICT');
  assert.equal(await queryCount('actions'), 1);
});

test('allows intentionally identical requests under different idempotency keys', async () => {
  const base = {
    tool: 'refund.create',
    orderId: 'ord_demo_small',
    amountMinor: 4900,
    currency: 'USD',
  };

  const first = await postAction<ActionResponse>('alpha-agent', { ...base, idempotencyKey: 'same-body-1' });
  const second = await postAction<ActionResponse>('alpha-agent', { ...base, idempotencyKey: 'same-body-2' });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.notEqual(first.body.actionId, second.body.actionId);
  assert.equal(await queryCount('actions'), 2);
});

test('collapses simultaneous duplicate submissions into one logical action', async () => {
  const request = {
    tool: 'refund.create',
    orderId: 'ord_demo_small',
    amountMinor: 4900,
    currency: 'USD',
    idempotencyKey: 'concurrent-once',
  };

  const responses = await Promise.all(Array.from({ length: 12 }, () => postAction<ActionResponse>('alpha-agent', request)));
  assert.equal(new Set(responses.map((response) => response.body.actionId)).size, 1);
  assert.equal(responses.filter((response) => response.statusCode === 201).length, 1);
  assert.ok(responses.every((response) => response.statusCode === 200 || response.statusCode === 201));
  assert.equal(await queryCount('actions'), 1);
  assert.equal(await queryCount('audit_events'), 1);
  assert.equal(await queryCount('outbox_entries'), 1);
});

test('preserves idempotency across an application restart', async () => {
  const request = {
    tool: 'refund.create',
    orderId: 'ord_demo_small',
    amountMinor: 4900,
    currency: 'USD',
    idempotencyKey: 'restart-replay',
  };
  const first = await postAction<ActionResponse>('alpha-agent', request);
  assert.equal(first.statusCode, 201);

  await context.restart();
  const replay = await postAction<ActionResponse>('alpha-agent', request);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.actionId, first.body.actionId);
  assert.equal(await queryCount('actions'), 1);
  assert.equal(await queryCount('audit_events'), 1);
});

test('lists actions with stable bounded pagination and rejects malformed cursors', async () => {
  for (let index = 0; index < 5; index += 1) {
    const created = await postAction<ActionResponse>('alpha-agent', {
      tool: 'refund.create',
      orderId: 'ord_demo_small',
      amountMinor: 100 + index,
      currency: 'USD',
      idempotencyKey: `page-${index}`,
    });
    assert.equal(created.statusCode, 201);
  }

  const first = await context.app.inject({
    method: 'GET',
    url: '/v1/actions?limit=2&status=queued',
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
  });
  assert.equal(first.statusCode, 200);
  const firstPage = JSON.parse(first.payload) as { items: ActionResponse[]; nextCursor: string | null };
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.nextCursor);

  const second = await context.app.inject({
    method: 'GET',
    url: `/v1/actions?limit=2&status=queued&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
  });
  assert.equal(second.statusCode, 200);
  const secondPage = JSON.parse(second.payload) as { items: ActionResponse[]; nextCursor: string | null };
  assert.equal(secondPage.items.length, 2);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.actionId)).size, 4);

  for (const cursor of ['not-base64-json', Buffer.from(JSON.stringify({ actionId: 'act_bad', createdAt: 'not-a-date' })).toString('base64url')]) {
    const invalid = await context.app.inject({
      method: 'GET',
      url: `/v1/actions?cursor=${encodeURIComponent(cursor)}`,
      headers: { 'x-fiar-dev-credential': 'alpha-agent' },
    });
    assert.equal(invalid.statusCode, 400);
  }
});

test('denies an ineligible refund without creating outbox work', async () => {
  const response = await postAction<ActionResponse>('alpha-agent', {
    tool: 'refund.create',
    orderId: 'ord_demo_denied',
    amountMinor: 1500,
    currency: 'USD',
    idempotencyKey: 'deny-only',
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.decision, 'DENY');
  assert.equal(response.body.status, 'denied');
  assert.equal(await queryCount('outbox_entries'), 0);
  assert.equal(await queryCount('pending_approval_requests'), 0);
});

test('keeps actions tenant scoped on read and list endpoints', async () => {
  const created = await postAction<ActionResponse>('alpha-agent', {
    tool: 'refund.create',
    orderId: 'ord_demo_small',
    amountMinor: 4900,
    currency: 'USD',
    idempotencyKey: 'tenant-scope',
  });

  assert.equal(created.statusCode, 201);

  const wrongTenantRead = await context.app.inject({
    method: 'GET',
    url: `/v1/actions/${created.body.actionId}`,
    headers: { 'x-fiar-dev-credential': 'beta-agent' },
  });

  assert.equal(wrongTenantRead.statusCode, 404);

  const wrongTenantList = await context.app.inject({
    method: 'GET',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'beta-agent' },
  });

  assert.equal(wrongTenantList.statusCode, 200);
  const listed = JSON.parse(wrongTenantList.payload) as { items: Array<{ actionId: string }>; nextCursor: string | null };
  assert.equal(listed.items.length, 0);
  assert.equal(listed.nextCursor, null);
});
