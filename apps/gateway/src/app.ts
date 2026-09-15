import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyReply } from 'fastify';
import type { Pool } from 'pg';

import { authenticateRequest, requirePermission, type DevCredentialDirectory } from './auth';
import { createAction, getActionById, listActions } from './actions';
import { DomainError } from '../../../packages/shared/src/errors';
import { mapDomainErrorToStatusCode, toHttpErrorPayload } from './errors';

export interface GatewayAppOptions {
  pool: Pool;
  devCredentials: DevCredentialDirectory;
  approvalExpiryHours: number;
  testHooks?: {
    failAfterPersist?: boolean;
  };
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

  app.addHook('onClose', async () => {
    if (typeof options.pool.end === 'function') {
      await options.pool.end();
    }
  });

  app.post('/v1/actions', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticateRequest(request, options.pool, options.devCredentials);
      requirePermission(principal, 'actions:create');
      const createOptions: Parameters<typeof createAction>[3] = { approvalExpiryHours: options.approvalExpiryHours };
      if (options.testHooks?.failAfterPersist) {
        createOptions.testFailAfterPersist = true;
      }

      const result = await createAction(options.pool, principal, request.body, createOptions);
      reply.code(result.httpStatus).send(result.action);
    });
  });

  app.get('/v1/actions/:id', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticateRequest(request, options.pool, options.devCredentials);
      requirePermission(principal, 'actions:read');
      const action = await getActionById(options.pool, principal, (request.params as { id: string }).id);
      reply.code(200).send(action);
    });
  });

  app.get('/v1/actions', async (request, reply) => {
    await callSafely(reply, async () => {
      const principal = await authenticateRequest(request, options.pool, options.devCredentials);
      requirePermission(principal, 'actions:read');
      const page = await listActions(options.pool, principal, parseListQuery(request.query));
      reply.code(200).send(page);
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
