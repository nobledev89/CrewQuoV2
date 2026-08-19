import {
  calculateMargin,
  convertToReportingCurrency,
  type ConversionGap,
  type FxRateFacts,
  type ProjectSummary,
  type ProviderRollup,
  type ResolvedRateSnapshot,
  type ShiftType,
} from '@crewquo/shared';
import { query } from '../../db';
import { listFxRatesQuoting } from '../money/repo';
import { getEffectiveTimeframeDefinitions } from '../rates/repo';
import { resolveBillCentsForLog } from './billing';

/**
 * Server-computed project summary (CREWQUO_V2_PLAN.md §3.4, §6, §41).
 *
 * Labor cost is read from each approved log's frozen rate snapshot (stable — set
 * at submit). Bill/margin are computed best-effort at read time by resolving the
 * owner's BILL cards against the project's client; when no client or BILL cards
 * exist they are null.
 *
 * **Every figure below is in the project's reporting currency** (§3.3 decision #5,
 * `docs/operating-model/money-boundary.md`). Amounts whose source is in another
 * currency are converted through a recorded exchange rate, and amounts with no
 * such rate are **withheld and named in `conversionGaps`** rather than estimated
 * or folded in at zero. A caller that ignores `conversionGaps` will show a total
 * that is smaller than the truth, which is why the gaps travel with the totals
 * rather than being fetched separately.
 *
 * The PAY side prefers the FX frozen onto the log at submit; only a log that
 * predates the money boundary falls back to a live lookup. That asymmetry with
 * the BILL side is deliberate and mirrors the existing one: PAY is what is owed
 * and was agreed at submit, BILL is what the owner would charge today.
 */

interface ApprovedLogRow {
  provider_company_id: string;
  provider_company_name: string;
  role_id: string;
  shift_type: ShiftType;
  work_date: string;
  hours_regular: string;
  hours_ot: string;
  resolved_rate: (ResolvedRateSnapshot & { currency?: string; fx?: FrozenFx }) | null;
}

interface FrozenFx {
  fxRateId: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  asOf: string;
  source: string;
}

/** Accumulates "what could not be reported", keyed by currency pair. */
class GapLedger {
  private readonly gaps = new Map<string, ConversionGap>();

  record(baseCurrency: string, quoteCurrency: string, date: string): void {
    const key = `${baseCurrency}/${quoteCurrency}`;
    const existing = this.gaps.get(key);
    if (!existing) {
      this.gaps.set(key, { baseCurrency, quoteCurrency, earliestDate: date, recordCount: 1 });
      return;
    }
    existing.recordCount += 1;
    if (date < existing.earliestDate) existing.earliestDate = date;
  }

  get size(): number {
    return this.gaps.size;
  }

  toArray(): ConversionGap[] {
    return [...this.gaps.values()].sort((a, b) =>
      `${a.baseCurrency}${a.quoteCurrency}`.localeCompare(`${b.baseCurrency}${b.quoteCurrency}`)
    );
  }
}

