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
  let stopping = false;
  try {
    if (config.autoMigrate) await applySchema(pool); else await assertRequiredMigrations(pool);
    const worker = new ExecutionWorker(pool, new FakeRefundProvider(pool), { workerId: config.workerId, leaseSeconds: config.leaseSeconds, maxAttempts: config.maxAttempts });
    const metrics = new OperationalMetrics();
    healthServer = createHealthServer(pool, metrics, metricsSecret);
    await new Promise<void>((resolve, reject) => { healthServer!.once('error', reject); healthServer!.listen(config.healthPort, config.healthHost, resolve); });
    let shutdownTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      shutdownTimer = setTimeout(() => {
        operationalLog('error', { event: 'worker.shutdown_timeout', service: 'worker', reason: 'IN_FLIGHT_LEASE_LEFT_FOR_RECONCILIATION' });
        process.exit(1);
      }, 10_000);
      shutdownTimer.unref();
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    operationalLog('info', { event: 'worker.started', service: 'worker', runtimeMode: config.runtimeMode, workerId: config.workerId });
    while (!stopping) {
      const execution = await worker.processOne();
      metrics.increment('worker_claims_total', { result: execution.kind.toUpperCase() });
      if ('outcome' in execution && execution.outcome) metrics.increment('execution_outcomes_total', { outcome: execution.outcome });
      if (execution.kind === 'blocked' && execution.reason === 'KILL_SWITCH_ENABLED') metrics.increment('kill_switch_blocks_total');
      if (execution.kind === 'executed' && execution.outcome === 'RETRYABLE_FAILURE') metrics.increment('worker_retries_total', { reason: 'PRE_PROVIDER' });
      if (stopping) break;
      const reconciliation = await worker.reconcileOne();
      if (reconciliation.kind === 'resolved') metrics.increment('reconciliation_outcomes_total', { outcome: reconciliation.outcome.toUpperCase() });
      if (execution.kind === 'none' && reconciliation.kind === 'none') await wait(config.pollIntervalMs, () => stopping);
    }
    if (shutdownTimer) clearTimeout(shutdownTimer);
  } finally {
    if (healthServer) await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
    await closeDatabasePool(pool);
  }
}

function createHealthServer(pool: ReturnType<typeof createDatabasePool>, metrics: OperationalMetrics, metricsSecret: string | null): Server {
  return createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json'); response.setHeader('x-content-type-options', 'nosniff');
    if (request.url === '/health/live') { response.statusCode = 200; response.end(JSON.stringify({ status: 'live' })); return; }
    if (request.url === '/health/ready') {
      const ready = await checkDatabaseReady(pool); response.statusCode = ready ? 200 : 503;
      response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', components: { database: ready ? 'ready' : 'unavailable', connector: 'ready' } })); return;
    }
    if (request.url === '/metrics') {
      const authorization = request.headers.authorization ?? ''; const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!metricsSecret || !timingSafeHexEqual(sha256(supplied), sha256(metricsSecret))) { response.statusCode = 401; response.end(JSON.stringify({ error: 'UNAUTHORIZED' })); return; }
      response.statusCode = 200; response.setHeader('content-type', 'text/plain; version=0.0.4'); response.end(await metrics.render(pool)); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
}
async function wait(milliseconds: number, shouldStop: () => boolean): Promise<void> {
  const interval = 100; for (let elapsed = 0; elapsed < milliseconds && !shouldStop(); elapsed += interval) await new Promise((resolve) => setTimeout(resolve, Math.min(interval, milliseconds - elapsed)));
}
main().catch(() => { operationalLog('error', { event: 'worker.start_failed', service: 'worker', reason: 'STARTUP_OR_RUNTIME_FAILURE' }); process.exitCode = 1; });
