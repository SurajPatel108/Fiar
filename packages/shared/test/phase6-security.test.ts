import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sanitizeAuditPayload } from '../src/audit-redaction';
import { parseRuntimeMode } from '../src/runtime';
import { FileSecretProvider } from '../src/secrets';
import { hmacSha256, timingSafeHexEqual } from '../src/secure-values';
import { createCsrfToken, verifyCsrfToken } from '../../../apps/gateway/src/csrf';
import { loadGatewayConfig } from '../../../apps/gateway/src/config';
import { OperationalMetrics } from '../../../apps/gateway/src/metrics';
import { operationalLog } from '../src/operational-log';

test('runtime mode is explicit and closed to unknown values', () => {
  assert.equal(parseRuntimeMode('production'), 'production');
  assert.throws(() => parseRuntimeMode(undefined), /FIAR_RUNTIME_MODE/);
  assert.throws(() => parseRuntimeMode('staging'), /FIAR_RUNTIME_MODE/);
});

test('production configuration rejects development credentials before listening', () => {
  assert.throws(() => loadGatewayConfig({ FIAR_RUNTIME_MODE: 'production', FIAR_DATABASE_URL: 'postgresql://db', FIAR_DEV_CREDENTIALS_JSON: '[]' }), /forbidden/);
  assert.throws(() => loadGatewayConfig({ FIAR_DATABASE_URL: 'postgresql://db' }), /FIAR_RUNTIME_MODE/);
});

test('HMAC verification and CSRF tokens are bound and expire', () => {
  const verifier = hmacSha256('secret', 'pepper');
  assert.equal(timingSafeHexEqual(verifier, hmacSha256('secret', 'pepper')), true);
  assert.equal(timingSafeHexEqual(verifier, hmacSha256('other', 'pepper')), false);
  const now = 1_700_000_000_000;
  const token = createCsrfToken('ses_1', 'csrf', 60, now);
  assert.equal(verifyCsrfToken(token, 'ses_1', 'csrf', now), true);
  assert.equal(verifyCsrfToken(token, 'ses_2', 'csrf', now), false);
  assert.equal(verifyCsrfToken(token, 'ses_1', 'csrf', now + 61_000), false);
});

test('audit allowlists reject nested and value-shaped secrets', () => {
  assert.deepEqual(sanitizeAuditPayload({ status: 'queued' }, new Set(['status'])), { status: 'queued' });
  assert.throws(() => sanitizeAuditPayload({ authorization: 'Bearer value' }, new Set(['authorization'])));
  assert.throws(() => sanitizeAuditPayload({ status: { cookie: 'value' } }, new Set(['status'])));
  assert.throws(() => sanitizeAuditPayload({ status: 'fiar_wcr_abc_secret' }, new Set(['status'])));
  assert.throws(() => sanitizeAuditPayload({ status: ['queued'] }, new Set(['status'])), /arrays/);
});

test('audit redaction rejects realistic secret keys, values, depth, size, and error payloads', () => {
  const allowed = new Set(['status']);
  const unsafeKeys = ['Authorization', 'set-cookie', 'SESSION_ID', 'csrfToken', 'client_secret', 'pkce-verifier', 'providerKey', 'Ｄａｔａｂａｓｅ＿ＵＲＬ'];
  for (const key of unsafeKeys) assert.throws(() => sanitizeAuditPayload({ status: { [key]: 'value' } }, allowed), /Unsafe/);
  const values = [
    'Bearer raw-access-token', 'Basic Y2xpZW50OnNlY3JldA==', 'fiar_session_ses_deadbeef_secret',
    'postgresql://user:password@database.internal/fiar',
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJtYW5hZ2VyIn0.c2lnbmF0dXJlMTIzNA',
    'refresh_token=raw-refresh-token', 'ｂｅａｒｅｒ raw-unicode-token',
  ];
  for (const value of values) assert.throws(() => sanitizeAuditPayload({ status: value }, allowed), /Unsafe/);
  assert.throws(() => sanitizeAuditPayload({ status: { one: { two: { three: { four: { five: 'deep' } } } } } }, allowed), /deep/);
  assert.throws(() => sanitizeAuditPayload({ status: 'x'.repeat(513) }, allowed), /Unsafe/);
  assert.throws(() => sanitizeAuditPayload({ status: new Error('Bearer should-never-log') }, allowed), /Unsafe/);
});

test('operational logger retains diagnostics but redacts secret-shaped allowed values and drops unknown fields', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (value?: unknown) => { lines.push(String(value)); };
  try {
    operationalLog('error', { event: 'gateway.start_failed', service: 'gateway', reason: 'Bearer raw-secret', databaseUrl: 'postgresql://u:p@db/fiar' } as Record<string, string>);
  } finally { console.error = original; }
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /gateway.start_failed/);
  assert.match(lines[0]!, /REDACTED/);
  assert.doesNotMatch(lines[0]!, /raw-secret|postgresql|databaseUrl/);
});

test('mounted secret provider accepts safe files and rejects writable files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fiar-secret-'));
  const path = join(directory, 'secret');
  await writeFile(path, 'safe-value\n', { mode: 0o400 });
  assert.equal(await new FileSecretProvider({ key: path }).get('key'), 'safe-value');
  const optional = join(directory, 'optional');
  await writeFile(optional, '', { mode: 0o400 });
  assert.equal(await new FileSecretProvider({ key: optional }).get('key', false), null);
  await assert.rejects(new FileSecretProvider({ key: optional }).get('key'), /unavailable or unsafe/);
  await chmod(path, 0o622);
  await assert.rejects(new FileSecretProvider({ key: path }).get('key'), /unavailable or unsafe/);
});

test('metrics accept only bounded enumerated labels', () => {
  const metrics = new OperationalMetrics();
  metrics.increment('authentication_failures_total', { category: 'INVALID', channel: 'REQUEST' });
  assert.throws(() => metrics.increment('authentication_failures_total', { tenant: 'ten_demo_alpha' }), /Unsafe metric label/);
  assert.throws(() => metrics.increment('authentication_failures_total', { message: 'arbitrary error message' }), /Unsafe metric label/);
  assert.throws(() => metrics.increment('unsafe'), /Unsafe metric name/);
});
