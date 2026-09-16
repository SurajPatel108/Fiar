import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { DomainError } from '../../../packages/shared/src/errors';
import { createId } from '../../../packages/shared/src/ids';
import type { AuthenticatedPrincipal } from './auth';
import { insertAuditEvent } from './audit';
import { withTransaction } from './db';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ManagerDecision = 'approve' | 'reject';

export interface ApprovalResponse {
  approvalId: string;
  status: ApprovalStatus;
  actionId: string;
  actionStatus: string;
  tool: 'refund.create';
  orderId: string;
  amountMinor: number;
  currency: 'USD';
  decisionReason: string;
  requestHash: string;
  policyVersionId: string;
  decision: ManagerDecision | null;
  comment: string | null;
  resolutionReason: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  context: {
    orderFactVersion: string;
    orderActive: boolean | null;
    refundableRemainingMinor: number | null;
    orderExposureMinor: number | null;
    budgetAvailableMinor: number | null;
  };
}

export interface ApprovalListPage {
  items: ApprovalResponse[];
  nextCursor: string | null;
}

export interface ApprovalListQuery {
  limit?: number;
  cursor?: string | null;
  status?: ApprovalStatus | null;
}

export interface ApprovalDecisionInput {
  decision: ManagerDecision;
  comment: string | null;
  expectedRequestHash: string;
  expectedPolicyVersion: string;
}

export interface ApprovalDecisionOptions {
  testFailAfterDecisionPersist?: boolean;
}

interface DbApprovalRow {
  id: string;
  tenant_id: string;
  status: ApprovalStatus;
  action_id: string;
  policy_version_id: string;
  request_hash: string;
  action_request_hash: string;
  action_policy_version_id: string;
  decision: ManagerDecision | null;
  manager_comment: string | null;
  resolution_reason: string | null;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  resolved_at: Date | string | null;
  action_status: string;
  principal_id: string;
  tool: 'refund.create';
  order_id: string;
  amount_minor: string | number;
  currency: 'USD';
  decision_reason: string;
  order_fact_version: string;
  business_facts: unknown;
  current_policy_version_id?: string | null;
  requester_status?: string;
  tenant_status?: string;
  manager_status?: string;
  manager_type?: AuthenticatedPrincipal['principalType'];
  database_now?: Date | string;
}

interface ApprovalCursor {
  approvalId: string;
  createdAt: string;
}

export function parseApprovalListQuery(value: unknown): ApprovalListQuery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_REQUEST', 'Invalid approval list query');
  }

  const query = value as Record<string, unknown>;
  const allowedKeys = new Set(['limit', 'cursor', 'status']);
  if (Object.keys(query).some((key) => !allowedKeys.has(key))) {
    throw new DomainError('INVALID_REQUEST', 'Invalid approval list query');
  }

  const parsed: ApprovalListQuery = {};
  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError('INVALID_REQUEST', 'limit must be between 1 and 100');
    }
    parsed.limit = limit;
  }

  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string') {
      throw new DomainError('INVALID_REQUEST', 'cursor must be a string');
    }
    parsed.cursor = query.cursor;
  }

  if (query.status !== undefined && query.status !== '') {
    if (!isApprovalStatus(query.status)) {
      throw new DomainError('INVALID_REQUEST', 'Invalid approval status filter');
    }
    parsed.status = query.status;
  }

  return parsed;
}

export function parseApprovalDecision(value: unknown): ApprovalDecisionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_REQUEST', 'Invalid approval decision request');
  }

  const body = value as Record<string, unknown>;
  const allowedKeys = new Set(['decision', 'comment', 'expectedRequestHash', 'expectedPolicyVersion']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new DomainError('INVALID_REQUEST', 'Invalid approval decision request');
  }

  if (body.decision !== 'approve' && body.decision !== 'reject') {
    throw new DomainError('INVALID_REQUEST', 'decision must be approve or reject');
  }
  if (typeof body.expectedRequestHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRequestHash)) {
    throw new DomainError('INVALID_REQUEST', 'expectedRequestHash must be a lowercase SHA-256 hash');
  }
  if (
    typeof body.expectedPolicyVersion !== 'string' ||
    body.expectedPolicyVersion.trim().length === 0 ||
    body.expectedPolicyVersion.length > 255
  ) {
    throw new DomainError('INVALID_REQUEST', 'expectedPolicyVersion must be a non-empty policy version ID');
  }

  let comment: string | null = null;
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== 'string') {
      throw new DomainError('INVALID_REQUEST', 'comment must be a string');
    }
    const trimmed = body.comment.trim();
    if (trimmed.length > 1000) {
      throw new DomainError('INVALID_REQUEST', 'comment must be at most 1000 characters');
    }
    comment = trimmed.length > 0 ? trimmed : null;
  }

  return {
    decision: body.decision,
    comment,
    expectedRequestHash: body.expectedRequestHash,
    expectedPolicyVersion: body.expectedPolicyVersion,
  };
}

