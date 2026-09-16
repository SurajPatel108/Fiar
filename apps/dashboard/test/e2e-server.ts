import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { createCredential } from '../../gateway/src/admin-cli';
import { buildGatewayApp } from '../../gateway/src/app';
import { createDatabasePool } from '../../gateway/src/db';
import { OidcClient } from '../../gateway/src/oidc';
import { createId } from '../../../packages/shared/src/ids';
import { createGatewayTestContext } from '../../gateway/test/integration-support';

const publicOrigin = 'https://127.0.0.1:4210';
const issuer = 'http://127.0.0.1:4211';
const gatewayOrigin = 'http://127.0.0.1:4212';
const credentialPepper = 'e2e-credential-pepper';

const context = await createGatewayTestContext('fiar_phase6_browser');
const pool = createDatabasePool(context.databaseUrl);
const { privateKey, publicKey } = await generateKeyPair('RS256');
const { privateKey: untrustedPrivateKey } = await generateKeyPair('RS256');
const { privateKey: disallowedAlgorithmKey } = await generateKeyPair('RS512');
const jwk = await exportJWK(publicKey);
Object.assign(jwk, { kid: 'e2e-key', alg: 'RS256', use: 'sig' });
type OidcMode = 'manager' | 'agent' | 'error' | 'state' | 'expired_state' | 'nonce' | 'missing_nonce' | 'missing_claims' | 'invalid_code' | 'replayed_code' | 'issuer' | 'audience' | 'expired_token' | 'algorithm' | 'signature';
let mode: OidcMode = 'manager';
let lastCallback = '';
const codes = new Map<string, { nonce: string; challenge: string; used: boolean }>();

await pool.query(`insert into human_identity_mappings (id, issuer, subject, tenant_id, principal_id, status) values
  ($1, $3, 'manager-subject', 'ten_demo_alpha', 'prn_demo_alpha_manager', 'active'),
  ($2, $3, 'agent-subject', 'ten_demo_alpha', 'prn_demo_alpha_agent', 'active')`, [createId('him'), createId('him'), issuer]);

const fakeIssuer = createHttpServer(async (request, response) => {
  const url = new URL(request.url ?? '/', issuer);
  if (url.pathname === '/.well-known/openid-configuration') return sendJson(response, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, code_challenge_methods_supported: ['S256'] });
  if (url.pathname === '/jwks') return sendJson(response, { keys: [jwk] });
  if (url.pathname === '/authorize') {
    const state = url.searchParams.get('state'); const nonce = url.searchParams.get('nonce'); const challenge = url.searchParams.get('code_challenge');
    if (!state || !nonce || !challenge || url.searchParams.get('code_challenge_method') !== 'S256') return sendJson(response, { error: 'invalid_request' }, 400);
    const code = createId('cod'); codes.set(code, { nonce, challenge, used: mode === 'replayed_code' });
    if (mode === 'expired_state') await pool.query(`update oidc_login_attempts set created_at = now() - interval '1 day', expires_at = now() - interval '1 second' where state_verifier = $1`, [createHash('sha256').update(state).digest('hex')]);
    const returnedState = mode === 'state' ? `${state}tampered` : state;
    const returnedCode = mode === 'invalid_code' ? 'invalid-code' : code;
    lastCallback = `/v1/auth/oidc/callback?code=${encodeURIComponent(returnedCode)}&state=${encodeURIComponent(returnedState)}`;
    response.statusCode = 302; response.setHeader('location', `${publicOrigin}${lastCallback}`); response.end(); return;
  }
  if (url.pathname === '/token' && request.method === 'POST') {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const entry = codes.get(body.get('code') ?? '');
    const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
    if (!entry || entry.used || challenge !== entry.challenge || mode === 'error') return sendJson(response, { error: 'invalid_grant' }, 400);
    entry.used = true;
    const subject = mode === 'agent' ? 'agent-subject' : 'manager-subject';
    const algorithm = mode === 'algorithm' ? 'RS512' : 'RS256';
    let builder = new SignJWT(mode === 'missing_nonce' ? {} : { nonce: mode === 'nonce' ? 'wrong-nonce' : entry.nonce })
      .setProtectedHeader({ alg: algorithm, kid: 'e2e-key' })
      .setIssuer(mode === 'issuer' ? `${issuer}/wrong` : issuer)
      .setAudience(mode === 'audience' ? 'wrong-audience' : 'fiar-e2e')
      .setIssuedAt();
    builder = mode === 'expired_token' ? builder.setExpirationTime(Math.floor(Date.now() / 1000) - 60) : builder.setExpirationTime('5m');
    if (mode !== 'missing_claims') builder = builder.setSubject(subject);
    const token = await builder.sign(mode === 'signature' ? untrustedPrivateKey : mode === 'algorithm' ? disallowedAlgorithmKey : privateKey);
    return sendJson(response, { id_token: token });
  }
  if (url.pathname === '/control/mode') { const requested = url.searchParams.get('value') as OidcMode; mode = ['manager', 'agent', 'error', 'state', 'expired_state', 'nonce', 'missing_nonce', 'missing_claims', 'invalid_code', 'replayed_code', 'issuer', 'audience', 'expired_token', 'algorithm', 'signature'].includes(requested) ? requested : 'manager'; return sendJson(response, { mode }); }
  if (url.pathname === '/control/last-callback') return sendJson(response, { path: lastCallback });
  if (url.pathname === '/control/revoke') { await pool.query(`update human_sessions set status = 'revoked', revoked_at = now(), updated_at = now() where id = (select id from human_sessions order by created_at desc limit 1)`); return sendJson(response, { ok: true }); }
  if (url.pathname === '/control/expire') { await pool.query(`update human_sessions set created_at = now() - interval '1 day', absolute_expires_at = now() - interval '1 hour', idle_expires_at = now() - interval '1 hour' where id = (select id from human_sessions order by created_at desc limit 1)`); return sendJson(response, { ok: true }); }
  response.statusCode = 404; response.end();
});
await listen(fakeIssuer, 4211);

