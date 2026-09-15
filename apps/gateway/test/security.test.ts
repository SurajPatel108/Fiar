import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import { createGatewayTestContext } from './integration-support';
import { buildGatewayApp } from '../src/app';
import { loadDevCredentialDirectory } from '../src/auth';
import { createDatabasePool } from '../src/db';
import { createTestCredentialDirectory } from './integration-support';

let context: Awaited<ReturnType<typeof createGatewayTestContext>>;

before(async () => {
  context = await createGatewayTestContext('gateway-security');
});

beforeEach(async () => {
  await context.reset();
});

after(async () => {
  await context.cleanup();
});

test('rejects undeclared request fields', async () => {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
    payload: {
      tool: 'refund.create',
      orderId: 'ord_demo_small',
      amountMinor: 4900,
      currency: 'USD',
      idempotencyKey: 'bad-extra-field',
      manager: true,
    },
  });

  assert.equal(response.statusCode, 400);
});

test('rejects missing credentials', async () => {
  const response = await context.app.inject({
    method: 'GET',
    url: '/v1/actions',
  });

  assert.equal(response.statusCode, 401);
});

test('rejects invalid credentials and principals without create permission', async () => {
  const invalid = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'not-valid' },
    payload: {
      tool: 'refund.create',
      orderId: 'ord_demo_small',
      amountMinor: 4900,
      currency: 'USD',
      idempotencyKey: 'invalid-auth',
    },
  });
  assert.equal(invalid.statusCode, 401);

  const manager = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'alpha-manager' },
    payload: {
      tool: 'refund.create',
      orderId: 'ord_demo_small',
      amountMinor: 4900,
      currency: 'USD',
      idempotencyKey: 'manager-create',
    },
  });
  assert.equal(manager.statusCode, 403);
});

test('rejects suspended principals', async () => {
  await context.pool.query(`update principals set status = 'suspended' where id = 'prn_demo_alpha_agent'`);

  const response = await context.app.inject({
    method: 'GET',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
  });

  assert.equal(response.statusCode, 403);
});

test('rejects suspended tenants', async () => {
  await context.pool.query(`update tenants set status = 'suspended' where id = 'ten_demo_alpha'`);
  const response = await context.app.inject({
    method: 'GET',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
  });
  assert.equal(response.statusCode, 403);
});

test('fails closed for cross-tenant create and replay attempts', async () => {
  const request = {
    tool: 'refund.create',
    orderId: 'ord_demo_small',
    amountMinor: 4900,
    currency: 'USD',
    idempotencyKey: 'cross-tenant-replay',
  };

  const alpha = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
    payload: request,
  });
  assert.equal(alpha.statusCode, 201);

  const beta = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'beta-agent' },
    payload: request,
  });
  assert.equal(beta.statusCode, 400);
  assert.equal((JSON.parse(beta.payload) as { error: string }).error, 'INVALID_REQUEST');
  const count = await context.pool.query<{ count: string }>('select count(*)::text as count from actions');
  assert.equal(Number(count.rows[0]?.count), 1);
});

test('fails closed when authoritative business facts are missing', async () => {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
    payload: {
      tool: 'refund.create',
      orderId: 'ord_missing',
      amountMinor: 100,
      currency: 'USD',
      idempotencyKey: 'missing-facts',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal((JSON.parse(response.payload) as { error: string }).error, 'INVALID_REQUEST');
});

test('records a denial when the selected published policy has invalid required facts', async () => {
  await context.pool.query(`
    insert into policy_versions (
      id, tenant_id, version_number, status, ruleset, published_by, published_at
    ) values (
      'pol_demo_alpha_invalid', 'ten_demo_alpha', 2, 'published', '{}'::jsonb,
      'prn_demo_alpha_manager', now()
    )
  `);
  await context.pool.query(`
    update tenants set active_policy_version_id = 'pol_demo_alpha_invalid' where id = 'ten_demo_alpha'
  `);

  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
    payload: {
      tool: 'refund.create',
      orderId: 'ord_demo_small',
      amountMinor: 100,
      currency: 'USD',
      idempotencyKey: 'invalid-policy-facts',
    },
  });
  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.payload) as { decision: string; reason: string; status: string };
  assert.deepEqual({ decision: body.decision, reason: body.reason, status: body.status }, {
    decision: 'DENY',
    reason: 'INVALID_FACTS',
    status: 'denied',
  });
});

