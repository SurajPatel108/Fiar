import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import { DomainError } from '../../../packages/shared/src/errors';

export interface DevCredentialRecord {
  token: string;
  principalId: string;
}

export interface AuthenticatedPrincipal {
  tenantId: string;
  principalId: string;
  principalType: 'agent' | 'manager' | 'admin' | 'service';
  permissions: readonly ActionPermission[];
}

export type ActionPermission = 'actions:create' | 'actions:read' | 'approvals:read' | 'approvals:decide';

export type DevCredentialDirectory = ReadonlyMap<string, string>;

export function assertDevelopmentAuthenticationAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.FIAR_RUNTIME_MODE !== 'development') {
    throw new Error('The development credential adapter requires FIAR_RUNTIME_MODE=development');
  }
}

export function loadDevCredentialDirectory(env: NodeJS.ProcessEnv = process.env): DevCredentialDirectory {
  const raw = env.FIAR_DEV_CREDENTIALS_JSON;
  if (!raw) {
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('FIAR_DEV_CREDENTIALS_JSON must contain valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('FIAR_DEV_CREDENTIALS_JSON must be an array');
  }

  const credentials = new Map<string, string>();
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Invalid dev credential entry');
    }

    const token = (entry as Record<string, unknown>).token;
    const principalId = (entry as Record<string, unknown>).principalId;
    if (typeof token !== 'string' || token.length === 0 || typeof principalId !== 'string' || principalId.length === 0) {
      throw new Error('Invalid dev credential entry');
    }

    if (credentials.has(token)) {
      throw new Error('FIAR_DEV_CREDENTIALS_JSON contains a duplicate token');
    }

    credentials.set(token, principalId);
  }

  return credentials;
}

function readCredentialToken(request: FastifyRequest): string | null {
  const header = request.headers['x-fiar-dev-credential'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }

  if (Array.isArray(header) && header[0]) {
    return header[0];
  }

  return null;
}

export async function authenticateRequest(
  request: FastifyRequest,
  pool: Pool,
  credentials: DevCredentialDirectory,
): Promise<AuthenticatedPrincipal> {
  const token = readCredentialToken(request);
  if (!token) {
    throw new DomainError('UNAUTHORIZED', 'Missing development credential');
  }

  const principalId = credentials.get(token);
  if (!principalId) {
    throw new DomainError('UNAUTHORIZED', 'Invalid development credential');
  }

  const result = await pool.query<{
    principal_id: string;
    principal_type: AuthenticatedPrincipal['principalType'];
    principal_status: string;
    tenant_id: string;
    tenant_status: string;
  }>(
    `
      select
        p.id as principal_id,
        p.type as principal_type,
        p.status as principal_status,
        t.id as tenant_id,
        t.status as tenant_status
      from principals p
      join tenants t on t.id = p.tenant_id
      where p.id = $1
      limit 1
    `,
    [principalId],
  );

  if (result.rowCount === 0) {
    throw new DomainError('UNAUTHORIZED', 'Invalid development credential');
  }

  const row = result.rows[0];
  if (!row) {
    throw new DomainError('UNAUTHORIZED', 'Invalid development credential');
  }

  if (row.principal_status !== 'active' || row.tenant_status !== 'active') {
    throw new DomainError('FORBIDDEN', 'Credential is suspended');
  }

  return {
    principalId: row.principal_id,
    tenantId: row.tenant_id,
    principalType: row.principal_type,
    permissions: permissionsForPrincipalType(row.principal_type),
  };
}

function permissionsForPrincipalType(principalType: AuthenticatedPrincipal['principalType']): readonly ActionPermission[] {
  switch (principalType) {
    case 'agent':
    case 'service':
      return ['actions:create', 'actions:read'];
    case 'manager':
    case 'admin':
      return ['actions:read', 'approvals:read', 'approvals:decide'];
  }
}

export function requirePermission(principal: AuthenticatedPrincipal, permission: ActionPermission): void {
  if (!principal.permissions.includes(permission)) {
    throw new DomainError('FORBIDDEN', 'Credential is not permitted to perform this operation');
  }
}
