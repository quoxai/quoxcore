import { defineConfig } from '@playwright/test';
import fs from 'fs';
import { resolve } from 'path';

/**
 * Playwright Config for QuoxCORE Dashboard
 *
 * Usage:
 *   Explicit target:     BASE_URL=https://localhost:3443 npx playwright test
 *   Development (vite):  npx playwright test
 *
 * Run specific tests:
 *   npx playwright test tests/auth.spec.js --headed
 */
const DEFAULT_BASE_URL = process.env.BASE_URL || 'https://127.0.0.1:3000';
const USE_LOCAL_DEV_SERVER = /https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(DEFAULT_BASE_URL);

export default defineConfig({
  testDir: './tests',
  timeout: 120000,
  expect: {
    timeout: 30000
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    // Canonical workstation/browser target is the dashboard on 3000.
    // Override with BASE_URL when intentionally targeting another deployment.
    baseURL: DEFAULT_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,  // Allow self-signed certs
  },
  ...(USE_LOCAL_DEV_SERVER ? {
    webServer: {
      command: 'npm run dev -- --host 0.0.0.0 --port 3000',
      url: DEFAULT_BASE_URL || (
        fs.existsSync(resolve(__dirname, 'certs/key.pem'))
          ? 'https://localhost:3000'
          : 'http://localhost:3000'
      ),
      ignoreHTTPSErrors: true,
      reuseExistingServer: true,
      timeout: 60000,
    }
  } : {}),
});
