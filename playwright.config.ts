import { defineConfig } from '@playwright/test';

/**
 * Browser-level smoke test configuration (Phase 3).
 *
 * Scope: one Chromium project against the real Vite client. The Phase 7 server
 * is not needed — the offline client owns its state — so `webServer` starts only
 * `apps/client`.
 *
 * Determinism: one worker, no retries, a fixed viewport and a fixed clock
 * installed by the test itself. A retry could hide exactly the flakiness this
 * test exists to catch, so it is deliberately off.
 *
 * Artifacts: traces, screenshots and video are kept only for failures; the HTML
 * report is written to `playwright-report/` (git-ignored) for CI to upload.
 */

const PORT = 5173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Vitest collects `**/*.test.ts` only; `.spec.ts` under `e2e/` is invisible to it.
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    // Fixed so canvas coordinates in the test are stable. Phaser scales the
    // canvas to this viewport, so a different size would move every tile.
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    // The client's own dev server, on the port `vite.config.ts` pins with
    // `strictPort`, so a stale server on another port cannot silently be used.
    command: 'pnpm --filter @coc/client dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
