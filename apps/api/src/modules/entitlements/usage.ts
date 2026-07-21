import type { LimitKey, LimitUsage } from '@crewquo/shared';
import { LIMIT_KEYS } from '@crewquo/shared';
import { queryOne } from '../../db';

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
    // Introduced with engagements in Phase 3.
    case 'active_subcontractors':
    case 'clients':
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
