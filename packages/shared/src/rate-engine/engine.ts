import { SHIFT_TYPE_TO_RATE_LABEL, type RateLabel, type ShiftType } from '../enums';
import type {
  CostInput,
  ExtractedRate,
  HolidayInfo,
  MarginResult,
  RateCardInput,
  ResolvedRate,
  TimeframeDefinition,
} from './types';

/**
 * Rate engine — pure functions ported from v1 `functions/src/rates.ts`
 * (CREWQUO_V2_PLAN.md §6). No I/O: the API loads candidate cards from Postgres
 * and passes them in. Every branch is pinned by `engine.test.ts`.
 */

/** Day-of-week (0=Sun … 6=Sat) for an ISO date, read in UTC to avoid TZ drift. */
export function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/**
 * Baseline shift-type → rate-label mapping. This is the enum correspondence
 * between what a worker logs and how a card is labelled — structural, not a
 * pricing rule — and it is what applies when a company has configured no
 * `label_rule` covering the shift.
 */
export function shiftTypeToRateLabel(shiftType: ShiftType): RateLabel {
  return SHIFT_TYPE_TO_RATE_LABEL[shiftType];
}

/**
 * Resolve the rate label for a shift on a specific date, honouring the company's
 * own label rules.
 *
 * **No date rule is hardcoded here** (owner decision, 2026-08-17). `rules` comes
 * from the company's default `rate_card_templates.timeframe_definitions`; the
 * first `label_rule` matching both the shift type and the weekday wins, so the
 * array order is the company's precedence list. With no matching rule the
 * baseline mapping applies.
 *
 * The weekend-night behaviour that used to live in this function is now a rule a
 * company holds as data — migration 0007 wrote it for every company that had a
 * FRI_SAT_NIGHT card, so nothing already priced changes.
 */
export function resolveRateLabel(
  shiftType: ShiftType,
  isoDate: string,
  rules: readonly TimeframeDefinition[]
): RateLabel {
  const dow = dayOfWeek(isoDate);
  for (const rule of rules) {
    if (rule.type !== 'label_rule') continue;
    if (rule.shiftType !== shiftType) continue;
    if (rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(dow)) continue;
    return rule.label;
  }
  return shiftTypeToRateLabel(shiftType);
}

/**
 * From a set of candidate cards (already filtered to one company/kind/role/label),
 * pick the one in effect on `isoDate`: active, `effective_from <= date`, and
 * `effective_to` null or `>= date`; ties broken by most recent `effective_from`
 * (v1 RateResolver's effective-date selection loop). Returns null if none apply.
 */
export function selectEffectiveCard<T extends RateCardInput>(
  cards: readonly T[],
  isoDate: string
): T | null {
  let best: T | null = null;
  for (const card of cards) {
    if (!card.active) continue;
    if (card.effectiveFrom > isoDate) continue;
    if (card.effectiveTo !== null && card.effectiveTo < isoDate) continue;
    if (best === null || card.effectiveFrom > best.effectiveFrom) best = card;
  }
  return best;
}

/**
 * Extract the base (and OT) rate per `rate_mode` (v1 `extractRate`):
 * - HOURLY: base = hourly rate; OT = explicit ot rate, else base × 1.5.
 * - SHIFT/DAILY: base = the shift/daily rate; no OT.
 * Throws if the card is missing the rate its mode requires.
 */
export function extractRate(card: RateCardInput): ExtractedRate {
  switch (card.rateMode) {
    case 'HOURLY': {
      if (card.hourlyRateCents === null) {
        throw new Error('HOURLY rate card is missing hourly_rate_cents');
      }
      const otCents =
        card.otHourlyRateCents ?? Math.round(card.hourlyRateCents * 1.5);
      return { baseCents: card.hourlyRateCents, otCents };
    }
    case 'SHIFT': {
      if (card.shiftRateCents === null) {
        throw new Error('SHIFT rate card is missing shift_rate_cents');
      }
      return { baseCents: card.shiftRateCents, otCents: null };
    }
    case 'DAILY': {
      if (card.dailyRateCents === null) {
        throw new Error('DAILY rate card is missing daily_rate_cents');
      }
      return { baseCents: card.dailyRateCents, otCents: null };
    }
  }
}

/**
 * Full resolve (v1 `RateResolver.resolveRate`): derive the label from the shift +
 * date + the company's label rules, pick the effective card, and extract its
 * rate. The caller supplies cards pre-filtered by company/kind/role (the SQL
 * candidate query lives in the repo); this narrows to the label and effective
 * date. Returns null if nothing applies.
 */
export function resolveRate(
  cards: readonly RateCardInput[],
  shiftType: ShiftType,
  isoDate: string,
  rules: readonly TimeframeDefinition[]
): ResolvedRate | null {
  const label = resolveRateLabel(shiftType, isoDate, rules);
  const forLabel = cards.filter((c) => c.rateLabel === label);
  const card = selectEffectiveCard(forLabel, isoDate);
  if (card === null) return null;
  return { label, card, rate: extractRate(card) };
}

/**
 * Enforce a card's minimum billable hours (v1 `applyMinHours`): a null minimum is
 * a no-op. Only meaningful for HOURLY work.
 */
export function applyMinHours(hours: number, minHours: number | null): number {
  if (minHours === null) return hours;
  return Math.max(hours, minHours);
}

/**
 * Holiday lookup over a template's timeframe definitions (v1 `getHolidayInfo`).
 * When `isoDate` matches a `holiday` timeframe's `holidayDates`, returns that
 * timeframe's multiplier; otherwise `{ isHoliday: false, multiplier: 1 }`. If
 * several holiday timeframes match, the largest multiplier wins.
 */
export function getHolidayInfo(
  isoDate: string,
  timeframes: readonly TimeframeDefinition[]
): HolidayInfo {
  let multiplier = 1;
  let isHoliday = false;
  for (const tf of timeframes) {
    if (tf.type !== 'holiday') continue;
    if (tf.holidayDates.includes(isoDate)) {
      isHoliday = true;
      if (tf.holidayMultiplier > multiplier) multiplier = tf.holidayMultiplier;
    }
  }
  return { isHoliday, multiplier };
}

/**
 * Cost of a single line item in cents (v1 `PriceCalculator.calculate`).
 * - HOURLY: (max(quantity, min_hours) × base + otHours × ot) × multiplier.
 * - SHIFT/DAILY: quantity units × base × multiplier; no OT, no min-hours.
 * Rounded to whole cents.
 */
export function calculateCost(input: CostInput): number {
  const { card, quantity, otHours = 0, multiplier = 1 } = input;
  const rate = extractRate(card);

  if (card.rateMode === 'HOURLY') {
    const hours = applyMinHours(quantity, card.minHours);
    const regular = hours * rate.baseCents;
    const overtime = rate.otCents === null ? 0 : otHours * rate.otCents;
    return Math.round((regular + overtime) * multiplier);
  }

  // SHIFT / DAILY — quantity is a unit count.
  return Math.round(quantity * rate.baseCents * multiplier);
}

/**
 * Margin between the client BILL total and the provider PAY (sub) cost
 * (v1 `PriceCalculator`): `margin = clientBill − subCost`. `marginPct` is
 * margin ÷ clientBill as a percentage to 2 dp (0 when clientBill is 0).
 */
export function calculateMargin(
  clientBillCents: number,
  subCostCents: number
): MarginResult {
  const marginCents = clientBillCents - subCostCents;
  const marginPct =
    clientBillCents === 0
      ? 0
      : Math.round((marginCents / clientBillCents) * 10000) / 100;
  return { clientBillCents, subCostCents, marginCents, marginPct };
}
