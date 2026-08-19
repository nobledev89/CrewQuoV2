import type {
  PortalLineItem,
  PortalProjectView,
  ProjectStatus,
  ShiftType,
} from '@crewquo/shared';
import { query, queryOne } from '../../db';
import { resolveBillCentsForLog } from '../projects/billing';
import { getEffectiveTimeframeDefinitions } from '../rates/repo';

/**
 * Client-portal persistence (CREWQUO_V2_PLAN.md §3.6).
 *
 * Every read here is anchored on `client_company_id = <the caller>` **and**
 * `client_visible`, so a project the owner hasn't published simply does not
 * exist as far as these queries are concerned. The row shapes deliberately omit
 * the owner's PAY columns and every provider identity — see `portal.ts` in
 * `@crewquo/shared` for why that's a type boundary and not a filter.
 */

interface PortalProjectRow {
  id: string;
  owner_company_id: string;
  owner_company_name: string;
  engagement_id: string | null;
  name: string;
  status: ProjectStatus;
  reporting_currency: string;
  starts_on: string | null;
  ends_on: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function toPortalProjectView(r: PortalProjectRow): PortalProjectView {
  return {
    id: r.id,
    providerCompanyId: r.owner_company_id,
    providerCompanyName: r.owner_company_name,
    engagementId: r.engagement_id,
    name: r.name,
    status: r.status,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const PORTAL_PROJECT_SELECT = `
  select p.id, p.owner_company_id, oc.name as owner_company_name, p.engagement_id,
         p.name, p.status, p.reporting_currency,
         to_char(p.starts_on, 'YYYY-MM-DD') as starts_on,
         to_char(p.ends_on, 'YYYY-MM-DD') as ends_on,
         p.notes, p.created_at, p.updated_at
    from projects p
    join companies oc on oc.id = p.owner_company_id`;

export async function listPortalProjects(
  clientCompanyId: string
): Promise<PortalProjectView[]> {
  const rows = await query<PortalProjectRow>(
    `${PORTAL_PROJECT_SELECT}
      where p.client_company_id = $1 and p.client_visible
      order by p.created_at desc`,
    [clientCompanyId]
  );
  return rows.map(toPortalProjectView);
}

/** A single published project. Null covers both "not yours" and "not published". */
export async function getPortalProject(
  clientCompanyId: string,
  id: string
): Promise<
  (PortalProjectView & { ownerCompanyId: string; reportingCurrency: string }) | null
> {
  const row = await queryOne<PortalProjectRow>(
    `${PORTAL_PROJECT_SELECT}
      where p.client_company_id = $1 and p.client_visible and p.id = $2`,
    [clientCompanyId, id]
  );
  if (!row) return null;
  return {
    ...toPortalProjectView(row),
    ownerCompanyId: row.owner_company_id,
    // Internal extensions, not part of `PortalProjectView`: the client is told
    // which unit the figures are in via `PortalProjectDetail.currency`, and never
    // learns anything more about the owner's money boundary than that.
    reportingCurrency: row.reporting_currency,
  };
}

interface ApprovedTimeRow {
  id: string;
  role_id: string;
  role_name: string;
  shift_type: ShiftType;
  work_date: string;
  hours_regular: string;
  hours_ot: string;
}

interface ApprovedExpenseRow {
  id: string;
  amount_cents: number;
  category: string | null;
  description: string | null;
  work_date: string;
}

export interface PortalLineItems {
  lineItems: PortalLineItem[];
  timeTotalCents: number;
  expenseTotalCents: number;
  pricingComplete: boolean;
}

/**
 * The billable lines of a published project, priced BILL-side.
 *
 * Only APPROVED work appears: a client should never see a draft or a rejected
 * line, and work still awaiting the owner's approval isn't yet a claim on them.
 *
 * One line per time log, deliberately *not* grouped by role/date: notes anchor to
 * a real `TIME_LOG` id (§3.6), so collapsing several logs into a synthetic row
 * would strand every note on whichever log lent the row its id. The rows carry
 * role, date and hours but no provider column, so the client learns what was
 * done without learning which subcontractor did it.
 */
export async function getPortalLineItems(project: {
  id: string;
  ownerCompanyId: string;
  clientCompanyId: string;
  /**
   * The unit this page reports in — the project's reporting currency (§3.3
   * decision #5). A BILL card that declares a different unit makes the total
   * incomplete rather than converted: converting here would put the owner's own
   * exchange rate in front of their client, which the money-boundary packet §7
   * keeps on the owner's side of the portal boundary.
   */
  reportingCurrency: string;
}): Promise<PortalLineItems> {
  const timeRows = await query<ApprovedTimeRow>(
    `select t.id, t.role_id, r.name as role_name, t.shift_type,
            to_char(t.work_date, 'YYYY-MM-DD') as work_date,
            t.hours_regular::text as hours_regular,
            t.hours_ot::text as hours_ot
       from time_logs t
       join role_catalog r on r.id = t.role_id
      where t.project_id = $1 and t.status = 'APPROVED'
      order by t.work_date asc, r.name asc, t.id asc`,
    [project.id]
  );

  const expenseRows = await query<ApprovedExpenseRow>(
    `select e.id, e.amount_cents, e.category, e.description,
            to_char(e.created_at, 'YYYY-MM-DD') as work_date
       from expenses e
      where e.project_id = $1 and e.status = 'APPROVED'
      order by e.created_at asc`,
    [project.id]
  );

  const noteCounts = await countNotesByEntity(project.id);
  // The owner's label rules — one load for the whole page, not one per line.
  const labelRules = await getEffectiveTimeframeDefinitions(project.ownerCompanyId);

  const lineItems: PortalLineItem[] = [];
  let timeTotalCents = 0;
  let pricingComplete = true;

  for (const row of timeRows) {
    const hoursRegular = Number(row.hours_regular);
    const hoursOt = Number(row.hours_ot);
    const bill = await resolveBillCentsForLog({
      ownerCompanyId: project.ownerCompanyId,
      clientCompanyId: project.clientCompanyId,
      roleId: row.role_id,
      shiftType: row.shift_type,
      workDate: row.work_date,
      hoursRegular,
      hoursOt,
      labelRules,
    });
    // Priced or not — there is no third "priced in the wrong unit" case any more:
    // a company works in exactly one currency (owner decision, 2026-08-19).
    const priced = bill !== null;
    const amountCents = priced ? bill.amountCents : null;
    if (!priced) pricingComplete = false;
    else timeTotalCents += bill.amountCents;

    lineItems.push({
      id: row.id,
      kind: 'TIME',
      date: row.work_date,
      description: row.role_name,
      shiftType: row.shift_type,
      hoursRegular,
      hoursOt,
      amountCents,
      noteCount: noteCounts.get(`TIME_LOG:${row.id}`) ?? 0,
    });
  }

  // Expenses are passed through at cost, matching the owner's project summary.
  let expenseTotalCents = 0;
  for (const row of expenseRows) {
    expenseTotalCents += row.amount_cents;
    lineItems.push({
      id: row.id,
      kind: 'EXPENSE',
      date: row.work_date,
      description: row.description ?? row.category ?? 'Expense',
      shiftType: null,
      hoursRegular: null,
      hoursOt: null,
      amountCents: row.amount_cents,
      noteCount: noteCounts.get(`EXPENSE:${row.id}`) ?? 0,
    });
  }

  return { lineItems, timeTotalCents, expenseTotalCents, pricingComplete };
}

/** Note counts for every line item on a project, keyed `ENTITY_TYPE:id`. */
async function countNotesByEntity(projectId: string): Promise<Map<string, number>> {
  const rows = await query<{ entity_type: string; entity_id: string; n: number }>(
    `select n.entity_type, n.entity_id::text as entity_id, count(*)::int as n
       from line_item_notes n
      where (n.entity_type = 'PROJECT' and n.entity_id = $1)
         or (n.entity_type = 'TIME_LOG'
             and n.entity_id in (select id from time_logs where project_id = $1))
         or (n.entity_type = 'EXPENSE'
             and n.entity_id in (select id from expenses where project_id = $1))
      group by n.entity_type, n.entity_id`,
    [projectId]
  );
  return new Map(rows.map((r) => [`${r.entity_type}:${r.entity_id}`, r.n]));
}
