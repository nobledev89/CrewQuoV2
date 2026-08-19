import type { CompanySummary, UpdateCompany } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

export interface CompanyRow {
  id: string;
  name: string;
  currency: string;
  time_zone: string;
  is_placeholder: boolean;
  claimed_by_company_id: string | null;
  /**
   * Legal identity (§3.1.1(6)). Nullable because every company created before
   * migration 0011 has neither, and because plenty of jurisdictions and entity
   * types have no registration identifier at all. The duplicate check treats
   * absent as "no signal", never as a match.
   */
  country: string | null;
  registration_id: string | null;
}

const COMPANY_COLUMNS =
  'id, name, currency, time_zone, is_placeholder, claimed_by_company_id, country, registration_id';

export function toCompanySummary(row: CompanyRow): CompanySummary {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    timeZone: row.time_zone,
    isPlaceholder: row.is_placeholder,
    country: row.country,
    registrationId: row.registration_id,
  };
}

export function findCompanyById(id: string, runner?: Queryable): Promise<CompanyRow | null> {
  return queryOne<CompanyRow>(
    `select ${COMPANY_COLUMNS} from companies where id = $1`,
    [id],
    runner
  );
}

/** Company settings patch (§7). Only the name and currency are editable today. */
export async function updateCompany(
  id: string,
  patch: UpdateCompany,
  runner?: Queryable
): Promise<CompanyRow> {
  const row = await queryOne<CompanyRow>(
    `update companies set
       name = coalesce($2, name),
       currency = coalesce($3, currency),
       time_zone = coalesce($4, time_zone),
       updated_at = now()
     where id = $1
     returning ${COMPANY_COLUMNS}`,
    [id, patch.name ?? null, patch.currency ?? null, patch.timeZone ?? null],
    runner
  );
  if (!row) throw new AppError('NOT_FOUND', 'Company not found');
  return row;
}

/**
 * A placeholder stops being a placeholder the moment a real person owns it.
 *
 * `is_placeholder` means "a stub for a party not yet on CrewQuo" (§3.1). When an
 * invitee accepts and *claims* the stub — the CLAIMED path, where they had no
 * company of their own — that description stops being true: someone signed in,
 * it is their real company, and it is the one they log time from. Leaving the flag
 * set made the UI report "Invitation pending" for a subcontractor who had plainly
 * joined, and made §5B's "only real portal logins count toward `clients`"
 * unimplementable, since the flag no longer distinguished a stub from a customer.
 *
 * The MERGED path does not come through here: there the placeholder really does
 * stay a placeholder, tombstoned via `claimed_by_company_id` (see `merge.ts`).
 */
export async function markCompanyClaimed(id: string, runner?: Queryable): Promise<void> {
  await query(
    `update companies set is_placeholder = false, updated_at = now()
      where id = $1 and is_placeholder`,
    [id],
    runner
  );
}

/**
 * The raw insert. **Not** the way a tenant is created — `company-creation`'s
 * service is, because that is where the §3.1.1 allowance/approval ledger is spent
 * in the same transaction. This stays public for the placeholder path (§3.6),
 * which creates a stub owned by nobody and must not consume anyone's allowance.
 */
export async function insertCompany(
  input: {
    name: string;
    currency: string;
    isPlaceholder?: boolean;
    country?: string | null;
    registrationId?: string | null;
  },
  runner?: Queryable
): Promise<CompanyRow> {
  const rows = await query<CompanyRow>(
    `insert into companies (name, currency, is_placeholder, country, registration_id)
     values ($1, $2, $3, $4, $5)
     returning ${COMPANY_COLUMNS}`,
    [
      input.name,
      input.currency,
      input.isPlaceholder ?? false,
      input.country ?? null,
      input.registrationId ?? null,
    ],
    runner
  );
  return rows[0]!;
}
