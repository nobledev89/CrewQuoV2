import { z } from 'zod';
import {
  assignmentAcceptanceSchema,
  rateLabelSchema,
  rateModeSchema,
  rateProposalOperationSchema,
  rateProposalStatusSchema,
  type RateProposalOperation,
  type RateProposalStatus,
} from './enums';

/**
 * Commercial agreements (CREWQUO_V2_PLAN.md §3.3.1, §16 decision #23) — the
 * cross-company PAY schedule workflow, engagement commercial terms, and the
 * acceptance rules that stop one company binding another unilaterally.
 *
 * The operating-model packet that specifies all of this is
 * `docs/operating-model/commercial-agreements.md`; read that before changing a
 * rule here, because most of these constants are decisions rather than choices.
 *
 * Everything in this file is pure. The state machine, the schedule validation and
 * the money-boundary refusals are unit-tested in `commercial.test.ts`, so the API
 * never has to be running for a rule to be provable.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const cents = z.number().int().min(0).max(2_147_483_647);
const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'expected a 3-letter ISO 4217 code');

// ── The state machine (§3 of the packet) ──────────────────────────────────────

/**
 * Who may drive each transition. `provider` is the side that proposes, `client`
 * the hiring side that decides — engagement positions, never user roles (§4).
 *
 * Modelled as data rather than a chain of `if`s so that "can this actor do this?"
 * and "what can I do next?" read the same table. A transition absent from here is
 * absent from the product: `rateProposalTransitionRefusal` closes over it.
 */
export const RATE_PROPOSAL_TRANSITIONS = [
  { from: 'DRAFT', to: 'SUBMITTED', side: 'provider', verb: 'submit', past: 'submitted' },
  { from: 'SUBMITTED', to: 'APPROVED', side: 'client', verb: 'approve', past: 'approved' },
  { from: 'SUBMITTED', to: 'REJECTED', side: 'client', verb: 'reject', past: 'rejected' },
  { from: 'SUBMITTED', to: 'WITHDRAWN', side: 'provider', verb: 'withdraw', past: 'withdrawn' },
] as const satisfies readonly {
  from: RateProposalStatus;
  to: RateProposalStatus;
  side: 'provider' | 'client';
  verb: string;
  /**
   * The past participle, carried as data. English does not derive it from the
   * stem — "submit" takes a doubled consonant, "withdraw" is irregular — and a
   * suffix rule here produced "submited" in a user-facing refusal.
   */
  past: string;
}[];

export type RateProposalVerb = (typeof RATE_PROPOSAL_TRANSITIONS)[number]['verb'];

/** Terminal states accept no further transition and are never editable. */
export const RATE_PROPOSAL_TERMINAL_STATUSES: readonly RateProposalStatus[] = [
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
];

export function isRateProposalTerminal(status: RateProposalStatus): boolean {
  return RATE_PROPOSAL_TERMINAL_STATUSES.includes(status);
}

/** Only a DRAFT is editable, and only by the side that authored it. */
export function isRateProposalEditable(status: RateProposalStatus): boolean {
  return status === 'DRAFT';
}

/**
 * Why this actor may not drive this transition, or null when they may.
 *
 * Returns a *reason* rather than a boolean because every refusal here is one the
 * user needs explained: "you are the wrong side of this engagement" and "this
 * proposal has already been decided" are the same 403/409 to a machine and
 * completely different problems to a person.
 */
export function rateProposalTransitionRefusal(args: {
  verb: RateProposalVerb;
  status: RateProposalStatus;
  /** Which side of the engagement the acting company is on. */
  actorSide: 'provider' | 'client';
  /** Manager-or-above in the acting company. */
  actorIsManager: boolean;
}): string | null {
  const transition = RATE_PROPOSAL_TRANSITIONS.find((t) => t.verb === args.verb);
  if (!transition) return `Unknown action: ${args.verb}`;
  if (!args.actorIsManager) return 'Requires a manager role';
  if (transition.side !== args.actorSide) {
    return transition.side === 'provider'
      ? 'Only the provider side of this engagement may do that'
      : 'Only the hiring company may approve or reject a rate schedule';
  }
  if (args.status !== transition.from) {
    return isRateProposalTerminal(args.status)
      ? `This schedule is already ${args.status.toLowerCase()}`
      : `A ${args.status.toLowerCase()} schedule cannot be ${transition.past}`;
  }
  return null;
}

