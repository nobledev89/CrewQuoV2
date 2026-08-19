import { z } from 'zod';
import { describeProjectCommitments, type ProjectCommitmentPins } from './money';

/**
 * Time and time zones (CREWQUO_V2_PLAN.md §42).
 * Operating-model packet: `docs/operating-model/time.md`.
 *
 * **An instant is a point in time; a date is a human's answer to "which day was
 * that".** CrewQuo stores both — `timestamptz` and `date` — and the bug is never
 * in either column. The bug is always in converting one to the other without
 * naming a zone.
 *
 * The one that cost real money before this file existed: `todayIso()` returned
 * the *server's* UTC date and retroactive rate approval keyed off it. East of
 * UTC the safeguard was silently off every morning; west of UTC a schedule
 * starting today was refused every afternoon. One line, both directions.
 */

export const DEFAULT_TIME_ZONE = 'UTC';

/**
 * Is this a zone the runtime actually knows?
 *
 * Asked of `Intl` rather than matched against a pattern, because a pattern
 * happily accepts `Not/AZone` — which then throws inside whatever business
 * operation first tries to format with it. The database asks its own
 * `pg_timezone_names` for the same reason (0015).
 */
export function isValidTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'expected a valid IANA time zone, e.g. Asia/Manila');

/**
 * The calendar date at `instant`, as seen from `zone` — `YYYY-MM-DD`.
 *
 * `en-CA` is not a style choice: it is the locale whose short date format is
 * already ISO, so the parts come back in the order we need without assembling
 * them by hand and without a locale surprise on somebody else's machine.
 *
 * **Falls back to UTC rather than throwing.** A zone lookup must never fail a
 * business operation: refusing an approval over a zone string is worse than
 * reporting it against a slightly wrong day, and the wrong day is at least
 * visible, whereas the refusal looks like a bug in something else entirely.
 */
export function dateInZone(instant: Date, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** The wall-clock time at `instant` as seen from `zone` — `HH:MM`, 24-hour. */
export function timeInZone(instant: Date, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(instant);
  } catch {
    return instant.toISOString().slice(11, 16);
  }
}

/**
 * "What day is it" for a business — the answer every date-bound rule needs.
 *
 * Takes the instant explicitly rather than reading the clock, so every caller is
 * testable and nothing here depends on when the test runs.
 */
export function todayInZone(zone: string, now: Date): string {
  return dateInZone(now, zone);
}

/**
 * The zone a project's days are counted in: its own, or its company's.
 *
 * Null on the project means *inherit*, not *unset*. A project that copied the
 * company zone at creation would silently stop tracking it, and "wherever the
 * business is" is the far more common intent than "wherever it was the day I
 * made this project".
 */
export function effectiveTimeZone(
  projectZone: string | null | undefined,
  companyZone: string | null | undefined
): string {
  return projectZone ?? companyZone ?? DEFAULT_TIME_ZONE;
}

/**
 * Why a project's time zone can no longer be changed, or null when it still can.
 *
 * **The same pin the reporting currency uses, for the same reason** (packet §3):
 * a zone decides which local day an instant falls on, so moving it after work has
 * been approved would re-bucket committed days and restate history — the exact
 * outcome the whole domain exists to prevent. The invariant is "changing a zone
 * changes presentation and future bucketing, never a stored value"; once a
 * project holds committed money, a zone change is no longer only presentation.
 *
 * Refuses by naming what pins it, because "you cannot do that" is not an
 * explanation. Set the zone at creation instead — which is why
 * `createProjectSchema` accepts one and this refusal never fires on a new project.
 */
export function projectTimeZonePinRefusal(pins: ProjectCommitmentPins): string | null {
  const held = describeProjectCommitments(pins);
  if (!held) return null;
  return (
    `This project already holds committed work: ${held}. Changing its time zone ` +
    `now would move which local day that work counts against, so it is fixed for ` +
    `the life of the project.`
  );
}

