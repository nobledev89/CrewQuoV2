import type { RateKind, RateLabel, RateMode } from '../enums';

/**
 * Rate engine data shapes (CREWQUO_V2_PLAN.md §6). These are plain data — the
 * API loads rows from Postgres and passes them in. Money is always integer
 * cents; dates are ISO `YYYY-MM-DD` strings interpreted as calendar days (UTC).
 */

/** A rate card as the engine consumes it (camelCase mirror of the `rate_cards` row). */
export interface RateCardInput {
  kind: RateKind;
  rateMode: RateMode;
  rateLabel: RateLabel;
  hourlyRateCents: number | null;
  otHourlyRateCents: number | null;
  shiftRateCents: number | null;
  dailyRateCents: number | null;
  minHours: number | null;
  weekendMultiplier: number | null;
  nightMultiplier: number | null;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD, null = open-ended
  active: boolean;
}

/**
 * A timeframe definition from `rate_card_templates.timeframe_definitions`
 * (§3.3 / §6). Only `holiday` is defined today; the discriminated `type`
 * leaves room for future kinds.
 */
export interface HolidayTimeframe {
  type: 'holiday';
  holidayDates: string[]; // YYYY-MM-DD
  holidayMultiplier: number; // e.g. 2 for double-time
}
export type TimeframeDefinition = HolidayTimeframe;

/** Per-mode rate extracted from a card: a base unit rate and (HOURLY only) an OT rate. */
export interface ExtractedRate {
  baseCents: number;
  otCents: number | null; // null for SHIFT/DAILY
}

/** Result of resolving a shift + date against a company's candidate cards. */
export interface ResolvedRate {
  label: RateLabel;
  card: RateCardInput;
  rate: ExtractedRate;
}

export interface HolidayInfo {
  isHoliday: boolean;
  multiplier: number; // 1 when not a holiday
}

/** Inputs to a single line-item cost calculation. */
export interface CostInput {
  card: RateCardInput;
  /** HOURLY: regular hours worked. SHIFT/DAILY: number of units (default 1). */
  quantity: number;
  /** HOURLY only: overtime hours. Ignored for SHIFT/DAILY. */
  otHours?: number;
  /** Combined premium multiplier (weekend/night/holiday). Default 1. */
  multiplier?: number;
}

export interface MarginResult {
  clientBillCents: number;
  subCostCents: number;
  marginCents: number;
  /** margin ÷ clientBill as a percentage, 2 dp; 0 when clientBill is 0. */
  marginPct: number;
}
