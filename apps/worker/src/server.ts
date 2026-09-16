import { createServer, type Server } from 'node:http';
import { applySchema, assertRequiredMigrations, checkDatabaseReady, closeDatabasePool, createDatabasePool } from '../../gateway/src/db';
import { OperationalMetrics } from '../../gateway/src/metrics';
import { EnvironmentSecretProvider, FileSecretProvider } from '../../../packages/shared/src/secrets';
import { operationalLog } from '../../../packages/shared/src/operational-log';
import { sha256, timingSafeHexEqual } from '../../../packages/shared/src/secure-values';
import { parseRuntimeMode } from '../../../packages/shared/src/runtime';
import { FakeRefundProvider } from './connector';
import { loadWorkerConfig } from './config';
import { ExecutionWorker } from './worker';
import { WorkerRuntime } from './runtime';
import { recordExecutionMetrics, recordReconciliationMetrics } from './worker-metrics';
import { bindShutdownSignals, GracefulShutdown } from '../../../packages/shared/src/graceful-shutdown';

async function main(): Promise<void> {
  const mode = parseRuntimeMode(process.env.FIAR_RUNTIME_MODE);
  const secretProvider = mode === 'production'
    ? new FileSecretProvider({ metrics_token: process.env.FIAR_METRICS_TOKEN_FILE, database_url: process.env.FIAR_DATABASE_URL_FILE })
    : new EnvironmentSecretProvider(process.env);
  const databaseUrl = await secretProvider.get('database_url', mode === 'production');
  const config = loadWorkerConfig(databaseUrl ? { ...process.env, FIAR_DATABASE_URL: databaseUrl } : process.env);
  const metricsSecret = await secretProvider.get('metrics_token', config.runtimeMode === 'production');
  const pool = createDatabasePool(config.databaseUrl);
  let healthServer: Server | undefined;
  try {
    if (config.autoMigrate) await applySchema(pool); else await assertRequiredMigrations(pool);
    const metrics = new OperationalMetrics('WORKER');
    const worker = new ExecutionWorker(pool, new FakeRefundProvider(pool, {
      onIdempotencyPrevention: () => metrics.increment('idempotency_preventions_total', { layer: 'PROVIDER' }),
    }), { workerId: config.workerId, leaseSeconds: config.leaseSeconds, maxAttempts: config.maxAttempts });
    healthServer = createHealthServer(pool, metrics, metricsSecret);
    await new Promise<void>((resolve, reject) => { healthServer!.once('error', reject); healthServer!.listen(config.healthPort, config.healthHost, resolve); });
    const runtime = new WorkerRuntime({
      processOne: () => worker.processOne(),
      reconcileOne: () => worker.reconcileOne(),
      wait: (shouldStop) => wait(config.pollIntervalMs, shouldStop),
      closeHealth: async () => { if (healthServer) await new Promise<void>((resolve, reject) => healthServer!.close((error) => error ? reject(error) : resolve())); },
      closeDatabase: () => closeDatabasePool(pool),
      onExecution: (execution) => recordExecutionMetrics(metrics, execution),
      onReconciliation: (reconciliation) => recordReconciliationMetrics(metrics, reconciliation),
    });
    let unbind: () => void = () => undefined;
    const lifecycle = new GracefulShutdown({
      timeoutMs: 10_000,
      close: () => runtime.requestStop(),
      onTimeout: () => operationalLog('error', { event: 'worker.shutdown_timeout', service: 'worker', reason: 'IN_FLIGHT_LEASE_LEFT_FOR_RECONCILIATION' }),
    });
    unbind = bindShutdownSignals(process, () => lifecycle.shutdown().finally(unbind), () => { process.exit(1); });
    operationalLog('info', { event: 'worker.started', service: 'worker', runtimeMode: config.runtimeMode, workerId: config.workerId });
    await runtime.run();
  } finally {
    // WorkerRuntime owns resources after construction. Startup failures land here.
    if (!healthServer) await closeDatabasePool(pool);
  }
}

function createHealthServer(pool: ReturnType<typeof createDatabasePool>, metrics: OperationalMetrics, metricsSecret: string | null): Server {
  return createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json'); response.setHeader('x-content-type-options', 'nosniff');
    if (request.url === '/health/live') { response.statusCode = 200; response.end(JSON.stringify({ status: 'live' })); return; }
    if (request.url === '/health/ready') {
      const ready = await checkDatabaseReady(pool); response.statusCode = ready ? 200 : 503;
      metrics.setReadiness('WORKER', 'DATABASE', ready);
      metrics.setReadiness('WORKER', 'CONNECTOR', true);
      response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', components: { database: ready ? 'ready' : 'unavailable', connector: 'ready' } })); return;
    }
    if (request.url === '/metrics') {
      const authorization = request.headers.authorization ?? ''; const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!metricsSecret || !timingSafeHexEqual(sha256(supplied), sha256(metricsSecret))) { response.statusCode = 401; response.end(JSON.stringify({ error: 'UNAUTHORIZED' })); return; }
      const ready = await checkDatabaseReady(pool);
      metrics.setReadiness('WORKER', 'DATABASE', ready);
      metrics.setReadiness('WORKER', 'CONNECTOR', true);
      response.statusCode = 200; response.setHeader('content-type', 'text/plain; version=0.0.4'); response.end(await metrics.render(pool)); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
}
async function wait(milliseconds: number, shouldStop: () => boolean): Promise<void> {
  const interval = 100; for (let elapsed = 0; elapsed < milliseconds && !shouldStop(); elapsed += interval) await new Promise((resolve) => setTimeout(resolve, Math.min(interval, milliseconds - elapsed)));
}
main().catch(() => { operationalLog('error', { event: 'worker.start_failed', service: 'worker', reason: 'STARTUP_OR_RUNTIME_FAILURE' }); process.exitCode = 1; });
