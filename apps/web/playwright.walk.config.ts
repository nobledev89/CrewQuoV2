import { defineConfig, devices } from '@playwright/test';

/**
 * Design-review harness — deliberately NOT part of `test:e2e`.
 *
 * Runs a dev server on :3001 so a production build on :3000 is left
 * alone, provisions a densely-populated tenant, screenshots every screen at laptop
 * width, and measures how much vertical space each screen spends before its first
 * row of data — §40's density rule is quantitative, so auditing it should be too.
 *
 * Run: pnpm --filter @crewquo/web design:walk   (output in .tmp/walk/)
 */
const HOST = '127.0.0.1';
const PORT = 3001;
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: './walk',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { baseURL: BASE_URL },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Project-level `use` overrides the top level, so the viewport has to be set
        // HERE or devices['Desktop Chrome'] silently wins with its 1280x720. A laptop,
        // because §40's density rule ("20+ rows visible on a laptop screen") is a claim
        // about this viewport specifically.
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command: `next dev -p ${PORT} -H ${HOST}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
