import { calculateCost, resolveRateLabel, type ShiftType } from '@crewquo/shared';
import { listResolveCandidates } from '../rates/repo';
import { pickEffectiveCard } from '../rates/resolve';

/**
 * BILL-side pricing for one time log (CREWQUO_V2_PLAN.md §6) — what the project
 * owner charges its client for that labour, as opposed to the frozen PAY snapshot
 * on the log itself.
 *
 * Shared by the owner's project summary and the client portal so the two can
 * never disagree about a number the client is being shown.
 *
 * Returns null when no BILL card covers the line. Callers must surface that as
 * an incomplete total rather than folding it in as zero: a missing card means
 * "not priced yet", and silently billing 0 would understate the invoice.
 */
export async function resolveBillCentsForLog(args: {
  ownerCompanyId: string;
  clientCompanyId: string;
  roleId: string;
  shiftType: ShiftType;
  workDate: string;
  hoursRegular: number;
  hoursOt: number;
}): Promise<number | null> {
  const label = resolveRateLabel(args.shiftType, args.workDate);
  const candidates = await listResolveCandidates({
    companyId: args.ownerCompanyId,
    kind: 'BILL',
    roleId: args.roleId,
    label,
    date: args.workDate,
    counterpartyId: args.clientCompanyId,
  });
  const card = pickEffectiveCard(candidates, args.workDate, args.clientCompanyId);
  if (!card) return null;
  return calculateCost({
    card,
    quantity: args.hoursRegular,
    otHours: args.hoursOt,
  });
}
