import { pool } from '../db';
import { pruneAuthState } from './authRetention';
import { pruneJobRuns, recordJobRun } from './jobRuns';

/**
 * One-shot entry point for an external scheduler:
 * `pnpm --filter @crewquo/api purge-auth`.
 *
 * One-shot rather than an interval inside the API, for the same reason the audit
 * purge is: a `setInterval` in a server process stops pruning the moment that one
 * process falls over, and does nothing at all if the API scales to zero.
 */
try {
  await recordJobRun('auth-retention', async () => {
    const { attempts, sessions } = await pruneAuthState();
    console.log(`[auth-retention] done (${attempts} attempts, ${sessions} sessions)`);
    // Also prunes `job_runs` itself, on the same 30-day operational clock (§7).
    // Deliberately not its own job: a table that records whether jobs run,
    // pruned by a job that can stop, would be one more thing to notice had
    // stopped.
    const runs = await pruneJobRuns();
    if (runs > 0) console.log(`[auth-retention] pruned ${runs} job run(s)`);
    return { succeeded: attempts + sessions + runs };
  });
} catch (err) {
  console.error('[auth-retention] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
