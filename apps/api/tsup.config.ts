import { defineConfig } from 'tsup';

/**
 * The HTTP service is not the whole API deployment. Build every production
 * process so scheduled work cannot quietly keep executing source TypeScript
 * after the server has moved to a JavaScript artifact.
 *
 * `@crewquo/shared` exposes source to monorepo clients. It is therefore bundled;
 * ordinary runtime packages remain external and are installed from the lockfile.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'admin/grant-super-admin': 'src/modules/admin/grantSuperAdmin.cli.ts',
    'jobs/workers': 'src/jobs/workers.cli.ts',
    'jobs/closures': 'src/jobs/closures.cli.ts',
    'jobs/purge-audit': 'src/jobs/auditPurge.cli.ts',
    'jobs/purge-auth': 'src/jobs/authRetention.cli.ts',
    'operations/launch-check': 'src/launch/launchCheck.cli.ts',
  },
  outDir: 'dist',
  clean: true,
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  splitting: false,
  minify: false,
  dts: false,
  noExternal: ['@crewquo/shared'],
});