test('rolls back action, audit, approval, and outbox writes together', async () => {
  const failurePool = createDatabasePool(context.databaseUrl);
  const failureApp = await buildGatewayApp({
    pool: failurePool,
    devCredentials: createTestCredentialDirectory(),
    approvalExpiryHours: 12,
    testHooks: { failAfterPersist: true },
  });

  try {
    const response = await failureApp.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'x-fiar-dev-credential': 'alpha-agent' },
      payload: {
        tool: 'refund.create',
        orderId: 'ord_demo_small',
        amountMinor: 4900,
        currency: 'USD',
        idempotencyKey: 'forced-rollback',
      },
    });
    assert.equal(response.statusCode, 500);
  } finally {
    await failureApp.close();
  }

  for (const table of ['actions', 'audit_events', 'pending_approval_requests', 'outbox_entries']) {
    const result = await context.pool.query<{ count: string }>(`select count(*)::text as count from ${table}`);
    assert.equal(Number(result.rows[0]?.count), 0);
  }
});

test('excludes credentials and internal immutable fields from responses and audit payloads', async () => {
  const secret = 'credential-must-not-leak';
  const credentials = new Map([[secret, 'prn_demo_alpha_agent']]);
  const secretPool = createDatabasePool(context.databaseUrl);
  const secretApp = await buildGatewayApp({ pool: secretPool, devCredentials: credentials, approvalExpiryHours: 12 });

  let payload: string;
  try {
    const response = await secretApp.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'x-fiar-dev-credential': secret },
      payload: {
        tool: 'refund.create',
        orderId: 'ord_demo_small',
        amountMinor: 4900,
        currency: 'USD',
        idempotencyKey: 'sensitive-response-key',
      },
    });
    assert.equal(response.statusCode, 201);
    payload = response.payload;
  } finally {
    await secretApp.close();
  }

  assert.ok(!payload.includes(secret));
  assert.ok(!payload.includes('sensitive-response-key'));
  assert.ok(!payload.includes('requestHash'));
  assert.ok(!payload.includes('canonicalRequest'));

  const audit = await context.pool.query<{ redacted_payload: unknown }>('select redacted_payload from audit_events limit 1');
  const stored = JSON.stringify(audit.rows[0]?.redacted_payload);
  assert.ok(!stored.includes(secret));
  assert.ok(!stored.includes('sensitive-response-key'));
});

test('rejects malformed and unknown list query fields', async () => {
  for (const url of ['/v1/actions?limit=101', '/v1/actions?unexpected=true', '/v1/actions?status=unknown']) {
    const response = await context.app.inject({
      method: 'GET',
      url,
      headers: { 'x-fiar-dev-credential': 'alpha-agent' },
    });
    assert.equal(response.statusCode, 400);
  }
});

test('development credential configuration errors do not echo secrets', () => {
  const secret = 'do-not-print-this-secret';
  for (const raw of [
    `not-json-${secret}`,
    JSON.stringify([
      { token: secret, principalId: 'prn_demo_alpha_agent' },
      { token: secret, principalId: 'prn_demo_alpha_agent' },
    ]),
  ]) {
    assert.throws(
      () => loadDevCredentialDirectory({ FIAR_DEV_CREDENTIALS_JSON: raw }),
      (error: unknown) => error instanceof Error && !error.message.includes(secret),
    );
  }
});

test('database constraints preserve immutable action content and tenant consistency', async () => {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { 'x-fiar-dev-credential': 'alpha-agent' },
    payload: {
      tool: 'refund.create',
      orderId: 'ord_demo_denied',
      amountMinor: 1500,
      currency: 'USD',
      idempotencyKey: 'constraint-check',
    },
  });
  assert.equal(created.statusCode, 201);
  const actionId = (JSON.parse(created.payload) as { actionId: string }).actionId;

  await assert.rejects(
    context.pool.query('update actions set amount_minor = amount_minor + 1 where id = $1', [actionId]),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23000',
  );
  await assert.rejects(
    context.pool.query(
      `insert into outbox_entries (id, tenant_id, action_id, kind, payload, status)
       values ('box_wrong_tenant', 'ten_demo_beta', $1, 'refund.execute', '{}'::jsonb, 'ready')`,
      [actionId],
    ),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503',
  );
  await assert.rejects(
    context.pool.query(`update policy_versions set ruleset = '{}'::jsonb where id = 'pol_demo_alpha_v1'`),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23000',
  );
});
