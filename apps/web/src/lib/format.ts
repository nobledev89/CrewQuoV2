/** Presentation helpers for the console. Money is always integer cents. */

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
  return pct === null ? '—' : `${pct.toFixed(2)}%`;
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

/** A timestamptz, with the time — audit rows and note threads need the minute. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Today as `YYYY-MM-DD` in the viewer's own timezone — the default work date. */
export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

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
