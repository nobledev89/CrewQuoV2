import {
  calculateMargin,
  type ProjectSummary,
  type ProviderRollup,
  type ResolvedRateSnapshot,
  type ShiftType,
} from '@crewquo/shared';
import { query } from '../../db';
import { getEffectiveTimeframeDefinitions } from '../rates/repo';
import { resolveBillCentsForLog } from './billing';

/**
 * Server-computed project summary (CREWQUO_V2_PLAN.md §3.4, §6). Labor cost is
 * read from each approved log's frozen rate snapshot (stable — set at submit).
 * Bill/margin are computed best-effort at read time by resolving the owner's
 * BILL cards against the project's client; when no client or BILL cards exist
 * they are null.
 */

interface ApprovedLogRow {
  provider_company_id: string;
  provider_company_name: string;
  role_id: string;
  shift_type: ShiftType;
  work_date: string;
  hours_regular: string;
  hours_ot: string;
  resolved_rate: ResolvedRateSnapshot | null;
}

export async function computeProjectSummary(project: {
  id: string;
  ownerCompanyId: string;
  clientCompanyId: string | null;
  currency: string;
}): Promise<ProjectSummary> {
  const logs = await query<ApprovedLogRow>(
    `select t.provider_company_id, pc.name as provider_company_name, t.role_id, t.shift_type,
            to_char(t.work_date, 'YYYY-MM-DD') as work_date,
            t.hours_regular, t.hours_ot, t.resolved_rate
       from time_logs t
       join companies pc on pc.id = t.provider_company_id
      where t.project_id = $1 and t.status = 'APPROVED'`,
    [project.id]
  );

  const expenses = await query<{ provider_company_id: string; amount_cents: number }>(
    `select provider_company_id, amount_cents from expenses
      where project_id = $1 and status = 'APPROVED'`,
    [project.id]
  );

  const rollups = new Map<string, ProviderRollup>();
  const rollup = (id: string, name: string): ProviderRollup => {
    let r = rollups.get(id);
    if (!r) {
      r = {
        providerCompanyId: id,
        providerCompanyName: name,
        approvedTimeLogs: 0,
        laborCostCents: 0,
        expenseCostCents: 0,
      };
      rollups.set(id, r);
    }
    return r;
  };

  let laborCostCents = 0;
  let billCents = 0;
  let billResolvable = project.clientCompanyId !== null;

  // The owner's label rules — loaded once for the whole summary, not per log.
  const labelRules = await getEffectiveTimeframeDefinitions(project.ownerCompanyId);

  for (const log of logs) {
    const r = rollup(log.provider_company_id, log.provider_company_name);
    r.approvedTimeLogs += 1;
    const cost = log.resolved_rate?.costCents ?? 0;
    r.laborCostCents += cost;
    laborCostCents += cost;

    // Bill side: what the owner charges its client for this labor.
    if (billResolvable && project.clientCompanyId) {
      const bill = await resolveBillCentsForLog({
        ownerCompanyId: project.ownerCompanyId,
        clientCompanyId: project.clientCompanyId,
        roleId: log.role_id,
        shiftType: log.shift_type,
        workDate: log.work_date,
        hoursRegular: Number(log.hours_regular),
        hoursOt: Number(log.hours_ot),
        labelRules,
      });
      if (bill === null) {
        billResolvable = false; // a gap in BILL cards makes the total meaningless
      } else {
        billCents += bill;
      }
    }
  }

  let expenseCostCents = 0;
  for (const e of expenses) {
    const name = logs.find((l) => l.provider_company_id === e.provider_company_id)
      ?.provider_company_name;
    const r = rollup(e.provider_company_id, name ?? e.provider_company_id.slice(0, 8));
    r.expenseCostCents += e.amount_cents;
    expenseCostCents += e.amount_cents;
  }

  const totalCostCents = laborCostCents + expenseCostCents;

  // Bill total (labor via BILL cards + expenses passed through at cost).
  let finalBill: number | null = null;
  let marginCents: number | null = null;
  let marginPct: number | null = null;
  if (billResolvable && logs.length > 0) {
    finalBill = billCents + expenseCostCents;
    const m = calculateMargin(finalBill, totalCostCents);
    marginCents = m.marginCents;
    marginPct = m.marginPct;
  }

  return {
    projectId: project.id,
    currency: project.currency,
    approvedTimeLogs: logs.length,
    approvedExpenses: expenses.length,
    laborCostCents,
    expenseCostCents,
    totalCostCents,
    billCents: finalBill,
    marginCents,
    marginPct,
    byProvider: [...rollups.values()],
  };
}
