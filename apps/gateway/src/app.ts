import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import { authenticateRequest, requirePermission, type AuthenticatedPrincipal, type DevCredentialDirectory } from './auth';
import { createAction, getActionById, listActions } from './actions';
import {
  decideApproval,
  getApprovalById,
  listApprovals,
  parseApprovalDecision,
  parseApprovalListQuery,
} from './approvals';
import { DomainError } from '../../../packages/shared/src/errors';
import { mapDomainErrorToStatusCode, toHttpErrorPayload } from './errors';
import type { RuntimeMode } from '../../../packages/shared/src/runtime';
import { sha256, timingSafeHexEqual } from '../../../packages/shared/src/secure-values';
import { checkDatabaseReady } from './db';
import { createCsrfToken, verifyCsrfToken } from './csrf';
import type { OidcClient } from './oidc';
import { OperationalMetrics } from './metrics';
import { insertSecurityAuditEvent } from './security-audit';

export interface GatewayAppOptions {
  pool: Pool;
  devCredentials: DevCredentialDirectory;
  approvalExpiryHours: number;
  runtimeMode?: RuntimeMode;
  credentialPepper?: string;
  sessionPepper?: string;
  csrfSecret?: string;
  metricsSecret?: string;
  publicOrigin?: string;
  allowedHost?: string;
  sessionIdleSeconds?: number;
  oidcClient?: OidcClient;
  metrics?: OperationalMetrics;
  testHooks?: {
    failAfterPersist?: boolean;
    failAfterApprovalDecisionPersist?: boolean;
  };
}

class AuthenticationFailureLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  check(key: string, now = Date.now()): void {
    const current = this.failures.get(key);
    if (current && current.resetAt > now && current.count >= 20) throw new DomainError('RATE_LIMITED', 'Authentication temporarily unavailable');
  }
  fail(key: string, now = Date.now()): void {
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value as string);
    const current = this.failures.get(key);
    this.failures.set(key, !current || current.resetAt <= now ? { count: 1, resetAt: now + 300_000 } : { ...current, count: current.count + 1 });
  }
}

function parseListLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const numericValue = Number(value);
  if (!Number.isSafeInteger(numericValue) || numericValue < 1 || numericValue > 100) {
    throw new DomainError('INVALID_REQUEST', 'limit must be between 1 and 100');
  }

  return numericValue;
}

function parseStatusFilter(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new DomainError('INVALID_REQUEST', 'status must be a string');
  }

  const allowedStatuses = new Set([
    'pending',
    'denied',
    'awaiting_approval',
    'approved',
    'queued',
    'dispatched',
    'pending_reconciliation',
    'completed',
    'failed',
    'expired',
    'canceled',
    'suspended',
  ]);

  if (!allowedStatuses.has(value)) {
    throw new DomainError('INVALID_REQUEST', 'Invalid action status filter');
  }

  return value;
}

function parseListQuery(value: unknown): Parameters<typeof listActions>[2] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_REQUEST', 'Invalid list query');
  }

  const query = value as Record<string, unknown>;
  const allowedKeys = new Set(['limit', 'cursor', 'status']);
  if (Object.keys(query).some((key) => !allowedKeys.has(key))) {
    throw new DomainError('INVALID_REQUEST', 'Invalid list query');
  }

  if (query.cursor !== undefined && typeof query.cursor !== 'string') {
    throw new DomainError('INVALID_REQUEST', 'cursor must be a string');
  }

  const parsed: Parameters<typeof listActions>[2] = {
    cursor: typeof query.cursor === 'string' ? query.cursor : null,
    status: parseStatusFilter(query.status),
  };
  const limit = parseListLimit(query.limit);
  if (limit !== undefined) {
    parsed.limit = limit;
  }

  return parsed;
}

async function callSafely(reply: FastifyReply, handler: () => Promise<void>): Promise<void> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof DomainError) {
      reply.code(mapDomainErrorToStatusCode(error)).send(toHttpErrorPayload(error));
      return undefined;
    }

    if (error instanceof TypeError) {
      reply.code(400).send(toHttpErrorPayload(error));
      return undefined;
    }

    reply.code(500).send(toHttpErrorPayload(error));
    return undefined;
  }
}

