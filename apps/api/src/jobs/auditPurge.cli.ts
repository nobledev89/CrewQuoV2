import { pool } from '../db';
import { purgeExpiredAuditLogs } from './auditPurge';

/**
 * One-shot entry point for an external scheduler (Render Cron, GitHub Actions):
 * `pnpm --filter @crewquo/api purge-audit`. The API also runs this daily
 * in-process unless AUDIT_PURGE_ENABLED=false — see ./auditPurge.ts.
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
