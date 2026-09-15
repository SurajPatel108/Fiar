import { loadGatewayConfig } from './config';
import { applySchema, applySeedData, closeDatabasePool, createDatabasePool } from './db';

async function main(): Promise<void> {
  const config = loadGatewayConfig(process.env);
  const pool = createDatabasePool(config.databaseUrl);
  try {
    await applySchema(pool);
    await applySeedData(pool);
  } finally {
    await closeDatabasePool(pool);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
