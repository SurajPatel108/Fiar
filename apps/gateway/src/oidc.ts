import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { createId } from '../../../packages/shared/src/ids';
import { decryptValue, encryptValue, hmacSha256, randomToken, sha256, timingSafeHexEqual } from '../../../packages/shared/src/secure-values';
import type { OidcConfig } from './config';
import { insertSecurityAuditEvent } from './security-audit';
import { withTransaction } from './db';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  code_challenge_methods_supported?: string[];
}
interface AttemptRow {
  nonce_verifier: string;
  pkce_verifier_ciphertext: string;
  pkce_verifier_iv: string;
  pkce_verifier_tag: string;
}

export interface OidcClientOptions {
  config: OidcConfig;
  pool: Pool;
  stateEncryptionKey: string;
  sessionPepper: string;
  clientSecret: string | null;
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  fetchImplementation?: typeof fetch;
}

export class OidcClient {
  private discovery: Discovery | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  constructor(private readonly options: OidcClientOptions) {}

  async initialize(): Promise<void> {
    const fetcher = this.options.fetchImplementation ?? fetch;
    const response = await fetcher(`${this.options.config.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('OIDC discovery is unavailable');
    const value = await response.json() as Partial<Discovery>;
    if (value.issuer !== this.options.config.issuer || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) throw new Error('OIDC discovery response is invalid');
    for (const endpoint of [value.authorization_endpoint, value.token_endpoint, value.jwks_uri]) {
      const url = new URL(endpoint);
      if (this.options.config.issuer.startsWith('https:') && url.protocol !== 'https:') throw new Error('OIDC endpoint must use HTTPS');
    }
    if (value.code_challenge_methods_supported && !value.code_challenge_methods_supported.includes('S256')) throw new Error('OIDC provider does not support PKCE S256');
    this.discovery = value as Discovery;
    this.jwks = createRemoteJWKSet(new URL(value.jwks_uri));
  }

  isReady(): boolean { return this.discovery !== null && this.jwks !== null; }
  async checkReady(): Promise<boolean> {
    if (this.isReady()) return true;
    try { await this.initialize(); return true; } catch { return false; }
  }

  async begin(): Promise<string> {
    if (!this.discovery) throw new Error('OIDC authentication is not initialized');
    const id = createId('oid');
    const state = randomToken(32);
    const nonce = randomToken(32);
    const verifier = randomToken(32);
    const challenge = Buffer.from(sha256Buffer(verifier)).toString('base64url');
    const encrypted = encryptValue(verifier, this.options.stateEncryptionKey);
    await this.options.pool.query(`
      insert into oidc_login_attempts (
        id, state_verifier, nonce_verifier, pkce_verifier_ciphertext,
        pkce_verifier_iv, pkce_verifier_tag, expires_at
      ) values ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')
    `, [id, sha256(state), sha256(nonce), encrypted.ciphertext, encrypted.iv, encrypted.tag]);
    const url = new URL(this.discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: this.options.config.clientId,
      redirect_uri: this.options.config.redirectUri, scope: 'openid', state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async callback(code: string, state: string): Promise<{ cookieToken: string; expiresAt: Date }> {
    if (!this.discovery || !this.jwks || code.length > 4096 || state.length > 256) throw new Error('OIDC callback is invalid');
    const consumed = await this.options.pool.query<AttemptRow>(`
      update oidc_login_attempts set consumed_at = now()
      where state_verifier = $1 and consumed_at is null and expires_at > now()
      returning nonce_verifier, pkce_verifier_ciphertext, pkce_verifier_iv, pkce_verifier_tag
    `, [sha256(state)]);
    const attempt = consumed.rows[0];
    if (!attempt) throw new Error('OIDC callback is invalid');
    const verifier = decryptValue({ ciphertext: attempt.pkce_verifier_ciphertext, iv: attempt.pkce_verifier_iv, tag: attempt.pkce_verifier_tag }, this.options.stateEncryptionKey);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.options.config.redirectUri, client_id: this.options.config.clientId, code_verifier: verifier });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (this.options.clientSecret) headers.authorization = `Basic ${Buffer.from(`${this.options.config.clientId}:${this.options.clientSecret}`).toString('base64')}`;
    const response = await (this.options.fetchImplementation ?? fetch)(this.discovery.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('OIDC token exchange failed');
    const tokenResponse = await response.json() as { id_token?: unknown };
    if (typeof tokenResponse.id_token !== 'string' || tokenResponse.id_token.length > 20_000) throw new Error('OIDC token response is invalid');
    const verified = await jwtVerify(tokenResponse.id_token, this.jwks, {
      issuer: this.options.config.issuer,
      audience: this.options.config.audience,
      algorithms: [...this.options.config.allowedAlgorithms],
      clockTolerance: this.options.config.clockSkewSeconds,
    });
    if (typeof verified.payload.sub !== 'string' || typeof verified.payload.nonce !== 'string' || !timingSafeHexEqual(sha256(verified.payload.nonce), attempt.nonce_verifier)) throw new Error('OIDC identity token is invalid');
    const mapping = await this.options.pool.query<{ mapping_id: string; tenant_id: string; principal_id: string; principal_type: string; principal_status: string; tenant_status: string }>(`
      select m.id as mapping_id, m.tenant_id, m.principal_id, p.type as principal_type,
             p.status as principal_status, t.status as tenant_status
      from human_identity_mappings m
      join principals p on p.id = m.principal_id and p.tenant_id = m.tenant_id
      join tenants t on t.id = m.tenant_id
      where m.issuer = $1 and m.subject = $2 and m.status = 'active' limit 1
    `, [this.options.config.issuer, verified.payload.sub]);
    const identity = mapping.rows[0];
    if (!identity || !['manager', 'admin'].includes(identity.principal_type) || identity.principal_status !== 'active' || identity.tenant_status !== 'active') throw new Error('OIDC identity is not authorized');
    const sessionId = createId('ses');
    const sessionSecret = randomToken(32);
    const expiresAt = new Date(Date.now() + this.options.sessionAbsoluteSeconds * 1000);
    const idleAt = new Date(Math.min(expiresAt.getTime(), Date.now() + this.options.sessionIdleSeconds * 1000));
    await withTransaction(this.options.pool, async (client) => {
      await client.query(`
        insert into human_sessions (
          id, tenant_id, principal_id, token_verifier, status, absolute_expires_at, idle_expires_at
        ) values ($1, $2, $3, $4, 'active', $5, $6)
      `, [sessionId, identity.tenant_id, identity.principal_id, hmacSha256(sessionSecret, this.options.sessionPepper), expiresAt, idleAt]);
      await insertSecurityAuditEvent(client, {
        tenantId: identity.tenant_id, principalId: identity.principal_id, eventType: 'session.created',
        outcome: 'CREATED', reason: 'OIDC_LOGIN', correlationId: randomUUID(),
        payload: { principalType: identity.principal_type },
      });
      await insertSecurityAuditEvent(client, {
        tenantId: identity.tenant_id, principalId: identity.principal_id, eventType: 'oidc.succeeded',
        outcome: 'SUCCEEDED', reason: 'VERIFIED_IDENTITY', correlationId: randomUUID(),
        payload: { mappingId: identity.mapping_id, principalType: identity.principal_type },
      });
    });
    return { cookieToken: `fiar_session_${sessionId}_${sessionSecret}`, expiresAt };
  }
}

function sha256Buffer(value: string): Buffer {
  return Buffer.from(sha256(value), 'hex');
}
