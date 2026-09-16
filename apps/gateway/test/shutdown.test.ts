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

test('gateway real service wiring integration: listener shutdown stops intake, finishes in-flight requests, and closes pool', async () => {
  let poolEnded = false;
  const pool = {
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => undefined,
    }),
    query: async () => ({ rows: [] }),
    end: async () => { poolEnded = true; },
  } as unknown as import('pg').Pool;

  const app = await (await import('../src/app')).buildGatewayApp({
    pool,
    devCredentials: new Map([['alpha-agent', 'prn_demo_alpha_agent']]),
    approvalExpiryHours: 12,
    runtimeMode: 'test',
  });

  let inFlightProceed: () => void = () => undefined;
  const inFlightBarrier = new Promise<void>((resolve) => { inFlightProceed = resolve; });
  let inFlightStarted = false;
  let inFlightFinished = false;

  app.get('/test-in-flight', async (_req, reply) => {
    inFlightStarted = true;
    await inFlightBarrier;
    inFlightFinished = true;
    reply.send({ ok: true });
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal(app.server.listening, true);

  const { createGatewayLifecycle } = await import('../src/server');
  const lifecycle = createGatewayLifecycle(app, { timeoutMs: 5000 });

  // 1. Start in-flight request
  const inFlightPromise = app.inject({ method: 'GET', url: '/test-in-flight' });
  while (!inFlightStarted) await new Promise((resolve) => setTimeout(resolve, 5));

  // 2. Begin shutdown
  const shutdownPromise1 = lifecycle.shutdown();
  const shutdownPromise2 = lifecycle.shutdown();
  assert.equal(shutdownPromise1, shutdownPromise2); // duplicate calls share one close
  assert.equal(lifecycle.state, 'stopping');

  // 3. Fastify is stopping
  assert.equal(lifecycle.state, 'stopping');

  // 4. Release in-flight request
  inFlightProceed();
  const inFlightResult = await inFlightPromise;
  assert.equal(inFlightResult.statusCode, 200);
  assert.deepEqual(inFlightResult.json(), { ok: true });
  assert.equal(inFlightFinished, true);

  // 5. Shutdown completes and closes listener and pool
  await shutdownPromise1;
  assert.equal(lifecycle.state, 'stopped');
  assert.equal(app.server.listening, false);
  assert.equal(poolEnded, true);
});

test('gateway real service wiring enforces bounded timeout on stalled shutdown', async () => {
  let timeoutReported = false;
  let poolEnded = false;
  const pool = {
    end: async () => { poolEnded = true; },
  } as unknown as import('pg').Pool;

  const app = await (await import('../src/app')).buildGatewayApp({
    pool,
    devCredentials: new Map(),
    approvalExpiryHours: 12,
    runtimeMode: 'test',
  });

  // Hook onClose before listen to simulate a hung shutdown task
  app.addHook('onClose', async () => {
    await new Promise(() => undefined);
  });

  await app.listen({ host: '127.0.0.1', port: 0 });

  const { createGatewayLifecycle } = await import('../src/server');
  const lifecycle = createGatewayLifecycle(app, {
    timeoutMs: 50,
    onTimeout: () => { timeoutReported = true; },
  });

  await assert.rejects(lifecycle.shutdown(), ShutdownTimeoutError);
  assert.equal(timeoutReported, true);
  assert.equal(lifecycle.state, 'failed');
});


