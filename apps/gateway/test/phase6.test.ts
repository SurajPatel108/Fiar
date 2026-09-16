import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';

import { createId } from '../../../packages/shared/src/ids';
import { hmacSha256, randomToken } from '../../../packages/shared/src/secure-values';
import { buildGatewayApp } from '../src/app';
import { createDatabasePool } from '../src/db';
import { OidcClient } from '../src/oidc';
import { OperationalMetrics } from '../src/metrics';
import { createGatewayTestContext, type GatewayTestContext } from './integration-support';

let context: GatewayTestContext;
before(async () => { context = await createGatewayTestContext('fiar_phase6'); });
after(async () => { await context.cleanup(); });

test('production rejects development headers and authenticates an HMAC-protected workload credential', async () => {
  const id = createId('wcr'); const secret = randomToken(32); const pepper = 'test-workload-pepper';
  await context.pool.query(`insert into workload_credentials (id, tenant_id, principal_id, credential_type, verifier, status, expires_at) values ($1, 'ten_demo_alpha', 'prn_demo_alpha_agent', 'agent', $2, 'active', now() + interval '1 day')`, [id, hmacSha256(secret, pepper)]);
  const pool = createDatabasePool(context.databaseUrl);
  const metrics = new OperationalMetrics();
  const app = await buildGatewayApp({ pool, devCredentials: new Map([['alpha-agent', 'prn_demo_alpha_agent']]), approvalExpiryHours: 12, runtimeMode: 'production', credentialPepper: pepper, sessionPepper: 'session', csrfSecret: 'csrf', metricsSecret: 'metrics', metrics });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/actions', headers: { 'x-fiar-dev-credential': 'alpha-agent' } })).statusCode, 401);
    const response = await app.inject({ method: 'GET', url: '/v1/actions', headers: { authorization: `Bearer fiar_${id}_${secret}` } });
    assert.equal(response.statusCode, 200);
    assert.match(await metrics.render(context.pool), /fiar_authentication_successes_total\{channel="WORKLOAD"\} 1/);
    const stored = await context.pool.query<{ verifier: string }>(`select verifier from workload_credentials where id = $1`, [id]);
    assert.equal(stored.rows[0]?.verifier.includes(secret), false);
    await context.pool.query(`update workload_credentials set status = 'revoked', revoked_at = now() where id = $1`, [id]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/actions', headers: { authorization: `Bearer fiar_${id}_${secret}` } })).statusCode, 401);
  } finally { await app.close(); }
});

test('malformed, unknown, expired, rotated, and suspended workload authority fails closed', async () => {
  const pepper = 'negative-workload-pepper';
  const activeId = createId('wcr'); const activeSecret = randomToken(32);
  const expiredId = createId('wcr'); const expiredSecret = randomToken(32);
  await context.pool.query(`
    insert into workload_credentials (id, tenant_id, principal_id, credential_type, verifier, status, expires_at, created_at)
    values
      ($1, 'ten_demo_alpha', 'prn_demo_alpha_agent', 'agent', $2, 'active', now() + interval '1 day', now()),
      ($3, 'ten_demo_alpha', 'prn_demo_alpha_agent', 'agent', $4, 'active', now() - interval '1 day', now() - interval '2 days')
  `, [activeId, hmacSha256(activeSecret, pepper), expiredId, hmacSha256(expiredSecret, pepper)]);
  const pool = createDatabasePool(context.databaseUrl);
  const app = await buildGatewayApp({ pool, devCredentials: new Map(), approvalExpiryHours: 12, runtimeMode: 'production', credentialPepper: pepper });
  const get = (value: string) => app.inject({ method: 'GET', url: '/v1/actions', headers: { authorization: `Bearer ${value}` } });
  try {
    assert.equal((await get('malformed')).statusCode, 401);
    assert.equal((await get(`fiar_${createId('wcr')}_${randomToken(32)}`)).statusCode, 401);
    assert.equal((await get(`fiar_${expiredId}_${expiredSecret}`)).statusCode, 401);
    await context.pool.query(`update principals set status = 'suspended' where id = 'prn_demo_alpha_agent'`);
    assert.equal((await get(`fiar_${activeId}_${activeSecret}`)).statusCode, 403);
    await context.pool.query(`update principals set status = 'active' where id = 'prn_demo_alpha_agent'`);
    const replacementId = createId('wcr'); const replacementSecret = randomToken(32);
    await context.pool.query(`insert into workload_credentials (id, tenant_id, principal_id, credential_type, verifier, status, expires_at) values ($1, 'ten_demo_alpha', 'prn_demo_alpha_agent', 'agent', $2, 'active', now() + interval '1 day')`, [replacementId, hmacSha256(replacementSecret, pepper)]);
    await context.pool.query(`update workload_credentials set status = 'revoked', revoked_at = now(), replacement_credential_id = $2 where id = $1`, [activeId, replacementId]);
    assert.equal((await get(`fiar_${activeId}_${activeSecret}`)).statusCode, 401);
    assert.equal((await get(`fiar_${replacementId}_${replacementSecret}`)).statusCode, 200);
  } finally {
    await context.pool.query(`update principals set status = 'active' where id = 'prn_demo_alpha_agent'`);
    await app.close();
  }
});

