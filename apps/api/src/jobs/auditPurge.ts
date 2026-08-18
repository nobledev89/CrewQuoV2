import { deleteExpiredAuditLogsForCompany, listAuditCompanyIds } from '../modules/audit/repo';
import { auditExpiry } from '../modules/audit/retention';
import { resolveEntitlements } from '../modules/entitlements/resolve';

/**
 * Audit retention cleanup (CREWQUO_V2_PLAN.md §3.6). Run from the production
 * scheduler with `pnpm --filter @crewquo/api purge-audit`; it deliberately does
 * not depend on an API process staying alive.
 */
export async function purgeExpiredAuditLogs(): Promise<number> {
  let removed = 0;
  for (const companyId of await listAuditCompanyIds()) {
    try {
      const entitlements = await resolveEntitlements(companyId);
      removed += await deleteExpiredAuditLogsForCompany(
        companyId,
        auditExpiry(entitlements.limits.audit_retention_days)
      );
    } catch (err) {
      // A resolver/configuration failure must retain evidence, never erase it.
      console.error(`[audit-purge] skipped company ${companyId}:`, err);
    }
  }
  if (removed > 0) console.log(`[audit-purge] removed ${removed} expired audit rows`);
  return removed;
}
