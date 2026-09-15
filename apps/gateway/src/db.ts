import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool, type PoolClient } from 'pg';

const ROOT_DIR = process.cwd();

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

export async function applySchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
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
    ]) {
      if (applied.has(fileName)) {
        continue;
      }

      const filePath = resolve(ROOT_DIR, 'db/migrations', fileName);
      await runSqlFile(client, filePath);
      await client.query('insert into schema_migrations (name) values ($1)', [fileName]);
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function applySeedData(pool: Pool): Promise<void> {
  const filePath = resolve(ROOT_DIR, 'db/seeds/local-dev.sql');
  const sql = await readFile(filePath, 'utf8');
  await pool.query(sql);
}

export async function resetApplicationData(pool: Pool): Promise<void> {
  await pool.query(`
    truncate table
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
