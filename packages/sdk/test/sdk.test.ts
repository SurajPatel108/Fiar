import assert from 'node:assert/strict';
import test from 'node:test';

import { FiarApiError, FiarClient, FiarTransportError, type Approval } from '../src/index';

interface RecordedCall {
  input: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function approvalFixture(): Approval {
  return {
    approvalId: 'apr_test',
    status: 'pending',
    actionId: 'act_test',
    actionStatus: 'awaiting_approval',
    tool: 'refund.create',
    orderId: 'ord_test',
    amountMinor: 5000,
    currency: 'USD',
    decisionReason: 'Manager approval required',
    requestHash: 'a'.repeat(64),
    policyVersionId: 'pol_test_v1',
    decision: null,
    comment: null,
    resolutionReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    resolvedAt: null,
    context: {
      orderFactVersion: 'v1',
      orderActive: true,
      refundableRemainingMinor: 20000,
      orderExposureMinor: 100,
      budgetAvailableMinor: 50000,
    },
  };
}

test('submits the exact gateway action schema with caller credentials', async () => {
  const calls: RecordedCall[] = [];
  const client = new FiarClient({
    baseUrl: 'https://fiar.example/',
    credential: 'agent-secret',
    fetch: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({ actionId: 'act_test' }, 201);
    },
  });
  const request = {
    tool: 'refund.create' as const,
    orderId: 'ord_test',
    amountMinor: 5000,
    currency: 'USD' as const,
    idempotencyKey: 'refund-42',
  };

  await client.submitAction(request);

  assert.equal(calls[0]?.input, 'https://fiar.example/v1/actions');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), request);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers['x-fiar-dev-credential'], 'agent-secret');
  assert.equal(headers['content-type'], 'application/json');
});

test('constructs action and approval list pagination without undefined fields', async () => {
  const urls: string[] = [];
  const calls: RecordedCall[] = [];
  const client = new FiarClient({
    baseUrl: '',
    getCredentialHeaders: () => ({ authorization: 'Bearer ephemeral' }),
    fetch: async (input, init) => {
      urls.push(input);
      calls.push({ input, init });
      return jsonResponse({ items: [], nextCursor: null });
    },
  });

  await client.listActions({ status: 'queued', limit: 10 });
  await client.listApprovals({ status: 'pending', limit: 20, cursor: 'next/cursor' });

  assert.equal(urls[0], '/v1/actions?status=queued&limit=10');
  assert.equal(urls[1], '/v1/approvals?status=pending&limit=20&cursor=next%2Fcursor');
  assert.ok(calls.every((call) => call.init?.method === 'GET' && call.init.body === undefined));
  assert.ok(calls.every((call) =>
    (call.init?.headers as Record<string, string>).authorization === 'Bearer ephemeral'));
});

test('bound approve and reject helpers always send exact hash and policy bindings', async () => {
  const calls: RecordedCall[] = [];
  const fixture = approvalFixture();
  const client = new FiarClient({
    baseUrl: 'http://localhost:3000',
    fetch: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(fixture);
    },
  });

  await client.approveApproval(fixture, { comment: 'Reviewed' });
  await client.rejectApproval(fixture);

  assert.deepEqual(calls.map((call) => JSON.parse(String(call.init?.body)) as unknown), [
    {
      decision: 'approve',
      comment: 'Reviewed',
      expectedRequestHash: fixture.requestHash,
      expectedPolicyVersion: fixture.policyVersionId,
    },
    {
      decision: 'reject',
      comment: null,
      expectedRequestHash: fixture.requestHash,
      expectedPolicyVersion: fixture.policyVersionId,
    },
  ]);
  assert.ok(calls.every((call) =>
    call.input === 'http://localhost:3000/v1/approvals/apr_test/decision' &&
    call.init?.method === 'POST' &&
    (call.init.headers as Record<string, string>)['content-type'] === 'application/json'));
});

test('fetches encoded detail paths', async () => {
  const calls: RecordedCall[] = [];
  const client = new FiarClient({
    baseUrl: 'http://localhost:3000',
    fetch: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(approvalFixture());
    },
  });

  await client.getAction('act/unsafe');
  await client.getApproval('apr/unsafe');

  assert.deepEqual(calls.map((call) => call.input), [
    'http://localhost:3000/v1/actions/act%2Funsafe',
    'http://localhost:3000/v1/approvals/apr%2Funsafe',
  ]);
  assert.ok(calls.every((call) => call.init?.method === 'GET' && call.init.body === undefined));
});

test('sends direct approval decisions to the exact gateway route and schema', async () => {
  const calls: RecordedCall[] = [];
  const fixture = approvalFixture();
  const client = new FiarClient({
    baseUrl: 'http://localhost:3000',
    fetch: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(fixture);
    },
  });
  const decision = {
    decision: 'approve' as const,
    comment: null,
    expectedRequestHash: fixture.requestHash,
    expectedPolicyVersion: fixture.policyVersionId,
  };

  await client.decideApproval('apr/unsafe', decision);

  assert.equal(calls[0]?.input, 'http://localhost:3000/v1/approvals/apr%2Funsafe/decision');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), decision);
});

test('throws typed API and transport errors without reflecting credentials', async () => {
  const apiClient = new FiarClient({
    baseUrl: 'http://localhost:3000',
    credential: 'do-not-reflect',
    fetch: async () => jsonResponse({ error: 'CONFLICT', message: 'Approval has already been resolved' }, 409),
  });
  await assert.rejects(
    apiClient.getApproval('apr_test'),
    (error: unknown) => error instanceof FiarApiError &&
      error.status === 409 && error.code === 'CONFLICT' && !error.message.includes('do-not-reflect'),
  );

  const transportClient = new FiarClient({
    baseUrl: 'http://localhost:3000',
    fetch: async () => { throw new Error('offline'); },
  });
  await assert.rejects(
    transportClient.listApprovals(),
    (error: unknown) => error instanceof FiarTransportError && error.message === 'Unable to reach the Fiar gateway',
  );

  const responseFailureClient = new FiarClient({
    baseUrl: 'http://localhost:3000',
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error('response stream failed'); },
    } as unknown as Response),
  });
  await assert.rejects(
    responseFailureClient.getAction('act_test'),
    (error: unknown) => error instanceof FiarTransportError &&
      error.message === 'Unable to read the Fiar gateway response',
  );
});
