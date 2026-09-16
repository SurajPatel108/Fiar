const FORBIDDEN_KEY = /(authorization|cookie|session|csrf|token|credential|verifier|pepper|secret|password|database.?url|oidc.?code)/i;
const SECRET_VALUE = /(bearer\s+\S+|fiar_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+|postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@)/i;
const MAX_BYTES = 8 * 1024;

export function sanitizeAuditPayload(
  payload: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (!allowedKeys.has(key) || FORBIDDEN_KEY.test(key)) throw new Error('Unsafe audit payload field');
    output[key] = sanitizeValue(value, 0);
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_BYTES) throw new Error('Audit payload is too large');
  return output;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) throw new Error('Audit payload is too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.length > 512 || SECRET_VALUE.test(value)) throw new Error('Unsafe audit payload value');
    return value;
  }
  if (Array.isArray(value)) throw new Error('Audit payload arrays are not allowed');
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error('Unsafe nested audit payload field');
      result[key] = sanitizeValue(nested, depth + 1);
    }
    return result;
  }
  throw new Error('Unsupported audit payload value');
}
