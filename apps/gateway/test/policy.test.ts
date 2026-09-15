import assert from 'node:assert/strict';
import test from 'node:test';

import { decide } from '../src/policy';
import type { Facts } from '../../../packages/shared/src/policy-types';

const base: Facts = {
  tool: 'refund.create',
  amountMinor: 4900,
  currency: 'USD',
  active: true,
  remainingMinor: 20000,
  orderExposureMinor: 0,
  budgetAvailableMinor: 50000,
};

test('refund policy boundaries', () => {
  assert.equal(decide(base).decision, 'ALLOW');
  assert.equal(decide({ ...base, amountMinor: 5000 }).decision, 'REQUIRE_APPROVAL');
  assert.equal(decide({ ...base, tool: 'bank.update' }).decision, 'DENY');
  assert.equal(decide({ ...base, active: false }).decision, 'DENY');
  assert.equal(decide({ ...base, budgetAvailableMinor: 1 }).decision, 'DENY');
  assert.equal(decide({ ...base, orderExposureMinor: 100 }).decision, 'REQUIRE_APPROVAL');
});

test('refund policy rejects missing or invalid facts', () => {
  assert.equal(decide({ ...base, remainingMinor: Number.NaN } as Facts).decision, 'DENY');
  assert.equal(decide({ ...base, budgetAvailableMinor: Number.POSITIVE_INFINITY } as Facts).decision, 'DENY');
  assert.equal(decide({ ...base, active: 'true' } as unknown as Facts).decision, 'DENY');
});
