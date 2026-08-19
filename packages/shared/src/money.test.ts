import { describe, expect, it } from 'vitest';
import {
  TAX_IS_MANUAL_NOTICE,
  convertMinorUnits,
  convertToReportingCurrency,
  fxRateDeletionRefusal,
  isCurrencyCode,
  missingFxRateRefusal,
  pickFxRate,
  reportingCurrencyPinRefusal,
  toFxSnapshot,
  type FxRateFacts,
} from './money';

/**
 * One test per rule (§13, §44). Conversion is the one place in the product where
 * a rounding decision silently changes what somebody is owed, so the arithmetic
 * is pinned exhaustively rather than by sampling — the rate-engine lesson applied
 * to money's other axis.
 */

const rate = (over: Partial<FxRateFacts> = {}): FxRateFacts => ({
  id: '00000000-0000-4000-8000-000000000001',
  baseCurrency: 'GBP',
  quoteCurrency: 'USD',
  rate: '1.2700000000',
  asOf: '2026-08-01',
  source: 'ECB reference rate',
  ...over,
});

describe('convertMinorUnits', () => {
  it('converts at the stored rate', () => {
    expect(convertMinorUnits(10_000, '1.27')).toBe(12_700);
  });

  it('rounds half away from zero, matching the invoice line rule in 0008', () => {
    // 5 * 1.5 = 7.5 -> 8, not 7. Banker's rounding would give 8 here too, so the
    // discriminating case is 2.5 -> 3 (banker's would give 2).
    expect(convertMinorUnits(5, '1.5')).toBe(8);
    expect(convertMinorUnits(5, '0.5')).toBe(3);
    expect(convertMinorUnits(3, '0.5')).toBe(2);
  });

  it('rounds negatives away from zero too, so a credit is not quietly favourable', () => {
    expect(convertMinorUnits(-5, '0.5')).toBe(-3);
  });

  it('is exact where floating point is not', () => {
    // 3350 * 1.1 evaluates to 3685.0000000000005 in binary floating point, and
    // 50 * 1.1 to 55.00000000000001. Integer arithmetic makes the answer exact.
    expect(3350 * 1.1).not.toBe(3685);
    expect(convertMinorUnits(3350, '1.1')).toBe(3685);
    expect(50 * 1.1).not.toBe(55);
    expect(convertMinorUnits(50, '1.1')).toBe(55);
  });

  it('carries the full stored precision rather than truncating the rate first', () => {
    // A numeric(20,10) rate uses every decimal place it was given.
    expect(convertMinorUnits(1_000_000, '1.2345678901')).toBe(1_234_568);
  });

  it('never rounds mid-calculation (§41.9)', () => {
    // Rounding the rate to 2dp first would give 1.23 -> 123_000; rounding the
    // amount first would lose the fraction entirely. Only one rounding happens.
    expect(convertMinorUnits(100_000, '1.234')).toBe(123_400);
  });

  it('leaves an amount unchanged at a rate of exactly one', () => {
    expect(convertMinorUnits(99_999, '1')).toBe(99_999);
  });

  it('accepts a plain number rate as well as the stored decimal string', () => {
    expect(convertMinorUnits(10_000, 1.25)).toBe(12_500);
  });

  it('refuses a zero or negative rate rather than producing a zero cost', () => {
    expect(() => convertMinorUnits(100, '0')).toThrow(/greater than zero/);
    expect(() => convertMinorUnits(100, '-1.2')).toThrow(/greater than zero/);
  });

  it('refuses a non-integer amount, because minor units are integers', () => {
    expect(() => convertMinorUnits(10.5, '1.2')).toThrow(/integer minor units/);
  });

  it('refuses a rate that is not a decimal number', () => {
    expect(() => convertMinorUnits(100, '1,27')).toThrow(/decimal number/);
    expect(() => convertMinorUnits(100, 'abc')).toThrow(/decimal number/);
  });

  it('refuses a result outside the safe integer range rather than returning a wrong one', () => {
    expect(() => convertMinorUnits(Number.MAX_SAFE_INTEGER, '1000')).toThrow(/safe integer/);
  });
});

describe('pickFxRate', () => {
  it('returns null when nothing has been recorded', () => {
    expect(pickFxRate([], '2026-08-01')).toBeNull();
  });

  it('picks the latest rate on or before the date', () => {
    const older = rate({ id: 'a', asOf: '2026-07-01', rate: '1.20' });
    const newer = rate({ id: 'b', asOf: '2026-08-01', rate: '1.27' });
    expect(pickFxRate([older, newer], '2026-08-15')?.id).toBe('b');
  });

  it('includes a rate dated exactly on the day', () => {
    expect(pickFxRate([rate({ asOf: '2026-08-01' })], '2026-08-01')).not.toBeNull();
  });

  it('never applies a future rate backwards', () => {
    const future = rate({ id: 'future', asOf: '2026-09-01' });
    expect(pickFxRate([future], '2026-08-01')).toBeNull();
  });

  it('prefers the older rate when the newer one post-dates the work', () => {
    const older = rate({ id: 'a', asOf: '2026-07-01' });
    const future = rate({ id: 'b', asOf: '2026-09-01' });
    expect(pickFxRate([older, future], '2026-08-01')?.id).toBe('a');
  });

  it('does not depend on the order candidates arrive in', () => {
    const a = rate({ id: 'a', asOf: '2026-07-01' });
    const b = rate({ id: 'b', asOf: '2026-08-01' });
    expect(pickFxRate([a, b], '2026-08-15')?.id).toBe('b');
    expect(pickFxRate([b, a], '2026-08-15')?.id).toBe('b');
  });
});

