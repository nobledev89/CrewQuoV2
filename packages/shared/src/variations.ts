import { z } from 'zod';

/**
 * Variations / extra works (CREWQUO_V2_PLAN.md §30.1) — step 11.0 of the Phase 11
 * build order in `docs/operating-model/commercial-operations.md` §14.
 *
 * The pure half: the status machine as data, the transition table, and the two
 * arithmetic identities that decide whether a figure on an invoice can be trusted.
 * It knows nothing about Postgres and nothing about HTTP.
 *
 * ── WHY THE ARITHMETIC IS HERE AND NOT IN A ROUTE ───────────────────────────
 *
 * §30.1 stores four money columns per line — `unit_cost_cents`, `unit_sell_cents`,
 * `cost_cents`, `sell_cents` — where the last two are the first two times
 * `quantity`, and two more on the header that are the sums of the lines. Both are
 * denormalisations, and neither is one this product can afford to let drift,
 * because the header feeds `computeProjectSummary` and an invoice line
 * (packet finding 5).
 *
 * So there is exactly one function that computes a line total and exactly one that
 * computes a header total, they are both here, and the migration turns the first of
 * them into a **check constraint** so a future writer that never read this file
 * cannot get it wrong either.
 */

const money = z.number().int();

// ── The status machine (§30.1, packet §3) ────────────────────────────────────

export const VARIATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'COMPLETED',
  'INVOICED',
] as const;
export const variationStatusSchema = z.enum(VARIATION_STATUSES);
export type VariationStatus = z.infer<typeof variationStatusSchema>;

/**
 * Who may drive a transition.
 *
 * `RECORDER` is the company whose row it is — the one that raised the variation,
 * which on a subcontractor's job is not the project owner. `OWNER` is the
 * project-owning company. `SYSTEM` is the invoice domain, and it is a *distinct
 * actor rather than a role* on purpose: `INVOICED` is set inside the transaction
 * that creates the invoice line and there is no route to it, so a transition table
 * that let a caller name it would be describing an endpoint that must not exist.
 */
export type VariationActor = 'RECORDER' | 'OWNER' | 'SYSTEM';

export interface VariationTransition {
  from: VariationStatus;
  to: VariationStatus;
  actor: VariationActor;
  /** The capability the actor must hold. `null` for SYSTEM. */
  capability: 'variation.create' | 'variation.approve' | null;
  /** True when the transition may not happen without a stated reason. */
  reasonRequired: boolean;
}

/**
 * §30.1: *"The status machine mirrors the work workflow (§3.4) deliberately —
 * same shape, same guards, plus `COMPLETED`/`INVOICED`."*
 *
 * Written as data rather than as a `switch` so §44's state-machine test can walk
 * it: every declared transition covered by actor, source state, target state,
 * rejection, withdraw and terminal-state immutability. A `switch` is a thing you
 * read; a table is a thing a test enumerates.
 */
export const VARIATION_TRANSITIONS: readonly VariationTransition[] = [
  { from: 'DRAFT', to: 'SUBMITTED', actor: 'RECORDER', capability: 'variation.create', reasonRequired: false },
  // Withdraw — the same escape hatch §3.4 gives a timesheet.
  { from: 'SUBMITTED', to: 'DRAFT', actor: 'RECORDER', capability: 'variation.create', reasonRequired: false },
  { from: 'SUBMITTED', to: 'APPROVED', actor: 'OWNER', capability: 'variation.approve', reasonRequired: false },
  /*
   * A rejection with no reason is a message nobody can act on. §3.4 makes the same
   * demand of a rejected timesheet, and it matters more here: the person who has to
   * re-price the extra doors is on a different site, possibly in a different
   * company, and "no" on its own costs them a phone call they should not need.
   */
  { from: 'SUBMITTED', to: 'REJECTED', actor: 'OWNER', capability: 'variation.approve', reasonRequired: true },
  { from: 'REJECTED', to: 'SUBMITTED', actor: 'RECORDER', capability: 'variation.create', reasonRequired: false },
  { from: 'APPROVED', to: 'COMPLETED', actor: 'OWNER', capability: 'variation.approve', reasonRequired: false },
  /*
   * Both routes to INVOICED, and neither is a route. §30.1 gives a variation an
   * `invoice_id`, and the only thing that may set it is the transaction that
   * creates the invoice line — which is also what makes the double-bill impossible
   * (packet §3's concurrency rule). A variation may be invoiced from APPROVED
   * without passing through COMPLETED, because a contractor invoicing a stage
   * payment on agreed extra works is normal.
   */
  { from: 'APPROVED', to: 'INVOICED', actor: 'SYSTEM', capability: null, reasonRequired: false },
  { from: 'COMPLETED', to: 'INVOICED', actor: 'SYSTEM', capability: null, reasonRequired: false },
  // Voiding the invoice puts it back, inside that transaction — exactly what a
  // voided invoice already does for a time log.
  { from: 'INVOICED', to: 'APPROVED', actor: 'SYSTEM', capability: null, reasonRequired: false },
];

