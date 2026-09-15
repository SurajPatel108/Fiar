export type ActionStatus =
  | 'pending'
  | 'denied'
  | 'awaiting_approval'
  | 'approved'
  | 'queued'
  | 'dispatched'
  | 'pending_reconciliation'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'canceled'
  | 'suspended';

export const ACTION_TERMINAL_STATUSES = [
  'denied',
  'completed',
  'failed',
  'expired',
  'canceled',
  'suspended',
] as const satisfies readonly ActionStatus[];

export const ACTION_STATUS_TRANSITIONS: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  pending: ['denied', 'awaiting_approval', 'queued', 'suspended'],
  denied: [],
  awaiting_approval: ['approved', 'denied', 'expired', 'suspended'],
  approved: ['queued', 'suspended'],
  queued: ['dispatched', 'pending_reconciliation', 'suspended'],
  dispatched: ['completed', 'failed', 'pending_reconciliation'],
  pending_reconciliation: ['queued', 'completed', 'failed', 'suspended'],
  completed: [],
  failed: [],
  expired: [],
  canceled: [],
  suspended: [],
} as const;

export function isTerminalActionStatus(status: ActionStatus): boolean {
  return ACTION_TERMINAL_STATUSES.includes(status as (typeof ACTION_TERMINAL_STATUSES)[number]);
}

export function canTransitionActionStatus(from: ActionStatus, to: ActionStatus): boolean {
  return ACTION_STATUS_TRANSITIONS[from].includes(to);
}
