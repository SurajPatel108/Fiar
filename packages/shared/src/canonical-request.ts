import { createHash } from 'node:crypto';

import type { RefundActionRequest } from './schema';

export interface CanonicalRefundActionRequest {
  tool: RefundActionRequest['tool'];
  orderId: string;
  amountMinor: number;
  currency: RefundActionRequest['currency'];
}

export function canonicalizeRefundActionRequest(request: RefundActionRequest): CanonicalRefundActionRequest {
  return {
    tool: request.tool,
    orderId: request.orderId,
    amountMinor: request.amountMinor,
    currency: request.currency,
  };
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

export function hashCanonicalRefundActionRequest(request: CanonicalRefundActionRequest): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      normalized[key] = normalizeValue(entry);
    }

    return normalized;
  }

  return value;
}