const oidcClient = new OidcClient({
  config: { issuer, clientId: 'fiar-e2e', audience: 'fiar-e2e', redirectUri: `${publicOrigin}/v1/auth/oidc/callback`, dashboardUri: publicOrigin, allowedAlgorithms: ['RS256'], clockSkewSeconds: 30 },
  pool, stateEncryptionKey: 'e2e-state-encryption-key', sessionPepper: 'e2e-session-pepper', clientSecret: null,
  sessionIdleSeconds: 1800, sessionAbsoluteSeconds: 28800,
});
await oidcClient.initialize();
const gateway = await buildGatewayApp({
  pool, devCredentials: new Map(), approvalExpiryHours: 12, runtimeMode: 'production', credentialPepper,
  sessionPepper: 'e2e-session-pepper', csrfSecret: 'e2e-csrf-key', metricsSecret: 'e2e-metrics',
  publicOrigin, allowedHost: '127.0.0.1:4210', sessionIdleSeconds: 1800, oidcClient,
});
await gateway.listen({ host: '127.0.0.1', port: 4212 });

const workload = await createCredential(pool, 'ten_demo_alpha', 'prn_demo_alpha_agent', new Date(Date.now() + 86_400_000), credentialPepper);
await fetch(`${gatewayOrigin}/v1/actions`, {
  method: 'POST', headers: { authorization: `Bearer ${workload}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-pending-approval' },
  body: JSON.stringify({ tool: 'refund.create', orderId: 'ord_demo_small', amountMinor: 6000, currency: 'USD', idempotencyKey: 'e2e-pending-approval' }),
});

const certificateDirectory = await mkdtemp(join(tmpdir(), 'fiar-e2e-cert-'));
const keyPath = join(certificateDirectory, 'key.pem'); const certificatePath = join(certificateDirectory, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certificatePath, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const dashboardRoot = resolve('apps/dashboard/dist');
const front = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, async (request, response) => {
  const url = new URL(request.url ?? '/', publicOrigin);
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/health/') || url.pathname === '/metrics') { proxy(request, response); return; }
  const relative = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^\/+/, '');
  const file = resolve(dashboardRoot, relative);
  if (!file.startsWith(`${dashboardRoot}/`)) { response.statusCode = 404; response.end(); return; }
  try {
    const content = await readFile(file);
    response.statusCode = 200;
    response.setHeader('content-type', mime(extname(file)));
    response.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('x-frame-options', 'DENY'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer');
    response.end(content);
  } catch { response.statusCode = 404; response.end(); }
});
await listen(front, 4210);

function proxy(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void {
  const upstream = httpRequest({ hostname: '127.0.0.1', port: 4212, path: request.url, method: request.method, headers: { ...request.headers, host: '127.0.0.1:4210' } }, (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
  });
  upstream.on('error', () => { response.statusCode = 502; response.end(); }); request.pipe(upstream);
}

function sendJson(response: import('node:http').ServerResponse, value: unknown, status = 200): void { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); }
function listen(server: import('node:http').Server | import('node:https').Server, port: number): Promise<void> { return new Promise((resolveListen) => server.listen(port, '127.0.0.1', resolveListen)); }
function mime(extension: string): string { return extension === '.html' ? 'text/html; charset=utf-8' : extension === '.js' ? 'text/javascript; charset=utf-8' : extension === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream'; }

async function shutdown(): Promise<void> {
  await new Promise<void>((resolveClose) => front.close(() => resolveClose()));
  await gateway.close();
  await new Promise<void>((resolveClose) => fakeIssuer.close(() => resolveClose()));
  await context.cleanup();
}
process.once('SIGTERM', () => { void shutdown().finally(() => { process.exitCode = 0; }); });
process.once('SIGINT', () => { void shutdown().finally(() => { process.exitCode = 0; }); });
