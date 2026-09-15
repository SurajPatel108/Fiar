import { createId } from '../../../packages/shared/src/ids';

export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  leaseSeconds: number;
  pollIntervalMs: number;
  maxAttempts: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.FIAR_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or FIAR_DATABASE_URL is required');
  }
  if (env.FIAR_RUNTIME_MODE !== 'development') {
    throw new Error('The fake worker connector requires FIAR_RUNTIME_MODE=development');
  }
  return {
    databaseUrl,
    workerId: env.FIAR_WORKER_ID ?? createId('wrk'),
    leaseSeconds: positiveInteger(env.FIAR_WORKER_LEASE_SECONDS, 30),
    pollIntervalMs: positiveInteger(env.FIAR_WORKER_POLL_INTERVAL_MS, 1000),
    maxAttempts: positiveInteger(env.FIAR_WORKER_MAX_ATTEMPTS, 3),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Worker numeric configuration values must be positive integers');
  }
  return parsed;
}
