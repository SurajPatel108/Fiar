import { createId } from '../../../packages/shared/src/ids';
import { parseRuntimeMode, type RuntimeMode } from '../../../packages/shared/src/runtime';

export interface WorkerConfig {
  databaseUrl: string; workerId: string; leaseSeconds: number; pollIntervalMs: number; maxAttempts: number;
  runtimeMode: RuntimeMode; autoMigrate: boolean; healthHost: string; healthPort: number;
}
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.FIAR_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL or FIAR_DATABASE_URL is required');
  const runtimeMode = parseRuntimeMode(env.FIAR_RUNTIME_MODE);
  return {
    databaseUrl, runtimeMode, workerId: env.FIAR_WORKER_ID ?? createId('wrk'),
    leaseSeconds: positiveInteger(env.FIAR_WORKER_LEASE_SECONDS, 30, 'FIAR_WORKER_LEASE_SECONDS', 600),
    pollIntervalMs: positiveInteger(env.FIAR_WORKER_POLL_INTERVAL_MS, 1000, 'FIAR_WORKER_POLL_INTERVAL_MS', 60_000),
    maxAttempts: positiveInteger(env.FIAR_WORKER_MAX_ATTEMPTS, 3, 'FIAR_WORKER_MAX_ATTEMPTS', 20),
    autoMigrate: runtimeMode !== 'production' && env.FIAR_AUTO_MIGRATE !== 'false',
    healthHost: env.FIAR_WORKER_HEALTH_HOST ?? '127.0.0.1',
    healthPort: positiveInteger(env.FIAR_WORKER_HEALTH_PORT, 3001, 'FIAR_WORKER_HEALTH_PORT', 65535),
  };
}
function positiveInteger(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) throw new Error(`${name} must be a positive integer within its supported range`);
  return parsed;
}
