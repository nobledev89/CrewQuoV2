import { deleteExpiredAuditLogs } from '../modules/audit/repo';

/**
 * Nightly audit retention cleanup (CREWQUO_V2_PLAN.md §3.6 — "cleaned nightly by
 * expires_at; Postgres has no TTL").
 *
 * The purge is idempotent (`delete where expires_at < now()`), so running it on
 * several API instances at once is harmless — which is why an in-process timer
 * is enough and no lock is needed. Set `AUDIT_PURGE_ENABLED=false` and run
 * `pnpm --filter @crewquo/api purge-audit` from a scheduler instead if you'd
 * rather own the cadence externally.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export async function purgeExpiredAuditLogs(): Promise<number> {
  const removed = await deleteExpiredAuditLogs();
  if (removed > 0) console.log(`[audit-purge] removed ${removed} expired audit rows`);
  return removed;
}

/** Start the daily timer. Returns a stop function (used by tests / shutdown). */
export function startAuditPurgeSchedule(intervalMs = DAY_MS): () => void {
  const run = () => {
    void purgeExpiredAuditLogs().catch((err) => {
      console.error('[audit-purge] failed:', err);
    });
  };
  const timer = setInterval(run, intervalMs);
  // Never hold the process open just for the purge.
  timer.unref?.();
  run(); // sweep once at boot so a restarted instance catches up
  return () => clearInterval(timer);
}
