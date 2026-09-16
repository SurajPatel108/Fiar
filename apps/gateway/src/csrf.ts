import { hmacSha256, randomToken, timingSafeHexEqual } from '../../../packages/shared/src/secure-values';

export function createCsrfToken(sessionId: string, secret: string, ttlSeconds = 900, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const nonce = randomToken(16);
  return `${expires}.${nonce}.${hmacSha256(`${sessionId}.${expires}.${nonce}`, secret)}`;
}
export function verifyCsrfToken(token: string, sessionId: string, secret: string, now = Date.now()): boolean {
  if (token.length > 256) return false;
  const match = /^(\d{10})\.([A-Za-z0-9_-]{22})\.([a-f0-9]{64})$/.exec(token);
  if (!match?.[1] || !match[2] || !match[3] || Number(match[1]) < Math.floor(now / 1000)) return false;
  return timingSafeHexEqual(hmacSha256(`${sessionId}.${match[1]}.${match[2]}`, secret), match[3]);
}
