import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';

import { buildGatewayApp, type GatewayAppOptions } from '../src/app';
import { loadDevCredentialDirectory } from '../src/auth';
import { applySchema, applySeedData, createDatabasePool, resetApplicationData } from '../src/db';

export interface GatewayTestContext {
  app: Awaited<ReturnType<typeof buildGatewayApp>>;
  pool: Pool;
  databaseUrl: string;
  cleanup: () => Promise<void>;
  reset: () => Promise<void>;
  restart: () => Promise<void>;
}

export function createTestCredentialDirectory() {
  return loadDevCredentialDirectory({
    FIAR_DEV_CREDENTIALS_JSON: JSON.stringify([
      { token: 'alpha-agent', principalId: 'prn_demo_alpha_agent' },
      { token: 'alpha-manager', principalId: 'prn_demo_alpha_manager' },
      { token: 'alpha-admin', principalId: 'prn_demo_alpha_admin' },
      { token: 'alpha-service', principalId: 'prn_demo_alpha_service' },
      { token: 'beta-agent', principalId: 'prn_demo_beta_agent' },
      { token: 'beta-manager', principalId: 'prn_demo_beta_manager' },
    ]),
  });
}

function buildDatabaseName(prefix: string): string {
  return `${prefix}_${process.pid}_${Date.now()}_${randomBytes(3).toString('hex')}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function getConnectionDefaults() {
  const host = process.env.FIAR_TEST_DATABASE_HOST ?? '127.0.0.1';
  const port = Number(process.env.FIAR_TEST_DATABASE_PORT ?? '5432');
  const user = process.env.FIAR_TEST_DATABASE_USER ?? 'fiar';
  const password = process.env.FIAR_TEST_DATABASE_PASSWORD ?? 'fiar';
  const adminDatabase = process.env.FIAR_TEST_ADMIN_DATABASE_NAME ?? 'postgres';

  return { host, port, user, password, adminDatabase };
}

async function createDatabase(databaseName: string): Promise<void> {
  const { host, port, user, password, adminDatabase } = getConnectionDefaults();
  const adminPool = new Pool({
    host,
    port,
    user,
    password,
    database: adminDatabase,
    max: 1,
  });

  try {
    await adminPool.query(`create database ${quoteIdentifier(databaseName)}`);
  } finally {
    await adminPool.end();
  }
}

async function dropDatabase(databaseName: string): Promise<void> {
  const { host, port, user, password, adminDatabase } = getConnectionDefaults();
  const adminPool = new Pool({
    host,
    port,
    user,
    password,
    database: adminDatabase,
    max: 1,
  });

  try {
    await adminPool.query(`drop database if exists ${quoteIdentifier(databaseName)}`);
  } finally {
    await adminPool.end();
  }
}

export async function createGatewayTestContext(
  prefix: string,
  options: Partial<Omit<GatewayAppOptions, 'pool' | 'devCredentials'>> = {},
): Promise<GatewayTestContext> {
  const databaseName = buildDatabaseName(prefix);
  await createDatabase(databaseName);

  const { host, port, user, password } = getConnectionDefaults();
  const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${databaseName}`;
  let pool = createDatabasePool(databaseUrl);

  try {
    await applySchema(pool);
    await applySeedData(pool);

    let app = await buildGatewayApp({
      pool,
      devCredentials: createTestCredentialDirectory(),
      approvalExpiryHours: 12,
      ...options,
    });

    const context: GatewayTestContext = {
      app,
      pool,
      databaseUrl,
      cleanup: async () => {
        await app.close();
        await dropDatabase(databaseName);
      },
      reset: async () => {
        await resetApplicationData(pool);
        await applySeedData(pool);
      },
      restart: async () => {
        await app.close();
        pool = createDatabasePool(databaseUrl);
        app = await buildGatewayApp({
          pool,
          devCredentials: createTestCredentialDirectory(),
          approvalExpiryHours: 12,
          ...options,
        });
        context.app = app;
        context.pool = pool;
      },
    };
    return context;
  } catch (error) {
    await pool.end().catch(() => undefined);
    await dropDatabase(databaseName).catch(() => undefined);
    throw error;
  }
}
