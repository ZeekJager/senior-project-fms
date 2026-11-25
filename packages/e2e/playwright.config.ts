import { defineConfig, devices } from '@playwright/test'

// The golden path (FMS-63, docs/e2e.md) against a running stack: the web app at E2E_WEB_URL (the Vite dev server, which
// proxies /api to the backend) and the API behind it. The whole run has 5 minutes (the card's limit); nothing retries,
// so a pass means it passed once.

export default defineConfig({
  testDir: './tests',
  timeout: 5 * 60_000,
  globalTimeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'Africa/Addis_Ababa',
    locale: 'en-GB',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
