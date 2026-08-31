import { pool } from '../db';
import { runClosurePass } from './closures';
import { recordJobRun } from './jobRuns';

/**
 * One-shot entry point for the scheduler:
 * `pnpm --filter @crewquo/api run-closures`.
 *
 * One-shot for the reason every other job here is (`workers.cli.ts`): an external
 * scheduler restarts a dead job, whereas an interval inside the API server stops
 * the moment that process falls over and does nothing at all if the service scales
 * to zero.
 *
 * **The `job_runs` row matters more here than anywhere else in this repository.**
 * Every other scheduled pass fails by leaving work undone — an undrained outbox, an
 * unpurged audit row — and a customer eventually notices. This one fails by leaving
 * a promise unkept: somebody was told their account would close on the 28th, and on
 * the 28th nothing happened. Nobody notices that, because the person who would has
 * stopped signing in. The dead man's switch on this job is the only thing that
 * would ever say so.
 */
try {
  await recordJobRun('closures', async () => {
    const result = await runClosurePass();
    console.log(
      `[closures] warned=${result.warned} claimed=${result.claimed} ` +
        `completed=${result.completed} blocked=${result.blocked} failed=${result.failed}` +
        (result.recovered > 0 ? ` recovered=${result.recovered}` : '')
    );
    /*
     * A blocked run is not a failure and must not be counted as one: the deletion is
     * waiting on the customer to end an engagement, which is the design working. It
     * is visible on the request row and on their own screen. Counting it as failed
     * would make the operator console red for a company taking its time.
     */
    return {
      claimed: result.claimed,
      succeeded: result.completed + result.warned,
      failed: result.failed,
    };
  });
  console.log('[closures] done');
} catch (err) {
  console.error('[closures] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
