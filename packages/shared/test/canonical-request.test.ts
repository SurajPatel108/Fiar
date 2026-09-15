import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalizeRefundActionRequest,
  hashCanonicalRefundActionRequest,
  stableStringify,
} from '../src/canonical-request';
import type { RefundActionRequest } from '../src/schema';

test('canonical request hash is stable for equivalent inputs', () => {
  const left: RefundActionRequest = {
    tool: 'refund.create',
    orderId: 'ord_123',
    amountMinor: 4900,
    currency: 'USD',
    idempotencyKey: 'idem-1',
  };

  const right: RefundActionRequest = {
    idempotencyKey: 'idem-2',
    currency: 'USD',
    amountMinor: 4900,
    orderId: 'ord_123',
    tool: 'refund.create',
  };

  assert.deepEqual(canonicalizeRefundActionRequest(left), canonicalizeRefundActionRequest(right));
  assert.equal(
    hashCanonicalRefundActionRequest(canonicalizeRefundActionRequest(left)),
    hashCanonicalRefundActionRequest(canonicalizeRefundActionRequest(right)),
  );
});

test('stable stringify sorts object keys recursively', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');
});
