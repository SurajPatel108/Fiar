export interface GatewayConfig {
  databaseUrl: string;
  host: string;
  port: number;
  approvalExpiryHours: number;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric configuration value: ${value}`);
  }

  return parsed;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const databaseUrl = env.FIAR_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or FIAR_DATABASE_URL is required');
  }

  return {
    databaseUrl,
    host: env.FIAR_GATEWAY_HOST ?? '127.0.0.1',
    port: parsePositiveInteger(env.FIAR_GATEWAY_PORT, 3000),
    approvalExpiryHours: parsePositiveInteger(env.FIAR_APPROVAL_EXPIRY_HOURS, 24),
  };
}
