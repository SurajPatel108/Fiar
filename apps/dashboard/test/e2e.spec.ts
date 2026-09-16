import { expect, test } from '@playwright/test';

const app = 'https://127.0.0.1:4210';
const issuer = 'http://127.0.0.1:4211';

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await page.request.get(`${issuer}/control/mode?value=manager`);
});

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(app);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Pending approvals' })).toBeVisible();
}

test('production PKCE login creates a secure manager session and leaves browser storage empty', async ({ page, context }) => {
  await login(page);
  await expect(page.getByText('ord_demo_small')).toBeVisible();
  const session = (await context.cookies()).find((cookie) => cookie.name === '__Host-fiar_session');
  expect(session).toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.secure).toBe(true);
  expect(session?.sameSite).toBe('Strict');
  expect(session?.path).toBe('/');
  expect((session?.expires ?? 0) * 1000).toBeGreaterThan(Date.now());
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
  expect((await context.cookies()).some((cookie) => cookie.name === '__Host-fiar_oidc_flow' && cookie.value.length > 0)).toBe(false);
  const refreshed = await page.request.get(`${app}/v1/auth/session`);
  expect(refreshed.status()).toBe(200);
  const metrics = await page.request.get(`${app}/metrics`, { headers: { authorization: 'Bearer e2e-metrics' } });
  expect(metrics.status()).toBe(200);
  expect(await metrics.text()).toContain('fiar_oidc_authentication_total{outcome="SUCCEEDED"} 1');
});

test('CSRF is enforced and dashboard logout revokes the session', async ({ page }) => {
  await login(page);
  expect((await page.request.post(`${app}/v1/auth/logout`)).status()).toBe(403);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect((await page.request.get(`${app}/v1/auth/session`)).status()).toBe(401);
});

for (const state of ['revoke', 'expire'] as const) {
  test(`${state}d sessions return the manager to sign-in`, async ({ page }) => {
    await login(page);
    await page.request.get(`${issuer}/control/${state}`);
    await page.reload();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });
}

test('an OIDC identity mapped to an agent is denied a manager session', async ({ page }) => {
  await page.request.get(`${issuer}/control/mode?value=agent`);
  await page.goto(app);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByText('Authentication failed')).toBeVisible();
  expect(await page.locator('body').textContent()).not.toContain('agent-subject');
});

test('callback failures are generic and do not expose OIDC material', async ({ page }) => {
  await page.request.get(`${issuer}/control/mode?value=error`);
  await page.goto(app);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByText('Authentication failed')).toBeVisible();
  const body = await page.locator('body').textContent() ?? '';
  expect(body).not.toMatch(/code_verifier|id_token|invalid_grant|manager-subject/);
});

for (const mode of ['state', 'expired_state', 'nonce', 'missing_nonce', 'missing_claims', 'invalid_code', 'replayed_code', 'issuer', 'audience', 'expired_token', 'algorithm', 'signature'] as const) {
  test(`complete browser callback rejects ${mode.replaceAll('_', ' ')}`, async ({ page }) => {
    await page.request.get(`${issuer}/control/mode?value=${mode}`);
    await page.goto(app);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByText('Authentication failed')).toBeVisible();
    expect(page.url().startsWith(`${app}/v1/auth/oidc/callback`)).toBe(true);
  });
}

test('OIDC state is one-use and bound to the initiating browser', async ({ page, browser }) => {
  await login(page);
  const callback = await (await page.request.get(`${issuer}/control/last-callback`)).json() as { path: string };
  const second = await browser.newContext({ ignoreHTTPSErrors: true });
  const replay = await second.newPage();
  await replay.goto(`${app}${callback.path}`);
  await expect(replay.getByText('Authentication failed')).toBeVisible();
  await second.close();
});

test('login and callback parameters cannot create an open redirect', async ({ page }) => {
  const attacks = [
    'https://attacker.example/path', '//attacker.example/path', 'https%3A%2F%2Fattacker.example',
    'https%253A%252F%252Fattacker.example', '\\\\attacker.example', '../..//attacker.example',
  ];
  for (const attack of attacks) {
    await page.goto(`${app}/v1/auth/oidc/start?returnTo=${encodeURIComponent(attack)}&next=${encodeURIComponent(attack)}&redirect=${encodeURIComponent(attack)}`);
    await expect(page).toHaveURL(`${app}/`);
  }
  const callback = await (await page.request.get(`${issuer}/control/last-callback`)).json() as { path: string };
  await page.goto(`${app}${callback.path}&returnTo=${encodeURIComponent('https://attacker.example')}`);
  expect(new URL(page.url()).origin).toBe(app);
  await page.goto(`${app}/v1/auth/oidc/callback?code=missing-state&next=${encodeURIComponent('//attacker.example')}`);
  await expect(page.getByText('Invalid authentication callback')).toBeVisible();
  expect(new URL(page.url()).origin).toBe(app);
});