export async function computeProjectSummary(project: {
  id: string;
  ownerCompanyId: string;
  clientCompanyId: string | null;
  /** The project's reporting currency — the unit every figure here is in. */
  currency: string;
}): Promise<ProjectSummary> {
  const reportingCurrency = project.currency;

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

  const gaps = new GapLedger();

  // The owner's label rules — loaded once for the whole summary, not per log.
  const labelRules = await getEffectiveTimeframeDefinitions(project.ownerCompanyId);

  // Every rate that converts *into* this project's unit, in one query rather
  // than one per line. Loaded by target currency rather than by the bases seen
  // in the PAY snapshots: a BILL card's currency is only known once the card has
  // been resolved, so pre-computing the pairs would silently withhold a BILL
  // figure whose rate was on file the whole time. `pickFxRate` applies the
  // as-of rule per record.
  const fxCandidates = await listFxRatesQuoting(project.ownerCompanyId, reportingCurrency);

  let laborCostCents = 0;
  let billCents = 0;
  let billResolvable = project.clientCompanyId !== null;

  for (const log of logs) {
    const r = rollup(log.provider_company_id, log.provider_company_name);
    r.approvedTimeLogs += 1;
    // `recordCount` counts *records*, so a log whose PAY and BILL sides are both
    // unconvertible for the same pair is still one withheld record, not two.
    const gapsForThisLog = new Set<string>();
    const recordGap = (base: string) => {
      if (gapsForThisLog.has(base)) return;
      gapsForThisLog.add(base);
      gaps.record(base, reportingCurrency, log.work_date);
    };

    const payCurrency = log.resolved_rate?.currency ?? reportingCurrency;
    const rawCost = log.resolved_rate?.costCents ?? 0;
    const cost = convertPay({
      amountMinorUnits: rawCost,
      payCurrency,
      reportingCurrency,
      workDate: log.work_date,
      frozen: log.resolved_rate?.fx,
      candidates: fxCandidates,
    });

    if (cost === null) {
      // Withheld, not zeroed: this provider's rollup and the project total both
      // omit it, and `conversionGaps` says so.
      recordGap(payCurrency);
    } else {
      r.laborCostCents += cost;
      laborCostCents += cost;
    }

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
        const converted = convertToReportingCurrency({
          amountMinorUnits: bill.amountCents,
          sourceCurrency: bill.currency ?? reportingCurrency,
          reportingCurrency,
          asOf: log.work_date,
          candidates: fxCandidates,
        });
        if (!converted.ok) {
          // An unconvertible BILL line makes the bill total as meaningless as a
          // missing card does — the same refusal, for the same reason.
          billResolvable = false;
          recordGap(bill.currency ?? reportingCurrency);
        } else {
          billCents += converted.amountMinorUnits;
        }
      }
    }
  }

  // **Expenses carry no currency at all** (`expenses` in 0004 has no such column),
  // so there is nothing here to convert *from* and they pass through at cost.
  // That is a known limitation rather than a claim: an expense raised by a
  // provider working in another currency is currently taken at face value in the
  // project's unit. Recorded here and in the money-boundary packet so the next
  // person meets the gap in the open — giving `expenses` a currency is a schema
  // change, and inventing one now would be guessing which unit past rows meant.
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

  // A project with a withheld cost has an understated cost, so a margin computed
  // from it would be flatteringly wrong. Margin is withheld with it.
  if (billResolvable && logs.length > 0 && gaps.size === 0) {
    finalBill = billCents + expenseCostCents;
    const m = calculateMargin(finalBill, totalCostCents);
    marginCents = m.marginCents;
    marginPct = m.marginPct;
  }

  return {
    projectId: project.id,
    currency: reportingCurrency,
    approvedTimeLogs: logs.length,
    approvedExpenses: expenses.length,
    laborCostCents,
    expenseCostCents,
    totalCostCents,
    billCents: finalBill,
    marginCents,
    marginPct,
    byProvider: [...rollups.values()],
    conversionGaps: gaps.toArray(),
  };
}

/**
 * Convert one approved log's PAY cost, preferring the rate frozen at submit.
 *
 * A frozen rate is used verbatim and is never re-looked-up: the whole reason §6
 * freezes the PAY snapshot is that what a provider is owed must not move after
 * the fact, and re-resolving FX at read time would reintroduce exactly that drift
 * through the other axis. Only a log written before the money boundary existed
 * has no frozen rate, and those fall back to a live lookup.
 */
function convertPay(args: {
  amountMinorUnits: number;
  payCurrency: string;
  reportingCurrency: string;
  workDate: string;
  frozen: FrozenFx | undefined;
  candidates: readonly FxRateFacts[];
}): number | null {
  if (args.payCurrency === args.reportingCurrency) return args.amountMinorUnits;

  if (args.frozen && args.frozen.quoteCurrency === args.reportingCurrency) {
    const result = convertToReportingCurrency({
      amountMinorUnits: args.amountMinorUnits,
      sourceCurrency: args.payCurrency,
      reportingCurrency: args.reportingCurrency,
      asOf: args.frozen.asOf,
      candidates: [
        {
          id: args.frozen.fxRateId,
          baseCurrency: args.frozen.baseCurrency,
          quoteCurrency: args.frozen.quoteCurrency,
          rate: args.frozen.rate,
          asOf: args.frozen.asOf,
          source: args.frozen.source,
        },
      ],
    });
    return result.ok ? result.amountMinorUnits : null;
  }

  const result = convertToReportingCurrency({
    amountMinorUnits: args.amountMinorUnits,
    sourceCurrency: args.payCurrency,
    reportingCurrency: args.reportingCurrency,
    asOf: args.workDate,
    candidates: args.candidates,
  });
  return result.ok ? result.amountMinorUnits : null;
}
