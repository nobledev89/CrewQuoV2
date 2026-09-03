import { z } from 'zod';
import { invoiceStatusSchema } from './enums';
import { lineTotalCents } from './variations';

const isoDateTime = z.string().datetime({ offset: true });
const money = z.number().int().min(0).max(2_147_483_647);
const quantity = z.number().positive().max(99_999_999.99).multipleOf(0.01);

/**
 * Phase 11 adds `VARIATION` — the hook PROGRESS recorded when the invoice
 * foundation shipped on 2026-08-17: *"approved variation lines join this same
 * source builder when the variations domain exists."* Approved, uninvoiced
 * variations are pulled by `loadDerivedItems` alongside approved time and
 * expenses, under the same advisory lock and the same `not exists` guard, so the
 * double-bill is prevented by the mechanism that already prevents it for a
 * timesheet rather than by a second one.
 */
export const INVOICE_SOURCE_TYPES = ['TIME_LOG', 'EXPENSE', 'MANUAL', 'VARIATION'] as const;
export const invoiceSourceTypeSchema = z.enum(INVOICE_SOURCE_TYPES);
export type InvoiceSourceType = z.infer<typeof invoiceSourceTypeSchema>;

export const invoiceItemViewSchema = z.object({
  id: z.string().uuid(),
  invoiceId: z.string().uuid(),
  description: z.string(),
  quantity,
  unitAmountCents: money,
  amountCents: money,
  sourceType: invoiceSourceTypeSchema,
  sourceId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type InvoiceItemView = z.infer<typeof invoiceItemViewSchema>;

export const invoiceViewSchema = z.object({
  id: z.string().uuid(),
  engagementId: z.string().uuid(),
  issuerCompanyId: z.string().uuid(),
  issuerCompanyName: z.string(),
  counterpartyCompanyId: z.string().uuid(),
  counterpartyCompanyName: z.string(),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  number: z.string().nullable(),
  status: invoiceStatusSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  subtotalCents: money,
  taxCents: money,
  totalCents: money,
  issuedAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(invoiceItemViewSchema),
});
export type InvoiceView = z.infer<typeof invoiceViewSchema>;

/** Create a project invoice and optionally snapshot every approved, unbilled line. */
export const createInvoiceSchema = z.object({
  projectId: z.string().uuid(),
  dueAt: isoDateTime.nullable().default(null),
  taxCents: money.default(0),
  includeApprovedWork: z.boolean().default(true),
});
export type CreateInvoice = z.infer<typeof createInvoiceSchema>;

export const updateInvoiceSchema = z
  .object({
    dueAt: isoDateTime.nullable(),
    taxCents: money,
  })
  .partial();
export type UpdateInvoice = z.infer<typeof updateInvoiceSchema>;

const manualItemSchema = z.object({
  sourceType: z.literal('MANUAL'),
  description: z.string().trim().min(1).max(500),
  quantity,
  unitAmountCents: money,
}).strict();

const sourcedItemSchema = z.object({
  sourceType: z.enum(['TIME_LOG', 'EXPENSE']),
  sourceId: z.string().uuid(),
}).strict();

/** Work-backed amounts are intentionally absent: the server derives them. */
export const createInvoiceItemSchema = z.union([manualItemSchema, sourcedItemSchema]);
export type CreateInvoiceItem = z.infer<typeof createInvoiceItemSchema>;

export const updateInvoiceItemSchema = manualItemSchema.omit({ sourceType: true }).partial();
export type UpdateInvoiceItem = z.infer<typeof updateInvoiceItemSchema>;

/**
 * Postgres uses the same round(quantity * unit_amount_cents) rule — and until
 * 2026-09-03 this function did **not**, which was a live defect rather than a
 * theoretical one.
 *
 * `invoice_items` has carried `check (amount_cents = round(quantity *
 * unit_amount_cents))` since `0008`, and the body of this function used to be
 * `Math.round(quantityValue * unitAmountCents)`. Those two disagree at the
 * half-cent boundary, because Postgres computes the product in exact decimal and
 * IEEE 754 does not: `0.29 × 50` is exactly `14.50`, which `round()` sends to 15
 * and which JavaScript evaluates as `14.499999999999998` and rounds to 14. The
 * insert is then refused by the constraint with a `23514`, which reaches the caller
 * as a 500 — on a manual invoice line somebody typed perfectly.
 *
 * Found by Phase 11's packet while giving `variation_lines` the same identity
 * (`commercial-operations.md` finding 5). Fixed here rather than recorded and left,
 * because it is one line of application code with no migration behind it and the
 * failure is a 500 on a legitimate write; and it is fixed by **delegating to
 * `lineTotalCents`** rather than by copying its arithmetic, so the two money
 * identities in this product cannot drift apart again.
 */
export function calculateInvoiceItemAmount(quantityValue: number, unitAmountCents: number): number {
  return lineTotalCents(quantityValue, unitAmountCents);
}

export function calculateInvoiceTotals(
  itemAmounts: readonly number[],
  taxCents: number
): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = itemAmounts.reduce((sum, amount) => sum + amount, 0);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
