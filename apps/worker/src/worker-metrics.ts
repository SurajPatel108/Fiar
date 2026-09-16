import type { OperationalMetrics } from '../../gateway/src/metrics';
import type { ReconciliationResult } from './reconciliation';
import type { ProcessOneResult } from './worker';

export function recordExecutionMetrics(metrics: OperationalMetrics, execution: ProcessOneResult): void {
  metrics.increment('worker_claims_total', { result: execution.kind.toUpperCase() });
  if ('outcome' in execution && execution.outcome) metrics.increment('execution_outcomes_total', { outcome: execution.outcome });
  if (execution.kind === 'blocked' && execution.reason === 'KILL_SWITCH_ENABLED') metrics.increment('kill_switch_blocks_total');
  if (execution.kind === 'executed' && execution.outcome === 'RETRYABLE_FAILURE') metrics.increment('worker_retries_total', { reason: 'PRE_PROVIDER' });
  if (execution.kind === 'pending_reconciliation') metrics.increment('worker_failures_total', { reason: 'CONNECTOR_EXCEPTION' });
}

export function recordReconciliationMetrics(metrics: OperationalMetrics, reconciliation: ReconciliationResult): void {
  if (reconciliation.kind !== 'none') metrics.increment('reconciliation_attempts_total');
  if (reconciliation.kind === 'resolved') metrics.increment('reconciliation_outcomes_total', { outcome: reconciliation.outcome.toUpperCase() });
  if (reconciliation.kind === 'pending') metrics.increment('reconciliation_outcomes_total', { outcome: 'PENDING' });
}
