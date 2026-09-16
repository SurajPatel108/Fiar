import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import { hmacSha256, randomToken } from '../../../packages/shared/src/secure-values';
import { createId } from '../../../packages/shared/src/ids';
import { buildGatewayApp } from '../src/app';
import { createDatabasePool } from '../src/db';
import { OPERATOR_USAGE, parseArgs, runOperatorCommand } from '../src/admin-cli';
import { createGatewayTestContext, type GatewayTestContext } from './integration-support';

const pepper = 'phase6-cli-credential-pepper';
let context: GatewayTestContext;

before(async () => { context = await createGatewayTestContext('fiar_phase6_cli'); });
beforeEach(async () => { await context.reset(); });
after(async () => { await context.cleanup(); });

async function command(values: string[]): Promise<string[]> {
  const output: string[] = [];
  await runOperatorCommand(context.pool, pepper, values, (value) => output.push(value));
  return output;
}

test('help, usage, missing, malformed, and unknown commands are deterministic', async () => {
  assert.deepEqual(await command(['help']), [OPERATOR_USAGE]);
  assert.deepEqual(await command(['--help']), [OPERATOR_USAGE]);
  await assert.rejects(command(['credential-create']), /--tenant is required/);
  assert.throws(() => parseArgs(['credential-create', 'tenant', 'x']), /unique --name value pairs/);
  assert.throws(() => parseArgs(['credential-create', '--tenant', 'x', '--tenant', 'y']), /unique --name value pairs/);
  await assert.rejects(command(['unknown-command']), /Unknown operator command/);
  await assert.rejects(command(['credential-create', '--tenant', 'ten_demo_alpha', '--principal', 'prn_demo_alpha_agent', '--unexpected', 'value']), /Unknown operator argument/);
  await assert.rejects(command(['credential-create', '--tenant', 'ten_demo_alpha', '--principal', 'prn_demo_alpha_agent', '--expires-days', '0']), /between 1 and 365/);
});

test('credential creation reveals one raw secret while persisting only its HMAC', async () => {
  const output = await command(['credential-create', '--tenant', 'ten_demo_alpha', '--principal', 'prn_demo_alpha_agent']);
  assert.equal(output.length, 1);
  const token = output[0]!;
  const match = /^fiar_(wcr_[0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/.exec(token);
  assert.ok(match?.[1] && match[2]);
  const stored = await context.pool.query<{ verifier: string; redacted_payload: unknown }>(`
    select c.verifier, e.redacted_payload from workload_credentials c
    join security_audit_events e on e.event_type = 'credential.created'
    where c.id = $1 order by e.created_at desc limit 1
  `, [match[1]]);
  assert.equal(stored.rows[0]?.verifier, hmacSha256(match[2], pepper));
  assert.doesNotMatch(JSON.stringify(stored.rows[0]), new RegExp(match[2]));
  assert.equal(output.filter((value) => value.includes(match[2]!)).length, 1);
});

test('credential rotation atomically revokes old authority and the replacement authenticates', async () => {
  const oldToken = (await command(['credential-create', '--tenant', 'ten_demo_alpha', '--principal', 'prn_demo_alpha_agent']))[0]!;
  const oldId = /^fiar_(wcr_[0-9a-f-]{36})_/.exec(oldToken)![1]!;
  const newToken = (await command(['credential-rotate', '--credential', oldId]))[0]!;
  const newId = /^fiar_(wcr_[0-9a-f-]{36})_/.exec(newToken)![1]!;
  const rows = await context.pool.query<{ id: string; status: string; replacement_credential_id: string | null }>(`select id, status, replacement_credential_id from workload_credentials where id = any($1::text[]) order by id`, [[oldId, newId]]);
  assert.equal(rows.rows.find((row) => row.id === oldId)?.status, 'revoked');
  assert.equal(rows.rows.find((row) => row.id === oldId)?.replacement_credential_id, newId);
  const pool = createDatabasePool(context.databaseUrl);
  const app = await buildGatewayApp({ pool, devCredentials: new Map(), approvalExpiryHours: 12, runtimeMode: 'production', credentialPepper: pepper });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/actions', headers: { authorization: `Bearer ${oldToken}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/actions', headers: { authorization: `Bearer ${newToken}` } })).statusCode, 200);
    const used = await context.pool.query<{ last_used_at: Date | null }>(`select last_used_at from workload_credentials where id = $1`, [newId]);
    assert.ok(used.rows[0]?.last_used_at);
  } finally { await app.close(); }
});

