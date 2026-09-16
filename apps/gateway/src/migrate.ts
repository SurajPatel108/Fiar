import { applySchema, applySeedData, closeDatabasePool, createDatabasePool } from './db';
import { parseRuntimeMode } from '../../../packages/shared/src/runtime';
import { FileSecretProvider } from '../../../packages/shared/src/secrets';

async function main(): Promise<void> {
  const mode = parseRuntimeMode(process.env.FIAR_RUNTIME_MODE);
  let databaseUrl = process.env.FIAR_DATABASE_URL ?? process.env.DATABASE_URL;
  if (mode === 'production') databaseUrl = await new FileSecretProvider({ database_url: process.env.FIAR_DATABASE_URL_FILE }).get('database_url') ?? undefined;
  if (!databaseUrl) throw new Error('Database configuration is required');
  const pool = createDatabasePool(databaseUrl);
  try { await applySchema(pool); if (mode !== 'production') await applySeedData(pool); }
  finally { await closeDatabasePool(pool); }
}
main().catch(() => { console.error('Database migration failed'); process.exitCode = 1; });
