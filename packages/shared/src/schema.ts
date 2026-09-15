export type RefundActionTool = 'refund.create';

export interface RefundActionRequest {
  tool: RefundActionTool;
  orderId: string;
  amountMinor: number;
  currency: 'USD';
  idempotencyKey: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isRefundActionRequest(value: unknown): value is RefundActionRequest {
  if (!isPlainObject(value)) {
    return false;
  }

  const allowedKeys = ['tool', 'orderId', 'amountMinor', 'currency', 'idempotencyKey'];
  const keys = Object.keys(value);

  if (keys.length !== allowedKeys.length || keys.some((key) => !allowedKeys.includes(key))) {
    return false;
  }

  const amountMinor = value.amountMinor;

  return (
    value.tool === 'refund.create' &&
    isNonEmptyString(value.orderId) &&
    typeof amountMinor === 'number' &&
    Number.isSafeInteger(amountMinor) &&
    amountMinor > 0 &&
    value.currency === 'USD' &&
    isNonEmptyString(value.idempotencyKey)
  );
}

export function assertRefundActionRequest(value: unknown): RefundActionRequest {
  if (!isRefundActionRequest(value)) {
    throw new TypeError('Invalid refund action request');
  }

  return value;
}