// ── Effective dating (§3.3.1) ─────────────────────────────────────────────────

/** The ISO date one day before `isoDate`, in UTC so no zone can shift it. */
export function previousIsoDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * When a new version opens on `effectiveFrom`, the version it supersedes closes
 * the day before — never on the same day. `selectEffectiveCard` breaks ties by the
 * later `effective_from`, so a same-day overlap would resolve correctly *today*
 * and become ambiguous the moment a third version joined the chain.
 */
export function supersededEffectiveTo(effectiveFrom: string): string {
  return previousIsoDate(effectiveFrom);
}

/**
 * Is this schedule being made effective in the past? Retroactive activation is
 * refused by default (§3.3.1) because approved time keeps the PAY snapshot frozen
 * at submit, so a back-dated rate silently disagrees with money already owed.
 */
export function isRetroactive(effectiveFrom: string, today: string): boolean {
  return effectiveFrom < today;
}


/**
 * Why issuing this invoice would breach the engagement's purchase-order ceiling,
 * or null when it fits. A ceiling nobody checks is decoration, so this is called
 * at issue — the point the amount becomes a claim on the PO.
 *
 * `committedCents` is what the edge has already issued and not voided. Drafts are
 * excluded deliberately: a draft is a working document, and blocking issue on the
 * existence of other drafts would make the refusal depend on what a colleague
 * happened to leave open.
 */
export function purchaseOrderCeilingRefusal(args: {
  ceilingCents: number | null;
  committedCents: number;
  incomingCents: number;
  currency: string;
}): string | null {
  if (args.ceilingCents === null) return null;
  const total = args.committedCents + args.incomingCents;
  if (total <= args.ceilingCents) return null;
  const money = (value: number) => `${args.currency} ${(value / 100).toFixed(2)}`;
  return (
    `Issuing this invoice would exceed the purchase-order ceiling of ` +
    `${money(args.ceilingCents)}. ${money(args.committedCents)} is already issued ` +
    `against this engagement and this invoice is ${money(args.incomingCents)}, ` +
    `totalling ${money(total)}.`
  );
}

/**
 * The due date implied by an engagement's payment terms, or null when the edge
 * carries none. Terms that never reach an invoice are a text field, not terms.
 */
export function dueDateFromPaymentTerms(
  issuedAtIso: string,
  paymentTermsDays: number | null
): string | null {
  if (paymentTermsDays === null) return null;
  const due = new Date(issuedAtIso);
  if (Number.isNaN(due.getTime())) return null;
  due.setUTCDate(due.getUTCDate() + paymentTermsDays);
  return due.toISOString();
}

// ── Proposal lines ────────────────────────────────────────────────────────────

const lineAmountFields = {
  hourlyRateCents: cents.nullable().default(null),
  otHourlyRateCents: cents.nullable().default(null),
  shiftRateCents: cents.nullable().default(null),
  dailyRateCents: cents.nullable().default(null),
  minHours: z.number().min(0).max(9999.99).nullable().default(null),
  weekendMultiplier: z.number().positive().max(999.999).nullable().default(null),
  nightMultiplier: z.number().positive().max(999.999).nullable().default(null),
};

const proposalLineBase = z.object({
  operation: rateProposalOperationSchema,
  roleId: z.string().uuid(),
  rateLabel: rateLabelSchema,
  rateMode: rateModeSchema,
  ...lineAmountFields,
  /** The approved card version this line supersedes. Required by REPLACE and END. */
  replacesRateCardId: z.string().uuid().nullable().default(null),
});

/**
 * The mode dictates which amount is mandatory (§6 `extractRate`), except on an
 * `END` line, which closes a window rather than pricing one and therefore carries
 * no amount at all.
 */
