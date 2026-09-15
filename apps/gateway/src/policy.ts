import type { Facts, PolicyDecision } from '../../../packages/shared/src/policy-types';

function deny(reason: string): PolicyDecision {
  return { decision: 'DENY', reason };
}

export function decide(facts: Facts): PolicyDecision {
  if (!facts.active) {
    return deny('AGENT_SUSPENDED');
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

  if (facts.orderExposureMinor + facts.amountMinor >= 5000) {
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
