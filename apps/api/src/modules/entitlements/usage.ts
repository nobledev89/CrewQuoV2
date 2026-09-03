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
    /**
     * Phase 9 (§43, `sustainability.md` §0 finding 9). **The company's OWN sets,
     * never the platform library**, which is the whole of what makes this key
     * different from every other one here.
     *
     * A factor set is company reference data used across every project that company
     * owns, so the ceiling is charged to the company that imported it and to nobody
     * else — unlike `storage_gb`, which is charged to the project owner rather than
     * to the uploader. The platform library is `company_id is null` and is read-only
     * to everybody, so counting it would charge every customer for rows they cannot
     * delete.
     *
     * Inactive sets count. A deactivated set still holds its factor rows and is
     * still what a report generated last quarter cites; if the ceiling ignored them,
     * "deactivate and import another" would be an unlimited allowance.
     */
    case 'factor_sets':
      return countFactorSets(companyId);
    // audit_retention_days is a config value, not a meter.
    case 'audit_retention_days':
    case 'artifact_retention_days':
      return 0;
  }
}

async function countFactorSets(companyId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::int as n from emission_factor_sets where company_id = $1`,
    [companyId]
  );
  return Number(row?.n ?? 0);
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