test('workload replacement lineage cannot cross principal or tenant authority', async () => {
  const agentId = createId('wcr'); const serviceId = createId('wcr');
  await context.pool.query(`
    insert into workload_credentials (id, tenant_id, principal_id, credential_type, verifier, status, expires_at)
    values
      ($1, 'ten_demo_alpha', 'prn_demo_alpha_agent', 'agent', $2, 'active', now() + interval '1 day'),
      ($3, 'ten_demo_alpha', 'prn_demo_alpha_service', 'service', $4, 'active', now() + interval '1 day')
  `, [agentId, hmacSha256('agent-secret', 'lineage'), serviceId, hmacSha256('service-secret', 'lineage')]);
  await assert.rejects(context.pool.query(`
    update workload_credentials set status = 'revoked', revoked_at = now(), replacement_credential_id = $2
    where id = $1
  `, [agentId, serviceId]), /workload_credentials_replacement_fkey/);
  const stored = await context.pool.query<{ status: string; replacement_credential_id: string | null }>(`select status, replacement_credential_id from workload_credentials where id = $1`, [agentId]);
  assert.deepEqual(stored.rows[0], { status: 'active', replacement_credential_id: null });
  await context.pool.query(`delete from workload_credentials where id = any($1::text[])`, [[agentId, serviceId]]);
});

test('server-managed session requires bound CSRF and revokes on logout', async () => {
  const id = createId('ses'); const secret = randomToken(32); const pepper = 'session-pepper';
  await context.pool.query(`insert into human_sessions (id, tenant_id, principal_id, token_verifier, status, absolute_expires_at, idle_expires_at) values ($1, 'ten_demo_alpha', 'prn_demo_alpha_manager', $2, 'active', now() + interval '8 hours', now() + interval '30 minutes')`, [id, hmacSha256(secret, pepper)]);
  const pool = createDatabasePool(context.databaseUrl);
  const metrics = new OperationalMetrics();
  const app = await buildGatewayApp({ pool, devCredentials: new Map(), approvalExpiryHours: 12, runtimeMode: 'production', credentialPepper: 'credential', sessionPepper: pepper, csrfSecret: 'csrf-key', metricsSecret: 'metrics', publicOrigin: 'https://fiar.example', allowedHost: 'fiar.example', metrics });
  try {
    const cookie = `__Host-fiar_session=fiar_session_${id}_${secret}`;
    const session = await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    assert.equal(session.statusCode, 200);
    assert.match(await metrics.render(context.pool), /fiar_authentication_successes_total\{channel="SESSION"\} 1/);
    const csrfToken = (session.json() as { csrfToken: string }).csrfToken;
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, origin: 'https://evil.example', host: 'fiar.example', 'x-fiar-csrf-token': csrfToken } })).statusCode, 403);
    const otherId = createId('ses'); const otherSecret = randomToken(32);
    await context.pool.query(`insert into human_sessions (id, tenant_id, principal_id, token_verifier, status, absolute_expires_at, idle_expires_at) values ($1, 'ten_demo_alpha', 'prn_demo_alpha_manager', $2, 'active', now() + interval '8 hours', now() + interval '30 minutes')`, [otherId, hmacSha256(otherSecret, pepper)]);
    const otherSession = await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: `__Host-fiar_session=fiar_session_${otherId}_${otherSecret}` } });
    const otherCsrf = (otherSession.json() as { csrfToken: string }).csrfToken;
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, origin: 'https://fiar.example', host: 'fiar.example', 'x-fiar-csrf-token': otherCsrf } })).statusCode, 403);
    const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, origin: 'https://fiar.example', host: 'fiar.example', 'x-fiar-csrf-token': csrfToken } });
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers['set-cookie']), /HttpOnly/);
    assert.match(String(logout.headers['set-cookie']), /Secure/);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).statusCode, 401);
    const expiredId = createId('ses'); const expiredSecret = randomToken(32);
    await context.pool.query(`insert into human_sessions (id, tenant_id, principal_id, token_verifier, status, absolute_expires_at, idle_expires_at, created_at) values ($1, 'ten_demo_alpha', 'prn_demo_alpha_manager', $2, 'active', now() - interval '1 hour', now() - interval '1 hour', now() - interval '2 hours')`, [expiredId, hmacSha256(expiredSecret, pepper)]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: `__Host-fiar_session=fiar_session_${expiredId}_${expiredSecret}` } })).statusCode, 401);
    const agentSessionId = createId('ses'); const agentSessionSecret = randomToken(32);
    await context.pool.query(`insert into human_sessions (id, tenant_id, principal_id, token_verifier, status, absolute_expires_at, idle_expires_at) values ($1, 'ten_demo_alpha', 'prn_demo_alpha_agent', $2, 'active', now() + interval '8 hours', now() + interval '30 minutes')`, [agentSessionId, hmacSha256(agentSessionSecret, pepper)]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: `__Host-fiar_session=fiar_session_${agentSessionId}_${agentSessionSecret}` } })).statusCode, 403);
    await context.pool.query(`update principals set status = 'suspended' where id = 'prn_demo_alpha_manager'`);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: `__Host-fiar_session=fiar_session_${otherId}_${otherSecret}` } })).statusCode, 403);
  } finally {
    await context.pool.query(`update principals set status = 'active' where id = 'prn_demo_alpha_manager'`);
    await context.pool.query(`delete from human_sessions where tenant_id = 'ten_demo_alpha'`);
    await app.close();
  }
});