export function findVariationTransition(
  from: VariationStatus,
  to: VariationStatus
): VariationTransition | null {
  return VARIATION_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

/**
 * May the lines and prices be edited in this state?
 *
 * **Packet finding 4, and it is the invariant this whole file exists to protect.**
 * `client_approved_by` records that a named person outside the tenancy agreed a
 * figure. A line that stays editable past that point converts their agreement into
 * a signature on a blank cheque, and the trail would show a variation the client
 * approved and a different total on the invoice.
 *
 * This is not a new rule — Phase 6's `issueDraftInvoice` established exactly this
 * shape, where issue assigns a number and makes the document immutable. It is that
 * invariant arriving in a second place.
 */
export function variationIsEditable(status: VariationStatus): boolean {
  return status === 'DRAFT' || status === 'REJECTED';
}

/** The sentence a refusal shows, which has to name what to do instead. */
export function variationEditRefusal(status: VariationStatus): string | null {
  if (variationIsEditable(status)) return null;
  if (status === 'SUBMITTED') {
    return 'This variation is with the approver. Withdraw it back to draft to change a price.';
  }
  return `This variation is ${status.toLowerCase()} and the figures are what was agreed. Raise a new variation for a change.`;
}

// ── Lines ────────────────────────────────────────────────────────────────────

export const VARIATION_LINE_KINDS = [
  'LABOUR',
  'VEHICLE',
  'MATERIAL',
  'WASTE',
  'SUBCONTRACTOR',
  'OTHER',
] as const;
export const variationLineKindSchema = z.enum(VARIATION_LINE_KINDS);
export type VariationLineKind = z.infer<typeof variationLineKindSchema>;

/**
 * A line total, and the one place it is computed.
 *
 * ── THE FINDING THE BUILD ADDED, and the test caught it on its first run ────
 *
 * The obvious implementation is `Math.round(quantity * unitCents)`, and it
 * **disagrees with Postgres**, which is the one thing this function may not do:
 * `0045` turns this identity into a check constraint, so a divergence does not
 * produce a wrong total — it produces a `23514` refusing a write the API believed
 * it had made correctly, on a line somebody typed perfectly.
 *
 * The divergence is reachable with two decimal places and a small unit price.
 * `quantity` is `numeric(12,2)`, so `0.15` is a legal quantity; at a unit price of
 * 10 cents the exact product is `1.50`, and:
 *
 *   * Postgres computes it in exact decimal — `round(1.50)` → **2**.
 *   * IEEE 754 computes `0.15 * 10` as `1.4999999999999998` — `Math.round` → **1**.
 *
 * So the arithmetic is done in **integer hundredths**, where it is exact. Quantity
 * carries at most two decimal places by column definition, `Math.round(quantity *
 * 100)` recovers those hundredths exactly, and the product with an integer cent
 * price is an exact integer for every line whose total could fit in the `int`
 * column at all. Dividing that integer by 100 is exact at precisely the boundary
 * that matters — a value ending in half a cent is `(2k+1)/2`, which IEEE 754 holds
 * exactly — so the half-up decision is made on the true value rather than on a
 * float that landed just below it.
 *
 * The sign handling matches Postgres too: `round()` on numeric goes **away from
 * zero** on a half, where `Math.round(-1.5)` is `-1`. Neither column may be
 * negative today, so this is defence against a later signed credit line rather
 * than a live case.
 */
export function lineTotalCents(quantity: number, unitCents: number): number {
  const hundredths = Math.round(quantity * 100);
  const scaled = hundredths * unitCents;
  const sign = scaled < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(scaled) / 100);
}

export interface VariationLineTotals {
  costCents: number;
  sellCents: number;
}

/** Both totals for one line. */
export function computeLineTotals(line: {
  quantity: number;
  unitCostCents: number;
  unitSellCents: number;
}): VariationLineTotals {
  return {
    costCents: lineTotalCents(line.quantity, line.unitCostCents),
    sellCents: lineTotalCents(line.quantity, line.unitSellCents),
  };
}

