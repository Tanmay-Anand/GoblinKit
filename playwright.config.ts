import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: the real canvas in a real browser, against the real
 * local server — nothing mocked.
 *
 * The tests start their own pair of servers on their own ports, over a
 * throwaway workspace, so they never touch your workflows and can run while
 * `pnpm dev` is open.
 *
 *   pnpm test:e2e          run headless
 *   pnpm test:e2e:ui       Playwright's UI mode, for writing and debugging
 */

const CI = !!process.env['CI'];
const API_PORT = 8788;
const WEB_PORT = 5174;
const workspace = fileURLToPath(new URL('./e2e/.workspace', import.meta.url));

// Start each run from an empty workspace. Only the runner process does this:
// workers load this file too, and must not delete what the server is using.
if (!process.env['TEST_WORKER_INDEX']) rmSync(workspace, { recursive: true, force: true });

export default defineConfig({
  testDir: './e2e',
  // Each test arranges its own workflow through the API, so tests share no
  // state and can run in parallel.
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  ...(CI ? { workers: 2 } : {}),
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  expect: { timeout: 7_000 },

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    {
      name: 'chrome',
      // The installed Google Chrome, rather than a downloaded Chromium build.
      // On a machine without Chrome: `pnpm exec playwright install chrome`.
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } },
    },
  ],

  webServer: [
    {
      name: 'api',
      command: 'node node_modules/tsx/dist/cli.mjs apps/api/src/main.ts',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: { GOBLIN_PORT: String(API_PORT), GOBLIN_WORKSPACE: workspace },
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      name: 'web',
      command: 'node node_modules/vite/bin/vite.js --config apps/web/vite.config.ts',
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { GOBLIN_WEB_PORT: String(WEB_PORT), GOBLIN_API_PORT: String(API_PORT) },
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
