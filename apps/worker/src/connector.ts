import type { Pool } from 'pg';

import { createId } from '../../../packages/shared/src/ids';

export interface RefundProviderRequest {
  tenantId: string;
  actionId: string;
  orderId: string;
  amountMinor: number;
  currency: 'USD';
  providerIdempotencyKey: string;
}

export type ProviderExecutionResult =
  | { outcome: 'confirmed_success'; providerRequestId: string }
  | { outcome: 'confirmed_failure'; providerRequestId: string; errorClassification: string }
  | { outcome: 'retryable_failure'; errorClassification: string }
  | { outcome: 'ambiguous'; providerRequestId: string | null; errorClassification: string };

export type ProviderLookupResult =
  | { outcome: 'confirmed_success'; providerRequestId: string }
  | { outcome: 'confirmed_failure'; providerRequestId: string; errorClassification: string }
  | { outcome: 'confirmed_not_executed' }
  | { outcome: 'unknown'; providerRequestId: string | null };

export interface RefundProviderConnector {
  readonly name: string;
  executeRefund(request: RefundProviderRequest): Promise<ProviderExecutionResult>;
  lookupRefund(providerIdempotencyKey: string): Promise<ProviderLookupResult>;
}

export type FakeProviderBehavior =
  | 'success'
  | 'confirmed_failure'
  | 'retryable_failure'
  | 'ambiguous_success'
  | 'ambiguous_not_executed'
  | 'ambiguous_unknown';

export interface FakeRefundProviderOptions {
  behavior?: FakeProviderBehavior;
  behaviorForRequest?: (request: RefundProviderRequest) => FakeProviderBehavior;
}

interface ProviderLedgerRow {
  provider_request_id: string;
  status: 'succeeded' | 'failed' | 'unknown';
  error_classification: string | null;
}

export class FakeRefundProvider implements RefundProviderConnector {
  readonly name = 'fake-refund-provider';

  constructor(
    private readonly pool: Pool,
    private readonly options: FakeRefundProviderOptions = {},
  ) {}

  async executeRefund(request: RefundProviderRequest): Promise<ProviderExecutionResult> {
    const existing = await this.findLedgerEntry(request.providerIdempotencyKey);
    if (existing) {
      return executionResultFromLedger(existing);
    }

    const behavior = this.options.behaviorForRequest?.(request) ?? this.options.behavior ?? 'success';
    if (behavior === 'retryable_failure') {
      return { outcome: 'retryable_failure', errorClassification: 'FAKE_PROVIDER_UNREACHABLE' };
    }
    if (behavior === 'ambiguous_not_executed') {
      return { outcome: 'ambiguous', providerRequestId: null, errorClassification: 'FAKE_TIMEOUT' };
    }

    const providerRequestId = createId('fpr');
    const ledgerStatus = behavior === 'confirmed_failure'
      ? 'failed'
      : behavior === 'ambiguous_unknown'
        ? 'unknown'
        : 'succeeded';
    const errorClassification = ledgerStatus === 'failed'
      ? 'FAKE_PROVIDER_REJECTED'
      : ledgerStatus === 'unknown'
        ? 'FAKE_PROVIDER_UNKNOWN'
        : null;

    const inserted = await this.pool.query<ProviderLedgerRow>(
      `
        insert into fake_provider_refunds (
          provider_idempotency_key,
          provider_request_id,
          action_id,
          tenant_id,
          amount_minor,
          currency,
          status,
          error_classification
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (provider_idempotency_key) do nothing
        returning provider_request_id, status, error_classification
      `,
      [
        request.providerIdempotencyKey,
        providerRequestId,
        request.actionId,
        request.tenantId,
        request.amountMinor,
        request.currency,
        ledgerStatus,
        errorClassification,
      ],
    );
    const row = inserted.rows[0] ?? await this.requireLedgerEntry(request.providerIdempotencyKey);

    if (behavior === 'ambiguous_success' || behavior === 'ambiguous_unknown') {
      return {
        outcome: 'ambiguous',
        providerRequestId: row.provider_request_id,
        errorClassification: 'FAKE_TIMEOUT_AFTER_REQUEST',
      };
    }
    return executionResultFromLedger(row);
  }

  async lookupRefund(providerIdempotencyKey: string): Promise<ProviderLookupResult> {
    const row = await this.findLedgerEntry(providerIdempotencyKey);
    if (!row) {
      return { outcome: 'confirmed_not_executed' };
    }
    switch (row.status) {
      case 'succeeded':
        return { outcome: 'confirmed_success', providerRequestId: row.provider_request_id };
      case 'failed':
        return {
          outcome: 'confirmed_failure',
          providerRequestId: row.provider_request_id,
          errorClassification: row.error_classification ?? 'FAKE_PROVIDER_REJECTED',
        };
      case 'unknown':
        return { outcome: 'unknown', providerRequestId: row.provider_request_id };
    }
  }

  private async findLedgerEntry(providerIdempotencyKey: string): Promise<ProviderLedgerRow | null> {
    const result = await this.pool.query<ProviderLedgerRow>(
      `
        select provider_request_id, status, error_classification
        from fake_provider_refunds
        where provider_idempotency_key = $1
        limit 1
      `,
      [providerIdempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  private async requireLedgerEntry(providerIdempotencyKey: string): Promise<ProviderLedgerRow> {
    const row = await this.findLedgerEntry(providerIdempotencyKey);
    if (!row) {
      throw new Error('Fake provider idempotency conflict did not resolve to a ledger entry');
    }
    return row;
  }
}

function executionResultFromLedger(row: ProviderLedgerRow): ProviderExecutionResult {
  switch (row.status) {
    case 'succeeded':
      return { outcome: 'confirmed_success', providerRequestId: row.provider_request_id };
    case 'failed':
      return {
        outcome: 'confirmed_failure',
        providerRequestId: row.provider_request_id,
        errorClassification: row.error_classification ?? 'FAKE_PROVIDER_REJECTED',
      };
    case 'unknown':
      return {
        outcome: 'ambiguous',
        providerRequestId: row.provider_request_id,
        errorClassification: row.error_classification ?? 'FAKE_PROVIDER_UNKNOWN',
      };
  }
}
