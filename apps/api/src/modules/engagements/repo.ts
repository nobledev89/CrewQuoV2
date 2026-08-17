import type { EngagementStatus, EngagementView, ProviderView } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * Engagement persistence (CREWQUO_V2_PLAN.md §3.2). An engagement is the
 * client⇄provider edge; every read is filtered to edges the active company is an
 * endpoint of (the one-hop rule, §4).
 */

export interface EngagementEdgeRow {
  id: string;
  client_company_id: string;
  provider_company_id: string;
  status: EngagementStatus;
  created_by_company_id: string;
}

/** Load an engagement's edge for authorization (both endpoint company ids). */
export function findEngagementEdge(
  id: string,
  runner?: Queryable
): Promise<EngagementEdgeRow | null> {
  return queryOne<EngagementEdgeRow>(
    `select id, client_company_id, provider_company_id, status, created_by_company_id
       from engagements where id = $1`,
    [id],
    runner
  );
}

/** The engagement between a client and provider, if any (used to derive assignments). */
export function findEngagementByPair(
  clientCompanyId: string,
  providerCompanyId: string,
  runner?: Queryable
): Promise<EngagementEdgeRow | null> {
  return queryOne<EngagementEdgeRow>(
    `select id, client_company_id, provider_company_id, status, created_by_company_id
       from engagements where client_company_id = $1 and provider_company_id = $2`,
    [clientCompanyId, providerCompanyId],
    runner
  );
}

interface EngagementViewRow {
  id: string;
  client_company_id: string;
  client_company_name: string;
  provider_company_id: string;
  provider_company_name: string;
  provider_is_placeholder: boolean;
  status: EngagementStatus;
  created_by_company_id: string;
  created_at: Date;
  updated_at: Date;
}

function toEngagementView(r: EngagementViewRow, activeCompanyId: string): EngagementView {
  return {
    id: r.id,
    clientCompanyId: r.client_company_id,
    clientCompanyName: r.client_company_name,
    providerCompanyId: r.provider_company_id,
    providerCompanyName: r.provider_company_name,
    providerIsPlaceholder: r.provider_is_placeholder,
    status: r.status,
    createdByCompanyId: r.created_by_company_id,
    side: r.client_company_id === activeCompanyId ? 'client' : 'provider',
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const ENGAGEMENT_VIEW_SELECT = `
  select e.id, e.client_company_id, cc.name as client_company_name,
         e.provider_company_id, pc.name as provider_company_name,
         pc.is_placeholder as provider_is_placeholder,
         e.status, e.created_by_company_id, e.created_at, e.updated_at
    from engagements e
    join companies cc on cc.id = e.client_company_id
    join companies pc on pc.id = e.provider_company_id`;

/** Engagements where the active company is either endpoint (one-hop, §3.2). */
export async function listEngagements(activeCompanyId: string): Promise<EngagementView[]> {
  const rows = await query<EngagementViewRow>(
    `${ENGAGEMENT_VIEW_SELECT}
      where e.client_company_id = $1 or e.provider_company_id = $1
      order by e.created_at desc`,
    [activeCompanyId]
  );
  return rows.map((r) => toEngagementView(r, activeCompanyId));
}

export async function getEngagementView(
  id: string,
  activeCompanyId: string
): Promise<EngagementView | null> {
  const row = await queryOne<EngagementViewRow>(`${ENGAGEMENT_VIEW_SELECT} where e.id = $1`, [id]);
  return row ? toEngagementView(row, activeCompanyId) : null;
}

export async function insertEngagement(
  input: {
    clientCompanyId: string;
    providerCompanyId: string;
    createdByCompanyId: string;
    status?: EngagementStatus;
  },
  runner?: Queryable
): Promise<EngagementEdgeRow> {
  const rows = await query<EngagementEdgeRow>(
    `insert into engagements (client_company_id, provider_company_id, created_by_company_id, status)
     values ($1, $2, $3, coalesce($4, 'ACTIVE'))
     returning id, client_company_id, provider_company_id, status, created_by_company_id`,
    [input.clientCompanyId, input.providerCompanyId, input.createdByCompanyId, input.status ?? null],
    runner
  );
  return rows[0]!;
}

export async function updateEngagementStatus(
  id: string,
  status: EngagementStatus,
  runner?: Queryable
): Promise<EngagementEdgeRow | null> {
  return queryOne<EngagementEdgeRow>(
    `update engagements set status = $2, updated_at = now() where id = $1
     returning id, client_company_id, provider_company_id, status, created_by_company_id`,
    [id, status],
    runner
  );
}

/** Count distinct providers the active company engages (usage: active_subcontractors). */
export async function countActiveSubcontractors(companyId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from engagements
      where client_company_id = $1 and status in ('PENDING','ACTIVE','PAUSED')`,
    [companyId]
  );
  return row?.n ?? 0;
}

/** Count distinct clients the active company works for (usage: clients). */
export async function countClients(companyId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from engagements
      where provider_company_id = $1 and status in ('PENDING','ACTIVE','PAUSED')`,
    [companyId]
  );
  return row?.n ?? 0;
}

/** Providers = the client side of the active company's engagements (§7 GET /providers). */
export async function listProviders(activeCompanyId: string): Promise<ProviderView[]> {
  return query<ProviderView>(
    `select e.id as "engagementId", e.provider_company_id as "providerCompanyId",
            pc.name as name, pc.currency as currency, pc.is_placeholder as "isPlaceholder",
            e.status as status
       from engagements e
       join companies pc on pc.id = e.provider_company_id
      where e.client_company_id = $1
      order by pc.name asc`,
    [activeCompanyId]
  );
}
