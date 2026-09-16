import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { DomainError } from '../../../packages/shared/src/errors';
import { createId } from '../../../packages/shared/src/ids';
import { decide } from './policy';
import type { AuthenticatedPrincipal } from './auth';
import { parseAndCanonicalizeRefundRequest } from './canonicalize';
import { insertAuditEvent } from './audit';
import { withTransaction } from './db';

interface LoadedBusinessFacts {
  orderFactId: string;
  orderFactVersion: string;
  policyVersionId: string;
  approvalThresholdMinor: unknown;
  facts: {
    tool: string;
    currency: string;
    orderActive: boolean;
    remainingMinor: number;
    orderExposureMinor: number;
    budgetAvailableMinor: number;
  };
}

export interface ActionResponse {
  actionId: string;
  status: string;
  decision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  reason: string;
  approvalId?: string;
  orderId: string;
  amountMinor: number;
  currency: 'USD';
  policyVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionListPage {
  items: ActionResponse[];
  nextCursor: string | null;
}

export interface CreateActionOptions {
  testFailAfterPersist?: boolean;
  approvalExpiryHours?: number;
}

export async function createAction(
  pool: Pool,
  principal: AuthenticatedPrincipal,
  rawBody: unknown,
  options: CreateActionOptions = {},
): Promise<{ httpStatus: number; action: ActionResponse }> {
  const { request, canonicalRequest, requestHash } = parseAndCanonicalizeRefundRequest(rawBody);

  try {
    return await withTransaction(pool, async (client) => {
      const existing = await findActionByIdempotencyKey(client, principal.tenantId, request.idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new DomainError('CONFLICT', 'Idempotency key already used for a different action');
        }

        return {
          httpStatus: 200,
          action: mapActionRow(existing),
        };
      }

      const context = await loadBusinessFacts(client, principal, request.orderId);
      const evaluatedFacts = {
        tool: request.tool,
        amountMinor: request.amountMinor,
        currency: request.currency,
        orderActive: context.facts.orderActive,
        remainingMinor: context.facts.remainingMinor,
        orderExposureMinor: context.facts.orderExposureMinor,
        budgetAvailableMinor: context.facts.budgetAvailableMinor,
      };
      const policyDecision = decide(evaluatedFacts, context.approvalThresholdMinor);

      const actionId = createId('act');
      const now = new Date().toISOString();
      const status =
        policyDecision.decision === 'ALLOW'
          ? 'queued'
          : policyDecision.decision === 'REQUIRE_APPROVAL'
            ? 'awaiting_approval'
            : 'denied';

      await client.query(
        `
        insert into actions (
          id,
          tenant_id,
          principal_id,
          policy_version_id,
          order_fact_id,
          order_fact_version,
          business_facts,
          tool,
          order_id,
          amount_minor,
          currency,
          canonical_request,
          request_hash,
          idempotency_key,
          decision,
          decision_reason,
          status,
          created_at,
          updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19)
      `,
        [
          actionId,
          principal.tenantId,
          principal.principalId,
          context.policyVersionId,
          context.orderFactId,
          context.orderFactVersion,
          JSON.stringify(evaluatedFacts),
          request.tool,
          request.orderId,
          request.amountMinor,
          request.currency,
          JSON.stringify(canonicalRequest),
          requestHash,
          request.idempotencyKey,
          policyDecision.decision,
          policyDecision.reason,
          status,
          now,
          now,
        ],
      );

      let approvalId: string | undefined;
      if (policyDecision.decision === 'REQUIRE_APPROVAL') {
        approvalId = createId('apr');
        await client.query(
          `
          insert into pending_approval_requests (
            id,
            tenant_id,
            action_id,
            policy_version_id,
            request_hash,
            status,
            expires_at,
            created_at,
            updated_at
            ) values ($1, $2, $3, $4, $5, 'pending', $7::timestamptz + make_interval(hours => $6), $7, $7)
          `,
          [approvalId, principal.tenantId, actionId, context.policyVersionId, requestHash, options.approvalExpiryHours ?? 24, now],
        );
      }

      if (policyDecision.decision === 'ALLOW') {
        await client.query(
          `
          insert into outbox_entries (
            id,
            tenant_id,
            action_id,
            kind,
            payload,
            status,
            created_at,
            updated_at
          ) values ($1, $2, $3, 'refund.execute', $4::jsonb, 'ready', $5, $5)
          `,
          [
            createId('box'),
            principal.tenantId,
            actionId,
            JSON.stringify({
              actionId,
              tenantId: principal.tenantId,
              orderId: request.orderId,
              amountMinor: request.amountMinor,
              currency: request.currency,
              providerIdempotencyKey: `refund:${actionId}`,
            }),
            now,
          ],
        );
      }

      await insertAuditEvent(client, {
        tenantId: principal.tenantId,
        actionId,
        actorType: principal.principalType,
        requestHash,
        decision: policyDecision.decision,
        reason: policyDecision.reason,
        correlationId: randomUUID(),
        payload: {
          actionId,
          orderId: request.orderId,
          amountMinor: request.amountMinor,
          currency: request.currency,
          status,
          approvalId,
        },
      });

      if (options.testFailAfterPersist) {
        throw new Error('Injected transaction failure');
      }

      const action: ActionResponse = {
        actionId,
        status,
        decision: policyDecision.decision,
        reason: policyDecision.reason,
        orderId: request.orderId,
        amountMinor: request.amountMinor,
        currency: request.currency,
        policyVersionId: context.policyVersionId,
        createdAt: now,
        updatedAt: now,
      };

      if (approvalId) {
        action.approvalId = approvalId;
      }

      return {
        httpStatus: 201,
        action,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await findActionByIdempotencyKey(pool, principal.tenantId, request.idempotencyKey);
      if (!existing) {
        throw error;
      }

      if (existing.request_hash !== requestHash) {
        throw new DomainError('CONFLICT', 'Idempotency key already used for a different action');
      }

      return {
        httpStatus: 200,
        action: mapActionRow(existing),
      };
    }

    throw error;
  }
}

export async function getActionById(pool: Pool, principal: AuthenticatedPrincipal, actionId: string): Promise<ActionResponse> {
  const result = await pool.query<DbActionRow>(
    `
      select
        a.id,
        a.status,
        a.decision,
        a.decision_reason,
        a.order_id,
        a.amount_minor,
        a.currency,
        a.policy_version_id,
        a.created_at,
        a.updated_at,
        apr.id as approval_id
      from actions a
      left join pending_approval_requests apr on apr.action_id = a.id
      where a.tenant_id = $1 and a.id = $2
      limit 1
    `,
    [principal.tenantId, actionId],
  );

  if (result.rowCount === 0) {
    throw new DomainError('NOT_FOUND', 'Action not found');
  }

  const row = result.rows[0];
  if (!row) {
    throw new DomainError('NOT_FOUND', 'Action not found');
  }

  return mapActionRow(row);
}

export async function listActions(
  pool: Pool,
  principal: AuthenticatedPrincipal,
  query: { limit?: number; cursor?: string | null; status?: string | null },
): Promise<ActionListPage> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const cursor = parseCursor(query.cursor ?? null);
  const status = query.status ?? null;

  const values: unknown[] = [principal.tenantId];
  let sql = `
    select
      a.id,
      a.status,
      a.decision,
      a.decision_reason,
      a.order_id,
      a.amount_minor,
      a.currency,
      a.policy_version_id,
      a.created_at,
      a.updated_at,
      apr.id as approval_id
    from actions a
    left join pending_approval_requests apr on apr.action_id = a.id
    where a.tenant_id = $1
  `;

  if (status) {
    values.push(status);
    sql += ` and a.status = $${values.length}`;
  }

  if (cursor) {
    values.push(cursor.createdAt, cursor.actionId);
    sql += ` and (a.created_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length})`;
  }

  values.push(limit + 1);
  sql += ` order by a.created_at desc, a.id desc limit $${values.length}`;

  const result = await pool.query<DbActionRow>(sql, values);
  const rows = result.rows;
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  const items = pageRows.map(mapActionRow);
  const lastRow = pageRows.at(-1);
  const nextCursor = hasNextPage && lastRow
    ? encodeCursor({ actionId: lastRow.id, createdAt: toIsoString(lastRow.created_at) })
    : null;

  return { items, nextCursor };
}

interface DbActionRow {
  id: string;
  status: string;
  decision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  decision_reason: string;
  order_id: string;
  amount_minor: string | number;
  currency: 'USD';
  policy_version_id: string;
  created_at: string | Date;
  updated_at: string | Date;
  approval_id: string | null;
  request_hash?: string;
}

interface DbIdempotencyRow extends DbActionRow {
  request_hash: string;
}

async function findActionByIdempotencyKey(database: { query: Pool['query'] }, tenantId: string, idempotencyKey: string): Promise<DbIdempotencyRow | null> {
  const result = await database.query<DbIdempotencyRow>(
    `
      select
        a.id,
        a.status,
        a.decision,
        a.decision_reason,
        a.order_id,
        a.amount_minor,
        a.currency,
        a.policy_version_id,
        a.created_at,
        a.updated_at,
        apr.id as approval_id,
        a.request_hash
      from actions a
      left join pending_approval_requests apr on apr.action_id = a.id
      where a.tenant_id = $1 and a.idempotency_key = $2
      limit 1
    `,
    [tenantId, idempotencyKey],
  );

  return result.rows[0] ?? null;
}

async function loadBusinessFacts(client: PoolClient, principal: AuthenticatedPrincipal, orderId: string): Promise<LoadedBusinessFacts> {
  const result = await client.query<{
    order_fact_id: string;
    policy_version_id: string;
    policy_version_number: number;
    policy_ruleset: unknown;
    tenant_status: string;
    principal_status: string;
    principal_type: AuthenticatedPrincipal['principalType'];
    active: boolean;
    refundable_remaining_minor: string | number;
    order_exposure_minor: string | number;
    budget_available_minor: string | number;
    order_currency: 'USD';
    order_fact_version: string;
  }>(
    `
      select
        ofacts.id as order_fact_id,
        pv.id as policy_version_id,
        pv.version_number as policy_version_number,
        pv.ruleset as policy_ruleset,
        t.status as tenant_status,
        p.status as principal_status,
        p.type as principal_type,
        ofacts.active,
        ofacts.refundable_remaining_minor,
        ofacts.order_exposure_minor,
        ofacts.budget_available_minor,
        ofacts.currency as order_currency
        , ofacts.source_version as order_fact_version
      from tenants t
      join principals p on p.tenant_id = t.id
      join policy_versions pv on pv.id = t.active_policy_version_id and pv.status = 'published'
      join order_facts ofacts on ofacts.tenant_id = t.id and ofacts.external_order_id = $1
      where t.id = $2 and p.id = $3
      limit 1
    `,
    [orderId, principal.tenantId, principal.principalId],
  );

  if (result.rowCount === 0) {
    throw new DomainError('INVALID_REQUEST', 'Required business facts are unavailable');
  }

  const row = result.rows[0];
  if (!row) {
    throw new DomainError('INVALID_REQUEST', 'Required business facts are unavailable');
  }

  if (row.tenant_status !== 'active' || row.principal_status !== 'active') {
    throw new DomainError('FORBIDDEN', 'Tenant or principal is not active');
  }

  const remainingMinor = toSafeNonNegativeInteger(row.refundable_remaining_minor, 'refundableRemainingMinor');
  const orderExposureMinor = toSafeNonNegativeInteger(row.order_exposure_minor, 'orderExposureMinor');
  const budgetAvailableMinor = toSafeNonNegativeInteger(row.budget_available_minor, 'budgetAvailableMinor');

  return {
    orderFactId: row.order_fact_id,
    orderFactVersion: row.order_fact_version,
    policyVersionId: row.policy_version_id,
    approvalThresholdMinor: readApprovalThreshold(row.policy_ruleset),
    facts: {
      tool: 'refund.create',
      currency: row.order_currency,
      orderActive: row.active,
      remainingMinor,
      orderExposureMinor,
      budgetAvailableMinor,
    },
  };
}

function readApprovalThreshold(ruleset: unknown): unknown {
  if (typeof ruleset !== 'object' || ruleset === null || Array.isArray(ruleset)) {
    return null;
  }

  return (ruleset as Record<string, unknown>).approvalThresholdMinor ?? null;
}

function toSafeNonNegativeInteger(value: string | number, fieldName: string): number {
  const numericValue = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(numericValue) || numericValue < 0) {
    throw new DomainError('INVALID_REQUEST', `Invalid business fact: ${fieldName}`);
  }

