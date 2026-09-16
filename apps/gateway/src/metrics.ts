import type { Pool } from 'pg';

const LABEL_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  category: new Set(['INVALID', 'MALFORMED', 'EXPIRED', 'REVOKED', 'STALE_OR_RESOLVED']),
  channel: new Set(['REQUEST', 'DEVELOPMENT', 'WORKLOAD', 'SESSION', 'OIDC']),
  component: new Set(['DATABASE', 'AUTHENTICATION', 'CONNECTOR']),
  decision: new Set(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']),
  layer: new Set(['ACTION', 'PROVIDER']),
  outcome: new Set(['APPROVED', 'REJECTED', 'EXPIRED', 'CONFIRMED_SUCCESS', 'CONFIRMED_FAILURE', 'RETRYABLE_FAILURE', 'AMBIGUOUS', 'SUCCESS', 'FAILURE']),
  reason: new Set(['INVALID_FACTS', 'ORDER_NOT_ACTIVE', 'TOOL_NOT_ALLOWED', 'INVALID_AMOUNT_OR_CURRENCY', 'EXCEEDS_REFUNDABLE_BALANCE', 'BUDGET_EXCEEDED', 'ORDER_EXPOSURE_THRESHOLD', 'WITHIN_POLICY', 'PRE_PROVIDER', 'OTHER']),
  result: new Set(['EXECUTED', 'PENDING_RECONCILIATION', 'BLOCKED', 'NONE', 'RESOLVED']),
  service: new Set(['GATEWAY', 'WORKER']),
};

export class OperationalMetrics {
  private readonly counters = new Map<string, number>();
  increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    if (!/^[a-z_]{1,64}$/.test(name)) throw new Error('Unsafe metric name');
    for (const [key, value] of Object.entries(labels)) {
      if (!LABEL_VALUES[key]?.has(value)) throw new Error('Unsafe metric label');
    }
    const labelText = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}="${value}"`).join(',');
    const metric = `fiar_${name}${labelText ? `{${labelText}}` : ''}`;
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + 1);
  }
  async render(pool: Pool): Promise<string> {
    const lines = [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name} ${value}`);
    try {
      const result = await pool.query<{ pending_approvals: string; queue_depth: string; pending_reconciliation: string; oldest_ready_seconds: string | null; oldest_reconciliation_seconds: string | null }>(`
        select
          (select count(*) from pending_approval_requests where status = 'pending')::text as pending_approvals,
          (select count(*) from outbox_entries where status in ('ready', 'retryable_failure'))::text as queue_depth,
          (select count(*) from outbox_entries where status = 'pending_reconciliation')::text as pending_reconciliation,
          (select extract(epoch from now() - min(created_at)) from outbox_entries where status in ('ready', 'retryable_failure'))::text as oldest_ready_seconds,
          (select extract(epoch from now() - min(updated_at)) from outbox_entries where status = 'pending_reconciliation')::text as oldest_reconciliation_seconds
      `);
      const row = result.rows[0];
      if (row) lines.push(
        `fiar_pending_approvals ${row.pending_approvals}`,
        `fiar_queue_depth ${row.queue_depth}`,
        `fiar_pending_reconciliation ${row.pending_reconciliation}`,
        `fiar_oldest_ready_seconds ${safeGauge(row.oldest_ready_seconds)}`,
        `fiar_oldest_reconciliation_seconds ${safeGauge(row.oldest_reconciliation_seconds)}`,
      );
    } catch { lines.push('fiar_readiness{component="DATABASE"} 0'); }
    return `${lines.join('\n')}\n`;
  }
}

function safeGauge(value: string | null): number {
  if (value === null) return 0;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
