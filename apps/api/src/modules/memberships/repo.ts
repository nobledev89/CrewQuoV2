import type {
  MemberView,
  MembershipRole,
  MembershipStatus,
  MembershipSummary,
} from '@crewquo/shared';
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
    `select c.id as "companyId", c.name as "companyName", c.currency as currency,
            coalesce(c.time_zone, 'UTC') as "timeZone", m.role as role
       from memberships m
       join companies c on c.id = m.company_id
      where m.user_id = $1 and m.status = 'ACTIVE'
      order by c.name asc`,
    [userId],
    runner
  );
}

/** Members of a company with their user profile (§7 GET /members). */
export function listMembers(companyId: string, runner?: Queryable): Promise<MemberView[]> {
  return query<MemberView>(
    `select m.id as "membershipId", u.id as "userId", u.name as name, u.email as email,
            m.role as role, m.status as status
       from memberships m join users u on u.id = m.user_id
      where m.company_id = $1
      order by u.name asc`,
    [companyId],
    runner
  );
}

/**
 * One membership by its own id, scoped to the company doing the asking.
 *
 * Scoped in the query rather than checked afterwards: an unscoped lookup that
 * 403s later still confirms the id exists, and a membership id is guessable
 * nowhere but it costs nothing to make "not yours" and "not real" the same answer.
 */
export function findMembershipInCompany(
  companyId: string,
  membershipId: string,
  runner?: Queryable
): Promise<MembershipWithUser | null> {
  return queryOne<MembershipWithUser>(
    `select m.id, m.user_id, m.company_id, m.role, m.status,
            u.name as user_name, u.email as user_email
       from memberships m join users u on u.id = m.user_id
      where m.company_id = $1 and m.id = $2`,
    [companyId, membershipId],
    runner
  );
}

export interface MembershipWithUser extends MembershipRow {
  user_name: string;
  user_email: string;
}

/** The list-shaped view of one membership, so a mutation can answer without re-listing. */
export function toMemberView(row: MembershipWithUser): MemberView {
  return {
    membershipId: row.id,
    userId: row.user_id,
    name: row.user_name,
    email: row.user_email,
    role: row.role,
    status: row.status,
  };
}

/**
 * Active owners of a company. The last one may not be demoted, suspended or
 * removed (`membershipChangeRefusal`) — a company with no active owner cannot be
 * repaired from inside the product.
 */
export async function countActiveOwners(companyId: string, runner?: Queryable): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from memberships
      where company_id = $1 and role = 'OWNER' and status = 'ACTIVE'`,
    [companyId],
    runner
  );
  return row?.n ?? 0;
}

export async function updateMembership(
  membershipId: string,
  patch: { role?: MembershipRole; status?: MembershipStatus },
  runner?: Queryable
): Promise<MembershipRow> {
  const rows = await query<MembershipRow>(
    `update memberships set
       role = coalesce($2, role),
       status = coalesce($3, status),
       updated_at = now()
     where id = $1
     returning id, user_id, company_id, role, status`,
    [membershipId, patch.role ?? null, patch.status ?? null],
    runner
  );
  return rows[0]!;
}

export async function deleteMembership(membershipId: string, runner?: Queryable): Promise<void> {
  await query(`delete from memberships where id = $1`, [membershipId], runner);
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
