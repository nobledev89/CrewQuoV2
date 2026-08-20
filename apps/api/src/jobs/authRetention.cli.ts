import { pool } from '../db';
import { pruneAuthState } from './authRetention';

/**
 * One-shot entry point for an external scheduler:
 * `pnpm --filter @crewquo/api purge-auth`.
 *
 * One-shot rather than an interval inside the API, for the same reason the audit
 * purge is: a `setInterval` in a server process stops pruning the moment that one
 * process falls over, and does nothing at all if the API scales to zero.
 */
try {
  const { attempts, sessions } = await pruneAuthState();
  console.log(`[auth-retention] done (${attempts} attempts, ${sessions} sessions)`);
} catch (err) {
  console.error('[auth-retention] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
