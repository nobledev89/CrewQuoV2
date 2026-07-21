import type { MembershipRole, MembershipStatus, MembershipSummary } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

export interface MembershipRow {
  id: string;
  user_id: string;
  company_id: string;
  role: MembershipRole;
  status: MembershipStatus;
}

/** The active membership for a user+company — used to validate X-Company-Id. */
export function findMembership(
  userId: string,
  companyId: string,
  runner?: Queryable
): Promise<MembershipRow | null> {
  return queryOne<MembershipRow>(
    `select id, user_id, company_id, role, status
       from memberships
      where user_id = $1 and company_id = $2`,
    [userId, companyId],
    runner
  );
}

/** All companies a user belongs to, for the switcher (§7 GET /me/memberships). */
export function listMembershipSummaries(
  userId: string,
  runner?: Queryable
): Promise<MembershipSummary[]> {
  return query<MembershipSummary>(
    `select c.id as "companyId", c.name as "companyName", c.currency as currency, m.role as role
       from memberships m
       join companies c on c.id = m.company_id
      where m.user_id = $1 and m.status = 'ACTIVE'
      order by c.name asc`,
    [userId],
    runner
  );
}

export async function insertMembership(
  input: { userId: string; companyId: string; role: MembershipRole },
  runner?: Queryable
): Promise<MembershipRow> {
  const rows = await query<MembershipRow>(
    `insert into memberships (user_id, company_id, role, status)
     values ($1, $2, $3, 'ACTIVE')
     returning id, user_id, company_id, role, status`,
    [input.userId, input.companyId, input.role],
    runner
  );
  return rows[0]!;
}
