import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool, type PoolClient } from 'pg';

const ROOT_DIR = process.cwd();
export const REQUIRED_MIGRATION = '0007_phase6_acceptance.sql';

export function createDatabasePool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export async function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await callback(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function runSqlFile(client: PoolClient, filePath: string): Promise<void> {
  const sql = await readFile(filePath, 'utf8');
  await client.query(sql);
}

export async function applyMigrations(pool: Pool): Promise<void> {
  await applySchema(pool);
}

export class MigrationError extends Error {
  constructor(public readonly fileName: string | null, public readonly classification: string) {
    super(fileName ? `Migration failed during "${fileName}": ${classification}` : `Migration failed: ${classification}`);
    this.name = 'MigrationError';
  }
}

export function classifyDatabaseError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: string }).code;
    if (code === '42501' || code === 'EACCES') return 'permission_denied';
    if (code === '42P01') return 'undefined_table';
    if (code === '42703') return 'undefined_column';
    if (code === '23505') return 'unique_violation';
    if (code === '23503') return 'foreign_key_violation';
    if (code === '42601') return 'syntax_error';
    if (code === '57014') return 'query_canceled_or_timeout';
    if (code === '08001' || code === '08006' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'connection_failure';
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `pg_${code.toLowerCase()}`;
  }
  return 'database_error';
}

export async function applySchema(pool: Pool): Promise<void> {
  let client: PoolClient | undefined;
  let currentFile: string | null = null;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    const { rows } = await client.query<{ name: string }>('select name from schema_migrations order by name');
    const applied = new Set(rows.map((row) => row.name));

    for (const fileName of [
      '0001_init.sql',
      '0002_actions_and_approvals.sql',
      '0003_outbox_and_audit.sql',
      '0004_approval_decisions.sql',
      '0005_worker_execution.sql',
      '0006_phase6_identity_and_operations.sql',
      '0007_phase6_acceptance.sql',
    ]) {
      if (applied.has(fileName)) {
        continue;
      }

      currentFile = fileName;
      const filePath = resolve(ROOT_DIR, 'db/migrations', fileName);
      await runSqlFile(client, filePath);
      await client.query('insert into schema_migrations (name) values ($1)', [fileName]);
      currentFile = null;
    }

    await client.query('commit');
  } catch (error) {
    if (client) {
      await client.query('rollback').catch(() => undefined);
    }
    if (error instanceof MigrationError) throw error;
    throw new MigrationError(currentFile, classifyDatabaseError(error));
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function assertRequiredMigrations(pool: Pool): Promise<void> {
  const result = await pool.query<{ present: boolean }>(
    `select exists(select 1 from schema_migrations where name = $1) as present`,
    [REQUIRED_MIGRATION],
  );
  if (result.rows[0]?.present !== true) throw new Error('Required database migrations are not applied');
}

export async function checkDatabaseReady(pool: Pool): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      try {
        await client.query(`set local statement_timeout = '2000ms'`);
        await client.query('select 1');
        const result = await client.query<{ present: boolean }>(
          `select exists(select 1 from schema_migrations where name = $1) as present`,
          [REQUIRED_MIGRATION],
        );
        await client.query('commit');
        return result.rows[0]?.present === true;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      }
    } finally { client.release(); }
  } catch { return false; }
}

export async function applySeedData(pool: Pool): Promise<void> {
  const filePath = resolve(ROOT_DIR, 'db/seeds/local-dev.sql');
  const sql = await readFile(filePath, 'utf8');
  await pool.query(sql);
}

export async function resetApplicationData(pool: Pool): Promise<void> {
  await pool.query(`
    truncate table
      security_audit_events,
      human_sessions,
      oidc_login_attempts,
      human_identity_mappings,
      workload_credentials,
      fake_provider_refunds,
      execution_attempts,
      execution_reservations,
      audit_events,
      outbox_entries,
      pending_approval_requests,
      actions,
      order_facts,
      policy_versions,
      principals,
      tenants
    restart identity cascade;
  `);
}

export async function closeDatabasePool(pool: Pool): Promise<void> {
  await pool.end();
}
