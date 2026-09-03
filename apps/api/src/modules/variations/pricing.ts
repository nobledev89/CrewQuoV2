import {
  extractRate,
  resolveRateLabel,
  type ShiftType,
  type TimeframeDefinition,
  type VariationLineInput,
  type VariationLineView,
} from '@crewquo/shared';
import type { Queryable } from '../../db';
import { getEffectiveTimeframeDefinitions, listResolveCandidates } from '../rates/repo';
import { pickEffectiveCard } from '../rates/resolve';

/**
 * §30.1: *"Labour lines resolve their default cost and sell from the existing rate
 * engine, so a variation is priced the same way everything else is."*
 *
 * The whole of that sentence is load-bearing, and the last clause most of all: this
 * file resolves through `listResolveCandidates` → `pickEffectiveCard` →
 * `extractRate`, which is the same path `resolveBillCentsForLog` and
 * `/v1/rates/resolve` take. A second pricing implementation would be a second
 * answer to *"what does a Rigger cost on a Friday night?"*, and the first thing a
 * customer does with two answers is find the difference.
 *
 * ── WHY A UNIT RATE AND NOT `calculateCost` ─────────────────────────────────
 *
 * `calculateCost` prices a *line of work*: it applies `minHours`, splits regular
 * from overtime and multiplies premiums. A variation line is a **quote**, and its
 * `quantity` is whatever the quote is denominated in — sixteen hours, one shift,
 * four doors. What it needs is the card's unit rate; the `quantity × unit`
 * arithmetic then belongs to `lineTotalCents`, where the check constraint can see
 * it (`variations.ts` finding 5).
 *
 * Reaching for `calculateCost` here would silently apply a four-hour minimum to a
 * one-hour variation line and produce a quote nobody wrote.
 *
 * ── AND WHY IT WITHHOLDS RATHER THAN GUESSING ───────────────────────────────
 *
 * A LABOUR line with no `shiftType` has no rate **label** to resolve, and one with
 * no covering card has no rate. Both come back unpriced with the reason on the
 * line, so the panel says *"no PAY card covers Rigger on 2027-06-04"* rather than
 * offering a zero — §41.1's rule, and the same one `resolveBillCentsForLog`
 * already follows.
 *
 * ── AND WHOSE PAY RATE, WHICH THE PLAN DOES NOT SAY ────────────────────────
 *
 * §30.1 gives `variation_lines` a `role_id` and no provider column, and a PAY rate
 * card may be **scoped to a counterparty** (§3.3) — so "what does this cost?" has
 * two possible answers and the DDL picks neither. The rule here follows from who
 * raised the variation, which is the one fact the row does carry:
 *
 *  - **Raised by a subcontractor** → PAY resolves against *that subcontractor* as
 *    the counterparty. The figure is what they charge the hiring company, and the
 *    hiring company's PAY card for them is exactly where that lives. This is also
 *    what makes `variations.engagement_id` mean something.
 *  - **Raised by the project owner** → the default (uncounterpartied) card. At quote
 *    time the owner frequently does not yet know who will do the extra works, and
 *    picking one subcontractor's rate to stand for "labour" would produce a cost
 *    that changes when the crew does.
 *
 * A company that prices *only* per-subcontractor and raises its own variation gets
 * `PARTIAL` with a sentence saying so, rather than a zero or somebody else's rate.
 */

export interface ResolvedLinePrice {
  unitCostCents: number | null;
  unitSellCents: number | null;
  pricedFrom: VariationLineView['pricedFrom'];
  /** Null when both sides resolved. A sentence naming what is missing otherwise. */
  reason: string | null;
}

async function unitRateFor(args: {
  companyId: string;
  counterpartyId: string | null;
  kind: 'PAY' | 'BILL';
  roleId: string;
  shiftType: ShiftType;
  date: string;
  labelRules: readonly TimeframeDefinition[];
  runner?: Queryable;
}): Promise<number | null> {
  const label = resolveRateLabel(args.shiftType, args.date, args.labelRules);
  const candidates = await listResolveCandidates(
    {
      companyId: args.companyId,
      kind: args.kind,
      roleId: args.roleId,
      label,
      date: args.date,
      counterpartyId: args.counterpartyId ?? undefined,
    },
    args.runner
  );
  const card = pickEffectiveCard(candidates, args.date, args.counterpartyId ?? undefined);
  if (!card) return null;
  try {
    return extractRate(card).baseCents;
  } catch {
    /*
     * `extractRate` throws when a card is missing the rate its mode requires — a
     * HOURLY card with no hourly rate. `0003` allows that shape and `rates.ts`
     * refuses it at the edge, so it should be unreachable; a variation quote is not
     * the place to discover otherwise by 500ing. Unpriced with a reason instead.
     */
    return null;
  }
}

