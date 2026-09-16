import { assertNoProductionDevelopmentCredentials, parseRuntimeMode, type RuntimeMode } from '../../../packages/shared/src/runtime';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  audience: string;
  redirectUri: string;
  dashboardUri: string;
  allowedAlgorithms: readonly ('RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512')[];
  clockSkewSeconds: number;
}
export interface GatewayConfig {
  databaseUrl: string;
  host: string;
  port: number;
  approvalExpiryHours: number;
  runtimeMode: RuntimeMode;
  publicOrigin: string;
  allowedHost: string;
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  autoMigrate: boolean;
  oidc: OidcConfig | null;
}

function positive(value: string | undefined, fallback: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) throw new Error(`${name} must be a positive integer within its supported range`);
  return parsed;
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required in production`);
  return value;
}
function safeUrl(value: string, name: string, production: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid absolute URL`); }
  if (production && url.protocol !== 'https:') throw new Error(`${name} must use HTTPS in production`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} uses an unsupported URL scheme`);
  return url.toString().replace(/\/$/, '');
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const runtimeMode = parseRuntimeMode(env.FIAR_RUNTIME_MODE);
  assertNoProductionDevelopmentCredentials(env);
  const databaseUrl = env.FIAR_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL or FIAR_DATABASE_URL is required');
  const production = runtimeMode === 'production';
  const publicOrigin = safeUrl(production ? required(env, 'FIAR_PUBLIC_ORIGIN') : (env.FIAR_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173'), 'FIAR_PUBLIC_ORIGIN', production);
  const origin = new URL(publicOrigin);
  const allowedHost = env.FIAR_ALLOWED_HOST ?? origin.host;
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(allowedHost)) throw new Error('FIAR_ALLOWED_HOST is invalid');
  let oidc: OidcConfig | null = null;
  if (production || env.FIAR_OIDC_ISSUER) {
    const algorithms = (env.FIAR_OIDC_ALLOWED_ALGORITHMS ?? 'RS256').split(',').map((value) => value.trim());
    const allowed = new Set(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512']);
    if (algorithms.length === 0 || algorithms.some((value) => !allowed.has(value))) throw new Error('FIAR_OIDC_ALLOWED_ALGORITHMS contains an unsupported algorithm');
    oidc = {
      issuer: safeUrl(required(env, 'FIAR_OIDC_ISSUER'), 'FIAR_OIDC_ISSUER', production),
      clientId: required(env, 'FIAR_OIDC_CLIENT_ID'),
      audience: required(env, 'FIAR_OIDC_AUDIENCE'),
      redirectUri: safeUrl(required(env, 'FIAR_OIDC_REDIRECT_URI'), 'FIAR_OIDC_REDIRECT_URI', production),
      dashboardUri: safeUrl(env.FIAR_DASHBOARD_URI ?? publicOrigin, 'FIAR_DASHBOARD_URI', production),
      allowedAlgorithms: algorithms as OidcConfig['allowedAlgorithms'],
      clockSkewSeconds: positive(env.FIAR_OIDC_CLOCK_SKEW_SECONDS, 60, 'FIAR_OIDC_CLOCK_SKEW_SECONDS', 120),
    };
  }
  const idle = positive(env.FIAR_SESSION_IDLE_SECONDS, 1800, 'FIAR_SESSION_IDLE_SECONDS', 4 * 3600);
  const absolute = positive(env.FIAR_SESSION_ABSOLUTE_SECONDS, 8 * 3600, 'FIAR_SESSION_ABSOLUTE_SECONDS', 24 * 3600);
  if (idle > absolute) throw new Error('Session idle duration cannot exceed absolute duration');
  return {
    databaseUrl,
    host: env.FIAR_GATEWAY_HOST ?? '127.0.0.1',
    port: positive(env.FIAR_GATEWAY_PORT, 3000, 'FIAR_GATEWAY_PORT', 65535),
    approvalExpiryHours: positive(env.FIAR_APPROVAL_EXPIRY_HOURS, 24, 'FIAR_APPROVAL_EXPIRY_HOURS', 168),
    runtimeMode,
    publicOrigin,
    allowedHost,
    sessionIdleSeconds: idle,
    sessionAbsoluteSeconds: absolute,
    autoMigrate: !production && env.FIAR_AUTO_MIGRATE !== 'false',
    oidc,
  };
}
