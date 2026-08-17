import { z } from 'zod';
import { projectStatusSchema, shiftTypeSchema } from './enums';

/**
 * Client portal contracts (CREWQUO_V2_PLAN.md §3.6, §7).
 *
 * The portal is the mirror image of the PAY/BILL guard in §4. On a project, the
 * owner company is the one doing the work and the client is the one being
 * billed, so the portal must never surface:
 *
 *   - the owner's **PAY** side — its rate snapshots, labour cost or margin;
 *   - **who** actually performed the work — the owner's subcontractors are its
 *     own business, and naming them would defeat the one-hop rule (§3.2).
 *
 * Everything here is therefore a distinct view type rather than a filtered
 * `ProjectView`/`TimeLogView`: a field that doesn't exist can't leak.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * A project as its client sees it. `providerCompany*` is the project's *owner* —
 * from the client's side of the edge, that's simply the company they hired.
 */
export const portalProjectViewSchema = z.object({
  id: z.string().uuid(),
  providerCompanyId: z.string().uuid(),
  providerCompanyName: z.string(),
  engagementId: z.string().uuid().nullable(),
  name: z.string(),
  status: projectStatusSchema,
  startsOn: isoDate.nullable(),
  endsOn: isoDate.nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PortalProjectView = z.infer<typeof portalProjectViewSchema>;

/**
 * One billable line on a portal project. `amountCents` is the **BILL** figure —
 * what the client is charged — and is null when the owner has no BILL card
 * covering that line, which the detail response reports via `pricingComplete`.
 */
export const portalLineItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['TIME', 'EXPENSE']),
  date: isoDate,
  description: z.string(),
  shiftType: shiftTypeSchema.nullable(),
  hoursRegular: z.number().nullable(),
  hoursOt: z.number().nullable(),
  amountCents: z.number().int().nullable(),
  noteCount: z.number().int(),
});
export type PortalLineItem = z.infer<typeof portalLineItemSchema>;

/**
 * Portal project detail. Totals are BILL-side only: `pricingComplete` is false
 * when at least one line could not be priced, in which case `totalCents` is the
 * sum of what *could* be priced and must be shown as provisional.
 */
export const portalProjectDetailSchema = z.object({
  project: portalProjectViewSchema,
  currency: z.string(),
  lineItems: z.array(portalLineItemSchema),
  timeTotalCents: z.number().int(),
  expenseTotalCents: z.number().int(),
  totalCents: z.number().int(),
  pricingComplete: z.boolean(),
  canComment: z.boolean(),
  showAuditTrail: z.boolean(),
});
export type PortalProjectDetail = z.infer<typeof portalProjectDetailSchema>;

// ── Line-item notes ────────────────────────────────────────────────────────────

export const LINE_ITEM_ENTITY_TYPES = ['PROJECT', 'TIME_LOG', 'EXPENSE', 'INVOICE'] as const;
export const lineItemEntityTypeSchema = z.enum(LINE_ITEM_ENTITY_TYPES);
export type LineItemEntityType = z.infer<typeof lineItemEntityTypeSchema>;

export const lineItemNoteViewSchema = z.object({
  id: z.string().uuid(),
  engagementId: z.string().uuid(),
  entityType: lineItemEntityTypeSchema,
  entityId: z.string().uuid(),
  authorCompanyId: z.string().uuid(),
  authorCompanyName: z.string(),
  authorUserId: z.string().uuid(),
  authorName: z.string(),
  body: z.string(),
  resolved: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LineItemNoteView = z.infer<typeof lineItemNoteViewSchema>;

export const createLineItemNoteSchema = z.object({
  engagementId: z.string().uuid(),
  entityType: lineItemEntityTypeSchema,
  entityId: z.string().uuid(),
  body: z.string().trim().min(1).max(2000),
});
export type CreateLineItemNote = z.infer<typeof createLineItemNoteSchema>;

/** Body edits are the author's alone; either side of the edge may resolve. */
export const updateLineItemNoteSchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
    resolved: z.boolean(),
  })
  .partial();
export type UpdateLineItemNote = z.infer<typeof updateLineItemNoteSchema>;

export const listLineItemNotesQuerySchema = z.object({
  engagementId: z.string().uuid().optional(),
  entityType: lineItemEntityTypeSchema.optional(),
  entityId: z.string().uuid().optional(),
});
export type ListLineItemNotesQuery = z.infer<typeof listLineItemNotesQuerySchema>;
