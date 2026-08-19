import { z } from 'zod';

/**
 * The money boundary (CREWQUO_V2_PLAN.md §3.3 decision #5, §41.9).
 * Operating-model packet: `docs/operating-model/money-boundary.md`.
 *
 * An amount is a *number* and a *unit*. CrewQuo stores the number as integer
 * minor units and, until this module, kept the unit as a label on the company
 * rather than a property of each figure. That is safe exactly as long as every
 * figure in one company shares one unit — an assumption Phase 6 broke when a rate
 * proposal (0009) and an invoice (0008) each grew their own currency.
 *
 * Everything here obeys two rules that come from §41 rather than from taste:
 *
 * 1. **Never invent a rate.** CrewQuo holds no exchange rate and fetches none.
 *    A conversion is possible only when a human recorded a rate with a source.
 *    No rate means the figure is *withheld and named*, never estimated and never
 *    folded in as zero — the same shape `billResolvable` already uses for a gap
 *    in BILL cards.
 * 2. **Full precision internally, rounded once at the end** (§41.9). The
 *    arithmetic below is exact integer maths on `bigint`, not floating point, so
 *    a long chain of conversions cannot accumulate the drift that makes two
 *    screens disagree about the same total by a cent.
 */

/** A rate as stored: one unit of `baseCurrency` is worth `rate` of `quoteCurrency`. */
export interface FxRateFacts {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  /** Decimal string — `numeric(20,10)` arrives from pg as text, and is kept as text. */
  rate: string;
  /** YYYY-MM-DD. */
  asOf: string;
  source: string;
}

/** What a converted figure cites, frozen alongside the amount it produced. */
export interface FxSnapshot {
  fxRateId: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  asOf: string;
  source: string;
}

/** One reason a project summary could not report part of its money. */
export interface ConversionGap {
  baseCurrency: string;
  quoteCurrency: string;
  /** The earliest work date that needed a rate and did not find one. */
  earliestDate: string;
  /** How many records are withheld for this pair. */
  recordCount: number;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_RE.test(value);
}

/**
 * Exact conversion of integer minor units, rounded half-away-from-zero once at
 * the very end (§41.9).
 *
 * `rate` is parsed as a decimal string rather than a float on purpose. `1.1` is
 * not representable in binary floating point, so `12345 * 1.1` is already wrong
 * before any rounding decision is made; scaling to integers and dividing with
 * `bigint` means the only approximation in the whole pipeline is the single
 * deliberate rounding to minor units.
 *
 * Half-away-from-zero rather than banker's rounding because that is what an
 * invoice reader expects and what the rest of the codebase already does
 * (`amount_cents = round(quantity * unit_amount_cents)` in 0008 is Postgres
 * `round`, which is half-away-from-zero for numeric).
 */
export function convertMinorUnits(amountMinorUnits: number, rate: string | number): number {
  if (!Number.isInteger(amountMinorUnits)) {
    throw new RangeError('convertMinorUnits expects integer minor units');
  }
  const { numerator, scale } = parseDecimal(String(rate));
  if (numerator <= 0n) {
    throw new RangeError('An exchange rate must be greater than zero');
  }
  const amount = BigInt(amountMinorUnits);
  const denominator = 10n ** BigInt(scale);
  const product = amount * numerator;

  // Round half away from zero, entirely in integer arithmetic.
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
  const signed = negative ? -rounded : rounded;

  const result = Number(signed);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Converted amount exceeds the safe integer range');
  }
  return result;
}

