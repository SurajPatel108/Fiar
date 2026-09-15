import assert from 'node:assert/strict';
import test from 'node:test';

import { canTransitionActionStatus, isTerminalActionStatus } from '../src/states';

test('action state transitions reflect the planned lifecycle', () => {
  assert.equal(canTransitionActionStatus('pending', 'awaiting_approval'), true);
  assert.equal(canTransitionActionStatus('pending', 'queued'), true);
  assert.equal(canTransitionActionStatus('pending', 'completed'), false);
  assert.equal(canTransitionActionStatus('awaiting_approval', 'queued'), true);
  assert.equal(canTransitionActionStatus('queued', 'pending_reconciliation'), true);
  assert.equal(canTransitionActionStatus('pending_reconciliation', 'completed'), true);
  assert.equal(canTransitionActionStatus('pending_reconciliation', 'suspended'), false);
});

test('terminal statuses are recognized', () => {
  assert.equal(isTerminalActionStatus('completed'), true);
  assert.equal(isTerminalActionStatus('pending'), false);
});
