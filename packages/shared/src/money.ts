/**
 * Money identity (CREWQUO_V2_PLAN.md §3.3 decision #5).
 * Operating-model packet: `docs/operating-model/money-boundary.md`.
 *
 * **A company works in exactly one currency, and the currency is a label.**
 * Owner decision, 2026-08-19. There is no exchange rate anywhere in CrewQuo, no
 * conversion, and no arithmetic that crosses units — because there is never more
 * than one unit to cross. Every amount is integer minor units; the currency code
 * is what gets printed in front of it.
 *
 * That decision replaced an earlier, much larger design (migration 0013) which
 * gave rates, invoices and projects their own currency and converted between them
 * through human-recorded rates. All of it is gone: the `fx_rates` table, the
 * conversion arithmetic, the `conversionGaps` reporting, the frozen FX citations
 * on approved work, and the per-row currency columns on invoices, rate cards and
 * rate proposals. What is left is this file's two jobs — validate a currency code,
 * and say when a project's label is pinned.
 *
 * **The one thing still worth protecting: history must not be relabelled.**
 * `companies.currency` is a live column an owner may change, so a project
 * snapshots it at creation (`projects.reporting_currency`) and stops tracking it.
 * Without that, changing the company label next year would silently restate what a
 * project closed at last year — the numbers unchanged, the unit in front of them
 * different from the one anybody agreed.
 */

const CURRENCY_RE = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return typeof value === 'string' && CURRENCY_RE.test(value);
}

// `currencyCodeSchema` deliberately lives in `me.ts` and is not duplicated here:
// one currency validator for the whole product, next to the company shape that
// owns the value.

// ── The project pin ───────────────────────────────────────────────────────────

export interface ProjectCommitmentPins {
  approvedTimeLogs: number;
  approvedExpenses: number;
  liveInvoices: number;
}

/**
 * What this project has already committed, in words — or null when nothing is.
 *
 * Shared because two settings are pinned by the *same* facts: the reporting
 * currency and the project time zone. Both restate history if they move after
 * money commits, so both refuse on the same count, and a single description keeps
 * the two refusals from drifting into disagreeing about what a project holds. A
 * `VOID` invoice is deliberately excluded by every caller: it is a document
 * withdrawn before it became a claim.
 */
export function describeProjectCommitments(pins: ProjectCommitmentPins): string | null {
  const parts: string[] = [];
  if (pins.approvedTimeLogs > 0) parts.push(plural(pins.approvedTimeLogs, 'approved time log'));
  if (pins.approvedExpenses > 0) parts.push(plural(pins.approvedExpenses, 'approved expense'));
  if (pins.liveInvoices > 0) parts.push(plural(pins.liveInvoices, 'invoice'));
  return parts.length === 0 ? null : joinList(parts);
}

/**
 * Why a project's reporting currency can no longer be changed, or null when it
 * still can.
 *
 * The stored minor units never move, so changing the label after money has
 * committed changes what every past figure *means* while leaving every number
 * where it was. That is the one way a pure label can still do damage, which is why
 * a label has a pin at all.
 */
export function reportingCurrencyPinRefusal(pins: ProjectCommitmentPins): string | null {
  const held = describeProjectCommitments(pins);
  if (!held) return null;
  return (
    `This project already reports money: ${held}. Changing its ` +
    `reporting currency now would relabel figures that are already committed, so ` +
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

// ── The tax gate ──────────────────────────────────────────────────────────────

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
 * Exported as a constant so the label is written once and asserted by test, rather
 * than living in a reviewer's memory.
 */
export const TAX_IS_MANUAL_NOTICE =
  'Manually entered. CrewQuo does not calculate tax and this document is not a tax invoice.';
