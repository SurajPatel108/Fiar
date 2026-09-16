import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { createId } from '../../../packages/shared/src/ids';
import { parseRuntimeMode } from '../../../packages/shared/src/runtime';
import { EnvironmentSecretProvider, FileSecretProvider } from '../../../packages/shared/src/secrets';
import { hmacSha256, randomToken } from '../../../packages/shared/src/secure-values';
import { createDatabasePool, withTransaction } from './db';
import { insertSecurityAuditEvent } from './security-audit';

export const OPERATOR_USAGE = `Usage:
  credential-create --tenant ID --principal ID [--expires-days 1-365]
  credential-rotate --credential ID [--expires-days 1-365]
  credential-revoke --credential ID
  identity-map --issuer URL --subject SUBJECT --tenant ID --principal ID
  session-revoke --session ID`;

async function main(): Promise<void> {
  const values = process.argv.slice(2);
  const command = values[0];
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${OPERATOR_USAGE}\n`);
    return;
  }
  const mode = parseRuntimeMode(process.env.FIAR_RUNTIME_MODE);
  const provider = mode === 'production'
    ? new FileSecretProvider({
        credential_pepper: process.env.FIAR_CREDENTIAL_PEPPER_FILE,
        database_url: process.env.FIAR_DATABASE_URL_FILE,
      })
    : new EnvironmentSecretProvider(process.env);
  const databaseUrl = mode === 'production'
    ? await provider.get('database_url', true)
    : process.env.FIAR_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Database configuration is required');
  const pepper = await provider.get('credential_pepper', ['credential-create', 'credential-rotate'].includes(command ?? ''));
  const pool = createDatabasePool(databaseUrl);
  try {
    await runOperatorCommand(pool, pepper, values, (value) => process.stdout.write(`${value}\n`));
  } finally { await pool.end(); }
}

export async function runOperatorCommand(
  pool: ReturnType<typeof createDatabasePool>,
  pepper: string | null,
  values: string[],
  write: (value: string) => void = () => undefined,
): Promise<void> {
  const command = values[0];
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') { write(OPERATOR_USAGE); return; }
  const args = parseArgs(values);
  const allowed = COMMAND_ARGUMENTS[command];
  if (!allowed) throw new Error('Unknown operator command');
  if ([...args.keys()].some((key) => !allowed.has(key))) throw new Error('Unknown operator argument');
  if (command === 'credential-create') { if (!pepper) throw new Error('Credential pepper is required'); write(await createCredential(pool, required(args, 'tenant'), required(args, 'principal'), expiry(args), pepper)); }
  else if (command === 'credential-rotate') { if (!pepper) throw new Error('Credential pepper is required'); write(await rotateCredential(pool, required(args, 'credential'), expiry(args), pepper)); }
  else if (command === 'credential-revoke') await revokeCredential(pool, required(args, 'credential'));
  else if (command === 'identity-map') await mapIdentity(pool, required(args, 'issuer'), required(args, 'subject'), required(args, 'tenant'), required(args, 'principal'));
  else if (command === 'session-revoke') await revokeSession(pool, required(args, 'session'));
}

const COMMAND_ARGUMENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  'credential-create': new Set(['tenant', 'principal', 'expires-days']),
  'credential-rotate': new Set(['credential', 'expires-days']),
  'credential-revoke': new Set(['credential']),
  'identity-map': new Set(['issuer', 'subject', 'tenant', 'principal']),
  'session-revoke': new Set(['session']),
};

export async function createCredential(pool: ReturnType<typeof createDatabasePool>, tenantId: string, principalId: string, expiresAt: Date, pepper: string): Promise<string> {
  return withTransaction(pool, async (client) => createCredentialInTransaction(client, tenantId, principalId, expiresAt, pepper));
}
async function createCredentialInTransaction(client: PoolClient, tenantId: string, principalId: string, expiresAt: Date, pepper: string): Promise<string> {
  const principal = await client.query<{ type: 'agent' | 'service'; status: string; tenant_status: string }>(`
    select p.type, p.status, t.status as tenant_status from principals p join tenants t on t.id = p.tenant_id
    where p.id = $1 and p.tenant_id = $2 for update
  `, [principalId, tenantId]);
  const row = principal.rows[0];
  if (!row || !['agent', 'service'].includes(row.type) || row.status !== 'active' || row.tenant_status !== 'active') throw new Error('Selected principal is not eligible for a workload credential');
  const id = createId('wcr');
  const secret = randomToken(32);
  await client.query(`insert into workload_credentials (id, tenant_id, principal_id, credential_type, verifier, status, expires_at) values ($1, $2, $3, $4, $5, 'active', $6)`, [id, tenantId, principalId, row.type, hmacSha256(secret, pepper), expiresAt]);
  await insertSecurityAuditEvent(client, { tenantId, principalId, eventType: 'credential.created', outcome: 'CREATED', reason: 'OPERATOR_BOOTSTRAP', correlationId: randomUUID(), payload: { principalType: row.type } });
  return `fiar_${id}_${secret}`;
}
export async function rotateCredential(pool: ReturnType<typeof createDatabasePool>, credentialId: string, expiresAt: Date, pepper: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const current = await client.query<{ tenant_id: string; principal_id: string; status: string }>(`select tenant_id, principal_id, status from workload_credentials where id = $1 for update`, [credentialId]);
    const row = current.rows[0];
    if (!row || row.status !== 'active') throw new Error('Credential is not active');
    const token = await createCredentialInTransaction(client, row.tenant_id, row.principal_id, expiresAt, pepper);
    const replacementId = /^fiar_(wcr_[0-9a-f-]{36})_/.exec(token)?.[1];
    await client.query(`update workload_credentials set status = 'revoked', revoked_at = now(), replacement_credential_id = $2, updated_at = now() where id = $1`, [credentialId, replacementId]);
    await insertSecurityAuditEvent(client, { tenantId: row.tenant_id, principalId: row.principal_id, eventType: 'credential.rotated', outcome: 'ROTATED', reason: 'OPERATOR_ROTATION', correlationId: randomUUID(), payload: { replacementPresent: true } });
    return token;
  });
}
export async function revokeCredential(pool: ReturnType<typeof createDatabasePool>, id: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    const result = await client.query<{ tenant_id: string; principal_id: string }>(`update workload_credentials set status = 'revoked', revoked_at = now(), updated_at = now() where id = $1 and status = 'active' returning tenant_id, principal_id`, [id]);
    const row = result.rows[0]; if (!row) throw new Error('Credential is not active');
    await insertSecurityAuditEvent(client, { tenantId: row.tenant_id, principalId: row.principal_id, eventType: 'credential.revoked', outcome: 'REVOKED', reason: 'OPERATOR_REVOCATION', correlationId: randomUUID() });
  });
}
export async function mapIdentity(pool: ReturnType<typeof createDatabasePool>, issuer: string, subject: string, tenantId: string, principalId: string): Promise<void> {
  const url = new URL(issuer); if (!['http:', 'https:'].includes(url.protocol) || !subject || subject.length > 512) throw new Error('Identity mapping input is invalid');
  await withTransaction(pool, async (client) => {
    const result = await client.query<{ type: string; status: string; tenant_status: string }>(`select p.type, p.status, t.status as tenant_status from principals p join tenants t on t.id = p.tenant_id where p.id = $1 and p.tenant_id = $2`, [principalId, tenantId]);
    const row = result.rows[0]; if (!row || !['manager', 'admin'].includes(row.type) || row.status !== 'active' || row.tenant_status !== 'active') throw new Error('Selected principal is not eligible for a human identity mapping');
    const mappingId = createId('him');
    await client.query(`insert into human_identity_mappings (id, issuer, subject, tenant_id, principal_id, status) values ($1, $2, $3, $4, $5, 'active')`, [mappingId, url.toString().replace(/\/$/, ''), subject, tenantId, principalId]);
    await insertSecurityAuditEvent(client, { tenantId, principalId, eventType: 'identity.mapped', outcome: 'CREATED', reason: 'OPERATOR_MAPPING', correlationId: randomUUID(), payload: { mappingId, principalType: row.type } });
  });
}
export async function revokeSession(pool: ReturnType<typeof createDatabasePool>, id: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    const result = await client.query<{ tenant_id: string; principal_id: string }>(`update human_sessions set status = 'revoked', revoked_at = now(), updated_at = now() where id = $1 and status = 'active' returning tenant_id, principal_id`, [id]);
    const row = result.rows[0]; if (!row) throw new Error('Session is not active');
    await insertSecurityAuditEvent(client, { tenantId: row.tenant_id, principalId: row.principal_id, eventType: 'session.revoked', outcome: 'REVOKED', reason: 'OPERATOR_REVOCATION', correlationId: randomUUID() });
  });
}
export function parseArgs(values: string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let index = 1; index < values.length; index += 2) { const key = values[index]; const value = values[index + 1]; if (!key?.startsWith('--') || !value || output.has(key.slice(2))) throw new Error('Operator arguments must use unique --name value pairs'); output.set(key.slice(2), value); }
  return output;
}
function required(args: Map<string, string>, name: string): string { const value = args.get(name); if (!value) throw new Error(`--${name} is required`); return value; }
function expiry(args: Map<string, string>): Date { const days = Number(args.get('expires-days') ?? '90'); if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error('--expires-days must be between 1 and 365'); return new Date(Date.now() + days * 86_400_000); }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => { console.error('Operator command failed'); process.exitCode = 1; });
}
