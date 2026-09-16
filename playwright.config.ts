import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'apps/dashboard/test',
  testMatch: 'e2e.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  use: { browserName: 'chromium', channel: process.env.CI ? 'chromium' : 'chrome', ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'npx tsx apps/dashboard/test/e2e-server.ts',
    url: 'https://127.0.0.1:4210/health/live',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