/**
 * The header totals, and the one place *they* are computed.
 *
 * A `check` constraint cannot aggregate, so unlike the line identity this one
 * cannot be pushed into the database. It is instead recomputed inside every
 * transaction that touches a line — the way `recalculateInvoiceTotals` already
 * does — and **never accepted from a caller**: `updateVariationSchema` below has no
 * field for it, so a client sending `sellTotalCents` has it ignored rather than
 * honoured, which is what §12 step 7 asserts.
 */
export function computeVariationTotals(
  lines: readonly { quantity: number; unitCostCents: number; unitSellCents: number }[]
): { costTotalCents: number; sellTotalCents: number } {
  let costTotalCents = 0;
  let sellTotalCents = 0;
  for (const line of lines) {
    const totals = computeLineTotals(line);
    costTotalCents += totals.costCents;
    sellTotalCents += totals.sellCents;
  }
  return { costTotalCents, sellTotalCents };
}

/**
 * Margin on a variation, for the panel.
 *
 * Deliberately **not** `calculateMargin` from the rate engine, even though the
 * arithmetic is identical: that function's `MarginResult` is named for a
 * client-bill-versus-sub-cost comparison and returns `0` when the bill is zero,
 * which is right for a project total and wrong for one variation. A variation
 * quoted at nothing has no margin percentage, and printing `0%` beside it says
 * "we made nothing" where the truth is "there is nothing to divide by".
 */
export function variationMarginPct(sellCents: number, costCents: number): number | null {
  if (sellCents === 0) return null;
  return Math.round(((sellCents - costCents) / sellCents) * 10000) / 100;
}

// ── Views ────────────────────────────────────────────────────────────────────

export interface VariationLineView {
  id: string;
  variationId: string;
  kind: VariationLineKind;
  description: string;
  quantity: number;
  unitCostCents: number;
  unitSellCents: number;
  costCents: number;
  sellCents: number;
  roleId: string | null;
  roleName: string | null;
  assetId: string | null;
  /**
   * Where the prices came from, so a screen can say so. `RATE_ENGINE` means a
   * LABOUR line was priced from the PAY and BILL cards in effect on
   * `requestedOn`; `STATED` means somebody typed them. Not stored — derived at
   * insert and kept on the row so the panel does not have to re-resolve a rate to
   * find out whether it once resolved one.
   */
  pricedFrom: 'RATE_ENGINE' | 'STATED' | 'PARTIAL';
  createdAt: string;
}

export interface VariationView {
  id: string;
  projectId: string;
  companyId: string;
  companyName: string | null;
  engagementId: string | null;
  reference: string | null;
  description: string;
  reason: string | null;
  requestedBy: string | null;
  requestedOn: string;
  status: VariationStatus;
  sellTotalCents: number;
  costTotalCents: number;
  /** Null when nothing was sold — see `variationMarginPct`. */
  marginPct: number | null;
  clientApprovedBy: string | null;
  clientApprovedAt: string | null;
  /**
   * **The flag packet §3 exists for.** Approval without the client's own
   * agreement recorded is permitted — the client says yes on the phone on Tuesday
   * and sends the paperwork on Friday, and the crew works on Wednesday — but it is
   * never silent. Every response carrying a variation carries this, the panel
   * badges it, and §29.2's pack section prints it beside the row.
   */
  clientApprovalRecorded: boolean;
  approvalEvidenceFileId: string | null;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  lines: VariationLineView[];
  createdByUserId: string | null;
  createdByName: string | null;
  revision: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The client's half — `APPROVED` and later, **sell only** (packet §13.6).
 *
 * A separate type rather than a filtered `VariationView`, which is the mechanism
 * `reporting-signoff.md` finding 3 established and the reason it survives a later
 * edit: there is no field here a cost figure, a margin or a provider name could
 * occupy, so the exclusion cannot be forgotten by somebody widening a `select`
 * list.
 */
export interface PortalVariationView {
  id: string;
  reference: string | null;
  description: string;
  requestedOn: string;
  status: 'APPROVED' | 'COMPLETED' | 'INVOICED';
  sellTotalCents: number;
  clientApprovedBy: string | null;
  clientApprovedAt: string | null;
  approvedAt: string | null;
}

// ── Request schemas ──────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * A line as a caller states it.
 *
 * `unitCostCents`/`unitSellCents` are **optional for a LABOUR line carrying a
 * `roleId`** and required otherwise. That is §30.1's *"Labour lines resolve their
 * default cost and sell from the existing rate engine, so a variation is priced
 * the same way everything else is"* — the server resolves the PAY and BILL cards
 * in effect on the variation's `requestedOn` and fills them in.
 *
 * The totals are **absent from this schema entirely**. They are derived, and a
 * field a caller can send is a field a caller can send a wrong value in.
 */
export const variationLineInputSchema = z
  .object({
    kind: variationLineKindSchema,
    description: z.string().trim().min(1).max(300),
    quantity: z.number().min(0).max(1_000_000).default(1),
    unitCostCents: money.min(0).optional(),
    unitSellCents: money.min(0).optional(),
    roleId: z.string().uuid().nullable().default(null),
    assetId: z.string().uuid().nullable().default(null),
    shiftType: z
      .enum(['WEEKDAY_DAY', 'NIGHT', 'SUNDAY', 'SHIFT', 'DAILY'])
      .nullable()
      .default(null),
  })
  .superRefine((v, ctx) => {
    const priced = v.unitCostCents !== undefined && v.unitSellCents !== undefined;
    const resolvable = v.kind === 'LABOUR' && v.roleId !== null;
    if (!priced && !resolvable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitSellCents'],
        message:
          'State both a unit cost and a unit sell, or give a LABOUR line a roleId so the rate engine can price it',
      });
    }
  });
