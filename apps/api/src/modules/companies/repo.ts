import type { CompanySummary } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

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