/**
 * Price one line, or say why it could not be priced.
 *
 * `labelRules` is a required argument for the reason `resolveBillCentsForLog` makes
 * it one: a caller prices a whole variation's worth of lines, and loading the
 * company's timeframe definitions per line would turn one query into one per line.
 * Load once with `getEffectiveTimeframeDefinitions`, pass it in.
 */
export async function priceVariationLine(args: {
  line: VariationLineInput;
  /** The project owner — whose PAY cards pay and whose BILL cards charge. */
  ownerCompanyId: string;
  /** The project's client, for a counterparty-specific BILL card. Null when none. */
  clientCompanyId: string | null;
  /**
   * The company that raised this variation. When it is not the project owner, its
   * own PAY card is what prices the cost side — see the header.
   */
  recordingCompanyId: string;
  /** The variation's `requestedOn` — the date a quote is priced as of. */
  date: string;
  labelRules: readonly TimeframeDefinition[];
  runner?: Queryable;
}): Promise<ResolvedLinePrice> {
  const { line } = args;

  // Stated prices win outright. Somebody typing a number is the most authoritative
  // source there is for what they are quoting.
  if (line.unitCostCents !== undefined && line.unitSellCents !== undefined) {
    return {
      unitCostCents: line.unitCostCents,
      unitSellCents: line.unitSellCents,
      pricedFrom: 'STATED',
      reason: null,
    };
  }

  if (line.kind !== 'LABOUR' || line.roleId === null) {
    /* c8 ignore next 7 -- the schema's superRefine already refuses this shape. */
    return {
      unitCostCents: line.unitCostCents ?? null,
      unitSellCents: line.unitSellCents ?? null,
      pricedFrom: 'PARTIAL',
      reason: 'State a unit cost and a unit sell for a line the rate engine cannot price.',
    };
  }

  if (line.shiftType === null) {
    /*
     * Finding 6, on the line rather than on the assignment. There is no rate label
     * without a shift type, and inventing one from the date would be the
     * hardcoded rule the owner had removed on 2026-08-17.
     */
    return {
      unitCostCents: line.unitCostCents ?? null,
      unitSellCents: line.unitSellCents ?? null,
      pricedFrom: 'PARTIAL',
      reason:
        'Choose a shift type so the rate engine can resolve a label, or state the prices directly.',
    };
  }

  const payCounterparty =
    args.recordingCompanyId === args.ownerCompanyId ? null : args.recordingCompanyId;

  const [pay, bill] = await Promise.all([
    unitRateFor({
      companyId: args.ownerCompanyId,
      counterpartyId: payCounterparty,
      kind: 'PAY',
      roleId: line.roleId,
      shiftType: line.shiftType,
      date: args.date,
      labelRules: args.labelRules,
      runner: args.runner,
    }),
    args.clientCompanyId === null
      ? Promise.resolve(null)
      : unitRateFor({
          companyId: args.ownerCompanyId,
          counterpartyId: args.clientCompanyId,
          kind: 'BILL',
          roleId: line.roleId,
          shiftType: line.shiftType,
          date: args.date,
          labelRules: args.labelRules,
          runner: args.runner,
        }),
  ]);

  const unitCostCents = line.unitCostCents ?? pay;
  const unitSellCents = line.unitSellCents ?? bill;

  const missing: string[] = [];
  if (unitCostCents === null) {
    missing.push(
      payCounterparty === null
        ? 'no default PAY rate covers this role on this date — a rate card scoped to one subcontractor is not used here, because the extra works have no crew yet'
        : 'no PAY rate covers this role on this date for the company raising it'
    );
  }
  if (unitSellCents === null) {
    missing.push(
      args.clientCompanyId === null
        ? 'this project has no client, so there is no BILL rate to charge against'
        : 'no BILL rate covers this role on this date'
    );
  }

  return {
    unitCostCents,
    unitSellCents,
    pricedFrom: missing.length === 0 ? 'RATE_ENGINE' : 'PARTIAL',
    reason:
      missing.length === 0
        ? null
        : `${missing.join('; ')}. State the price directly, or add the rate card.`,
  };
}

/** The owner's label rules, loaded once for a whole variation. Re-exported for callers. */
export { getEffectiveTimeframeDefinitions };
