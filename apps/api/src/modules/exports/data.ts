import {
  DEFAULT_CURRENCY,
  type ProjectView,
  type ResolvedRateSnapshot,
  type ShiftType,
} from '@crewquo/shared';
import { query } from '../../db';
import { findCompanyById } from '../companies/repo';
import { computeProjectSummary } from '../projects/summary';
import type { ExportExpenseLine, ExportTimeLine, ProjectExportModel } from './model';

/**
 * Assemble the owner-side export model for one project.
 *
 * Totals come from `computeProjectSummary` — the same function the summary
 * endpoint and the web console read — rather than a second set of SUMs written
 * for the export. A file the client is shown must not be able to disagree with
 * the screen the owner approved it on.
 *
 * Only APPROVED work is included, matching the summary and the portal: a draft or
 * rejected line is not a cost, and an unreviewed one is not yet a commitment.
 */

interface ApprovedTimeDetailRow {
  work_date: string;
  provider_company_name: string;
  role_name: string;
  shift_type: ShiftType;
  hours_regular: string;
  hours_ot: string;
  resolved_rate: ResolvedRateSnapshot | null;
}

interface ApprovedExpenseDetailRow {
  work_date: string;
  provider_company_name: string;
  category: string | null;
  description: string | null;
  amount_cents: number;
}

export async function buildProjectExportModel(args: {
  project: ProjectView;
  generatedByName: string;
  generatedAt: string;
}): Promise<ProjectExportModel> {
  const { project } = args;

  const owner = await findCompanyById(project.ownerCompanyId);

  const summary = await computeProjectSummary({
    id: project.id,
    ownerCompanyId: project.ownerCompanyId,
    clientCompanyId: project.clientCompanyId,
    currency: owner?.currency ?? DEFAULT_CURRENCY,
  });

  const timeRows = await query<ApprovedTimeDetailRow>(
    `select to_char(t.work_date, 'YYYY-MM-DD') as work_date,
            pc.name as provider_company_name,
            r.name as role_name,
            t.shift_type,
            t.hours_regular::text as hours_regular,
            t.hours_ot::text as hours_ot,
            t.resolved_rate
       from time_logs t
       join companies pc on pc.id = t.provider_company_id
       join role_catalog r on r.id = t.role_id
      where t.project_id = $1 and t.status = 'APPROVED'
      order by t.work_date asc, pc.name asc, r.name asc, t.id asc`,
    [project.id]
  );

  const expenseRows = await query<ApprovedExpenseDetailRow>(
    `select to_char(e.created_at, 'YYYY-MM-DD') as work_date,
            pc.name as provider_company_name,
            e.category, e.description, e.amount_cents
       from expenses e
       join companies pc on pc.id = e.provider_company_id
      where e.project_id = $1 and e.status = 'APPROVED'
      order by e.created_at asc, e.id asc`,
    [project.id]
  );

  const timeLines: ExportTimeLine[] = timeRows.map((r) => ({
    date: r.work_date,
    providerName: r.provider_company_name,
    roleName: r.role_name,
    shiftType: r.shift_type,
    // The label is read from the snapshot frozen at submit, not re-resolved: the
    // company's label rules may have changed since, and the export must show what
    // was actually paid (§6).
    rateLabel: r.resolved_rate?.label ?? null,
    hoursRegular: Number(r.hours_regular),
    hoursOt: Number(r.hours_ot),
    payCents: r.resolved_rate?.costCents ?? null,
  }));

  const expenseLines: ExportExpenseLine[] = expenseRows.map((r) => ({
    date: r.work_date,
    providerName: r.provider_company_name,
    category: r.category,
    description: r.description,
    amountCents: r.amount_cents,
  }));

  return {
    generatedAt: args.generatedAt,
    generatedByName: args.generatedByName,
    ownerCompanyName: owner?.name ?? '—',
    clientCompanyName: project.clientCompanyName,
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      startsOn: project.startsOn,
      endsOn: project.endsOn,
      notes: project.notes,
    },
    summary,
    timeLines,
    expenseLines,
  };
}