export async function listApprovals(
  pool: Pool,
  principal: AuthenticatedPrincipal,
  query: ApprovalListQuery,
): Promise<ApprovalListPage> {
  return withTransaction(pool, async (client) => {
    await expireStaleApprovals(client, principal.tenantId);

    const limit = query.limit ?? 20;
    const cursor = parseCursor(query.cursor ?? null);
    const values: unknown[] = [principal.tenantId];
    let sql = `${approvalSelectSql()} where apr.tenant_id = $1`;

    if (query.status) {
      values.push(query.status);
      sql += ` and apr.status = $${values.length}`;
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.approvalId);
      sql += ` and (apr.created_at, apr.id) < ($${values.length - 1}::timestamptz, $${values.length})`;
    }

    values.push(limit + 1);
    sql += ` order by apr.created_at desc, apr.id desc limit $${values.length}`;
    const result = await client.query<DbApprovalRow>(sql, values);
    const hasNextPage = result.rows.length > limit;
    const rows = hasNextPage ? result.rows.slice(0, limit) : result.rows;
    const last = rows.at(-1);

    return {
      items: rows.map(mapApprovalRow),
      nextCursor: hasNextPage && last
        ? encodeCursor({ approvalId: last.id, createdAt: toIsoString(last.created_at) })
        : null,
    };
  });
}

