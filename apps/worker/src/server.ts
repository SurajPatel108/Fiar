import { applySchema, closeDatabasePool, createDatabasePool } from '../../gateway/src/db';
import { FakeRefundProvider } from './connector';
import { loadWorkerConfig } from './config';
import { ExecutionWorker } from './worker';

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const pool = createDatabasePool(config.databaseUrl);
  try {
    await applySchema(pool);
    const worker = new ExecutionWorker(pool, new FakeRefundProvider(pool), {
      workerId: config.workerId,
      leaseSeconds: config.leaseSeconds,
      maxAttempts: config.maxAttempts,
    });
    console.info(`Fiar worker ${config.workerId} started with the fake provider connector`);

    for (;;) {
      const execution = await worker.processOne();
      const reconciliation = await worker.reconcileOne();
      if (execution.kind === 'none' && reconciliation.kind === 'none') {
        await new Promise<void>((resolve) => setTimeout(resolve, config.pollIntervalMs));
      }
    }
  } finally {
    await closeDatabasePool(pool);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
