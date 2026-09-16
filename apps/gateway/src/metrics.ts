import type { Pool } from 'pg';

const LABEL_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  category: new Set(['INVALID', 'MALFORMED', 'EXPIRED', 'REVOKED', 'BINDING', 'RESOLVED', 'STALE', 'OTHER']),
  channel: new Set(['REQUEST', 'DEVELOPMENT', 'WORKLOAD', 'SESSION', 'OIDC']),
  component: new Set(['DATABASE', 'AUTHENTICATION', 'CONNECTOR']),
  decision: new Set(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']),
  layer: new Set(['ACTION', 'PROVIDER']),
  outcome: new Set(['APPROVED', 'REJECTED', 'EXPIRED', 'STALE', 'CONFIRMED_SUCCESS', 'CONFIRMED_FAILURE', 'CONFIRMED_NOT_EXECUTED', 'RETRYABLE_FAILURE', 'AMBIGUOUS', 'SUCCESS', 'FAILURE', 'NOT_EXECUTED', 'PENDING', 'SUCCEEDED', 'DENIED']),
  reason: new Set(['INVALID_FACTS', 'ORDER_NOT_ACTIVE', 'TOOL_NOT_ALLOWED', 'INVALID_AMOUNT_OR_CURRENCY', 'EXCEEDS_REFUNDABLE_BALANCE', 'BUDGET_EXCEEDED', 'PRE_PROVIDER', 'CONNECTOR_EXCEPTION', 'MAX_ATTEMPTS', 'OTHER']),
  result: new Set(['EXECUTED', 'PENDING_RECONCILIATION', 'BLOCKED', 'NONE', 'RESOLVED', 'PENDING']),
  service: new Set(['GATEWAY', 'WORKER']),
};

const COUNTERS: Readonly<Record<string, string>> = {
  action_decisions_total: 'Policy decisions returned for submitted actions.',
  action_denials_total: 'Policy denials by bounded reason.',
  authentication_successes_total: 'Successful authentication by bounded channel.',
  authentication_failures_total: 'Failed authentication by bounded channel and category.',
  oidc_authentication_total: 'OIDC callback outcomes.',
  approval_outcomes_total: 'Approval resolution and materialization outcomes.',
  approval_conflicts_total: 'Approval decision conflicts by bounded category.',
  idempotency_preventions_total: 'Duplicate effects prevented by idempotency layer.',
  worker_claims_total: 'Worker claim-loop results.',
  worker_retries_total: 'Worker retries by bounded reason.',
  worker_failures_total: 'Worker failures by bounded classification.',
  execution_outcomes_total: 'Execution terminal or uncertain outcomes.',
  reconciliation_attempts_total: 'Reconciliation attempts.',
  reconciliation_outcomes_total: 'Reconciliation results.',
  kill_switch_blocks_total: 'Execution attempts blocked by the kill switch.',
};

const GAUGES: Readonly<Record<string, string>> = {
  pending_approvals: 'Current pending approval requests.',
  oldest_pending_approval_age_seconds: 'Age of the oldest pending approval request.',
  queue_depth: 'Current ready or retryable worker queue depth.',
  oldest_queued_age_seconds: 'Age of the oldest ready or retryable queue entry.',
  pending_reconciliation: 'Current pending reconciliation entries.',
  oldest_reconciliation_age_seconds: 'Age of the oldest pending reconciliation entry.',
  readiness: 'Component readiness, where one is ready and zero is unavailable.',
};

export class OperationalMetrics {
  private readonly counters = new Map<string, number>();
  private readonly readiness = new Map<string, 0 | 1>();

  constructor(private readonly service: 'GATEWAY' | 'WORKER' = 'GATEWAY') {}

  increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    if (!(name in COUNTERS)) throw new Error('Unsafe metric name');
    const metric = `fiar_${name}${validateAndRenderLabels(labels)}`;
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + 1);
  }

  setReadiness(service: 'GATEWAY' | 'WORKER', component: 'DATABASE' | 'AUTHENTICATION' | 'CONNECTOR', ready: boolean): void {
    this.readiness.set(`fiar_readiness${validateAndRenderLabels({ service, component })}`, ready ? 1 : 0);
  }

  async render(pool: Pool): Promise<string> {
    const lines: string[] = [];
    for (const [name, help] of Object.entries(COUNTERS)) {
      lines.push(`# HELP fiar_${name} ${help}`, `# TYPE fiar_${name} counter`);
      const prefix = `fiar_${name}`;
      for (const [series, value] of [...this.counters.entries()].filter(([key]) => key === prefix || key.startsWith(`${prefix}{`)).sort(([a], [b]) => a.localeCompare(b))) lines.push(`${series} ${value}`);
    }
    for (const [name, help] of Object.entries(GAUGES)) lines.push(`# HELP fiar_${name} ${help}`, `# TYPE fiar_${name} gauge`);
    try {
      const result = await pool.query<{
        pending_approvals: string; oldest_pending_approval_seconds: string | null;
        queue_depth: string; oldest_ready_seconds: string | null;
        pending_reconciliation: string; oldest_reconciliation_seconds: string | null;
      }>(`
        select
          (select count(*) from pending_approval_requests where status = 'pending')::text as pending_approvals,
          (select extract(epoch from now() - min(created_at)) from pending_approval_requests where status = 'pending')::text as oldest_pending_approval_seconds,
          (select count(*) from outbox_entries where status in ('ready', 'retryable_failure'))::text as queue_depth,
          (select extract(epoch from now() - min(created_at)) from outbox_entries where status in ('ready', 'retryable_failure'))::text as oldest_ready_seconds,
          (select count(*) from outbox_entries where status = 'pending_reconciliation')::text as pending_reconciliation,
          (select extract(epoch from now() - min(updated_at)) from outbox_entries where status = 'pending_reconciliation')::text as oldest_reconciliation_seconds
      `);
      const row = result.rows[0];
      if (row) lines.push(
        `fiar_pending_approvals ${row.pending_approvals}`,
        `fiar_oldest_pending_approval_age_seconds ${safeGauge(row.oldest_pending_approval_seconds)}`,
        `fiar_queue_depth ${row.queue_depth}`,
        `fiar_oldest_queued_age_seconds ${safeGauge(row.oldest_ready_seconds)}`,
        `fiar_pending_reconciliation ${row.pending_reconciliation}`,
        `fiar_oldest_reconciliation_age_seconds ${safeGauge(row.oldest_reconciliation_seconds)}`,
      );
    } catch {
      this.setReadiness(this.service, 'DATABASE', false);
    }
    for (const [series, value] of [...this.readiness.entries()].sort(([a], [b]) => a.localeCompare(b))) lines.push(`${series} ${value}`);
    return `${lines.join('\n')}\n`;
  }
}

function validateAndRenderLabels(labels: Readonly<Record<string, string>>): string {
  for (const [key, value] of Object.entries(labels)) if (!LABEL_VALUES[key]?.has(value)) throw new Error('Unsafe metric label');
  const text = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}="${value}"`).join(',');
  return text ? `{${text}}` : '';
}

function safeGauge(value: string | null): number {
  if (value === null) return 0;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