/**
 * The UTC offset of `zone` at `instant`, in minutes east of UTC.
 *
 * Computed from the formatted parts rather than a hard-coded table, so it is
 * correct across DST transitions and across future tzdata changes without this
 * file knowing anything about either.
 */
export function offsetMinutes(instant: Date, zone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second')
    );
    // Whole minutes: `instant` may carry milliseconds the formatter dropped, and
    // an offset is never finer than a minute in any zone that has ever existed.
    return Math.round((asUtc - instant.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

/**
 * The instant at which a given wall-clock date and time occurs in `zone`.
 *
 * The two-pass shape is what makes DST work. A first guess treats the local time
 * as UTC and asks what offset the zone had at *that* moment; applying it lands
 * within an hour of the answer, and a second pass re-reads the offset there in
 * case the first guess fell on the wrong side of a transition.
 *
 * The two documented edges, both resolved rather than thrown:
 *
 *  - **Spring-forward gap** — 02:30 simply does not exist on that day. The result
 *    lands on the first real instant after the gap, which is the reading a person
 *    means by "half past two" on a day when half past two never happened.
 *  - **Autumn overlap** — 01:30 happens twice. The *earlier* one is chosen,
 *    consistently, because a shift recorded as starting at 01:30 started at the
 *    first 01:30 rather than an hour into a repeat nobody was thinking about.
 */
export function instantFromLocal(
  isoDate: string,
  hhmm: string,
  zone: string
): Date {
  const [y = 1970, mo = 1, d = 1] = isoDate.split('-').map(Number);
  const [h = 0, mi = 0] = hhmm.split(':').map(Number);
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi);
  const wanted = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;

  // First pass uses the offset in force *before* the local time in question.
  const before = new Date(asIfUtc - offsetMinutes(new Date(asIfUtc), zone) * 60_000);
  // Second pass re-reads the offset there, which corrects the first guess
  // whenever it landed on the wrong side of a transition.
  const settled = new Date(asIfUtc - offsetMinutes(before, zone) * 60_000);

  // If the settled instant reads back as the time we asked for, it exists and we
  // are done — this is every ordinary time, and both halves of an autumn overlap
  // (where the first pass already picks the earlier one).
  if (timeInZone(settled, zone) === wanted) return settled;

  // It does not read back, so the local time never happened: this is a
  // spring-forward gap. `before` is the instant that the pre-transition offset
  // maps it to, which lands just past the gap — 02:30 on a day that jumps 02:00
  // to 03:00 becomes 03:30, the reading a person means by it. Resolving backward
  // instead would silently move work an hour earlier than it was recorded.
  return before;
}

/**
 * The half-open instant range covering one local day in `zone`.
 *
 * Half-open — `[start, end)` — so consecutive days tile without overlapping and
 * a record cannot be counted twice at a boundary. Computed from the *next* local
 * date rather than by adding 24 hours, because a DST day is 23 or 25 hours long
 * and adding a fixed day would drop or double an hour of work twice a year.
 */
export function dayRangeInZone(isoDate: string, zone: string): { start: Date; end: Date } {
  return {
    start: instantFromLocal(isoDate, '00:00', zone),
    end: instantFromLocal(nextIsoDate(isoDate), '00:00', zone),
  };
}

/** The calendar day after `isoDate`, with no zone involved — pure date arithmetic. */
export function nextIsoDate(isoDate: string): string {
  const [y = 1970, m = 1, d = 1] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * A short, stable label for a zone, e.g. `Asia/Manila (UTC+08:00)`.
 *
 * The offset is resolved at a given instant rather than stated in the abstract,
 * because half the world's zones have two and showing the wrong one in January is
 * how a settings screen loses somebody's trust.
 */
export function timeZoneLabel(zone: string, at: Date): string {
  if (!isValidTimeZone(zone)) return zone;
  const minutes = offsetMinutes(at, zone);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${zone} (UTC${sign}${hh}:${mm})`;
}
