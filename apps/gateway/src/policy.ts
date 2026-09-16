import { isFacts, type Facts, type PolicyDecision } from '../../../packages/shared/src/policy-types';

function deny(reason: string): PolicyDecision {
  return { decision: 'DENY', reason };
}

export function decide(input: Facts, approvalThresholdMinor: unknown = 5000): PolicyDecision {
  if (!isFacts(input) || !Number.isSafeInteger(approvalThresholdMinor) || (approvalThresholdMinor as number) < 1) {
    return deny('INVALID_FACTS');
  }

  const facts = input;

  if (!facts.orderActive) {
    return deny('ORDER_NOT_ACTIVE');
  }

  if (facts.tool !== 'refund.create') {
    return deny('TOOL_NOT_ALLOWED');
  }

  if (!Number.isSafeInteger(facts.amountMinor) || facts.amountMinor < 1 || facts.currency !== 'USD') {
    return deny('INVALID_AMOUNT_OR_CURRENCY');
  }

  if (facts.amountMinor > facts.remainingMinor) {
    return deny('EXCEEDS_REFUNDABLE_BALANCE');
  }

  if (facts.amountMinor > facts.budgetAvailableMinor) {
    return deny('BUDGET_EXCEEDED');
  }

  if (facts.orderExposureMinor + facts.amountMinor >= (approvalThresholdMinor as number)) {
    return {
      decision: 'REQUIRE_APPROVAL',
      reason: 'ORDER_EXPOSURE_THRESHOLD',
    };
  }

  return {
    decision: 'ALLOW',
    reason: 'WITHIN_POLICY',
  };
}
