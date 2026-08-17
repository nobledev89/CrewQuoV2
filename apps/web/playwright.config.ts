import { defineConfig, devices } from '@playwright/test';

/**
 * Web E2E for the core workflows.
 *
 * These are *not* mocked. The spec drives the real Next.js app against the real API
 * against a real Postgres, because the thing being proven is that every workflow
 * CrewQuo already supports is reachable from the browser — and a mocked API would
 * prove only that the components render.
 *
 * Prerequisites (the same ones `verify:e2e` needs):
 *   1. Postgres up:  docker compose --env-file .env -f infra/docker-compose.yml up -d
 *   2. Migrated and seeded:  pnpm db:migrate && pnpm db:seed
 *   3. API running on :4000:  pnpm --filter @crewquo/api dev
 *
 * The web server is started by Playwright itself. `reuseExistingServer` keeps a dev
 * server you already have running, so a local watch loop is not fought over.
 *
 * **The host is `127.0.0.1`, not `localhost`, on purpose.** `next start` with no `-H`
 * binds `::` and on this platform `localhost` resolves to the IPv4 loopback first, so
 * the health poll never connects and the run hangs until it times out — with the server
 * itself perfectly healthy. This is the same port-shadowing footgun the repo already
 * pinned down for Postgres (see PROGRESS.md, Phase 1 local env note); the answer is the
 * same, name the address explicitly on both ends.
 */
const HOST = '127.0.0.1';
const PORT = 3000;
const BASE_URL = process.env.WEB_BASE_URL ?? `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Serial: the spec provisions companies and engagements, and parallel workers
  // racing on the same seeded plans would make failures look like flakes.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `next start -p ${PORT} -H ${HOST}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
    // Piped, not ignored: a server that fails to boot should say why in the run output
    // rather than surfacing as an unexplained health-check timeout.
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
