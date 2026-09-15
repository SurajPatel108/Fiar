export interface Facts {
  tool: string;
  amountMinor: number;
  currency: string;
  active: boolean;
  remainingMinor: number;
  orderExposureMinor: number;
  budgetAvailableMinor: number;
}

export type PolicyDecisionKind = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
}
