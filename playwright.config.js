import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/QuietChat/',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: { command: 'node scripts/serve.mjs --base /QuietChat/ --port 4173', url: 'http://127.0.0.1:4173/QuietChat/', reuseExistingServer: !process.env.CI },
});