export const rateProposalLineInputSchema = proposalLineBase.superRefine((line, ctx) => {
  const requireTarget = line.operation === 'REPLACE' || line.operation === 'END';
  if (requireTarget && line.replacesRateCardId === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replacesRateCardId'],
      message: `A ${line.operation} line must name the approved rate it supersedes`,
    });
  }
  if (!requireTarget && line.replacesRateCardId !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replacesRateCardId'],
      message: 'A CREATE line adds a new rate and must not name one to supersede',
    });
  }
  if (line.operation === 'END') {
    const priced = (
      ['hourlyRateCents', 'otHourlyRateCents', 'shiftRateCents', 'dailyRateCents'] as const
    ).filter((field) => line[field] !== null);
    if (priced.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [priced[0]!],
        message: 'An END line closes a rate and carries no amount',
      });
    }
    return;
  }
  const required = {
    HOURLY: 'hourlyRateCents',
    SHIFT: 'shiftRateCents',
    DAILY: 'dailyRateCents',
  } as const;
  const field = required[line.rateMode];
  if (line[field] === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `${line.rateMode} lines require ${field}`,
    });
  }
});
export type RateProposalLineInput = z.infer<typeof rateProposalLineInputSchema>;

/**
 * Two lines pricing the same (role, label) would let array order decide the rate —
 * the same failure the label-rule overlap check exists to prevent (§3.3 follow-up).
 * The DB carries the matching unique constraint; this is so the caller gets a 422
 * naming the line instead of a constraint name.
 */
export function duplicateScheduleLineIndex(
  lines: readonly Pick<RateProposalLineInput, 'roleId' | 'rateLabel'>[]
): number {
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const key = `${line.roleId}:${line.rateLabel}`;
    if (seen.has(key)) return index;
    seen.add(key);
  }
  return -1;
}

const scheduleLinesSchema = z
  .array(rateProposalLineInputSchema)
  .min(1, 'A schedule needs at least one line')
  .max(200)
  .superRefine((lines, ctx) => {
    const duplicate = duplicateScheduleLineIndex(lines);
    if (duplicate >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [duplicate, 'rateLabel'],
        message: 'Another line in this schedule already prices that role and label',
      });
    }
  });

// ── Proposal requests ─────────────────────────────────────────────────────────

/**
 * Create a draft schedule for one engagement. The provider side is derived from
 * the edge, never supplied: a caller does not get to say which company it is
 * proposing as.
 */
export const createRateProposalSchema = z.object({
  engagementId: z.string().uuid(),
  effectiveFrom: isoDate,
  // No `currency`. A PAY schedule is always in the hiring company's one currency —
  // `rate_cards` resolve on the hiring side, so that is whose money it governs, and
  // the proposer never got to choose the unit even when the field existed. Removed
  // with the exchange rates on 2026-08-19.
  note: z.string().trim().max(2000).nullable().default(null),
  /** Continues a rejected schedule. Validated against the chain server-side. */
  predecessorProposalId: z.string().uuid().nullable().default(null),
  lines: scheduleLinesSchema,
});
export type CreateRateProposal = z.infer<typeof createRateProposalSchema>;

