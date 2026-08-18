import { pool } from '../db';
import { purgeExpiredAuditLogs } from './auditPurge';

/**
 * One-shot entry point for an external scheduler (Render Cron, GitHub Actions):
 * `pnpm --filter @crewquo/api purge-audit`. Production invokes this from an
 * external scheduler so cleanup does not depend on one API process staying up.
 */
try {
  const removed = await purgeExpiredAuditLogs();
  console.log(`[audit-purge] done (${removed} rows)`);
} catch (err) {
  console.error('[audit-purge] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
