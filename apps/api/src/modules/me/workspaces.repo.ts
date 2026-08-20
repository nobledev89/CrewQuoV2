import type { MembershipRole } from '@crewquo/shared';
import { query } from '../../db';

/**
 * The relationship facts needed to build the company/view switcher in one read.
 * `created_by_company_id` distinguishes a provider a company invited to deliver
 * work from a client that provider invited to its portal (§3.2, §9.2).
 */
export interface WorkspaceFactsRow {
  companyId: string;
  companyName: string;
  currency: string;
  /** Null in the column means UTC; coalesced in the query so callers get a zone. */
  timeZone: string;
  role: MembershipRole;
  hasProviderRelationship: boolean;
  hasAssignedWork: boolean;
  hasClientRelationship: boolean;
  hasPortalProject: boolean;
}

export function listWorkspaceFacts(userId: string): Promise<WorkspaceFactsRow[]> {
  return query<WorkspaceFactsRow>(
    `select c.id as "companyId", c.name as "companyName", c.currency,
            coalesce(c.time_zone, 'UTC') as "timeZone",
            m.role,
            exists (
              select 1 from engagements e
               where e.provider_company_id = c.id
                 and e.created_by_company_id = e.client_company_id
            ) as "hasProviderRelationship",
            exists (
              select 1 from project_assignments a
               where a.provider_company_id = c.id
            ) as "hasAssignedWork",
            exists (
              select 1 from engagements e
               where e.client_company_id = c.id
                 and e.created_by_company_id = e.provider_company_id
            ) as "hasClientRelationship",
            exists (
              select 1 from projects p
               where p.client_company_id = c.id
                 and p.client_visible = true
            ) as "hasPortalProject"
       from memberships m
       join companies c on c.id = m.company_id
      where m.user_id = $1
        and m.status = 'ACTIVE'
        and c.claimed_by_company_id is null
      order by c.name asc`,
    [userId]
  );
}