function parseDecimal(value: string): { numerator: bigint; scale: number } {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new RangeError(`Not a decimal number: ${value}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  return {
    numerator: BigInt(whole + fraction),
    scale: fraction.length,
  };
}

/**
 * The rate in force for money dated `asOf`: the latest recorded rate on or before
 * that date, or null when none covers it.
 *
 * **A future rate is never applied backwards.** This is the same precedence shape
 * as `pickEffectiveCard` (§6) and exists for the same reason — a rate recorded
 * next month is evidence about next month, and using it to restate work already
 * done would make a committed cost move after the fact.
 */
export function pickFxRate(
  candidates: readonly FxRateFacts[],
  asOf: string
): FxRateFacts | null {
  let best: FxRateFacts | null = null;
  for (const candidate of candidates) {
    if (candidate.asOf > asOf) continue;
    if (!best || candidate.asOf > best.asOf) best = candidate;
  }
  return best;
}

/** Freeze what a conversion used, so the figure can name its own provenance. */
export function toFxSnapshot(rate: FxRateFacts): FxSnapshot {
  return {
    fxRateId: rate.id,
    baseCurrency: rate.baseCurrency,
    quoteCurrency: rate.quoteCurrency,
    rate: rate.rate,
    asOf: rate.asOf,
    source: rate.source,
  };
}

/**
 * Why this amount cannot be reported in the target currency, or null when it can
 * (either because the units already match or because a rate covers the date).
 *
 * The message names the exact missing row, because "unlike currencies are not
 * supported" tells a user nothing they can act on, whereas "record GBP→USD as of
 * or before 2026-08-01" is a repair path.
 */
export function missingFxRateRefusal(args: {
  baseCurrency: string;
  quoteCurrency: string;
  asOf: string;
}): string {
  return (
    `No exchange rate covers ${args.baseCurrency} to ${args.quoteCurrency} on or ` +
    `before ${args.asOf}. CrewQuo never estimates a rate, so this figure is left ` +
    `out rather than guessed. Record the rate with its source to include it.`
  );
}

/**
 * Convert an amount into the reporting currency, or explain why not.
 *
 * Returning a discriminated result rather than throwing is deliberate: a missing
 * rate is the *normal* partial-success case a summary is built to report, not an
 * error condition. A summary with three of five providers convertible reports the
 * three and names the two — a total that silently omitted the rest would be worse
 * than no total at all.
 */
export type ConversionResult =
  | { ok: true; amountMinorUnits: number; fx: FxSnapshot | null }
  | { ok: false; reason: string };

export function convertToReportingCurrency(args: {
  amountMinorUnits: number;
  sourceCurrency: string;
  reportingCurrency: string;
  asOf: string;
  candidates: readonly FxRateFacts[];
}): ConversionResult {
  if (args.sourceCurrency === args.reportingCurrency) {
    return { ok: true, amountMinorUnits: args.amountMinorUnits, fx: null };
  }
  const usable = args.candidates.filter(
    (c) => c.baseCurrency === args.sourceCurrency && c.quoteCurrency === args.reportingCurrency
  );
  const rate = pickFxRate(usable, args.asOf);
  if (!rate) {
    return {
      ok: false,
      reason: missingFxRateRefusal({
        baseCurrency: args.sourceCurrency,
        quoteCurrency: args.reportingCurrency,
        asOf: args.asOf,
      }),
    };
  }
  return {
    ok: true,
    amountMinorUnits: convertMinorUnits(args.amountMinorUnits, rate.rate),
    fx: toFxSnapshot(rate),
  };
}

/**
 * Why a project's reporting currency can no longer be changed, or null when it
 * still can.
 *
 * Changing the unit a project reports in after money has committed would restate
 * history: the stored minor units do not move, so every past figure would silently
 * change meaning. The refusal names what pins it, because "you cannot do that" is
 * not an explanation — a user who sees "3 approved time logs" knows both why and
 * what a new project would cost them.
 */
export function reportingCurrencyPinRefusal(pins: {
  approvedTimeLogs: number;
  approvedExpenses: number;
  liveInvoices: number;
}): string | null {
  const parts: string[] = [];
  if (pins.approvedTimeLogs > 0) parts.push(plural(pins.approvedTimeLogs, 'approved time log'));
  if (pins.approvedExpenses > 0) parts.push(plural(pins.approvedExpenses, 'approved expense'));
  if (pins.liveInvoices > 0) parts.push(plural(pins.liveInvoices, 'invoice'));
  if (parts.length === 0) return null;
  return (
    `This project already reports money: ${joinList(parts)}. Changing its ` +
    `reporting currency now would restate figures that are already committed, so ` +
    `it is fixed for the life of the project.`
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Why a recorded rate cannot be deleted, or null when it can.
 *
 * A frozen snapshot names the row it was computed from. Deleting it would turn a
 * traceable historical figure into an unexplainable one — the same reproducibility
 * rule §41.3 states for reports, applied to the input rather than the output.
 */
export function fxRateDeletionRefusal(citations: number): string | null {
  if (citations <= 0) return null;
  return (
    `This rate is cited by ${plural(citations, 'committed figure')} and cannot be ` +
    `deleted. To correct it, record a new rate at a later date — both stay visible, ` +
    `and nothing already agreed moves.`
  );
}

/**
 * The tax gate (money-boundary packet, "The tax gate").
 *
 * Today's invoice is a commercial document with a single operator-entered tax
 * amount: no tax identity on either party, no per-line rate, no jurisdiction and
 * no credit-note path. That is a legitimate inter-company document and is **not**
 * a tax invoice anywhere. Five things must exist before the product may say
 * otherwise, and they are listed in the packet rather than half-built here —
 * inventing a tax shape before the jurisdictions are known is the invented-shape
 * failure §0 rule 3 forbids, and a half-built tax model is more dangerous than an
 * honestly labelled manual field because it looks authoritative.
 *
 * Exported as a constant so the label is written once and asserted by test,
 * rather than living in a reviewer's memory.
 */
export const TAX_IS_MANUAL_NOTICE =
  'Manually entered. CrewQuo does not calculate tax and this document is not a tax invoice.';

// ── API contracts (§7 conventions, §46) ───────────────────────────────────────

const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(CURRENCY_RE, 'expected a 3-letter ISO 4217 code');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * A rate arrives and is stored as a decimal *string*, never a JS number. A float
 * cannot represent every `numeric(20,10)` value, so parsing one on the way in
 * would quietly lose precision before the row was even written — the drift
 * `convertMinorUnits` exists to avoid.
 */
const rateDecimal = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,10})?$/, 'expected a positive decimal with up to 10 places')
  .refine((v) => Number(v) > 0, 'an exchange rate must be greater than zero');

export const fxRateViewSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  baseCurrency: currencyCode,
  quoteCurrency: currencyCode,
  rate: z.string(),
  asOf: isoDate,
  source: z.string(),
  note: z.string().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
  /** How many committed figures cite this rate — the delete guard, surfaced. */
  citationCount: z.number().int().min(0),
});
export type FxRateView = z.infer<typeof fxRateViewSchema>;

export const createFxRateSchema = z
  .object({
    baseCurrency: currencyCode,
    quoteCurrency: currencyCode,
    rate: rateDecimal,
    asOf: isoDate,
    /**
     * Required, and deliberately not a free-form optional note. A rate without a
     * stated origin is indistinguishable from an invented one, which is the whole
     * thing §41.1 forbids.
     */
    source: z.string().trim().min(1).max(200),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.baseCurrency !== v.quoteCurrency, {
    message: 'A rate needs two different currencies',
    path: ['quoteCurrency'],
  });
export type CreateFxRate = z.infer<typeof createFxRateSchema>;

export const listFxRatesQuerySchema = z.object({
  baseCurrency: currencyCode.optional(),
  quoteCurrency: currencyCode.optional(),
});
export type ListFxRatesQuery = z.infer<typeof listFxRatesQuerySchema>;

/** The frozen citation carried inside a snapshot or alongside a converted figure. */
export const fxSnapshotSchema = z.object({
  fxRateId: z.string().uuid(),
  baseCurrency: currencyCode,
  quoteCurrency: currencyCode,
  rate: z.string(),
  asOf: isoDate,
  source: z.string(),
});

/** One named gap in a summary — what could not be reported, and why. */
export const conversionGapSchema = z.object({
  baseCurrency: currencyCode,
  quoteCurrency: currencyCode,
  earliestDate: isoDate,
  recordCount: z.number().int().min(0),
});
