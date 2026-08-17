import type { ProjectStatus, ProjectSummary, ShiftType, RateLabel } from '@crewquo/shared';

/**
 * The export model (CREWQUO_V2_PLAN.md §3.6, §7, §11 Phase 4) — one assembled,
 * fully-resolved snapshot of a project, and the pure functions that turn it into
 * printable rows.
 *
 * **One rendering path, one place numbers are formatted.** The PDF and the XLSX
 * both consume what's here, and §29's report engine (Phase 10) builds on the same
 * seam, so a figure can never read differently depending on which file the client
 * opened. Renderers do layout; they never compute and never format money.
 *
 * This is the **owner's** view: PAY cost from the frozen snapshots, BILL, margin
 * and the per-provider breakdown. The client-facing export — BILL-side only, no
 * PAY figure, no provider identity — lands with §29's reports in Phase 10 (owner
 * decision, 2026-08-17), where it renders from a stored snapshot rather than a
 * live recalculation.
 */

export const EXPORT_FORMATS = ['pdf', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Every string this module emits is **ASCII**, and `model.test.ts` enforces it.
 *
 * jsPDF's built-in Helvetica encodes Latin-1, not cp1252 or Unicode: an em dash,
 * an ellipsis and an arrow are all *silently dropped* from the page rather than
 * substituted or flagged. A null that renders as an em dash on screen and as
 * nothing at all in the PDF is the worst version of this bug — an empty cell
 * reads as "not applicable" where a marker reads as "we don't know yet".
 */
export const NOT_AVAILABLE = 'n/a';

export interface ExportTimeLine {
  date: string; // YYYY-MM-DD
  providerName: string;
  roleName: string;
  shiftType: ShiftType;
  /** The label the rate resolved under, frozen in the snapshot at submit time. */
  rateLabel: RateLabel | null;
  hoursRegular: number;
  hoursOt: number;
  /** PAY cost from the frozen snapshot; null when the log carries no snapshot. */
  payCents: number | null;
}

export interface ExportExpenseLine {
  date: string;
  providerName: string;
  category: string | null;
  description: string | null;
  amountCents: number;
}

export interface ProjectExportModel {
  generatedAt: string; // ISO instant
  generatedByName: string;
  ownerCompanyName: string;
  clientCompanyName: string | null;
  project: {
    id: string;
    name: string;
    status: ProjectStatus;
    startsOn: string | null;
    endsOn: string | null;
    notes: string | null;
  };
  /** Server-computed totals — the same `computeProjectSummary` the UI reads. */
  summary: ProjectSummary;
  timeLines: ExportTimeLine[];
  expenseLines: ExportExpenseLine[];
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * The single money formatter for exports. Minor units in, display string out.
 *
 * A null is **not** zero: `resolveBillCentsForLog` returns null when no BILL card
 * covers a line, and printing 0 there would understate an invoice. Nulls render
 * as `n/a` so a reader sees a gap rather than a total they'd trust.
 */
export function formatMoney(cents: number | null, currency: string): string {
  if (cents === null) return NOT_AVAILABLE;
  try {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
    }).format(cents / 100);
    // Intl separates the code from the number with U+00A0 (and U+202F in some
    // locales). Normalise to a plain space: these strings are compared in tests,
    // embedded in PDF content streams and will be content-hashed by §29.4, so
    // the bytes must not depend on an ICU version's choice of space.
    return formatted.replace(/[  ]/g, ' ');
  } catch {
    // An unknown ISO code must not fail an export.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatPercent(pct: number | null): string {
  return pct === null ? NOT_AVAILABLE : `${pct.toFixed(2)}%`;
}

export function formatHours(hours: number): string {
  return hours.toFixed(2);
}

export function formatDateRange(startsOn: string | null, endsOn: string | null): string {
  if (!startsOn && !endsOn) return NOT_AVAILABLE;
  return `${startsOn ?? 'open'} to ${endsOn ?? 'open'}`;
}

/**
 * A readable UTC stamp for the page. The ISO instant stays on the model for the
 * workbook metadata and for §29.4's content hashing; this is what a reader sees,
 * and it is short enough not to be truncated out of the header.
 */
export function formatTimestamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Slug for the download filename. ASCII-only and length-capped: this string
 * crosses into a `Content-Disposition` header, where non-ASCII bytes are not
 * valid and an unbounded project name is a way to write arbitrary header content.
 */
export function exportFilename(
  projectName: string,
  projectId: string,
  format: ExportFormat
): string {
  const slug = projectName
    .normalize('NFKD')
    // Fold accents: "Café" → "Cafe", not "Caf-".
    .replace(/[̀-ͯ]/g, '')
    // Anything else outside printable ASCII becomes a separator rather than
    // vanishing — dropping it would fuse "drop\r\nX-Evil" into one word.
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
    .toLowerCase();
  const stem = slug || `project-${projectId.slice(0, 8)}`;
  return `${stem}.${format}`;
}

// ── Printable rows (shared by both renderers) ─────────────────────────────────

export interface LabelledValue {
  label: string;
  value: string;
  /** Totals and margins are emphasised by both renderers. */
  emphasis?: boolean;
}

/**
 * The summary block. `billCents`/`marginCents` are null whenever a single line
 * couldn't be priced BILL-side, and the caption says why rather than leaving a
 * reader to guess at a dash.
 */
export function summaryRows(model: ProjectExportModel): LabelledValue[] {
  const s = model.summary;
  return [
    { label: 'Approved time logs', value: String(s.approvedTimeLogs) },
    { label: 'Approved expenses', value: String(s.approvedExpenses) },
    { label: 'Labour cost (PAY)', value: formatMoney(s.laborCostCents, s.currency) },
    { label: 'Expenses', value: formatMoney(s.expenseCostCents, s.currency) },
    { label: 'Total cost', value: formatMoney(s.totalCostCents, s.currency), emphasis: true },
    { label: 'Client bill (BILL)', value: formatMoney(s.billCents, s.currency) },
    { label: 'Margin', value: formatMoney(s.marginCents, s.currency), emphasis: true },
    { label: 'Margin %', value: formatPercent(s.marginPct) },
  ];
}

export function headerRows(model: ProjectExportModel): LabelledValue[] {
  return [
    { label: 'Project', value: model.project.name },
    { label: 'Status', value: model.project.status },
    { label: 'Dates', value: formatDateRange(model.project.startsOn, model.project.endsOn) },
    { label: 'Company', value: model.ownerCompanyName },
    { label: 'Client', value: model.clientCompanyName ?? NOT_AVAILABLE },
    { label: 'Currency', value: model.summary.currency },
    // Split rather than combined: as one string this is wide enough to be
    // truncated out of a two-column header, and provenance is the last thing that
    // should be trimmed to make a layout fit.
    { label: 'Generated', value: formatTimestamp(model.generatedAt) },
    { label: 'Generated by', value: model.generatedByName },
  ];
}

/** True when at least one line couldn't be priced BILL-side (§6). */
export function hasPricingGap(model: ProjectExportModel): boolean {
  return model.summary.billCents === null;
}

export const PRICING_GAP_NOTE =
  `Client bill and margin are incomplete: at least one approved line has no BILL rate card covering its role, date and shift. Unpriced lines are shown as ${NOT_AVAILABLE} and are not counted as zero.`;

export const PROVIDER_TABLE_HEAD = [
  'Provider',
  'Approved logs',
  'Labour cost',
  'Expenses',
  'Total',
] as const;

export function providerRows(model: ProjectExportModel): string[][] {
  const currency = model.summary.currency;
  return model.summary.byProvider.map((p) => [
    p.providerCompanyName,
    String(p.approvedTimeLogs),
    formatMoney(p.laborCostCents, currency),
    formatMoney(p.expenseCostCents, currency),
    formatMoney(p.laborCostCents + p.expenseCostCents, currency),
  ]);
}

export const TIME_TABLE_HEAD = [
  'Date',
  'Provider',
  'Role',
  'Shift',
  'Rate label',
  'Hours',
  'OT',
  'Cost (PAY)',
] as const;

export function timeRows(model: ProjectExportModel): string[][] {
  const currency = model.summary.currency;
  return model.timeLines.map((l) => [
    l.date,
    l.providerName,
    l.roleName,
    l.shiftType,
    l.rateLabel ?? NOT_AVAILABLE,
    formatHours(l.hoursRegular),
    formatHours(l.hoursOt),
    formatMoney(l.payCents, currency),
  ]);
}

export const EXPENSE_TABLE_HEAD = ['Date', 'Provider', 'Category', 'Description', 'Amount'] as const;

export function expenseRows(model: ProjectExportModel): string[][] {
  const currency = model.summary.currency;
  return model.expenseLines.map((l) => [
    l.date,
    l.providerName,
    l.category ?? NOT_AVAILABLE,
    l.description ?? NOT_AVAILABLE,
    formatMoney(l.amountCents, currency),
  ]);
}
