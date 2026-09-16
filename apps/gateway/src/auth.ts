import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import { DomainError } from '../../../packages/shared/src/errors';
import { hmacSha256, timingSafeHexEqual } from '../../../packages/shared/src/secure-values';
import type { RuntimeMode } from '../../../packages/shared/src/runtime';

export interface DevCredentialRecord { token: string; principalId: string }
export interface AuthenticatedPrincipal {
  tenantId: string;
  principalId: string;
  principalType: 'agent' | 'manager' | 'admin' | 'service';
  permissions: readonly ActionPermission[];
  authenticationKind?: 'development' | 'workload' | 'session';
  sessionId?: string;
}
export type ActionPermission = 'actions:create' | 'actions:read' | 'approvals:read' | 'approvals:decide';
export type DevCredentialDirectory = ReadonlyMap<string, string>;
export interface AuthenticationOptions {
  runtimeMode: RuntimeMode;
  devCredentials: DevCredentialDirectory;
  credentialPepper?: string;
  sessionPepper?: string;
  sessionIdleSeconds?: number;
}

export function assertDevelopmentAuthenticationAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.FIAR_RUNTIME_MODE !== 'development') throw new Error('The development credential adapter requires FIAR_RUNTIME_MODE=development');
}

export function loadDevCredentialDirectory(env: NodeJS.ProcessEnv = process.env): DevCredentialDirectory {
  const raw = env.FIAR_DEV_CREDENTIALS_JSON;
  if (!raw) return new Map();
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error('FIAR_DEV_CREDENTIALS_JSON must contain valid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('FIAR_DEV_CREDENTIALS_JSON must be an array');
  const credentials = new Map<string, string>();
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Invalid dev credential entry');
    const token = (entry as Record<string, unknown>).token;
    const principalId = (entry as Record<string, unknown>).principalId;
    if (typeof token !== 'string' || token.length === 0 || token.length > 512 || typeof principalId !== 'string' || principalId.length === 0) throw new Error('Invalid dev credential entry');
    if (credentials.has(token)) throw new Error('FIAR_DEV_CREDENTIALS_JSON contains a duplicate token');
    credentials.set(token, principalId);
  }
  return credentials;
}

export async function authenticateRequest(request: FastifyRequest, pool: Pool, options: AuthenticationOptions): Promise<AuthenticatedPrincipal> {
  const devHeader = singleHeader(request.headers['x-fiar-dev-credential']);
  if (options.runtimeMode === 'production' && devHeader) throw unauthorized('MALFORMED');
  if (devHeader && options.runtimeMode !== 'production') return authenticateDevelopment(pool, options.devCredentials, devHeader);
  const authorization = singleHeader(request.headers.authorization);
  if (authorization) {
    if (!options.credentialPepper) throw unauthorized();
    return authenticateWorkload(pool, authorization, options.credentialPepper);
  }
  const sessionToken = readCookie(singleHeader(request.headers.cookie), '__Host-fiar_session');
  if (sessionToken) {
    if (!options.sessionPepper) throw unauthorized();
    return authenticateSession(pool, sessionToken, options.sessionPepper, options.sessionIdleSeconds ?? 1800);
  }
  throw unauthorized();
}

async function authenticateDevelopment(pool: Pool, credentials: DevCredentialDirectory, token: string): Promise<AuthenticatedPrincipal> {
  const principalId = credentials.get(token);
  if (!principalId) throw unauthorized('INVALID');
  return loadActivePrincipal(pool, principalId, 'development');
}