  return numericValue;
}

function mapActionRow(row: DbActionRow): ActionResponse {
  const action: ActionResponse = {
    actionId: row.id,
    status: row.status,
    decision: row.decision,
    reason: row.decision_reason,
    orderId: row.order_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    policyVersionId: row.policy_version_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };

  if (row.approval_id) {
    action.approvalId = row.approval_id;
  }

  return action;
}

function parseCursor(cursor: string | null): { actionId: string; createdAt: string } | null {
  if (!cursor) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new DomainError('INVALID_REQUEST', 'Invalid list cursor');
  }

  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded) ||
    typeof (decoded as Record<string, unknown>).actionId !== 'string' ||
    typeof (decoded as Record<string, unknown>).createdAt !== 'string' ||
    Object.keys(decoded).length !== 2
  ) {
    throw new DomainError('INVALID_REQUEST', 'Invalid list cursor');
  }

  const parsed = decoded as Record<string, unknown>;
  if (typeof parsed.actionId !== 'string' || typeof parsed.createdAt !== 'string') {
    throw new DomainError('INVALID_REQUEST', 'Invalid list cursor');
  }

  if (!/^act_[0-9a-f-]{36}$/.test(parsed.actionId) || !isCanonicalIsoTimestamp(parsed.createdAt)) {
    throw new DomainError('INVALID_REQUEST', 'Invalid list cursor');
  }

  return {
    actionId: parsed.actionId,
    createdAt: parsed.createdAt,
  };
}

function encodeCursor(cursor: { actionId: string; createdAt: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'constraint' in error &&
    (error as { code?: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === 'actions_tenant_idempotency_key_key'
  );
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
