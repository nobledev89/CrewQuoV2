/**
 * Presentation helpers for the console. Money is always integer cents.
 *
 * **Every formatter here resolves the viewer's own locale** (`Intl` with an
 * `undefined` locale argument), deliberately and in one place: a person reading a
 * date or an amount reads it in their own conventions, and doing it centrally is
 * what stops one screen inventing a different format from the rest — which
 * `rates/roles` had already done with its own inline `DateTimeFormat`.
 *
 * **Two rules that are not obvious and have both been got wrong here before.**
 *
 * *Numbers are formatted consistently or not at all.* `formatPct` used `toFixed`
 * while `formatCents` used `Intl`, so a margin and the money beside it disagreed
 * about the decimal separator on the same row for anybody outside an en locale.
 * Money *entry* is separate and stays canonical: the inputs are `type="number"`, so
 * the DOM hands back a `.`-decimal string whatever the viewer types, which is why
 * `inputToCents` can parse with `Number` and must not be made locale-aware.
 *
 * *A day is not an instant, and whose day it is matters* (`docs/operating-model/
 * time.md`). `formatDate` renders a stored `date` in UTC so it cannot shift by a day
 * in a browser. `formatDateTime` renders a stored instant in the viewer's zone and
 * says which zone that is. And "today" is **not** the browser's today wherever a
 * rule depends on it — see `todayInZone`.
 */
import { timeZoneLabel } from '@crewquo/shared';

export function centsToInput(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

/** Parse a dollar-string field into integer cents, or null when blank. */
export function inputToCents(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function formatCents(cents: number | null, currency = 'USD'): string {
  if (cents === null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * A margin percentage. The summary endpoint returns `null` when the project has no
 * client or no BILL card resolves — which is "not known", not "zero", so it must
 * not render as 0%.
 */
export function formatPct(pct: number | null): string {
  if (pct === null) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(pct / 100);
  } catch {
    return `${pct.toFixed(2)}%`;
  }
}

/** A `YYYY-MM-DD` date column, rendered in the viewer's locale. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A stored instant, with the minute — audit rows and note threads need it.
 *
 * Rendered in the **viewer's** zone, which is the right answer for an instant: the
 * question behind an audit row is "when did this happen", and the only clock the
 * reader can check it against is their own. But an unlabelled time is ambiguous the
 * moment two companies in two zones share a trail — a London admin reviewing Manila
 * work reads 09:14 and cannot tell whose 09:14 it is. So the zone is named. This is
 * the one place the abbreviation appears, and it comes from the same
 * `timeZoneLabel` the settings screens use, so a trail and a picker cannot disagree
 * about what a zone is called.
 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const stamp = d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const label = viewerZone ? timeZoneLabel(viewerZone, d) : '';
  return label ? `${stamp} ${label}` : stamp;
}

/**
 * Today as `YYYY-MM-DD` **in a named zone** — never in the browser's.
 *
 * This replaces a `todayIso()` that used the viewer's own zone and had no parameter
 * to pass one. It was not a formatting preference; it was a second, wrong copy of a
 * function `packages/shared` already had right. The API resolves "today" against the
 * relevant **company's** zone, because `time.md` exists precisely because a
 * zone-naive today had this bug server-side — and the commercial screen was calling
 * the browser version to decide whether to warn about a back-dated rate while the
 * server used the company version to decide whether to *refuse* it. For a London
 * reviewer and a Manila company those disagree for eight hours a day, and the
 * disagreement surfaces as a 403 on a form that showed no warning and asked for no
 * reason.
 *
 * So there is one implementation, it lives in shared, it is DST-correct and unit
 * tested there, and this is a named re-export rather than a wrapper — a wrapper is
 * how the second copy happens again.
 */
export { todayInZone } from '@crewquo/shared';

/** `MON_FRI_DAY` → `Mon Fri Day`; `OWNER` → `Owner`. */
export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_, separator: string, letter: string) =>
      `${separator ? ' ' : ''}${letter.toUpperCase()}`
    );
}

/** `time_log.approved` → `Time log approved` — audit actions read as sentences. */
export function formatAuditAction(action: string): string {
  const spaced = action.replace(/[._]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Total hours on a time log, for the one column that wants them summed. */
export function totalHours(log: { hoursRegular: number; hoursOt: number }): number {
  return log.hoursRegular + log.hoursOt;
}

/**
 * A limit's usage as "23 / 30", or "23 / unlimited". `null` is unlimited, never
 * zero — the two mean opposite things and a plan seeds both (§5B).
 */
export function formatUsage(used: number, value: number | null): string {
  return value === null ? `${used} / unlimited` : `${used} / ${value}`;
}