describe('convertToReportingCurrency', () => {
  const base = {
    amountMinorUnits: 10_000,
    sourceCurrency: 'GBP',
    reportingCurrency: 'USD',
    asOf: '2026-08-15',
  };

  it('passes a like-for-like amount through untouched and cites no rate', () => {
    const result = convertToReportingCurrency({
      ...base,
      sourceCurrency: 'USD',
      candidates: [],
    });
    expect(result).toEqual({ ok: true, amountMinorUnits: 10_000, fx: null });
  });

  it('converts and cites the rate it used', () => {
    const result = convertToReportingCurrency({ ...base, candidates: [rate()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amountMinorUnits).toBe(12_700);
    expect(result.fx).toEqual({
      fxRateId: '00000000-0000-4000-8000-000000000001',
      baseCurrency: 'GBP',
      quoteCurrency: 'USD',
      rate: '1.2700000000',
      asOf: '2026-08-01',
      source: 'ECB reference rate',
    });
  });

  it('withholds and explains rather than estimating when no rate covers the date', () => {
    const result = convertToReportingCurrency({ ...base, candidates: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/GBP to USD/);
    expect(result.reason).toMatch(/2026-08-15/);
    expect(result.reason).toMatch(/never estimates/);
  });

  it('ignores a rate recorded for a different pair', () => {
    const wrongPair = rate({ baseCurrency: 'EUR' });
    expect(convertToReportingCurrency({ ...base, candidates: [wrongPair] }).ok).toBe(false);
  });

  it('does not use a rate in reverse — the inverse of a rate is a different number', () => {
    // A USD->GBP rate must not be flipped to answer GBP->USD: 1/rate looks like
    // algebra but is not the market's inverse, and §41.1 forbids inventing one.
    const reversed = rate({ baseCurrency: 'USD', quoteCurrency: 'GBP', rate: '0.7874015748' });
    expect(convertToReportingCurrency({ ...base, candidates: [reversed] }).ok).toBe(false);
  });

  it('refuses a rate that post-dates the money', () => {
    const future = rate({ asOf: '2026-09-01' });
    expect(convertToReportingCurrency({ ...base, candidates: [future] }).ok).toBe(false);
  });
});

describe('reportingCurrencyPinRefusal', () => {
  it('allows the change while the project holds no committed money', () => {
    expect(
      reportingCurrencyPinRefusal({ approvedTimeLogs: 0, approvedExpenses: 0, liveInvoices: 0 })
    ).toBeNull();
  });

  it('names a single pin in the singular', () => {
    const refusal = reportingCurrencyPinRefusal({
      approvedTimeLogs: 1,
      approvedExpenses: 0,
      liveInvoices: 0,
    });
    expect(refusal).toMatch(/1 approved time log\b/);
    expect(refusal).not.toMatch(/time logs/);
  });

  it('names every pin, so the user knows the whole reason at once', () => {
    const refusal = reportingCurrencyPinRefusal({
      approvedTimeLogs: 3,
      approvedExpenses: 2,
      liveInvoices: 1,
    });
    expect(refusal).toMatch(/3 approved time logs, 2 approved expenses and 1 invoice/);
  });

  it('is pinned by an approved expense alone, not only by time logs', () => {
    expect(
      reportingCurrencyPinRefusal({ approvedTimeLogs: 0, approvedExpenses: 1, liveInvoices: 0 })
    ).not.toBeNull();
  });

  it('is pinned by a live invoice alone', () => {
    expect(
      reportingCurrencyPinRefusal({ approvedTimeLogs: 0, approvedExpenses: 0, liveInvoices: 1 })
    ).not.toBeNull();
  });
});

describe('fxRateDeletionRefusal', () => {
  it('allows deleting a rate nothing cites', () => {
    expect(fxRateDeletionRefusal(0)).toBeNull();
  });

  it('refuses a cited rate and says how many figures depend on it', () => {
    expect(fxRateDeletionRefusal(2)).toMatch(/2 committed figures/);
  });

  it('offers the correction path rather than a bare refusal', () => {
    expect(fxRateDeletionRefusal(1)).toMatch(/record a new rate at a later date/i);
  });
});

describe('supporting rules', () => {
  it('accepts only ISO 4217-shaped codes', () => {
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('usd')).toBe(false);
    expect(isCurrencyCode('US')).toBe(false);
    expect(isCurrencyCode('USDX')).toBe(false);
  });

  it('names the exact missing row rather than saying multi-currency is unsupported', () => {
    const message = missingFxRateRefusal({
      baseCurrency: 'GBP',
      quoteCurrency: 'USD',
      asOf: '2026-08-01',
    });
    expect(message).toMatch(/GBP to USD/);
    expect(message).toMatch(/on or before 2026-08-01/);
  });

  it('freezes every field a figure needs to explain itself later', () => {
    expect(Object.keys(toFxSnapshot(rate())).sort()).toEqual([
      'asOf',
      'baseCurrency',
      'fxRateId',
      'quoteCurrency',
      'rate',
      'source',
    ]);
  });

  it('never lets the product call an invoice a tax invoice', () => {
    expect(TAX_IS_MANUAL_NOTICE).toMatch(/not a tax invoice/i);
    expect(TAX_IS_MANUAL_NOTICE).toMatch(/does not calculate tax/i);
  });
});
