// R176 smoke - Playwright config for the DEPLOYED site (no local server).
// Chromium only, one worker, no retries (a flaky pass must not hide a real failure).
import { defineConfig, devices } from '@playwright/test';
import { baseFor } from './config.mjs';

const baseURL = baseFor(process.env.SMOKE_TARGET || 'staging');

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.smoke\.spec\.mjs$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'out/browser-results.json' }]],
  outputDir: 'out/artifacts',
  use: {
    baseURL,
    // no extra request headers: a custom header would trigger CORS preflights on Supabase calls (false errors)
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