async function authenticateWorkload(pool: Pool, authorization: string, pepper: string): Promise<AuthenticatedPrincipal> {
  if (authorization.length > 256 || !authorization.startsWith('Bearer ')) throw unauthorized('MALFORMED');
  const match = /^fiar_(wcr_[0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/.exec(authorization.slice(7));
  if (!match?.[1] || !match[2]) throw unauthorized('MALFORMED');
  const result = await pool.query<{ id: string; verifier: string; status: string; expires_at: Date | string; principal_id: string; principal_type: AuthenticatedPrincipal['principalType']; principal_status: string; tenant_id: string; tenant_status: string }>(`
    select c.id, c.verifier, c.status, c.expires_at, p.id as principal_id, p.type as principal_type,
           p.status as principal_status, t.id as tenant_id, t.status as tenant_status
    from workload_credentials c join principals p on p.id = c.principal_id and p.tenant_id = c.tenant_id
    join tenants t on t.id = c.tenant_id where c.id = $1 limit 1
  `, [match[1]]);
  const row = result.rows[0];
  const candidate = hmacSha256(match[2], pepper);
  const verifierMatches = timingSafeHexEqual(candidate, row?.verifier ?? hmacSha256('unknown-workload-credential', pepper));
  if (!row || !verifierMatches) throw unauthorized('INVALID');
  if (row.status !== 'active') throw unauthorized('REVOKED');
  if (new Date(row.expires_at).getTime() <= Date.now()) throw unauthorized('EXPIRED');
  if (!['agent', 'service'].includes(row.principal_type) || row.principal_status !== 'active' || row.tenant_status !== 'active') throw new DomainError('FORBIDDEN', 'Credential is not authorized');
  void pool.query(`update workload_credentials set last_used_at = now(), updated_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')`, [row.id]).catch(() => undefined);
  return principal(row, 'workload');
}

async function authenticateSession(pool: Pool, token: string, pepper: string, idleSeconds: number): Promise<AuthenticatedPrincipal> {
  if (token.length > 256) throw unauthorized('MALFORMED');
  const match = /^fiar_session_(ses_[0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match?.[1] || !match[2]) throw unauthorized('MALFORMED');
  const result = await pool.query<{ id: string; token_verifier: string; status: string; absolute_expires_at: Date | string; idle_expires_at: Date | string; principal_id: string; principal_type: AuthenticatedPrincipal['principalType']; principal_status: string; tenant_id: string; tenant_status: string }>(`
    select s.id, s.token_verifier, s.status, s.absolute_expires_at, s.idle_expires_at,
           p.id as principal_id, p.type as principal_type, p.status as principal_status,
           t.id as tenant_id, t.status as tenant_status
    from human_sessions s join principals p on p.id = s.principal_id and p.tenant_id = s.tenant_id
    join tenants t on t.id = s.tenant_id where s.id = $1 limit 1
  `, [match[1]]);
  const row = result.rows[0];
  const now = Date.now();
  const verifierMatches = timingSafeHexEqual(hmacSha256(match[2], pepper), row?.token_verifier ?? hmacSha256('unknown-human-session', pepper));
  if (!row || !verifierMatches) throw unauthorized('INVALID');
  if (row.status !== 'active') throw unauthorized('REVOKED');
  if (new Date(row.absolute_expires_at).getTime() <= now || new Date(row.idle_expires_at).getTime() <= now) throw unauthorized('EXPIRED');
  if (!['manager', 'admin'].includes(row.principal_type) || row.principal_status !== 'active' || row.tenant_status !== 'active') throw new DomainError('FORBIDDEN', 'Session is not authorized');
  await pool.query(`update human_sessions set last_seen_at = now(), idle_expires_at = least(absolute_expires_at, now() + make_interval(secs => $2)), updated_at = now() where id = $1`, [row.id, idleSeconds]);
  return { ...principal(row, 'session'), sessionId: row.id };
}

async function loadActivePrincipal(pool: Pool, principalId: string, kind: 'development'): Promise<AuthenticatedPrincipal> {
  const result = await pool.query<{ principal_id: string; principal_type: AuthenticatedPrincipal['principalType']; principal_status: string; tenant_id: string; tenant_status: string }>(`
    select p.id as principal_id, p.type as principal_type, p.status as principal_status, t.id as tenant_id, t.status as tenant_status
    from principals p join tenants t on t.id = p.tenant_id where p.id = $1 limit 1
  `, [principalId]);
  const row = result.rows[0];
  if (!row) throw unauthorized();
  if (row.principal_status !== 'active' || row.tenant_status !== 'active') throw new DomainError('FORBIDDEN', 'Credential is not authorized');
  return principal(row, kind);
}

function principal(row: { principal_id: string; tenant_id: string; principal_type: AuthenticatedPrincipal['principalType'] }, kind: NonNullable<AuthenticatedPrincipal['authenticationKind']>): AuthenticatedPrincipal {
  return { principalId: row.principal_id, tenantId: row.tenant_id, principalType: row.principal_type, permissions: permissionsForPrincipalType(row.principal_type), authenticationKind: kind };
}
function singleHeader(value: string | string[] | undefined): string | null { return typeof value === 'string' ? value : Array.isArray(value) && value.length === 1 ? value[0] ?? null : null; }
export function readCookie(header: string | null, name: string): string | null {
  if (!header || header.length > 4096) return null;
  for (const part of header.split(';')) { const [key, ...rest] = part.trim().split('='); if (key === name) return rest.join('='); }
  return null;
}
function unauthorized(category: 'INVALID' | 'MALFORMED' | 'EXPIRED' | 'REVOKED' = 'INVALID'): DomainError {
  return new DomainError('UNAUTHORIZED', 'Authentication required', { authenticationCategory: category });
}
export function permissionsForPrincipalType(type: AuthenticatedPrincipal['principalType']): readonly ActionPermission[] {
  switch (type) { case 'agent': case 'service': return ['actions:create', 'actions:read']; case 'manager': case 'admin': return ['actions:read', 'approvals:read', 'approvals:decide']; }
}
export function requirePermission(value: AuthenticatedPrincipal, permission: ActionPermission): void {
  if (!value.permissions.includes(permission)) throw new DomainError('FORBIDDEN', 'Credential is not permitted to perform this operation');
}
