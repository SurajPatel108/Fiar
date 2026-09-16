import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerRuntime } from '../src/runtime';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function runtime(overrides: Partial<ConstructorParameters<typeof WorkerRuntime>[0]> = {}) {
  const counts = { claims: 0, reconciliations: 0, healthCloses: 0, databaseCloses: 0 };
  const instance = new WorkerRuntime({
    processOne: async () => { counts.claims += 1; return { kind: 'none' }; },
    reconcileOne: async () => { counts.reconciliations += 1; return { kind: 'none' }; },
    wait: async (stopping) => { while (!stopping()) await new Promise((resolve) => setTimeout(resolve, 1)); },
    closeHealth: async () => { counts.healthCloses += 1; },
    closeDatabase: async () => { counts.databaseCloses += 1; },
    ...overrides,
  });
  return { instance, counts };
}

test('worker idle shutdown closes health and database resources', async () => {
  const { instance, counts } = runtime();
  const running = instance.run();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await instance.requestStop();
  await running;
  assert.equal(counts.healthCloses, 1);
  assert.equal(counts.databaseCloses, 1);
});

test('worker shutdown waits for in-flight work and starts no new claim', async () => {
  const claim = deferred<{ kind: 'executed'; actionId: string; outcome: 'CONFIRMED_SUCCESS' }>();
  const { instance, counts } = runtime({ processOne: async () => { counts.claims += 1; return claim.promise; } });
  const running = instance.run();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = instance.requestStop();
  assert.equal(instance.isStopping, true);
  assert.equal(counts.claims, 1);
  assert.equal(counts.reconciliations, 0);
  claim.resolve({ kind: 'executed', actionId: 'act_test', outcome: 'CONFIRMED_SUCCESS' });
  await stopping;
  await running;
  assert.equal(counts.claims, 1);
  assert.equal(counts.reconciliations, 0);
});

test('worker repeated shutdown calls close resources once', async () => {
  const { instance, counts } = runtime();
  await Promise.all([instance.requestStop(), instance.requestStop(), instance.requestStop()]);
  assert.equal(counts.healthCloses, 1);
  assert.equal(counts.databaseCloses, 1);
});

test('worker reports resource close failure after attempting every owner', async () => {
  const { instance, counts } = runtime({ closeHealth: async () => { counts.healthCloses += 1; throw new Error('health close failed'); } });
  await assert.rejects(instance.requestStop(), AggregateError);
  assert.equal(counts.healthCloses, 1);
  assert.equal(counts.databaseCloses, 1);
});

test('worker real service wiring integration: runtime shutdown stops claims, finishes in-flight work, closes health and database pool', async () => {
  let poolEnded = false;
  const pool = {
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => undefined,
    }),
    query: async () => ({ rows: [] }),
    end: async () => { poolEnded = true; },
  } as unknown as import('pg').Pool;

  const claimProceed = deferred<{ kind: 'executed'; actionId: string; outcome: 'CONFIRMED_SUCCESS' }>();
  let processCount = 0;

  const { createWorkerService, createWorkerLifecycle } = await import('../src/server');
  const service = createWorkerService({
    pool,
    metricsSecret: 'metrics-secret',
    config: { pollIntervalMs: 10, leaseSeconds: 30, maxAttempts: 3 },
  });

  // Intercept processOne
  const originalProcessOne = service.worker.processOne.bind(service.worker);
  service.worker.processOne = async () => {
    processCount += 1;
    if (processCount === 1) {
      return claimProceed.promise;
    }
    return originalProcessOne();
  };

  // Start health server on random port
  await new Promise<void>((resolve, reject) => {
    service.healthServer.once('error', reject);
    service.healthServer.listen(0, '127.0.0.1', resolve);
  });
  assert.equal(service.healthServer.listening, true);

  // Start runtime
  const runPromise = service.runtime.run();
  while (processCount === 0) await new Promise((r) => setTimeout(r, 5));

  // Trigger shutdown via lifecycle
  const lifecycle = createWorkerLifecycle(service.runtime, { timeoutMs: 5000 });
  const shutdownPromise1 = lifecycle.shutdown();
  const shutdownPromise2 = lifecycle.shutdown();
  assert.equal(shutdownPromise1, shutdownPromise2); // repeated calls share one close
  assert.equal(service.runtime.isStopping, true);

  // In-flight work completes safely
  claimProceed.resolve({ kind: 'executed', actionId: 'act_test_shutdown', outcome: 'CONFIRMED_SUCCESS' });
  await shutdownPromise1;
  await runPromise;

  // No further claims started
  assert.equal(processCount, 1);

  // Health server is closed
  assert.equal(service.healthServer.listening, false);

  // PostgreSQL pool is closed
  assert.equal(poolEnded, true);
  assert.equal(lifecycle.state, 'stopped');
});

