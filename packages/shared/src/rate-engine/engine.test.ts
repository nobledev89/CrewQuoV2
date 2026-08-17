import { describe, expect, it } from 'vitest';
import {
  applyMinHours,
  calculateCost,
  calculateMargin,
  dayOfWeek,
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

describe('dayOfWeek', () => {
  it('reads the weekday in UTC, so a date is never shifted by the host TZ', () => {
    // 2026-07-20 is a Monday; the week runs Mon..Sun through 2026-07-26.
    expect(dayOfWeek('2026-07-20')).toBe(1);
    expect(dayOfWeek('2026-07-24')).toBe(5); // Fri
    expect(dayOfWeek('2026-07-25')).toBe(6); // Sat
    expect(dayOfWeek('2026-07-26')).toBe(0); // Sun
  });
});

describe('resolveRateLabel — no rule is hardcoded', () => {
  /**
   * The weekend-night rule as a company now holds it (migration 0007 wrote this
   * shape for every company that had a FRI_SAT_NIGHT card).
   */
  const weekendNight: TimeframeDefinition[] = [
    { type: 'label_rule', shiftType: 'NIGHT', daysOfWeek: [5, 6], label: 'FRI_SAT_NIGHT' },
  ];

  it('falls back to the baseline mapping when the company has no rules', () => {
    // The old hardcoded Fri/Sat promotion is *gone* — a Friday night is just NIGHT.
    expect(resolveRateLabel('NIGHT', '2026-07-24', [])).toBe('MON_THU_NIGHT'); // Fri
    expect(resolveRateLabel('NIGHT', '2026-07-25', [])).toBe('MON_THU_NIGHT'); // Sat
    expect(resolveRateLabel('WEEKDAY_DAY', '2026-07-24', [])).toBe('MON_FRI_DAY');
    expect(resolveRateLabel('SUNDAY', '2026-07-26', [])).toBe('SUNDAY');
  });

  it('applies a matching rule on the days it names', () => {
    expect(resolveRateLabel('NIGHT', '2026-07-24', weekendNight)).toBe('FRI_SAT_NIGHT'); // Fri
    expect(resolveRateLabel('NIGHT', '2026-07-25', weekendNight)).toBe('FRI_SAT_NIGHT'); // Sat
  });

  it('leaves days the rule does not name on the baseline', () => {
    expect(resolveRateLabel('NIGHT', '2026-07-23', weekendNight)).toBe('MON_THU_NIGHT'); // Thu
    expect(resolveRateLabel('NIGHT', '2026-07-26', weekendNight)).toBe('MON_THU_NIGHT'); // Sun
  });

  it('only matches the shift type the rule names', () => {
    expect(resolveRateLabel('WEEKDAY_DAY', '2026-07-24', weekendNight)).toBe('MON_FRI_DAY');
    expect(resolveRateLabel('SUNDAY', '2026-07-25', weekendNight)).toBe('SUNDAY');
  });

  it('treats an empty daysOfWeek as every day', () => {
    const always: TimeframeDefinition[] = [
      { type: 'label_rule', shiftType: 'NIGHT', daysOfWeek: [], label: 'FRI_SAT_NIGHT' },
    ];
    for (const date of ['2026-07-20', '2026-07-23', '2026-07-25', '2026-07-26']) {
      expect(resolveRateLabel('NIGHT', date, always)).toBe('FRI_SAT_NIGHT');
    }
  });

  it('lets a company invert the shipped default — Sunday nights, not weekend nights', () => {
    const sundayNights: TimeframeDefinition[] = [
      { type: 'label_rule', shiftType: 'NIGHT', daysOfWeek: [0], label: 'FRI_SAT_NIGHT' },
    ];
    expect(resolveRateLabel('NIGHT', '2026-07-26', sundayNights)).toBe('FRI_SAT_NIGHT'); // Sun
    expect(resolveRateLabel('NIGHT', '2026-07-24', sundayNights)).toBe('MON_THU_NIGHT'); // Fri
  });

  it('takes the first matching rule, so array order is the precedence list', () => {
    const ordered: TimeframeDefinition[] = [
      { type: 'label_rule', shiftType: 'NIGHT', daysOfWeek: [5], label: 'SUNDAY' },
      { type: 'label_rule', shiftType: 'NIGHT', daysOfWeek: [5], label: 'FRI_SAT_NIGHT' },
    ];
    expect(resolveRateLabel('NIGHT', '2026-07-24', ordered)).toBe('SUNDAY');
  });

  it('ignores holiday definitions sharing the same array', () => {
    const mixed: TimeframeDefinition[] = [
      { type: 'holiday', holidayDates: ['2026-07-24'], holidayMultiplier: 2 },
      ...weekendNight,
    ];
    expect(resolveRateLabel('NIGHT', '2026-07-24', mixed)).toBe('FRI_SAT_NIGHT');
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
  const cards: RateCardInput[] = [
    card({ rateLabel: 'MON_THU_NIGHT', hourlyRateCents: 6000 }),
    card({ rateLabel: 'FRI_SAT_NIGHT', hourlyRateCents: 8000 }),
  ];
  const weekendNight: TimeframeDefinition[] = [
    { type: 'label_rule', shiftType: 'NIGHT', daysOfWeek: [5, 6], label: 'FRI_SAT_NIGHT' },
  ];

  it('derives the label from the rules, then selects the card and extracts the rate', () => {
    const resolved = resolveRate(cards, 'NIGHT', '2026-07-24', weekendNight); // Friday
    expect(resolved?.label).toBe('FRI_SAT_NIGHT');
    expect(resolved?.rate.baseCents).toBe(8000);
  });
  it('picks a different card for the same date when the rules differ', () => {
    // Same cards, same Friday, no rule — the company prices it as a weekday night.
    const resolved = resolveRate(cards, 'NIGHT', '2026-07-24', []);
    expect(resolved?.label).toBe('MON_THU_NIGHT');
    expect(resolved?.rate.baseCents).toBe(6000);
  });
  it('returns null when no card matches the resolved label', () => {
    expect(resolveRate([card({ rateLabel: 'MON_FRI_DAY' })], 'NIGHT', '2026-07-23', [])).toBeNull();
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
