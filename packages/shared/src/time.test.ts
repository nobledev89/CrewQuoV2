import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_ZONE,
  dateInZone,
  dayRangeInZone,
  effectiveTimeZone,
  instantFromLocal,
  isValidTimeZone,
  nextIsoDate,
  offsetMinutes,
  projectTimeZonePinRefusal,
  timeInZone,
  timeZoneLabel,
  timeZoneSchema,
  todayInZone,
} from './time';
import { reportingCurrencyPinRefusal } from './money';

/**
 * One test per rule (§13, §44). The DST cases are pinned against real transition
 * dates rather than a fixture zone, because the whole point is that this code
 * knows nothing about transitions and gets them from the runtime's tzdata.
 *
 * Transitions used:
 *   America/New_York  2026-03-08 02:00 → 03:00 (gap), 2026-11-01 02:00 → 01:00 (overlap)
 *   Asia/Manila       none, ever — the constant-offset control
 */

describe('isValidTimeZone', () => {
  it('accepts real IANA zones', () => {
    for (const zone of ['UTC', 'Asia/Manila', 'America/New_York', 'Europe/London']) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });

  it('rejects a plausible-looking string that is not a zone', () => {
    // The reason this is asked of Intl rather than matched with a regex: a regex
    // accepts this, and it then throws inside a business transaction.
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('rejects empty and blank', () => {
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
  });

  it('refuses an invalid zone at the schema edge', () => {
    expect(timeZoneSchema.safeParse('Asia/Manila').success).toBe(true);
    expect(timeZoneSchema.safeParse('Mars/Olympus').success).toBe(false);
  });
});

describe('dateInZone — whose day is it', () => {
  it('agrees with UTC when the zone is UTC', () => {
    expect(dateInZone(new Date('2026-08-20T23:30:00Z'), 'UTC')).toBe('2026-08-20');
  });

  it('is already tomorrow east of UTC', () => {
    // The exact divergence the retroactive-approval bug turned on.
    expect(dateInZone(new Date('2026-08-20T23:30:00Z'), 'Asia/Manila')).toBe('2026-08-21');
  });

  it('is still yesterday west of UTC', () => {
    expect(dateInZone(new Date('2026-08-21T02:00:00Z'), 'America/Los_Angeles')).toBe('2026-08-20');
  });

  it('falls back to UTC rather than throwing on a bad zone', () => {
    // A zone lookup must never fail a business operation: a slightly wrong day is
    // visible, whereas a refusal looks like a bug in something else.
    expect(dateInZone(new Date('2026-08-20T23:30:00Z'), 'Not/AZone')).toBe('2026-08-20');
  });

  it('reads the wall clock too', () => {
    expect(timeInZone(new Date('2026-08-20T23:30:00Z'), 'Asia/Manila')).toBe('07:30');
    expect(timeInZone(new Date('2026-08-20T23:30:00Z'), 'UTC')).toBe('23:30');
  });

  it('answers "today" for a business from an explicit instant', () => {
    // Explicit instant, so the test does not depend on when it runs.
    expect(todayInZone('Asia/Manila', new Date('2026-08-20T23:30:00Z'))).toBe('2026-08-21');
  });
});

describe('offsetMinutes', () => {
  it('is zero for UTC', () => {
    expect(offsetMinutes(new Date('2026-08-20T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('is a positive whole number of minutes east of UTC', () => {
    expect(offsetMinutes(new Date('2026-08-20T12:00:00Z'), 'Asia/Manila')).toBe(480);
  });

  it('tracks DST rather than assuming one offset per zone', () => {
    // New York is -5 in January and -4 in July. A hard-coded table would show the
    // wrong one for half the year.
    expect(offsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(offsetMinutes(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-240);
  });

  it('handles a zone whose offset is not a whole hour', () => {
    expect(offsetMinutes(new Date('2026-08-20T12:00:00Z'), 'Asia/Kolkata')).toBe(330);
  });
});

describe('instantFromLocal', () => {
  it('round-trips an ordinary local time', () => {
    const instant = instantFromLocal('2026-08-20', '09:00', 'Asia/Manila');
    expect(instant.toISOString()).toBe('2026-08-20T01:00:00.000Z');
    expect(dateInZone(instant, 'Asia/Manila')).toBe('2026-08-20');
    expect(timeInZone(instant, 'Asia/Manila')).toBe('09:00');
  });

  it('round-trips either side of a DST transition', () => {
    for (const [date, time] of [['2026-01-15', '09:00'], ['2026-07-15', '09:00']] as const) {
      const instant = instantFromLocal(date, time, 'America/New_York');
      expect(timeInZone(instant, 'America/New_York')).toBe(time);
      expect(dateInZone(instant, 'America/New_York')).toBe(date);
    }
  });

  it('resolves a spring-forward gap forward instead of throwing', () => {
    // 2026-03-08: New York jumps 02:00 → 03:00, so 02:30 never happens. The
    // result must be a real instant on the correct day, not an exception and not
    // a silent slide into the previous day.
    const instant = instantFromLocal('2026-03-08', '02:30', 'America/New_York');
    expect(Number.isNaN(instant.getTime())).toBe(false);
    expect(dateInZone(instant, 'America/New_York')).toBe('2026-03-08');
    expect(timeInZone(instant, 'America/New_York')).toBe('03:30');
  });

  it('resolves an autumn overlap to the earlier of the two', () => {
    // 2026-11-01: New York repeats 01:00–02:00. A shift recorded as starting at
    // 01:30 started at the first 01:30.
    const instant = instantFromLocal('2026-11-01', '01:30', 'America/New_York');
    expect(instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(timeInZone(instant, 'America/New_York')).toBe('01:30');
  });
});

describe('dayRangeInZone', () => {
  it('covers exactly 24 hours on an ordinary day', () => {
    const { start, end } = dayRangeInZone('2026-08-20', 'Asia/Manila');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(24);
    expect(start.toISOString()).toBe('2026-08-19T16:00:00.000Z');
  });

  it('is 23 hours on a spring-forward day', () => {
    // Computed from the next local midnight, not by adding 24 hours — otherwise
    // an hour of work is double-counted or dropped twice a year.
    const { start, end } = dayRangeInZone('2026-03-08', 'America/New_York');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('is 25 hours on an autumn fall-back day', () => {
    const { start, end } = dayRangeInZone('2026-11-01', 'America/New_York');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });

  it('tiles consecutive days without overlapping', () => {
    // Half-open, so a record on a boundary is counted once and only once.
    const first = dayRangeInZone('2026-03-07', 'America/New_York');
    const second = dayRangeInZone('2026-03-08', 'America/New_York');
    expect(first.end.getTime()).toBe(second.start.getTime());
  });
});

describe('supporting rules', () => {
  it('advances a date across a month and a year boundary', () => {
    expect(nextIsoDate('2026-08-20')).toBe('2026-08-21');
    expect(nextIsoDate('2026-08-31')).toBe('2026-09-01');
    expect(nextIsoDate('2026-12-31')).toBe('2027-01-01');
    expect(nextIsoDate('2028-02-28')).toBe('2028-02-29'); // leap year
  });

  it('treats a null project zone as inherit, not unset', () => {
    expect(effectiveTimeZone(null, 'Asia/Manila')).toBe('Asia/Manila');
    expect(effectiveTimeZone('Asia/Dubai', 'Asia/Manila')).toBe('Asia/Dubai');
    expect(effectiveTimeZone(null, null)).toBe(DEFAULT_TIME_ZONE);
  });

  it('labels a zone with the offset it has at that moment', () => {
    // Half the world's zones have two offsets; showing the January one in July is
    // how a settings screen loses somebody's trust.
    expect(timeZoneLabel('Asia/Manila', new Date('2026-08-20T12:00:00Z'))).toBe(
      'Asia/Manila (UTC+08:00)'
    );
    expect(timeZoneLabel('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(
      'America/New_York (UTC-05:00)'
    );
    expect(timeZoneLabel('America/New_York', new Date('2026-07-15T12:00:00Z'))).toBe(
      'America/New_York (UTC-04:00)'
    );
  });

  it('labels a half-hour zone without mangling the minutes', () => {
    expect(timeZoneLabel('Asia/Kolkata', new Date('2026-08-20T12:00:00Z'))).toBe(
      'Asia/Kolkata (UTC+05:30)'
    );
  });
});

describe('the project time-zone pin (packet §3, §12 step 6)', () => {
  const empty = { approvedTimeLogs: 0, approvedExpenses: 0, liveInvoices: 0 };

  it('lets an empty project change zone', () => {
    expect(projectTimeZonePinRefusal(empty)).toBeNull();
  });

  it('refuses once the project holds approved work, and names what pins it', () => {
    const refusal = projectTimeZonePinRefusal({ ...empty, approvedTimeLogs: 3 });
    expect(refusal).toContain('3 approved time logs');
    // "You cannot do that" is not an explanation: the reason has to say that the
    // days already counted would move.
    expect(refusal).toContain('which local day');
  });

  it('counts one of something as singular', () => {
    expect(projectTimeZonePinRefusal({ ...empty, liveInvoices: 1 })).toContain('1 invoice');
    expect(projectTimeZonePinRefusal({ ...empty, liveInvoices: 2 })).toContain('2 invoices');
  });

  it('lists every kind of commitment, not just the first', () => {
    const refusal = projectTimeZonePinRefusal({
      approvedTimeLogs: 2, approvedExpenses: 1, liveInvoices: 4,
    });
    expect(refusal).toContain('2 approved time logs, 1 approved expense and 4 invoices');
  });

  it('pins on exactly the same facts as the reporting currency', () => {
    // Two settings, one set of committed facts. If these ever diverge, one screen
    // will offer a change the other refuses, for the same project on the same day.
    const pins = { approvedTimeLogs: 1, approvedExpenses: 0, liveInvoices: 0 };
    expect(projectTimeZonePinRefusal(pins) === null).toBe(
      reportingCurrencyPinRefusal(pins) === null
    );
    expect(projectTimeZonePinRefusal(empty) === null).toBe(
      reportingCurrencyPinRefusal(empty) === null
    );
  });
});
