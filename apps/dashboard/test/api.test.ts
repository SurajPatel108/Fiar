import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FiarApiError,
  FiarTransportError,
  type Approval,
  type ApprovalListOptions,
  type Page,
} from '@fiar/sdk';
import { describeDecisionError, listAllPendingApprovals } from '../src/api';

function approvalFixture(id: string, status: Approval['status'] = 'pending'): Approval {
  return {
    approvalId: id,
    status,
    actionId: `act_${id}`,
    actionStatus: status === 'expired' ? 'expired' : status === 'rejected' ? 'denied' : status === 'approved' ? 'queued' : 'awaiting_approval',
    tool: 'refund.create',
    orderId: `ord_${id}`,
    amountMinor: 5000,
    currency: 'USD',
    decisionReason: 'Manager approval required',
    requestHash: 'a'.repeat(64),
    policyVersionId: 'pol_test_v1',
    decision: status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : null,
    comment: null,
    resolutionReason: status === 'expired' ? 'APPROVAL_EXPIRED' : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    resolvedAt: status === 'pending' ? null : '2026-01-01T01:00:00.000Z',
    context: {
      orderFactVersion: 'v1',
      active: true,
      refundableRemainingMinor: 20000,
      orderExposureMinor: 100,
      budgetAvailableMinor: 50000,
    },
  };
}

test('loads every pending approval page using the server cursor', async () => {
  const calls: Array<{ status?: string; limit?: number; cursor?: string }> = [];
  const pages: Array<Page<Approval>> = [
    { items: [approvalFixture('apr_one')], nextCursor: 'cursor-two' },
    { items: [approvalFixture('apr_two')], nextCursor: null },
  ];
  const client = {
    listApprovals: async (options: ApprovalListOptions = {}) => {
      calls.push(options);
      const page = pages.shift();
      assert.ok(page);
      return page;
    },
  };

  const approvals = await listAllPendingApprovals(client);

  assert.deepEqual(approvals.map((approval) => approval.approvalId), ['apr_one', 'apr_two']);
  assert.deepEqual(calls, [
    { status: 'pending', limit: 100 },
    { status: 'pending', limit: 100, cursor: 'cursor-two' },
  ]);
});

test('rejects a repeated pagination cursor instead of looping forever', async () => {
  const client = {
    listApprovals: async (): Promise<Page<Approval>> => ({ items: [], nextCursor: 'repeated' }),
  };

  await assert.rejects(
    listAllPendingApprovals(client),
    (error: unknown) => error instanceof FiarTransportError && /repeated approval cursor/.test(error.message),
  );
});

test('distinguishes expired and already-resolved decisions after refreshing detail', () => {
  const conflict = new FiarApiError(409, 'CONFLICT', 'Approval has already been resolved');

  assert.deepEqual(describeDecisionError(conflict, approvalFixture('apr_expired', 'expired')), {
    kind: 'expired',
    message: 'This approval is expired and cannot be decided (APPROVAL_EXPIRED).',
  });
  assert.deepEqual(describeDecisionError(conflict, approvalFixture('apr_approved', 'approved')), {
    kind: 'conflict',
    message: 'This approval was already approved. The refreshed detail is shown.',
  });
});
