import {
  calculateCost,
  resolveRateLabel,
  type ShiftType,
  type TimeframeDefinition,
} from '@crewquo/shared';
import { listResolveCandidates } from '../rates/repo';
import { pickEffectiveCard } from '../rates/resolve';

/**
 * BILL-side pricing for one time log (CREWQUO_V2_PLAN.md §6) — what the project
 * owner charges its client for that labour, as opposed to the frozen PAY snapshot
 * on the log itself.
 *
 * Shared by the owner's project summary, the client portal and the export engine
 * so they can never disagree about a number the client is being shown.
 *
 * `labelRules` is the owner's own timeframe definitions and is deliberately a
 * required argument: callers price a whole project's worth of lines, and loading
 * the rules per line would turn one query into one per log. Load once with
 * `getEffectiveTimeframeDefinitions`, pass it in.
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
  labelRules: readonly TimeframeDefinition[];
}): Promise<number | null> {
  const label = resolveRateLabel(args.shiftType, args.workDate, args.labelRules);
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
