const FORBIDDEN_KEY = /(authorization|cookie|setcookie|session|csrf|token|credential|verifier|pepper|secret|password|databaseurl|oidccode|pkce|clientsecret|providerkey|connectorkey)/i;
const SECRET_VALUE = /(bearer\s+\S+|basic\s+\S+|fiar_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+|postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:access|refresh|id|client|provider)[_ -]?(?:token|secret|key)\s*[:=]\s*\S+)/iu;
const MAX_BYTES = 8 * 1024;

export function sanitizeAuditPayload(
  payload: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (!allowedKeys.has(key) || isForbiddenKey(key)) throw new Error('Unsafe audit payload field');
    output[key] = sanitizeValue(value, 0);
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_BYTES) throw new Error('Audit payload is too large');
  return output;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) throw new Error('Audit payload is too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const normalized = value.normalize('NFKC');
    if (Buffer.byteLength(normalized, 'utf8') > 512 || SECRET_VALUE.test(normalized)) throw new Error('Unsafe audit payload value');
    return value;
  }
  if (Array.isArray(value)) throw new Error('Audit payload arrays are not allowed');
  if (typeof value === 'object' && value !== null) {
    if (value instanceof Error || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Unsafe audit payload object');
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isForbiddenKey(key)) throw new Error('Unsafe nested audit payload field');
      result[key] = sanitizeValue(nested, depth + 1);
    }
    return result;
  }
  throw new Error('Unsupported audit payload value');
}

function isForbiddenKey(value: string): boolean {
  return FORBIDDEN_KEY.test(value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, ''));
}
