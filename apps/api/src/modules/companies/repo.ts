import type { CompanySummary, UpdateCompany } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

export interface CompanyRow {
  id: string;
  name: string;
  currency: string;
  is_placeholder: boolean;
  claimed_by_company_id: string | null;
}

export function toCompanySummary(row: CompanyRow): CompanySummary {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    isPlaceholder: row.is_placeholder,
  };
}

export function findCompanyById(id: string, runner?: Queryable): Promise<CompanyRow | null> {
  return queryOne<CompanyRow>(
    `select id, name, currency, is_placeholder, claimed_by_company_id
       from companies where id = $1`,
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
       updated_at = now()
     where id = $1
     returning id, name, currency, is_placeholder, claimed_by_company_id`,
    [id, patch.name ?? null, patch.currency ?? null],
    runner
  );
  if (!row) throw new AppError('NOT_FOUND', 'Company not found');
  return row;
}

export async function insertCompany(
  input: { name: string; currency: string; isPlaceholder?: boolean },
  runner?: Queryable
): Promise<CompanyRow> {
  const rows = await query<CompanyRow>(
    `insert into companies (name, currency, is_placeholder)
     values ($1, $2, $3)
     returning id, name, currency, is_placeholder, claimed_by_company_id`,
    [input.name, input.currency, input.isPlaceholder ?? false],
    runner
  );
  return rows[0]!;
}