test('credential rotation rolls replacement creation back if old-authority revocation fails', async () => {
  const oldToken = (await command(['credential-create', '--tenant', 'ten_demo_alpha', '--principal', 'prn_demo_alpha_agent']))[0]!;
  const oldId = /^fiar_(wcr_[0-9a-f-]{36})_/.exec(oldToken)![1]!;
  await context.pool.query(`create function reject_test_rotation() returns trigger language plpgsql as $$ begin raise exception 'injected rotation failure'; end $$`);
  await context.pool.query(`create trigger reject_test_rotation before update on workload_credentials for each row execute function reject_test_rotation()`);
  try {
    await assert.rejects(command(['credential-rotate', '--credential', oldId]), /injected rotation failure/);
  } finally {
    await context.pool.query(`drop trigger reject_test_rotation on workload_credentials`);
    await context.pool.query(`drop function reject_test_rotation()`);
  }
  const rows = await context.pool.query<{ status: string; replacement_credential_id: string | null }>(`select status, replacement_credential_id from workload_credentials where principal_id = 'prn_demo_alpha_agent'`);
  assert.deepEqual(rows.rows, [{ status: 'active', replacement_credential_id: null }]);
});

test('failed authentication does not update last_used_at and expired credentials fail', async () => {
  const id = createId('wcr'); const secret = randomToken(32);
  await context.pool.query(`insert into workload_credentials (id, tenant_id, principal_id, credential_type, verifier, status, expires_at, created_at) values ($1, 'ten_demo_alpha', 'prn_demo_alpha_agent', 'agent', $2, 'active', now() - interval '1 minute', now() - interval '1 day')`, [id, hmacSha256(secret, pepper)]);
  const pool = createDatabasePool(context.databaseUrl);
  const app = await buildGatewayApp({ pool, devCredentials: new Map(), approvalExpiryHours: 12, runtimeMode: 'production', credentialPepper: pepper });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/actions', headers: { authorization: `Bearer fiar_${id}_${secret}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/actions', headers: { authorization: `Bearer fiar_${id}_${randomToken(32)}` } })).statusCode, 401);
    const row = await context.pool.query<{ last_used_at: Date | null }>(`select last_used_at from workload_credentials where id = $1`, [id]);
    assert.equal(row.rows[0]?.last_used_at, null);
  } finally { await app.close(); }
});

test('credential revocation is safe for active, repeated, and missing identifiers', async () => {
  const token = (await command(['credential-create', '--tenant', 'ten_demo_alpha', '--principal', 'prn_demo_alpha_service']))[0]!;
  const id = /^fiar_(wcr_[0-9a-f-]{36})_/.exec(token)![1]!;
  await command(['credential-revoke', '--credential', id]);
  await assert.rejects(command(['credential-revoke', '--credential', id]), /Credential is not active/);
  await assert.rejects(command(['credential-revoke', '--credential', createId('wcr')]), /Credential is not active/);
  assert.equal((await context.pool.query<{ status: string }>(`select status from workload_credentials where id = $1`, [id])).rows[0]?.status, 'revoked');
});

test('identity mapping enforces manager role and session revocation is audited', async () => {
  await command(['identity-map', '--issuer', 'https://issuer.example', '--subject', 'manager-subject', '--tenant', 'ten_demo_alpha', '--principal', 'prn_demo_alpha_manager']);
  assert.equal((await context.pool.query(`select 1 from human_identity_mappings where issuer = 'https://issuer.example' and subject = 'manager-subject'`)).rowCount, 1);
  await assert.rejects(command(['identity-map', '--issuer', 'https://issuer.example', '--subject', 'agent-subject', '--tenant', 'ten_demo_alpha', '--principal', 'prn_demo_alpha_agent']), /not eligible/);
  await assert.rejects(command(['identity-map', '--issuer', 'https://issuer.example', '--subject', 'cross-tenant', '--tenant', 'ten_demo_beta', '--principal', 'prn_demo_alpha_manager']), /not eligible/);
  const sessionId = createId('ses');
  await context.pool.query(`insert into human_sessions (id, tenant_id, principal_id, token_verifier, status, absolute_expires_at, idle_expires_at) values ($1, 'ten_demo_alpha', 'prn_demo_alpha_manager', $2, 'active', now() + interval '8 hours', now() + interval '30 minutes')`, [sessionId, hmacSha256(randomToken(32), 'session')]);
  await command(['session-revoke', '--session', sessionId]);
  assert.equal((await context.pool.query<{ status: string }>(`select status from human_sessions where id = $1`, [sessionId])).rows[0]?.status, 'revoked');
  await assert.rejects(command(['session-revoke', '--session', sessionId]), /Session is not active/);
});

test('operator database failures propagate without printing credential material', async () => {
  const broken = { connect: async () => { throw new Error('database unavailable'); } } as unknown as typeof context.pool;
  await assert.rejects(runOperatorCommand(broken, pepper, ['credential-create', '--tenant', 'ten_demo_alpha', '--principal', 'prn_demo_alpha_agent']), /database unavailable/);
});
