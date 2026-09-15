import { buildGatewayApp } from './app';
import { assertDevelopmentAuthenticationAllowed, loadDevCredentialDirectory } from './auth';
import { loadGatewayConfig } from './config';
import { applySchema, createDatabasePool } from './db';

async function main(): Promise<void> {
  const config = loadGatewayConfig(process.env);
  assertDevelopmentAuthenticationAllowed(process.env);
  const pool = createDatabasePool(config.databaseUrl);
  let app: Awaited<ReturnType<typeof buildGatewayApp>> | undefined;
  try {
    await applySchema(pool);
    const credentials = loadDevCredentialDirectory(process.env);

    if (credentials.size === 0) {
      throw new Error('FIAR_DEV_CREDENTIALS_JSON must define at least one local development credential');
    }

    app = await buildGatewayApp({
      pool,
      devCredentials: credentials,
      approvalExpiryHours: config.approvalExpiryHours,
    });

    await app.listen({ host: config.host, port: config.port });
    console.info(`Fiar gateway listening on http://${config.host}:${config.port}`);
  } catch (error) {
    if (app) {
      await app.close();
    } else {
      await pool.end();
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
