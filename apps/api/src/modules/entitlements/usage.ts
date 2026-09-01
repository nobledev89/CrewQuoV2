import type { LimitKey, LimitUsage } from '@crewquo/shared';
import { LIMIT_KEYS, bytesToGb } from '@crewquo/shared';
import { queryOne } from '../../db';
import { countActiveSubcontractors, countClients } from '../engagements/repo';
import { evidenceUploadsThisMonth, storageBytesForCompany } from '../storage/repo';

/**
 * Live usage per limit key. Some meters depend on tables introduced in later
 * phases (engagements → Phase 3); those return 0 until then. `audit_retention_days`
 * is a config value, not a meter, so its usage is always 0.
 */
async function countInternalSeats(companyId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::int as n from memberships where company_id = $1 and status = 'ACTIVE'`,
    [companyId]
  );
  return Number(row?.n ?? 0);
}

export async function getUsage(companyId: string, key: LimitKey): Promise<number> {
  switch (key) {
    case 'internal_seats':
      return countInternalSeats(companyId);
    case 'active_subcontractors':
      return countActiveSubcontractors(companyId);
    case 'clients':
      return countClients(companyId);
    /**
     * The first meter here whose unit is not a count (§43, Phase 7). Bytes are
     * summed in the database and converted **once**, here at the boundary, so a
     * caller of `withinLimit` passes gigabytes and never bytes — see `bytesToGb`
     * for why that distinction is worth a named function.
     */
    case 'storage_gb':
      return bytesToGb(await storageBytesForCompany(companyId));
    /** And the first windowed one: the month is the company's own, not the server's. */
    case 'evidence_uploads_per_month':
      return evidenceUploadsThisMonth(companyId);
    // audit_retention_days is a config value, not a meter.
    case 'audit_retention_days':
      return 0;
  }
}

export async function getAllUsage(
  companyId: string,
  limits: Partial<Record<LimitKey, number | null>>
): Promise<LimitUsage[]> {
  const keys = LIMIT_KEYS.filter((k) => k in limits);
  return Promise.all(
    keys.map(async (key) => ({ key, value: limits[key] ?? null, used: await getUsage(companyId, key) }))
  );
}
