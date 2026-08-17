import { z } from 'zod';
import { invoiceStatusSchema } from './enums';

const isoDateTime = z.string().datetime({ offset: true });
const money = z.number().int().min(0).max(2_147_483_647);
const quantity = z.number().positive().max(99_999_999.99).multipleOf(0.01);

export const INVOICE_SOURCE_TYPES = ['TIME_LOG', 'EXPENSE', 'MANUAL'] as const;
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

/** Postgres uses the same round(quantity * unit_amount_cents) rule. */
export function calculateInvoiceItemAmount(quantityValue: number, unitAmountCents: number): number {
  return Math.round(quantityValue * unitAmountCents);
}

export function calculateInvoiceTotals(
  itemAmounts: readonly number[],
  taxCents: number
): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = itemAmounts.reduce((sum, amount) => sum + amount, 0);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