export async function buildGatewayApp(options: GatewayAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const runtimeMode = options.runtimeMode ?? 'test';
  const metrics = options.metrics ?? new OperationalMetrics();
  const failureLimiter = new AuthenticationFailureLimiter();
  const publicOrigin = options.publicOrigin ?? 'http://127.0.0.1:5173';
  const allowedHost = options.allowedHost ?? new URL(publicOrigin).host;
  const authenticate = async (request: FastifyRequest): Promise<AuthenticatedPrincipal> => {
    const key = authenticationBucket(request);
    failureLimiter.check(key);
    try {
      return await authenticateRequest(request, options.pool, {
        runtimeMode,
        devCredentials: options.devCredentials,
        ...(options.credentialPepper ? { credentialPepper: options.credentialPepper } : {}),
        ...(options.sessionPepper ? { sessionPepper: options.sessionPepper } : {}),
        ...(options.sessionIdleSeconds ? { sessionIdleSeconds: options.sessionIdleSeconds } : {}),
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'UNAUTHORIZED') {
        const category = authenticationFailureCategory(error.details?.authenticationCategory);
        failureLimiter.fail(key);
        metrics.increment('authentication_failures_total', { category, channel: 'REQUEST' });
        void insertSecurityAuditEvent(options.pool, {
          eventType: 'authentication.failed', outcome: 'DENIED', reason: `${category}_AUTHENTICATION`,
          correlationId: request.id, payload: { channel: 'REQUEST', category },
        }).catch(() => undefined);
      }
      throw error;
    }
  };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    return payload;
  });

  app.addHook('onClose', async () => {
    if (typeof options.pool.end === 'function') {
      await options.pool.end();
    }
  });

  app.get('/health/live', async (_request, reply) => {
    reply.code(200).send({ status: 'live' });
  });

  app.get('/health/ready', async (_request, reply) => {
    const database = await checkDatabaseReady(options.pool);
    const authentication = runtimeMode !== 'production' || (options.oidcClient ? await options.oidcClient.checkReady() : false);
    const ready = database && authentication;
    reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', components: { database: database ? 'ready' : 'unavailable', authentication: authentication ? 'ready' : 'unavailable' } });
  });

  app.get('/metrics', async (request, reply) => {
    const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!options.metricsSecret || !timingSafeHexEqual(sha256(supplied), sha256(options.metricsSecret))) {
      reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }
    reply.type('text/plain; version=0.0.4').send(await metrics.render(options.pool));
  });

  app.get('/v1/auth/oidc/start', async (_request, reply) => {
    if (!options.oidcClient || !(await options.oidcClient.checkReady())) { reply.code(503).send({ error: 'UNAVAILABLE', message: 'Authentication unavailable' }); return; }
    reply.redirect(await options.oidcClient.begin());
  });

  app.get('/v1/auth/oidc/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (typeof query.code !== 'string' || typeof query.state !== 'string') { reply.code(400).send({ error: 'INVALID_REQUEST', message: 'Invalid authentication callback' }); return; }
    try {
      const session = await options.oidcClient?.callback(query.code, query.state);
      if (!session) throw new Error('OIDC unavailable');
      reply.header('set-cookie', sessionCookie(session.cookieToken, session.expiresAt, runtimeMode === 'production'));
      reply.redirect(publicOrigin);
    } catch {
      void insertSecurityAuditEvent(options.pool, { eventType: 'oidc.failed', outcome: 'DENIED', reason: 'OIDC_VALIDATION_FAILED', correlationId: request.id }).catch(() => undefined);
      reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authentication failed' });
    }
  });

  app.get('/v1/auth/session', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticate(request);
      if (principal.authenticationKind !== 'session' || !principal.sessionId || !options.csrfSecret) throw new DomainError('UNAUTHORIZED', 'Authentication required');
      reply.code(200).send({ authenticated: true, principalType: principal.principalType, csrfToken: createCsrfToken(principal.sessionId, options.csrfSecret) });
    });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticate(request);
      enforceBrowserMutation(request, principal, options.csrfSecret, publicOrigin, allowedHost);
      await options.pool.query(`update human_sessions set status = 'revoked', revoked_at = now(), updated_at = now() where id = $1 and status = 'active'`, [principal.sessionId]);
      await insertSecurityAuditEvent(options.pool, { tenantId: principal.tenantId, principalId: principal.principalId, eventType: 'session.revoked', outcome: 'REVOKED', reason: 'LOGOUT', correlationId: request.id });
      reply.header('set-cookie', clearSessionCookie(runtimeMode === 'production')).code(204).send();
    });
  });

  app.post('/v1/actions', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticate(request);
      requirePermission(principal, 'actions:create');
      const createOptions: Parameters<typeof createAction>[3] = { approvalExpiryHours: options.approvalExpiryHours };
      if (options.testHooks?.failAfterPersist) {
        createOptions.testFailAfterPersist = true;
      }

      const result = await createAction(options.pool, principal, request.body, createOptions);
      metrics.increment('action_decisions_total', { decision: result.action.decision });
      if (result.action.decision === 'DENY') metrics.increment('action_denials_total', { reason: boundedPolicyReason(result.action.reason) });
      if (result.httpStatus === 200) metrics.increment('idempotency_preventions_total', { layer: 'ACTION' });
      reply.code(result.httpStatus).send(result.action);
    });
  });

  app.get('/v1/actions/:id', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticate(request);
      requirePermission(principal, 'actions:read');
      const action = await getActionById(options.pool, principal, (request.params as { id: string }).id);
      reply.code(200).send(action);
    });
  });

  app.get('/v1/actions', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticate(request);
      requirePermission(principal, 'actions:read');
      const page = await listActions(options.pool, principal, parseListQuery(request.query));
      reply.code(200).send(page);
    });
  });

  app.get('/v1/approvals', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticate(request);
      requirePermission(principal, 'approvals:read');
      const page = await listApprovals(options.pool, principal, parseApprovalListQuery(request.query));
      reply.code(200).send(page);
    });
  });

  app.get('/v1/approvals/:id', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticate(request);
      requirePermission(principal, 'approvals:read');
      const approval = await getApprovalById(
        options.pool,
        principal,
        (request.params as { id: string }).id,
      );
      reply.code(200).send(approval);
    });
  });

  app.post('/v1/approvals/:id/decision', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticate(request);
      requirePermission(principal, 'approvals:decide');
      if (principal.authenticationKind === 'session') enforceBrowserMutation(request, principal, options.csrfSecret, publicOrigin, allowedHost);
      let approval;
      try {
        approval = await decideApproval(
          options.pool,
          principal,
          (request.params as { id: string }).id,
          parseApprovalDecision(request.body),
          { testFailAfterDecisionPersist: options.testHooks?.failAfterApprovalDecisionPersist ?? false },
        );
      } catch (error) {
        if (error instanceof DomainError && error.code === 'CONFLICT') metrics.increment('approval_conflicts_total', { category: 'STALE_OR_RESOLVED' });
        throw error;
      }
      metrics.increment('approval_outcomes_total', { outcome: approval.status.toUpperCase() });
      reply.code(200).send(approval);
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      reply.code(mapDomainErrorToStatusCode(error)).send(toHttpErrorPayload(error));
      return;
    }

    if (error instanceof TypeError) {
      reply.code(400).send(toHttpErrorPayload(error));
      return;
    }

    reply.code(500).send(toHttpErrorPayload(error));
  });

  return app;
}

