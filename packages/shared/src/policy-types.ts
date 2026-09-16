export interface Facts {
  tool: string;
  amountMinor: number;
  currency: string;
  orderActive: boolean;
  remainingMinor: number;
  orderExposureMinor: number;
  budgetAvailableMinor: number;
}

export type PolicyDecisionKind = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isFacts(value: unknown): value is Facts {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    typeof value.tool === 'string' &&
    isSafeNonNegativeInteger(value.amountMinor) &&
    typeof value.currency === 'string' &&
    typeof value.orderActive === 'boolean' &&
    isSafeNonNegativeInteger(value.remainingMinor) &&
    isSafeNonNegativeInteger(value.orderExposureMinor) &&
    isSafeNonNegativeInteger(value.budgetAvailableMinor)
  );
}

export function assertFacts(value: unknown): Facts {
  if (!isFacts(value)) {
    throw new TypeError('Invalid policy facts');
  }

  return value;
}
