import { pool } from '../db';
import { purgeExpiredAuditLogs } from './auditPurge';
import { recordJobRun } from './jobRuns';

/**
 * One-shot entry point for the scheduler (§13.5: GitHub Actions):
 * `pnpm --filter @crewquo/api purge-audit`. Production invokes this from an
 * external scheduler so cleanup does not depend on one API process staying up.
 *
 * **Every pass writes a `job_runs` row, and that is not bookkeeping.** Until
 * 0020 nothing scheduled this at all, and the way that stayed true for a whole
 * phase is that a purge which never runs looks exactly like a purge with nothing
 * to do. The row is what lets the console say when this last worked, and its
 * absence is what raises the alarm.
 */
try {
  await recordJobRun('audit-retention', async () => {
    const removed = await purgeExpiredAuditLogs();
    console.log(`[audit-purge] done (${removed} rows)`);
    return { succeeded: removed };
  });
} catch (err) {
  console.error('[audit-purge] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
