import {
  canonicalizeRefundActionRequest,
  hashCanonicalRefundActionRequest,
  stableStringify,
} from '../../../packages/shared/src/canonical-request';
import { assertRefundActionRequest, type RefundActionRequest } from '../../../packages/shared/src/schema';

export function parseAndCanonicalizeRefundRequest(value: unknown): {
  request: RefundActionRequest;
  canonicalRequest: ReturnType<typeof canonicalizeRefundActionRequest>;
  requestHash: string;
} {
  const request = assertRefundActionRequest(value);
  const canonicalRequest = canonicalizeRefundActionRequest(request);
  return {
    request,
    canonicalRequest,
    requestHash: hashCanonicalRefundActionRequest(canonicalRequest),
  };
}

export function serializeCanonicalRequest(value: unknown): string {
  return stableStringify(value);
}