export async function getApprovalById(
  pool: Pool,
  principal: AuthenticatedPrincipal,
  approvalId: string,
): Promise<ApprovalResponse> {
  return withTransaction(pool, async (client) => {
    await expireStaleApprovals(client, principal.tenantId, approvalId);
    const result = await client.query<DbApprovalRow>(
      `${approvalSelectSql()} where apr.tenant_id = $1 and apr.id = $2 limit 1`,
      [principal.tenantId, approvalId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DomainError('NOT_FOUND', 'Approval not found');
    }
    return mapApprovalRow(row);
  });
}

export async function decideApproval(
  pool: Pool,
  principal: AuthenticatedPrincipal,
  approvalId: string,
  input: ApprovalDecisionInput,
  options: ApprovalDecisionOptions = {},
): Promise<ApprovalResponse> {
  const result = await withTransaction(pool, async (client) => {
    const decisionSelectSql = approvalSelectSql(`,
      t.active_policy_version_id as current_policy_version_id,
      t.status as tenant_status,
      requester.status as requester_status,
      manager.status as manager_status,
      manager.type as manager_type,
      now() as database_now
    `);
    const query = await client.query<DbApprovalRow>(
      `
        ${decisionSelectSql}
        join tenants t on t.id = apr.tenant_id
        join principals requester on requester.id = a.principal_id and requester.tenant_id = a.tenant_id
        join principals manager on manager.id = $3 and manager.tenant_id = apr.tenant_id
        where apr.tenant_id = $1 and apr.id = $2
        for update of apr, a
        for share of t, requester, manager
      `,
      [principal.tenantId, approvalId, principal.principalId],
    );
    const row = query.rows[0];
    if (!row) {
      throw new DomainError('NOT_FOUND', 'Approval not found');
    }

    if (row.manager_status !== 'active' || (row.manager_type !== 'manager' && row.manager_type !== 'admin')) {
      throw new DomainError('FORBIDDEN', 'Credential is not permitted to decide approvals');
    }
    if (row.tenant_status !== 'active') {
      throw new DomainError('FORBIDDEN', 'Tenant is not active');
    }
    if (
      input.expectedRequestHash !== row.request_hash ||
      input.expectedRequestHash !== row.action_request_hash ||
      input.expectedPolicyVersion !== row.policy_version_id ||
      input.expectedPolicyVersion !== row.action_policy_version_id
    ) {
      throw new DomainError('CONFLICT', 'Approval binding does not match the requested action');
    }
    if (row.status !== 'pending' || row.action_status !== 'awaiting_approval') {
      throw new DomainError('CONFLICT', 'Approval has already been resolved');
    }

    const staleReason = getStaleReason(row);
    if (staleReason) {
      const expired = await expireLockedApproval(client, row, staleReason);
      return { expired };
    }

    const approvalStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    const actionStatus = input.decision === 'approve' ? 'queued' : 'denied';
    const resolutionReason = input.decision === 'approve' ? 'MANAGER_APPROVED' : 'MANAGER_REJECTED';
    const resolvedAt = toIsoString(row.database_now ?? new Date());

    await client.query(
      `
        update pending_approval_requests
        set status = $1,
            manager_principal_id = $2,
            decision = $3,
            manager_comment = $4,
            resolved_at = $5,
            resolution_reason = $6,
            updated_at = $5
        where id = $7 and tenant_id = $8
      `,
      [approvalStatus, principal.principalId, input.decision, input.comment, resolvedAt, resolutionReason, row.id, row.tenant_id],
    );
    await client.query(
      `update actions set status = $1, updated_at = $2 where id = $3 and tenant_id = $4`,
      [actionStatus, resolvedAt, row.action_id, row.tenant_id],
    );

    if (input.decision === 'approve') {
      await client.query(
        `
          insert into outbox_entries (
            id, tenant_id, action_id, kind, payload, status, created_at, updated_at
          ) values ($1, $2, $3, 'refund.execute', $4::jsonb, 'ready', $5, $5)
        `,
        [
          createId('box'),
          row.tenant_id,
          row.action_id,
          JSON.stringify({
            actionId: row.action_id,
            tenantId: row.tenant_id,
            orderId: row.order_id,
            amountMinor: Number(row.amount_minor),
            currency: row.currency,
            providerIdempotencyKey: `refund:${row.action_id}`,
          }),
          resolvedAt,
        ],
      );
    }

    await insertAuditEvent(client, {
      tenantId: row.tenant_id,
      actionId: row.action_id,
      actorType: principal.principalType,
      eventType: input.decision === 'approve' ? 'approval.approved' : 'approval.rejected',
      requestHash: row.request_hash,
      decision: input.decision === 'approve' ? 'APPROVED' : 'REJECTED',
      reason: resolutionReason,
      correlationId: randomUUID(),
      payload: {
        approvalId: row.id,
        actionId: row.action_id,
        approvalStatus,
        actionStatus,
        commentPresent: input.comment !== null,
      },
    });

    if (options.testFailAfterDecisionPersist) {
      throw new Error('Injected approval decision transaction failure');
    }

    const decided = await selectApproval(client, row.tenant_id, row.id);
    return { decided };
  });

  if ('expired' in result) {
    throw new DomainError('CONFLICT', `Approval is no longer usable: ${result.expired.resolutionReason ?? 'EXPIRED'}`);
  }
  return result.decided;
}

function approvalSelectSql(extraColumns = ''): string {
  return `
    select
      apr.id,
      apr.tenant_id,
      apr.status,
      apr.action_id,
      apr.policy_version_id,
      apr.request_hash,
      a.policy_version_id as action_policy_version_id,
      a.request_hash as action_request_hash,
      apr.decision,
      apr.manager_comment,
      apr.resolution_reason,
      apr.expires_at,
      apr.created_at,
      apr.updated_at,
      apr.resolved_at,
      a.status as action_status,
      a.principal_id,
      a.tool,
      a.order_id,
      a.amount_minor,
      a.currency,
      a.decision_reason,
      a.order_fact_version,
      a.business_facts
      ${extraColumns}
    from pending_approval_requests apr
    join actions a on a.id = apr.action_id and a.tenant_id = apr.tenant_id
  `;
}

async function selectApproval(client: PoolClient, tenantId: string, approvalId: string): Promise<ApprovalResponse> {
  const result = await client.query<DbApprovalRow>(
    `${approvalSelectSql()} where apr.tenant_id = $1 and apr.id = $2 limit 1`,
    [tenantId, approvalId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DomainError('NOT_FOUND', 'Approval not found');
  }
  return mapApprovalRow(row);
}

async function expireStaleApprovals(client: PoolClient, tenantId: string, approvalId?: string): Promise<void> {
  const values: unknown[] = [tenantId];
  let sql = `
    select
      apr.id,
      apr.tenant_id,
      apr.status,
      apr.action_id,
      apr.policy_version_id,
      apr.request_hash,
      a.policy_version_id as action_policy_version_id,
      a.request_hash as action_request_hash,
      apr.expires_at,
      apr.created_at,
      apr.updated_at,
      apr.resolved_at,
      apr.decision,
      apr.manager_comment,
      apr.resolution_reason,
      a.status as action_status,
      a.principal_id,
      a.tool,
      a.order_id,
      a.amount_minor,
      a.currency,
      a.decision_reason,
      a.order_fact_version,
      a.business_facts,
      t.active_policy_version_id as current_policy_version_id,
      requester.status as requester_status,
      now() as database_now
    from pending_approval_requests apr
    join actions a on a.id = apr.action_id and a.tenant_id = apr.tenant_id
    join tenants t on t.id = apr.tenant_id
    join principals requester on requester.id = a.principal_id and requester.tenant_id = a.tenant_id
    where apr.tenant_id = $1 and apr.status = 'pending'
  `;
  if (approvalId) {
    values.push(approvalId);
    sql += ` and apr.id = $2`;
  }
  sql += ` for update of apr, a`;

  const result = await client.query<DbApprovalRow>(sql, values);
  for (const row of result.rows) {
    const reason = getStaleReason(row);
    if (reason) {
      await expireLockedApproval(client, row, reason);
    }
  }
}

function getStaleReason(row: DbApprovalRow): string | null {
  const now = new Date(row.database_now ?? new Date());
  if (new Date(row.expires_at).valueOf() <= now.valueOf()) {
    return 'APPROVAL_EXPIRED';
  }
  if (row.current_policy_version_id !== undefined && row.current_policy_version_id !== row.policy_version_id) {
    return 'POLICY_VERSION_CHANGED';
  }
  if (row.requester_status !== undefined && row.requester_status !== 'active') {
    return 'REQUESTER_NOT_ACTIVE';
  }
  return null;
}

async function expireLockedApproval(
  client: PoolClient,
  row: DbApprovalRow,
  reason: string,
): Promise<ApprovalResponse> {
  const resolvedAt = toIsoString(row.database_now ?? new Date());
  await client.query(
    `
      update pending_approval_requests
      set status = 'expired', resolved_at = $1, resolution_reason = $2, updated_at = $1
      where id = $3 and tenant_id = $4 and status = 'pending'
    `,
    [resolvedAt, reason, row.id, row.tenant_id],
  );
  if (row.action_status === 'awaiting_approval') {
    await client.query(
      `update actions set status = 'expired', updated_at = $1 where id = $2 and tenant_id = $3`,
      [resolvedAt, row.action_id, row.tenant_id],
    );
  }
  await insertAuditEvent(client, {
    tenantId: row.tenant_id,
    actionId: row.action_id,
    actorType: 'service',
    eventType: 'approval.expired',
    requestHash: row.request_hash,
    decision: 'EXPIRED',
    reason,
    correlationId: randomUUID(),
    payload: {
      approvalId: row.id,
      actionId: row.action_id,
      approvalStatus: 'expired',
      actionStatus: row.action_status === 'awaiting_approval' ? 'expired' : row.action_status,
    },
  });
  return selectApproval(client, row.tenant_id, row.id);
}

function mapApprovalRow(row: DbApprovalRow): ApprovalResponse {
  const facts = readSafeFacts(row.business_facts);
  return {
    approvalId: row.id,
    status: row.status,
    actionId: row.action_id,
    actionStatus: row.action_status,
    tool: row.tool,
    orderId: row.order_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    decisionReason: row.decision_reason,
    requestHash: row.request_hash,
    policyVersionId: row.policy_version_id,
    decision: row.decision,
    comment: row.manager_comment,
    resolutionReason: row.resolution_reason,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    expiresAt: toIsoString(row.expires_at),
    resolvedAt: row.resolved_at ? toIsoString(row.resolved_at) : null,
    context: {
      orderFactVersion: row.order_fact_version,
      orderActive: safeOrderActive(facts),
      refundableRemainingMinor: safeNumber(facts.remainingMinor),
      orderExposureMinor: safeNumber(facts.orderExposureMinor),
      budgetAvailableMinor: safeNumber(facts.budgetAvailableMinor),
    },
  };
}

function readSafeFacts(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeOrderActive(facts: Record<string, unknown>): boolean | null {
  if (typeof facts.orderActive === 'boolean') {
    return facts.orderActive;
  }
  // Actions recorded before the semantic rename stored the same order fact as `active`.
  return typeof facts.active === 'boolean' ? facts.active : null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseCursor(value: string | null): ApprovalCursor | null {
  if (!value) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new DomainError('INVALID_REQUEST', 'Invalid approval list cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2
  ) {
    throw new DomainError('INVALID_REQUEST', 'Invalid approval list cursor');
  }
  const cursor = parsed as Record<string, unknown>;
  if (
    typeof cursor.approvalId !== 'string' ||
    !/^apr_[0-9a-f-]{36}$/.test(cursor.approvalId) ||
    typeof cursor.createdAt !== 'string' ||
    !isCanonicalIsoTimestamp(cursor.createdAt)
  ) {
    throw new DomainError('INVALID_REQUEST', 'Invalid approval list cursor');
  }
  return { approvalId: cursor.approvalId, createdAt: cursor.createdAt };
}

function encodeCursor(cursor: ApprovalCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'expired';
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