export type VariationLineInput = z.infer<typeof variationLineInputSchema>;

export const createVariationSchema = z.object({
  /** The offline contract's idempotency key — Femi in a stairwell (packet §8). */
  clientId: z.string().uuid().optional(),
  reference: z.string().trim().max(60).nullable().default(null),
  description: z.string().trim().min(1).max(2000),
  reason: z.string().trim().max(2000).nullable().default(null),
  /** The client-side person who asked. Text, never a user — packet finding 11. */
  requestedBy: z.string().trim().max(200).nullable().default(null),
  requestedOn: isoDate,
  lines: z.array(variationLineInputSchema).max(200).default([]),
});
export type CreateVariation = z.infer<typeof createVariationSchema>;

export const updateVariationSchema = z
  .object({
    reference: z.string().trim().max(60).nullable(),
    description: z.string().trim().min(1).max(2000),
    reason: z.string().trim().max(2000).nullable(),
    requestedBy: z.string().trim().max(200).nullable(),
    requestedOn: isoDate,
    /** Replaces the whole set. A line-by-line patch API for six fields is ceremony. */
    lines: z.array(variationLineInputSchema).max(200),
    expectedRevision: z.number().int().min(0).optional(),
  })
  .partial();
export type UpdateVariation = z.infer<typeof updateVariationSchema>;

/**
 * Approve.
 *
 * Every field is optional, and that is packet §3's gate being a warning rather
 * than a block: approval with no client evidence is permitted and reported as
 * `clientApprovalRecorded: false`, because requiring it would refuse the
 * commonest real sequence and the crew is going to do the work on Wednesday
 * either way.
 */
export const approveVariationSchema = z.object({
  clientApprovedBy: z.string().trim().max(200).nullable().optional(),
  clientApprovedAt: z.string().datetime().nullable().optional(),
  approvalEvidenceFileId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(500).optional(),
});
export type ApproveVariation = z.infer<typeof approveVariationSchema>;

export const rejectVariationSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type RejectVariation = z.infer<typeof rejectVariationSchema>;

export const listVariationsQuerySchema = z.object({
  status: variationStatusSchema.optional(),
  includeDeleted: z.boolean().optional(),
});
export type ListVariationsQuery = z.infer<typeof listVariationsQuerySchema>;

/**
 * The overlap notice §13.2 asks the panel to render.
 *
 * The product cannot know whether a lump-sum variation was quoted *instead of* or
 * *in addition to* the hours behind it, so it declines to guess and puts the
 * question in front of the only person who does know — at the moment they are
 * about to create an invoice, rather than after the client has received it.
 */
export function variationTimesheetOverlapNotice(approvedLogsInWindow: number): string | null {
  if (approvedLogsInWindow <= 0) return null;
  const s = approvedLogsInWindow === 1 ? '' : 's';
  return (
    `${approvedLogsInWindow} approved timesheet${s} fall${approvedLogsInWindow === 1 ? 's' : ''} inside this ` +
    'variation’s dates. If this price was quoted for those hours, billing both would charge the client twice.'
  );
}
