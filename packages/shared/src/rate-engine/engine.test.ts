import { describe, expect, it } from 'vitest';
import {
  applyMinHours,
  calculateCost,
  calculateMargin,
  extractRate,
  getHolidayInfo,
  resolveRate,
  resolveRateLabel,
  selectEffectiveCard,
  shiftTypeToRateLabel,
} from './engine';
import type { RateCardInput, TimeframeDefinition } from './types';

/** Build a rate card with sane defaults; override what a test cares about. */
function card(overrides: Partial<RateCardInput> = {}): RateCardInput {
  return {
    kind: 'PAY',
    rateMode: 'HOURLY',
    rateLabel: 'MON_FRI_DAY',
    hourlyRateCents: 5000,
    otHourlyRateCents: null,
    shiftRateCents: null,
    dailyRateCents: null,
    minHours: null,
    weekendMultiplier: null,
    nightMultiplier: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    active: true,
    ...overrides,
  };
}

describe('shiftTypeToRateLabel', () => {
  it('maps every shift type to its DB-code rate label', () => {
    expect(shiftTypeToRateLabel('WEEKDAY_DAY')).toBe('MON_FRI_DAY');
    expect(shiftTypeToRateLabel('NIGHT')).toBe('MON_THU_NIGHT');
    expect(shiftTypeToRateLabel('SUNDAY')).toBe('SUNDAY');
    expect(shiftTypeToRateLabel('SHIFT')).toBe('SHIFT');
    expect(shiftTypeToRateLabel('DAILY')).toBe('DAILY');
  });
});

describe('resolveRateLabel — FRI_SAT_NIGHT date logic', () => {
  // 2026-07-20 is a Monday; the week runs Mon..Sun through 2026-07-26.
  it('keeps a weekday NIGHT on MON_THU_NIGHT (Thursday)', () => {
    expect(resolveRateLabel('NIGHT', '2026-07-23')).toBe('MON_THU_NIGHT'); // Thu
  });
  it('promotes a Friday NIGHT to FRI_SAT_NIGHT', () => {
    expect(resolveRateLabel('NIGHT', '2026-07-24')).toBe('FRI_SAT_NIGHT'); // Fri
  });
  it('promotes a Saturday NIGHT to FRI_SAT_NIGHT', () => {
    expect(resolveRateLabel('NIGHT', '2026-07-25')).toBe('FRI_SAT_NIGHT'); // Sat
  });
  it('keeps a Sunday NIGHT on MON_THU_NIGHT (not a Fri/Sat)', () => {
    expect(resolveRateLabel('NIGHT', '2026-07-26')).toBe('MON_THU_NIGHT'); // Sun
  });
  it('never promotes a non-NIGHT shift regardless of weekday', () => {
    expect(resolveRateLabel('WEEKDAY_DAY', '2026-07-24')).toBe('MON_FRI_DAY'); // Fri
    expect(resolveRateLabel('SUNDAY', '2026-07-25')).toBe('SUNDAY'); // Sat
  });
});

