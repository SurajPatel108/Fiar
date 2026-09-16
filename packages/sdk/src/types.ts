export type ActionDecision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

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

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalDecision = 'approve' | 'reject';

export interface SubmitRefundActionRequest {
  tool: 'refund.create';
  orderId: string;
  amountMinor: number;
  currency: 'USD';
  idempotencyKey: string;
}

export interface Action {
  actionId: string;
  status: ActionStatus;
  decision: ActionDecision;
  reason: string;
  approvalId?: string;
  orderId: string;
  amountMinor: number;
  currency: 'USD';
  policyVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalBusinessContext {
  orderFactVersion: string;
  orderActive: boolean | null;
  refundableRemainingMinor: number | null;
  orderExposureMinor: number | null;
  budgetAvailableMinor: number | null;
}

export interface Approval {
  approvalId: string;
  status: ApprovalStatus;
  actionId: string;
  actionStatus: ActionStatus;
  tool: 'refund.create';
  orderId: string;
  amountMinor: number;
  currency: 'USD';
  decisionReason: string;
  requestHash: string;
  policyVersionId: string;
  decision: ApprovalDecision | null;
  comment: string | null;
  resolutionReason: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  context: ApprovalBusinessContext;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ActionListOptions {
  status?: ActionStatus;
  limit?: number;
  cursor?: string;
}

export interface ApprovalListOptions {
  status?: ApprovalStatus;
  limit?: number;
  cursor?: string;
}

export interface ApprovalDecisionRequest {
  decision: ApprovalDecision;
  comment?: string | null;
  expectedRequestHash: string;
  expectedPolicyVersion: string;
}

export interface ApprovalBinding {
  approvalId: string;
  requestHash: string;
  policyVersionId: string;
}

export interface BoundDecisionOptions {
  comment?: string | null;
}

export interface FiarErrorResponse {
  error: string;
  message: string;
}

export type CredentialHeaders = Readonly<Record<string, string>>;
export type CredentialHeaderProvider = () => CredentialHeaders | Promise<CredentialHeaders>;

export type FetchTransport = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface FiarClientOptions {
  baseUrl: string;
  credential?: string;
  credentialHeader?: string;
  headers?: CredentialHeaders;
  getCredentialHeaders?: CredentialHeaderProvider;
  fetch?: FetchTransport;
}