function authenticationFailureCategory(value: unknown): 'INVALID' | 'MALFORMED' | 'EXPIRED' | 'REVOKED' {
  return value === 'MALFORMED' || value === 'EXPIRED' || value === 'REVOKED' ? value : 'INVALID';
}

function authenticationBucket(request: FastifyRequest): string {
  const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
  const cookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : '';
  const development = typeof request.headers['x-fiar-dev-credential'] === 'string' ? request.headers['x-fiar-dev-credential'] : '';
  const workloadId = /Bearer fiar_(wcr_[0-9a-f-]{36})_/.exec(authorization)?.[1];
  const sessionId = /(?:^|;\s*)__Host-fiar_session=fiar_session_(ses_[0-9a-f-]{36})_/.exec(cookie)?.[1];
  const hint = workloadId ?? sessionId ?? (development ? sha256(development) : authorization || cookie ? 'MALFORMED' : 'ANONYMOUS');
  return sha256(`${request.ip}:${hint}`).slice(0, 32);
}

function boundedPolicyReason(value: string): string {
  const allowed = new Set(['INVALID_FACTS', 'ORDER_NOT_ACTIVE', 'TOOL_NOT_ALLOWED', 'INVALID_AMOUNT_OR_CURRENCY', 'EXCEEDS_REFUNDABLE_BALANCE', 'BUDGET_EXCEEDED']);
  return allowed.has(value) ? value : 'OTHER';
}

function enforceBrowserMutation(request: FastifyRequest, principal: AuthenticatedPrincipal, csrfSecret: string | undefined, publicOrigin: string, allowedHost: string): void {
  if (!principal.sessionId || !csrfSecret) throw new DomainError('FORBIDDEN', 'Browser request validation failed');
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
  const host = typeof request.headers.host === 'string' ? request.headers.host : '';
  const token = typeof request.headers['x-fiar-csrf-token'] === 'string' ? request.headers['x-fiar-csrf-token'] : '';
  if (origin !== publicOrigin || host !== allowedHost || !verifyCsrfToken(token, principal.sessionId, csrfSecret)) throw new DomainError('FORBIDDEN', 'Browser request validation failed');
}

function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return `__Host-fiar_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}${secure ? '; Secure' : ''}`;
}
function clearSessionCookie(secure: boolean): string {
  return `__Host-fiar_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