/** Edit a draft. `lines` replaces the whole schedule — a schedule is atomic (§3.3.1). */
export const updateRateProposalSchema = z
  .object({
    effectiveFrom: isoDate,
    note: z.string().trim().max(2000).nullable(),
    lines: scheduleLinesSchema,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update' });
export type UpdateRateProposal = z.infer<typeof updateRateProposalSchema>;

export const rejectRateProposalSchema = z.object({
  /** Required: a rejection without a reason leaves the provider nothing to correct. */
  reason: z.string().trim().min(1).max(2000),
});
export type RejectRateProposal = z.infer<typeof rejectRateProposalSchema>;

/**
 * Approve. `retroactiveReason` is the owner override for a schedule whose
 * effective date has already passed; supplying it when the date is not in the past
 * is refused rather than ignored, so the record never claims an override happened.
 */
export const approveRateProposalSchema = z.object({
  retroactiveReason: z.string().trim().min(1).max(2000).nullable().default(null),
});
export type ApproveRateProposal = z.infer<typeof approveRateProposalSchema>;

/**
 * Direct entry (§3.3.1): the hiring company records a schedule agreed outside
 * CrewQuo. It creates the same immutable approved versions the proposal path does
 * — not a mutable shortcut — so it is the same payload plus the provider it is for.
 */
export const directRateScheduleSchema = z.object({
  engagementId: z.string().uuid(),
  effectiveFrom: isoDate,
  note: z.string().trim().max(2000).nullable().default(null),
  retroactiveReason: z.string().trim().min(1).max(2000).nullable().default(null),
  lines: scheduleLinesSchema,
});
export type DirectRateSchedule = z.infer<typeof directRateScheduleSchema>;

// ── Proposal views ────────────────────────────────────────────────────────────

export const rateProposalLineViewSchema = proposalLineBase.extend({
  id: z.string().uuid(),
  proposalId: z.string().uuid(),
  roleName: z.string(),
  /**
   * The amount currently in force for this (role, label) on the edge, so a
   * reviewer sees what they are being asked to change *from* without a second
   * request. Null when nothing is in force — i.e. this line is genuinely new.
   */
  currentAmountCents: cents.nullable(),
  createdAt: z.string(),
});
export type RateProposalLineView = z.infer<typeof rateProposalLineViewSchema>;

export const rateProposalViewSchema = z.object({
  id: z.string().uuid(),
  engagementId: z.string().uuid(),
  proposedByCompanyId: z.string().uuid(),
  providerCompanyId: z.string().uuid(),
  providerCompanyName: z.string(),
  clientCompanyId: z.string().uuid(),
  clientCompanyName: z.string(),
  /** Which side of this edge the *reading* company is on. */
  side: z.enum(['client', 'provider']),
  currency: z.string(),
  effectiveFrom: isoDate,
  status: rateProposalStatusSchema,
  predecessorProposalId: z.string().uuid().nullable(),
  note: z.string().nullable(),
  submittedAt: z.string().nullable(),
  submittedByName: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewedByName: z.string().nullable(),
  decisionReason: z.string().nullable(),
  retroactiveReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lines: z.array(rateProposalLineViewSchema),
});
export type RateProposalView = z.infer<typeof rateProposalViewSchema>;

/** What the provider may pick as a REPLACE/END target: the edge's live PAY cards. */
export const agreementRateSchema = z.object({
  rateCardId: z.string().uuid(),
  roleId: z.string().uuid(),
  roleName: z.string(),
  rateLabel: rateLabelSchema,
  rateMode: rateModeSchema,
  amountCents: cents,
  otHourlyRateCents: cents.nullable(),
  minHours: z.number().nullable(),
  currency: z.string(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable(),
  version: z.number().int().min(1),
  locked: z.boolean(),
  /**
   * Where this rate comes from. `ENGAGEMENT` is a card aimed at this provider;
   * `COMPANY_DEFAULT` is the hiring company's default card, which the resolver falls
   * back to (§6) and which therefore prices this engagement too.
   *
   * The distinction is load-bearing for the UI: a default must **not** be offered as
   * a REPLACE target, because superseding it would reprice every other provider on
   * the same role at once. Overriding it means a CREATE line, which produces a
   * counterparty-specific card that then wins on precedence.
   */
  scope: z.enum(['ENGAGEMENT', 'COMPANY_DEFAULT']),
});
export type AgreementRate = z.infer<typeof agreementRateSchema>;

/** One engagement's commercial picture: terms, live PAY schedule, proposal history. */
export const commercialAgreementSchema = z.object({
  engagementId: z.string().uuid(),
  side: z.enum(['client', 'provider']),
  providerCompanyId: z.string().uuid(),
  providerCompanyName: z.string(),
  clientCompanyId: z.string().uuid(),
  clientCompanyName: z.string(),
  currency: z.string(),
  /**
   * Today, as the **hiring company** reckons it — the date `isRetroactive` will be
   * judged against when this screen submits.
   *
   * Sent rather than derived, because the screen was deriving it and getting a
   * different answer. `todayIso()` in the web client used the *viewer's browser*
   * zone; the API uses the hiring company's (see `todayIso` in the commercial
   * service, and `time.md` for why that packet exists at all). For a London reviewer
   * and a Manila company those disagree for eight hours of every day, and the
   * disagreement is not cosmetic: the screen showed no back-dating warning and asked
   * for no reason, and the server then refused the submit with a 403 nothing had
   * predicted.
   *
   * **The provider side cannot compute this at all**, which is the deeper reason it
   * belongs on the payload. A provider drafting a PAY schedule is judged by the
   * hiring company's calendar and does not know the hiring company's zone — and
   * should not be told it. A date is the narrower disclosure and the only part the
   * rule actually needs.
   *
   * A date, so a screen left open across midnight in the hiring zone goes stale by
   * one day. That is a warning being a day out versus a systematic eight-hour
   * disagreement, and the server remains the enforcer either way.
   */
  hiringToday: z.string(),
  terms: z.object({
    paymentTermsDays: z.number().int().nullable(),
    purchaseOrderReference: z.string().nullable(),
    purchaseOrderCeilingCents: z.number().int().nullable(),
    /** Issued and unvoided invoice value on this edge, against the ceiling. */
    committedCents: z.number().int(),
    termsUpdatedAt: z.string().nullable(),
  }),
  acceptance: z.object({
    status: z.string(),
    providerAcceptedAt: z.string().nullable(),
    decisionReason: z.string().nullable(),
  }),
  liveRates: z.array(agreementRateSchema),
  proposals: z.array(rateProposalViewSchema),
});
export type CommercialAgreement = z.infer<typeof commercialAgreementSchema>;

// ── Engagement commercial terms ───────────────────────────────────────────────

/**
 * Payment terms and the PO reference/ceiling live on the *edge*, not the project:
 * they are what the two companies agreed, and every project on the edge inherits
 * them. Revision-tracked (§36) with an optional reason.
 */
export const updateEngagementTermsSchema = z
  .object({
    paymentTermsDays: z.number().int().min(0).max(365).nullable(),
    purchaseOrderReference: z.string().trim().max(120).nullable(),
    /** bigint in the DB: a contract value, not a line amount. */
    purchaseOrderCeilingCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    reason: z.string().trim().max(2000).optional(),
  })
  .partial()
  .refine(
    (patch) =>
      Object.keys(patch).filter((key) => key !== 'reason').length > 0,
    { message: 'Nothing to update' }
  );
export type UpdateEngagementTerms = z.infer<typeof updateEngagementTermsSchema>;

/** A provider's decision on an engagement or an assignment it has been offered. */
export const acceptanceDecisionSchema = z.object({
  reason: z.string().trim().max(2000).nullable().default(null),
});
export type AcceptanceDecision = z.infer<typeof acceptanceDecisionSchema>;

export const assignmentAcceptanceViewSchema = z.object({
  acceptance: assignmentAcceptanceSchema,
  acceptedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
});
export type AssignmentAcceptanceView = z.infer<typeof assignmentAcceptanceViewSchema>;

/**
 * `GET`/`PATCH /v1/engagements/:id/terms`. `committedCents` is what the edge has
 * already issued and not voided, so a screen can show "$600 of $1,000 committed"
 * beside the ceiling instead of a bare cap the reader has to reconcile themselves.
 */
export const engagementTermsViewSchema = z.object({
  engagementId: z.string().uuid(),
  clientCompanyId: z.string().uuid(),
  providerCompanyId: z.string().uuid(),
  status: z.string(),
  paymentTermsDays: z.number().int().nullable(),
  purchaseOrderReference: z.string().nullable(),
  purchaseOrderCeilingCents: z.number().int().nullable(),
  termsUpdatedAt: z.string().nullable(),
  providerAcceptedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  /** Present on the GET; absent on the PATCH response, which returns the row alone. */
  committedCents: z.number().int().optional(),
});
export type EngagementTermsView = z.infer<typeof engagementTermsViewSchema>;

/** An assignment the active provider company has been offered. */
export const pendingAssignmentViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  providerCompanyId: z.string().uuid(),
  engagementId: z.string().uuid(),
  acceptance: assignmentAcceptanceSchema,
  acceptedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
});
export type PendingAssignmentView = z.infer<typeof pendingAssignmentViewSchema>;

/**
 * Which operation a proposal line performs, for display. Kept here so the web and
 * any later client describe an operation the same way.
 */
export const RATE_PROPOSAL_OPERATION_LABELS: Record<RateProposalOperation, string> = {
  CREATE: 'New rate',
  REPLACE: 'Replaces',
  END: 'Ends',
};