describe('selectEffectiveCard', () => {
  it('returns null when no card is active on the date', () => {
    expect(selectEffectiveCard([card({ active: false })], '2026-07-01')).toBeNull();
  });
  it('ignores cards whose effective_from is after the date', () => {
    expect(selectEffectiveCard([card({ effectiveFrom: '2026-08-01' })], '2026-07-01')).toBeNull();
  });
  it('ignores cards whose effective_to is before the date', () => {
    expect(
      selectEffectiveCard([card({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' })], '2026-07-01')
    ).toBeNull();
  });
  it('includes an open-ended card (null effective_to)', () => {
    const c = card({ effectiveFrom: '2026-01-01', effectiveTo: null });
    expect(selectEffectiveCard([c], '2026-07-01')).toBe(c);
  });
  it('includes the boundary dates (from == date and to == date)', () => {
    const c = card({ effectiveFrom: '2026-07-01', effectiveTo: '2026-07-01' });
    expect(selectEffectiveCard([c], '2026-07-01')).toBe(c);
  });
  it('picks the most recent effective_from among overlapping cards', () => {
    const older = card({ effectiveFrom: '2026-01-01', hourlyRateCents: 4000 });
    const newer = card({ effectiveFrom: '2026-06-01', hourlyRateCents: 6000 });
    expect(selectEffectiveCard([older, newer], '2026-07-01')).toBe(newer);
    expect(selectEffectiveCard([newer, older], '2026-07-01')).toBe(newer); // order-independent
  });
});

describe('extractRate', () => {
  it('HOURLY: uses explicit OT when present', () => {
    expect(extractRate(card({ hourlyRateCents: 5000, otHourlyRateCents: 8000 }))).toEqual({
      baseCents: 5000,
      otCents: 8000,
    });
  });
  it('HOURLY: defaults OT to base × 1.5 (rounded) when absent', () => {
    expect(extractRate(card({ hourlyRateCents: 5001, otHourlyRateCents: null }))).toEqual({
      baseCents: 5001,
      otCents: 7502, // round(5001 * 1.5) = round(7501.5)
    });
  });
  it('SHIFT: base = shift rate, no OT', () => {
    expect(extractRate(card({ rateMode: 'SHIFT', shiftRateCents: 30000 }))).toEqual({
      baseCents: 30000,
      otCents: null,
    });
  });
  it('DAILY: base = daily rate, no OT', () => {
    expect(extractRate(card({ rateMode: 'DAILY', dailyRateCents: 90000 }))).toEqual({
      baseCents: 90000,
      otCents: null,
    });
  });
  it('throws when the mode-required rate is missing', () => {
    expect(() => extractRate(card({ rateMode: 'HOURLY', hourlyRateCents: null }))).toThrow();
    expect(() => extractRate(card({ rateMode: 'SHIFT', shiftRateCents: null }))).toThrow();
    expect(() => extractRate(card({ rateMode: 'DAILY', dailyRateCents: null }))).toThrow();
  });
});

describe('resolveRate', () => {
  it('derives the label, filters, selects the effective card, extracts the rate', () => {
    const cards: RateCardInput[] = [
      card({ rateLabel: 'MON_THU_NIGHT', hourlyRateCents: 6000 }),
      card({ rateLabel: 'FRI_SAT_NIGHT', hourlyRateCents: 8000 }),
    ];
    const resolved = resolveRate(cards, 'NIGHT', '2026-07-24'); // Friday → FRI_SAT_NIGHT
    expect(resolved?.label).toBe('FRI_SAT_NIGHT');
    expect(resolved?.rate.baseCents).toBe(8000);
  });
  it('returns null when no card matches the resolved label', () => {
    const cards: RateCardInput[] = [card({ rateLabel: 'MON_FRI_DAY' })];
    expect(resolveRate(cards, 'NIGHT', '2026-07-23')).toBeNull();
  });
});

describe('applyMinHours', () => {
  it('is a no-op when minHours is null', () => {
    expect(applyMinHours(2, null)).toBe(2);
  });
  it('raises hours up to the minimum', () => {
    expect(applyMinHours(2, 4)).toBe(4);
  });
  it('leaves hours above the minimum untouched', () => {
    expect(applyMinHours(6, 4)).toBe(6);
  });
});

describe('getHolidayInfo', () => {
  const tfs: TimeframeDefinition[] = [
    { type: 'holiday', holidayDates: ['2026-12-25', '2026-01-01'], holidayMultiplier: 2 },
    { type: 'holiday', holidayDates: ['2026-12-25'], holidayMultiplier: 2.5 },
  ];
  it('returns multiplier 1 for a normal day', () => {
    expect(getHolidayInfo('2026-07-01', tfs)).toEqual({ isHoliday: false, multiplier: 1 });
  });
  it('flags a holiday and returns its multiplier', () => {
    expect(getHolidayInfo('2026-01-01', tfs)).toEqual({ isHoliday: true, multiplier: 2 });
  });
  it('takes the largest multiplier when multiple timeframes match', () => {
    expect(getHolidayInfo('2026-12-25', tfs)).toEqual({ isHoliday: true, multiplier: 2.5 });
  });
  it('handles an empty timeframe list', () => {
    expect(getHolidayInfo('2026-12-25', [])).toEqual({ isHoliday: false, multiplier: 1 });
  });
});

describe('calculateCost', () => {
  it('HOURLY: regular hours × base', () => {
    expect(calculateCost({ card: card({ hourlyRateCents: 5000 }), quantity: 8 })).toBe(40000);
  });
  it('HOURLY: applies min-hours before charging', () => {
    expect(
      calculateCost({ card: card({ hourlyRateCents: 5000, minHours: 4 }), quantity: 2 })
    ).toBe(20000); // charged for 4h
  });
  it('HOURLY: adds overtime at the OT rate', () => {
    expect(
      calculateCost({
        card: card({ hourlyRateCents: 5000, otHourlyRateCents: 7500 }),
        quantity: 8,
        otHours: 2,
      })
    ).toBe(40000 + 15000);
  });
  it('HOURLY: multiplier scales the whole line', () => {
    expect(
      calculateCost({ card: card({ hourlyRateCents: 5000 }), quantity: 8, multiplier: 2 })
    ).toBe(80000);
  });
  it('SHIFT: quantity units × shift rate, ignores otHours/min-hours', () => {
    expect(
      calculateCost({
        card: card({ rateMode: 'SHIFT', shiftRateCents: 30000, minHours: 8 }),
        quantity: 2,
        otHours: 5,
      })
    ).toBe(60000);
  });
  it('DAILY: quantity units × daily rate with multiplier', () => {
    expect(
      calculateCost({
        card: card({ rateMode: 'DAILY', dailyRateCents: 90000 }),
        quantity: 3,
        multiplier: 1.5,
      })
    ).toBe(405000);
  });
  it('rounds to whole cents', () => {
    expect(
      calculateCost({ card: card({ hourlyRateCents: 3333 }), quantity: 1, multiplier: 1.005 })
    ).toBe(3350); // round(3333 * 1.005) = round(3349.665)
  });
});

describe('calculateMargin', () => {
  it('computes margin and percentage', () => {
    expect(calculateMargin(10000, 7500)).toEqual({
      clientBillCents: 10000,
      subCostCents: 7500,
      marginCents: 2500,
      marginPct: 25,
    });
  });
  it('handles a negative margin', () => {
    const m = calculateMargin(5000, 8000);
    expect(m.marginCents).toBe(-3000);
    expect(m.marginPct).toBe(-60);
  });
  it('returns 0% when clientBill is 0 (no divide-by-zero)', () => {
    expect(calculateMargin(0, 0).marginPct).toBe(0);
  });
  it('rounds the percentage to 2 dp', () => {
    expect(calculateMargin(3000, 1000).marginPct).toBe(66.67);
  });
});
