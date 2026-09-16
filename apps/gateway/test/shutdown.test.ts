import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { bindShutdownSignals, GracefulShutdown, ShutdownTimeoutError } from '../../../packages/shared/src/graceful-shutdown';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('gateway idle shutdown closes its application once and removes signal listeners', async () => {
  const signals = new EventEmitter();
  let closes = 0;
  const lifecycle = new GracefulShutdown({ timeoutMs: 100, close: async () => { closes += 1; } });
  const unbind = bindShutdownSignals(signals, () => lifecycle.shutdown(), (error) => { throw error; });
  signals.emit('SIGTERM');
  await lifecycle.shutdown();
  unbind();
  assert.equal(closes, 1);
  assert.equal(lifecycle.state, 'stopped');
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('gateway shutdown awaits open work and duplicate signals share one close', async () => {
  const openWork = deferred();
  let closes = 0;
  const lifecycle = new GracefulShutdown({ timeoutMs: 100, close: async () => { closes += 1; await openWork.promise; } });
  const first = lifecycle.shutdown();
  const second = lifecycle.shutdown();
  assert.equal(first, second);
  assert.equal(lifecycle.state, 'stopping');
  assert.equal(closes, 1);
  openWork.resolve();
  await first;
  assert.equal(lifecycle.state, 'stopped');
});

test('gateway shutdown has a deterministic timeout', async () => {
  let timedOut = 0;
  const lifecycle = new GracefulShutdown({ timeoutMs: 5, close: () => new Promise(() => undefined), onTimeout: () => { timedOut += 1; } });
  await assert.rejects(lifecycle.shutdown(), ShutdownTimeoutError);
  assert.equal(timedOut, 1);
  assert.equal(lifecycle.state, 'failed');
});

test('gateway shutdown reports resource-close failure', async () => {
  const lifecycle = new GracefulShutdown({ timeoutMs: 100, close: async () => { throw new Error('close failed'); } });
  await assert.rejects(lifecycle.shutdown(), /close failed/);
  assert.equal(lifecycle.state, 'failed');
});