test('liveness remains safe while readiness and metrics are separately protected', async () => {
  const live = await context.app.inject({ method: 'GET', url: '/health/live' });
  assert.deepEqual(live.json(), { status: 'live' });
  assert.equal((await context.app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
  assert.equal((await context.app.inject({ method: 'GET', url: '/metrics' })).statusCode, 401);
  assert.doesNotMatch(live.body, /postgres|credential|token/i);
});

test('liveness survives database and OIDC degradation while readiness recovers', async () => {
  let databaseAvailable = false;
  let oidcAvailable = false;
  const pool = {
    connect: async () => {
      if (!databaseAvailable) throw new Error('unavailable');
      return {
        query: async (query: string) => query.includes('schema_migrations') ? { rows: [{ present: true }] } : { rows: [] },
        release: () => undefined,
      };
    },
    end: async () => undefined,
  } as unknown as Pool;
  const oidcClient = { checkReady: async () => oidcAvailable } as unknown as OidcClient;
  const app = await buildGatewayApp({ pool, devCredentials: new Map(), approvalExpiryHours: 12, runtimeMode: 'production', oidcClient });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 503);
    databaseAvailable = true;
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 503);
    oidcAvailable = true;
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
  } finally { await app.close(); }
});

test('authentication failures are bounded per privacy-preserving source and credential bucket', async () => {
  let response;
  for (let attempt = 0; attempt < 21; attempt += 1) {
    response = await context.app.inject({ method: 'GET', url: '/v1/actions', headers: { 'x-fiar-dev-credential': 'same-invalid-credential' } });
  }
  assert.equal(response?.statusCode, 429);
  assert.deepEqual(response?.json(), { error: 'RATE_LIMITED', message: 'Authentication temporarily unavailable' });
});

