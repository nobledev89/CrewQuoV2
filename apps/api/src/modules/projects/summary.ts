import {
  calculateMargin,
  type ProjectSummary,
  type ProviderRollup,
  type ResolvedRateSnapshot,
  type ShiftType,
} from '@crewquo/shared';
import { query } from '../../db';
import { getEffectiveTimeframeDefinitions } from '../rates/repo';
import { approvedVariationTotals } from '../variations/repo';
import { resolveBillCentsForLog } from './billing';

/**
 * Server-computed project summary (CREWQUO_V2_PLAN.md §3.4, §6, §41).
 *
 * Labour cost is read from each approved log's frozen rate snapshot (stable — set
 * at submit). Bill/margin are computed best-effort at read time by resolving the
 * owner's BILL cards against the project's client; when no client or BILL cards
 * exist they are null.
 *
 * **Every figure is in the project's reporting currency, and there is only ever
 * one currency to be in.** A company works in exactly one (owner decision,
 * 2026-08-19), and the project snapshots it at creation so a later change to the
 * company label cannot relabel a closed project. CrewQuo holds no exchange rate
 * and converts nothing.
 *
 * This function used to be twice as long. It carried a `GapLedger`, a per-record
 * `conversionGaps` accumulator, a `convertPay` helper that preferred the FX frozen
 * onto each log at submit, and a rule that withheld margin whenever any figure was
 * unconvertible. All of it existed to keep unlike units from being added together,
 * and all of it went with the decision that there are no unlike units.
 *
 * **The one withholding rule that survives is about BILL cards, not currency.** A
 * line with no covering BILL card is "not priced yet", and folding it in at zero
 * would understate the invoice — so the bill total, and the margin computed from
 * it, are withheld rather than guessed (§41.1).
 *
 * ── PHASE 11: THE SECOND WRITER, AND WHY IT IS ONLY HALF A WRITER ───────────
 *
 * §30.1 sends approved variations here rather than to a second calculator, and
 * this is the first time in nine phases that anything but approved work has
 * contributed to these figures. Two properties of how it does are worth stating
 * where the code is, because both look like omissions:
 *
 *  1. **The variation's SELL is folded into revenue and its COST is never folded
 *     into cost.** The hours worked on extra works are approved time logs like any
 *     other hours and are already in `laborCostCents` through their frozen PAY
 *     snapshots; a variation's `cost_total_cents` is what the contractor *expected*
 *     the works to cost when it quoted them. Adding it counts the same labour twice
 *     and deflates margin — the one direction of error nobody catches, because it
 *     is pessimistic. It is reported as `variationCostCents` beside the total
 *     instead (`commercial-operations.md` finding 3).
 *
 *  2. **`revenueCents` is null whenever `billCents` is.** The withholding rule
 *     propagates rather than being repaired by a variation that happens to carry a
 *     figure: a project with one unpriced hour has an unknown revenue, not a
 *     revenue of "just the variations". Margin then goes with it, as it always has.
 */

interface ApprovedLogRow {
  provider_company_id: string;
  provider_company_name: string;
  role_id: string;
  shift_type: ShiftType;
  work_date: string;
  hours_regular: string;
  hours_ot: string;
  resolved_rate: (ResolvedRateSnapshot & { currency?: string }) | null;
}

export async function computeProjectSummary(project: {
  id: string;
  ownerCompanyId: string;
  clientCompanyId: string | null;
  /** The project's reporting currency — the label every figure here is printed with. */
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

  // The owner's label rules — loaded once for the whole summary, not per log.
  const labelRules = await getEffectiveTimeframeDefinitions(project.ownerCompanyId);

  let laborCostCents = 0;
  let billCents = 0;
  let billResolvable = project.clientCompanyId !== null;

  for (const log of logs) {
    const r = rollup(log.provider_company_id, log.provider_company_name);
    r.approvedTimeLogs += 1;

    // Straight from the frozen snapshot. §6 pins what a provider is owed at
    // submit, and nothing at read time may move it.
    const cost = log.resolved_rate?.costCents ?? 0;
    r.laborCostCents += cost;
    laborCostCents += cost;

    // Bill side: what the owner charges its client for this labour.
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
        // A gap in BILL cards makes the total meaningless — "not priced yet" is
        // not the same as "priced at zero".
        billResolvable = false;
      } else {
        billCents += bill.amountCents;
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

  // Bill total (labour via BILL cards + expenses passed through at cost).
  let finalBill: number | null = null;

  if (billResolvable && logs.length > 0) {
    finalBill = billCents + expenseCostCents;
  }

  /*
   * §30.1's feed-through. Read once, and read for every project rather than only
   * for projects with a client: a variation is agreed money whether or not the
   * BILL cards resolve, and withholding the figure itself would hide the one
   * revenue record the project definitely has.
   */
  const variations = await approvedVariationTotals(project.id);

  /*
   * Revenue = billed work + approved variation sell, and **null whenever the bill
   * total is** — see property 2 in the header. A project whose labour is not fully
   * priced does not have a revenue figure, and `finalBill + variations.sellCents`
   * on a withheld bill would produce one out of nothing.
   */
  const revenueCents = finalBill === null ? null : finalBill + variations.sellCents;

  /*
   * Margin over **revenue**, not over the bill total. This is the one existing
   * figure Phase 11 changes the meaning of, and it changes it in the direction
   * §30.1 asks for: a project that made £4,000 of agreed extra works at a good
   * price is more profitable than one that did not, and a margin computed over the
   * bill alone would not say so. `totalCostCents` is unchanged, per property 1.
   */
  let marginCents: number | null = null;
  let marginPct: number | null = null;
  if (revenueCents !== null && logs.length > 0) {
    const m = calculateMargin(revenueCents, totalCostCents);
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
    approvedVariations: variations.count,
    variationSellCents: variations.sellCents,
    variationCostCents: variations.costCents,
    revenueCents,
    marginCents,
    marginPct,
    byProvider: [...rollups.values()],
  };
}
