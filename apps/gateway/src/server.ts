import { buildGatewayApp } from './app';
import { loadDevCredentialDirectory } from './auth';
import { loadGatewayConfig } from './config';
import { applySchema, assertRequiredMigrations, createDatabasePool } from './db';
import { OidcClient } from './oidc';
import { EnvironmentSecretProvider, FileSecretProvider, type SecretProvider } from '../../../packages/shared/src/secrets';
import { operationalLog } from '../../../packages/shared/src/operational-log';
import { parseRuntimeMode } from '../../../packages/shared/src/runtime';
import { bindShutdownSignals, GracefulShutdown } from '../../../packages/shared/src/graceful-shutdown';

async function main(): Promise<void> {
  const mode = parseRuntimeMode(process.env.FIAR_RUNTIME_MODE);
  const secrets = secretProvider(mode);
  const databaseUrl = await secrets.get('database_url', mode === 'production');
  const config = loadGatewayConfig(databaseUrl ? { ...process.env, FIAR_DATABASE_URL: databaseUrl } : process.env);
  const credentialPepper = await secrets.get('credential_pepper', config.runtimeMode === 'production');
  const sessionPepper = await secrets.get('session_pepper', config.runtimeMode === 'production');
  const csrfSecret = await secrets.get('csrf_key', config.runtimeMode === 'production');
  const oidcStateKey = await secrets.get('oidc_state_key', config.runtimeMode === 'production');
  const metricsSecret = await secrets.get('metrics_token', config.runtimeMode === 'production');
  const oidcClientSecret = await secrets.get('oidc_client_secret', false);
  const pool = createDatabasePool(config.databaseUrl);
  let app: Awaited<ReturnType<typeof buildGatewayApp>> | undefined;
  try {
    if (config.autoMigrate) await applySchema(pool); else await assertRequiredMigrations(pool);
    const credentials = config.runtimeMode === 'production' ? new Map<string, string>() : loadDevCredentialDirectory(process.env);
    if (config.runtimeMode === 'development' && credentials.size === 0) throw new Error('Development credential configuration is required');
    let oidcClient: OidcClient | undefined;
    if (config.oidc) {
      if (!sessionPepper || !oidcStateKey) throw new Error('OIDC session secrets are unavailable');
      oidcClient = new OidcClient({
        config: config.oidc, pool, stateEncryptionKey: oidcStateKey, sessionPepper,
        clientSecret: oidcClientSecret, sessionIdleSeconds: config.sessionIdleSeconds,
        sessionAbsoluteSeconds: config.sessionAbsoluteSeconds,
      });
      await oidcClient.initialize().catch(() => undefined);
    }
    app = await buildGatewayApp({
      pool, devCredentials: credentials, approvalExpiryHours: config.approvalExpiryHours,
      runtimeMode: config.runtimeMode, publicOrigin: config.publicOrigin, allowedHost: config.allowedHost,
      sessionIdleSeconds: config.sessionIdleSeconds,
      ...(credentialPepper ? { credentialPepper } : {}),
      ...(sessionPepper ? { sessionPepper } : {}),
      ...(csrfSecret ? { csrfSecret } : {}),
      ...(metricsSecret ? { metricsSecret } : {}),
      ...(oidcClient ? { oidcClient } : {}),
    });
    await app.listen({ host: config.host, port: config.port });
    operationalLog('info', { event: 'gateway.started', service: 'gateway', runtimeMode: config.runtimeMode, host: config.host, port: config.port });
    installShutdown(app);
  } catch (error) {
    if (app) await app.close(); else await pool.end();
    throw error;
  }
}

function secretProvider(mode: 'development' | 'test' | 'production'): SecretProvider {
  if (mode !== 'production') return new EnvironmentSecretProvider(process.env);
  return new FileSecretProvider({
    credential_pepper: process.env.FIAR_CREDENTIAL_PEPPER_FILE,
    session_pepper: process.env.FIAR_SESSION_PEPPER_FILE,
    csrf_key: process.env.FIAR_CSRF_KEY_FILE,
    oidc_state_key: process.env.FIAR_OIDC_STATE_KEY_FILE,
    metrics_token: process.env.FIAR_METRICS_TOKEN_FILE,
    oidc_client_secret: process.env.FIAR_OIDC_CLIENT_SECRET_FILE,
    database_url: process.env.FIAR_DATABASE_URL_FILE,
  });
}

function installShutdown(app: Awaited<ReturnType<typeof buildGatewayApp>>): void {
  let unbind: () => void = () => undefined;
  const lifecycle = new GracefulShutdown({
    timeoutMs: 10_000,
    close: async () => { await app.close(); unbind(); },
    onTimeout: () => operationalLog('error', { event: 'gateway.shutdown_timeout', service: 'gateway', reason: 'TIMEOUT' }),
  });
  unbind = bindShutdownSignals(process, () => lifecycle.shutdown(), () => { process.exit(1); });
}

main().catch(() => {
  operationalLog('error', { event: 'gateway.start_failed', service: 'gateway', reason: 'STARTUP_VALIDATION_FAILED' });
  process.exitCode = 1;
});