test('generic OIDC client verifies discovery, PKCE, JWKS, nonce, mapping, and creates a protected session', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const { privateKey: untrustedPrivateKey } = await generateKeyPair('RS256');
  const { privateKey: disallowedAlgorithmKey } = await generateKeyPair('RS512');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  let expectedNonce = '';
  let tokenMode: 'valid' | 'issuer' | 'audience' | 'algorithm' | 'signature' | 'expired' = 'valid';
  const server = createServer(async (request, response) => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.url === '/.well-known/openid-configuration') return json(response, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, code_challenge_methods_supported: ['S256'] });
    if (request.url === '/jwks') return json(response, { keys: [jwk] });
    if (request.url === '/token') {
      const algorithm = tokenMode === 'algorithm' ? 'RS512' : 'RS256';
      let builder = new SignJWT({ nonce: expectedNonce })
        .setProtectedHeader({ alg: algorithm, kid: 'test-key' })
        .setIssuer(tokenMode === 'issuer' ? `${base}/wrong` : base)
        .setAudience(tokenMode === 'audience' ? 'another-client' : 'fiar-client')
        .setSubject('manager-subject');
      builder = tokenMode === 'expired'
        ? builder.setIssuedAt(Math.floor(Date.now() / 1000) - 600).setExpirationTime(Math.floor(Date.now() / 1000) - 300)
        : builder.setIssuedAt().setExpirationTime('5m');
      const signingKey = tokenMode === 'signature' ? untrustedPrivateKey : tokenMode === 'algorithm' ? disallowedAlgorithmKey : privateKey;
      const token = await builder.sign(signingKey);
      return json(response, { id_token: token });
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await context.pool.query(`insert into human_identity_mappings (id, issuer, subject, tenant_id, principal_id, status) values ($1, $2, 'manager-subject', 'ten_demo_alpha', 'prn_demo_alpha_manager', 'active')`, [createId('him'), issuer]);
    const client = new OidcClient({ config: { issuer, clientId: 'fiar-client', audience: 'fiar-client', redirectUri: `${issuer}/callback`, dashboardUri: issuer, allowedAlgorithms: ['RS256'], clockSkewSeconds: 30 }, pool: context.pool, stateEncryptionKey: 'state-key', sessionPepper: 'session-pepper', clientSecret: null, sessionIdleSeconds: 1800, sessionAbsoluteSeconds: 28800 });
    await client.initialize();
    const authorizationStart = await client.begin(); const authorization = new URL(authorizationStart.authorizationUrl); expectedNonce = authorization.searchParams.get('nonce') ?? '';
    assert.equal(authorization.searchParams.get('redirect_uri'), `${issuer}/callback`);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    const result = await client.callback('valid-code', authorization.searchParams.get('state') ?? '', authorizationStart.browserBinding);
    assert.match(result.cookieToken, /^fiar_session_ses_/);
    assert.equal((await context.pool.query(`select count(*)::int as count from human_sessions where tenant_id = 'ten_demo_alpha' and status = 'active'`)).rows[0]?.count, 1);
    await assert.rejects(client.callback('valid-code', authorization.searchParams.get('state') ?? '', authorizationStart.browserBinding), /invalid/);
    const wrongNonceStart = await client.begin(); const wrongNonce = new URL(wrongNonceStart.authorizationUrl); expectedNonce = 'not-the-issued-nonce';
    await assert.rejects(client.callback('valid-code', wrongNonce.searchParams.get('state') ?? '', wrongNonceStart.browserBinding), /identity token is invalid/);
    for (const mode of ['issuer', 'audience', 'algorithm', 'signature', 'expired'] as const) {
      const invalidStart = await client.begin(); const invalid = new URL(invalidStart.authorizationUrl); expectedNonce = invalid.searchParams.get('nonce') ?? ''; tokenMode = mode;
      await assert.rejects(client.callback('valid-code', invalid.searchParams.get('state') ?? '', invalidStart.browserBinding));
    }
    tokenMode = 'valid';
    const stateStart = await client.begin(); const stateAttempt = new URL(stateStart.authorizationUrl); expectedNonce = stateAttempt.searchParams.get('nonce') ?? '';
    await assert.rejects(client.callback('valid-code', `${stateAttempt.searchParams.get('state') ?? ''}changed`, stateStart.browserBinding), /invalid/);
    const browserBound = await client.begin(); const browserBoundUrl = new URL(browserBound.authorizationUrl);
    await assert.rejects(client.callback('valid-code', browserBoundUrl.searchParams.get('state') ?? '', randomToken(32)), /invalid/);
    await context.pool.query(`update human_identity_mappings set status = 'revoked', revoked_at = now() where issuer = $1`, [issuer]);
    const unknownStart = await client.begin(); const unknown = new URL(unknownStart.authorizationUrl); expectedNonce = unknown.searchParams.get('nonce') ?? '';
    await assert.rejects(client.callback('valid-code', unknown.searchParams.get('state') ?? '', unknownStart.browserBinding), /not authorized/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

function json(response: import('node:http').ServerResponse, value: unknown): void { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); }
