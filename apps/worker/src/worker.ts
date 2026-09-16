import type { Pool } from 'pg';

import type { RefundProviderConnector } from './connector';
import { claimNextExecution, finalizeExecution, type ClaimOptions } from './outbox';
import { reconcileNext, type ReconciliationResult } from './reconciliation';

export interface ExecutionWorkerOptions {
  workerId: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  failAfterClaimPersist?: boolean;
  crashAfterProviderCall?: boolean;
}

export type ProcessOneResult =
  | { kind: 'executed'; actionId: string; outcome: 'CONFIRMED_SUCCESS' | 'CONFIRMED_FAILURE' | 'RETRYABLE_FAILURE' }
  | { kind: 'pending_reconciliation'; actionId?: string; outcome?: 'AMBIGUOUS' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'none' };

export class ExecutionWorker {
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly pool: Pool,
    private readonly connector: RefundProviderConnector,
    private readonly options: ExecutionWorkerOptions,
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async processOne(): Promise<ProcessOneResult> {
    const claimOptions: ClaimOptions = {
      workerId: this.options.workerId,
      leaseSeconds: this.leaseSeconds,
      maxAttempts: this.maxAttempts,
      providerName: this.connector.name,
    };
    if (this.options.failAfterClaimPersist) {
      claimOptions.failAfterClaimPersist = true;
    }
    const claim = await claimNextExecution(this.pool, claimOptions);
    if (claim.kind === 'none') {
      return { kind: 'none' };
    }
    if (claim.kind === 'blocked') {
      return claim;
    }
    if (claim.kind === 'reconciliation_required') {
      return { kind: 'pending_reconciliation' };
    }

    let providerResult;
    try {
      providerResult = await this.connector.executeRefund(claim.execution.providerRequest);
    } catch {
      providerResult = {
        outcome: 'ambiguous' as const,
        providerRequestId: null,
        errorClassification: 'CONNECTOR_EXCEPTION',
      };
    }
    if (this.options.crashAfterProviderCall) {
      throw new Error('Injected worker crash after provider call');
    }
    await finalizeExecution(this.pool, claim.execution, providerResult, this.maxAttempts);
    return providerResult.outcome === 'ambiguous'
      ? { kind: 'pending_reconciliation', actionId: claim.execution.actionId, outcome: 'AMBIGUOUS' }
      : { kind: 'executed', actionId: claim.execution.actionId, outcome: providerResult.outcome.toUpperCase() as 'CONFIRMED_SUCCESS' | 'CONFIRMED_FAILURE' | 'RETRYABLE_FAILURE' };
  }

  async reconcileOne(): Promise<ReconciliationResult> {
    return reconcileNext(this.pool, this.connector, this.options.workerId, this.leaseSeconds);
  }
}
