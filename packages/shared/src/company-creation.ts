import { z } from 'zod';
import { currencyCodeSchema, DEFAULT_CURRENCY } from './me';

/**
 * Company ownership & creation safeguard (CREWQUO_V2_PLAN.md §3.1.1).
 * Operating-model packet: docs/operating-model/company-creation.md
 *
 * The distinction the whole domain rests on: **membership is unlimited, creating
 * a tenant is not**. Nothing here touches invitations — a user may be invited
 * into any number of companies and the switcher keeps showing every one. What is
 * rationed is bringing a new tenant into existence, because a tenant is a
 * subscription boundary, a data boundary and a trial.
 *
 * Everything in this file is pure (§0 rule 4). The API loads rows and passes them
 * in; the decisions live here so they can be pinned exhaustively without a
 * database, which is what §44's company-creation policy test list asks for.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Days a filed request stays open before it lapses. */
export const COMPANY_REQUEST_PENDING_DAYS = 14;

/**
 * Days an *approved* request stays usable. The clock restarts on approval
 * because at that point the thing you have to use is the approval, not the
 * application — and an approval left lying around indefinitely is a spare tenant
 * in a drawer.
 */
export const COMPANY_REQUEST_APPROVAL_DAYS = 30;

/** Requests one user may file in a rolling 24 hours (§3.1.1(7) rate limiting). */
export const COMPANY_REQUEST_RATE_LIMIT = 5;
export const COMPANY_REQUEST_RATE_WINDOW_HOURS = 24;

/**
 * The attestation, frozen onto the row at filing time.
 *
 * Stored rather than referenced so a later wording change cannot retroactively
 * alter what somebody agreed to — the same reason a submitted rate proposal
 * freezes its lines.
 */
export const COMPANY_CREATION_ATTESTATION =
  'I confirm this is a separate legal business — not a client, subcontractor, ' +
  'department, branch, brand or project that belongs inside a company I already ' +
  'have on CrewQuo. I understand it is billed separately and shares no data with ' +
  'my other companies.';

/** What a user hitting a registration-identifier collision is offered (§3.1.1(6)). */
export const COMPANY_RECOVERY_ROUTES = [
  'Ask an existing owner or admin of that company to invite you.',
  'If you should own it and cannot reach anyone, request ownership recovery from support.',
  'If this is genuinely a different business that shares the identifier by mistake, contact support with the paperwork.',
] as const;

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * §3.1.1 names these six and no more. A requester who changes their mind deletes
 * the row rather than moving it to a seventh state — the live row is the claim,
 * and `platform_audit_logs` (insert-only) is the history.
 */
export const COMPANY_REQUEST_STATUSES = [
  'PENDING_CHECKOUT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CONSUMED',
] as const;
export const companyRequestStatusSchema = z.enum(COMPANY_REQUEST_STATUSES);
export type CompanyRequestStatus = z.infer<typeof companyRequestStatusSchema>;

export type CompanyRequestEvent =
  | 'CHECKOUT_RECORDED'
  | 'ADMIN_APPROVE'
  | 'ADMIN_REJECT'
  | 'EXPIRE'
  | 'CONSUME';

/** A request still occupying the caller's single open slot. */
export function isCompanyRequestOpen(status: CompanyRequestStatus): boolean {
  return status === 'PENDING_CHECKOUT' || status === 'PENDING_REVIEW' || status === 'APPROVED';
}

/** Awaiting a decision — the only states the requester may delete. */
export function isCompanyRequestPending(status: CompanyRequestStatus): boolean {
  return status === 'PENDING_CHECKOUT' || status === 'PENDING_REVIEW';
}

export function isCompanyRequestTerminal(status: CompanyRequestStatus): boolean {
  return status === 'REJECTED' || status === 'EXPIRED' || status === 'CONSUMED';
}

/**
 * The state machine. Returns the next status, or `null` when the transition is
 * not allowed — callers turn that into a 409 naming what actually happened.
 */
export function nextCompanyRequestStatus(
  current: CompanyRequestStatus,
  event: CompanyRequestEvent
): CompanyRequestStatus | null {
  switch (event) {
    case 'CHECKOUT_RECORDED':
      return current === 'PENDING_CHECKOUT' ? 'APPROVED' : null;
    case 'ADMIN_APPROVE':
      // A super admin may approve out of PENDING_CHECKOUT too: §3.1.1(3)'s
      // exceptional path exists precisely for a legitimate free/Crew company that
      // should not be made to pay.
      return isCompanyRequestPending(current) ? 'APPROVED' : null;
    case 'ADMIN_REJECT':
      // Approved-but-unconsumed is still rejectable — an approval given in error
      // has to be retractable before it becomes a tenant.
      return isCompanyRequestPending(current) || current === 'APPROVED' ? 'REJECTED' : null;
    case 'EXPIRE':
      return isCompanyRequestOpen(current) ? 'EXPIRED' : null;
    case 'CONSUME':
      return current === 'APPROVED' ? 'CONSUMED' : null;
  }
}

/**
 * Expiry is materialised on read, not by a timer (see the packet's §3): durable
 * jobs are their own Phase 6 bullet and "move derivatives off process-local
 * timers" is already on the list, so adding a timer here would be work to undo.
 *
 * `CONSUMED` is deliberately immune. A company exists; its request cannot later
 * read as expired.
 */
export function effectiveCompanyRequestStatus(
  status: CompanyRequestStatus,
  expiresAt: Date | string,
  now: Date
): CompanyRequestStatus {
  if (!isCompanyRequestOpen(status)) return status;
  const expiry = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
  return expiry.getTime() <= now.getTime() ? 'EXPIRED' : status;
}

// ── Identity normalisation & the duplicate signal (§3.1.1(6)) ─────────────────

/**
 * Mirrors migration 0011's generated column exactly: strip everything that is not
 * a letter or digit, upper-case the rest, and treat an empty result as absent.
 *
 * "SC 123 456", "sc123456" and "SC-123456" are the same company registration
 * written by three different people, and a duplicate check that disagrees with
 * that is not a duplicate check.
 */
export function normalizeRegistrationId(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return stripped === '' ? null : stripped;
}

const COMPANY_NAME_SUFFIXES = [
  'limited', 'ltd', 'llc', 'llp', 'lp', 'plc', 'inc', 'incorporated',
  'corp', 'corporation', 'co', 'company', 'gmbh', 'bv', 'nv', 'sa', 'srl', 'pty',
];

/**
 * Loose name key for the *warning* path only.
 *
 * Punctuation, case, spacing and the trailing legal suffix are all noise when a
 * human is asking "have we already got these people?". It is only ever a warning:
 * §3.1.1(6) is explicit that names are not globally unique, and a blocking name
 * check would also be a free "does X use CrewQuo?" oracle (packet §10).
 */
export function normalizeCompanyName(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = base.split(' ').filter(Boolean);
  while (words.length > 1 && COMPANY_NAME_SUFFIXES.includes(words[words.length - 1]!)) {
    words.pop();
  }
  return words.join(' ');
}

export interface CompanyIdentityCandidate {
  /** Where the candidate came from — an existing tenant, or somebody else's open request. */
  kind: 'COMPANY' | 'REQUEST';
  country: string | null;
  registrationIdNormalized: string | null;
  nameNormalized: string;
}

export interface DuplicateSignal {
  /** `BLOCK` routes to recovery; `WARNING` is shown and the user continues. */
  level: 'NONE' | 'WARNING' | 'BLOCK';
  reason: string | null;
  /** Deliberately carries no company id, name or owner — see the packet's §10. */
  matchedKind: 'COMPANY' | 'REQUEST' | null;
}

/**
 * Country + registration identifier is a strong signal and blocks; a name-only
 * match warns. The return value never names the matched company: the whole point
 * is to answer "is this already here" without becoming a tenant-enumeration
 * oracle.
 */
export function classifyDuplicateSignal(
  input: { country: string; registrationId?: string | null; legalName: string },
  candidates: CompanyIdentityCandidate[]
): DuplicateSignal {
  const registration = normalizeRegistrationId(input.registrationId);
  const country = input.country.trim().toUpperCase();

  if (registration) {
    const hit = candidates.find(
      (c) =>
        c.registrationIdNormalized === registration &&
        (c.country ?? '').toUpperCase() === country
    );
    if (hit) {
      return {
        level: 'BLOCK',
        reason:
          hit.kind === 'COMPANY'
            ? 'A company with this registration number is already on CrewQuo.'
            : 'Another request for this registration number is already being reviewed.',
        matchedKind: hit.kind,
      };
    }
  }

  const name = normalizeCompanyName(input.legalName);
  if (name !== '') {
    const hit = candidates.find((c) => c.nameNormalized === name);
    if (hit) {
      return {
        level: 'WARNING',
        reason:
          'A company with a very similar name already exists. Company names are not unique, ' +
          'so this does not stop you — but check you are not re-creating one you can be invited into.',
        matchedKind: hit.kind,
      };
    }
  }

  return { level: 'NONE', reason: null, matchedKind: null };
}

// ── Routing a new request ─────────────────────────────────────────────────────

export type CompanyApprovalRoute = 'CHECKOUT' | 'ADMIN';

/**
 * The entry state is the **server's** decision, not the caller's — otherwise a
 * client would simply ask for the free review queue instead of paying.
 *
 * Checkout is off until Gumroad lands, so every request currently routes to
 * `ADMIN` / `PENDING_REVIEW`. That is §3.1.1(3)'s "audited super-admin approval"
 * arm, not a gap in the safeguard.
 */
export function resolveCompanyApprovalRoute(input: {
  checkoutEnabled: boolean;
  intendedPlanIsPaid: boolean;
}): { route: CompanyApprovalRoute; status: CompanyRequestStatus } {
  return input.checkoutEnabled && input.intendedPlanIsPaid
    ? { route: 'CHECKOUT', status: 'PENDING_CHECKOUT' }
    : { route: 'ADMIN', status: 'PENDING_REVIEW' };
}

// ── The creation gate ─────────────────────────────────────────────────────────

export interface CompanyCreationFacts {
  isPlatformStaff: boolean;
  emailVerified: boolean;
  /** Platform setting: gate the *automatic* first company on a verified address. */
  requireVerifiedEmail: boolean;
  /** True once the permanent ledger row exists — invitations never set this. */
  allowanceConsumed: boolean;
  /** The caller's single `APPROVED` request, already resolved by the repo. */
  approvedRequest: { id: string; expiresAt: Date | string } | null;
  now: Date;
}

export type CompanyCreationDecision =
  | { kind: 'ALLOWANCE' }
  | { kind: 'APPROVAL'; requestId: string }
  | {
      kind: 'REFUSED';
      code: 'FORBIDDEN' | 'VALIDATION' | 'CONFLICT';
      message: string;
      details?: Record<string, unknown>;
    };

/**
 * May this identity create a company right now, and on what authority?
 *
 * Order matters and is itself the policy: staff are excluded before anything
 * else, the automatic allowance is checked before any approval is looked for, and
 * an exhausted allowance with no approval is a `CONFLICT` that explains the next
 * step rather than a bare refusal.
 */
export function resolveCompanyCreationDecision(
  facts: CompanyCreationFacts
): CompanyCreationDecision {
  if (facts.isPlatformStaff) {
    return {
      kind: 'REFUSED',
      code: 'FORBIDDEN',
      message:
        'Platform staff do not create customer companies here. Use the CrewQuo Platform console.',
    };
  }

  if (!facts.allowanceConsumed) {
    if (facts.requireVerifiedEmail && !facts.emailVerified) {
      return {
        kind: 'REFUSED',
        code: 'VALIDATION',
        message: 'Verify your email address before creating a company.',
        details: { requires: 'email_verification' },
      };
    }
    return { kind: 'ALLOWANCE' };
  }

  if (!facts.approvedRequest) {
    return {
      kind: 'REFUSED',
      code: 'CONFLICT',
      message:
        'You have already used your included company. Creating another business needs an ' +
        'approved request first.',
      details: { requires: 'company_creation_request' },
    };
  }

  const expiry =
    typeof facts.approvedRequest.expiresAt === 'string'
      ? new Date(facts.approvedRequest.expiresAt)
      : facts.approvedRequest.expiresAt;
  if (expiry.getTime() <= facts.now.getTime()) {
    return {
      kind: 'REFUSED',
      code: 'CONFLICT',
      message: `That approval expired on ${expiry.toISOString().slice(0, 10)}. File a new request.`,
      details: { requires: 'company_creation_request', expiredAt: expiry.toISOString() },
    };
  }

  return { kind: 'APPROVAL', requestId: facts.approvedRequest.id };
}

// ── Trial eligibility (§3.1.1(5)) ─────────────────────────────────────────────

export interface TrialEligibilityFacts {
  /** Every OWNER identity of the target company. */
  ownerUserIds: string[];
  /** Prior grants for those identities, on **other** companies. */
  priorGrants: { userId: string; companyId: string }[];
  targetCompanyId: string;
  /** Does the target company already have a live/lapsed trial of its own? */
  targetHasTrial: boolean;
  acknowledgeRepeat: boolean;
}

export type TrialEligibility =
  | { kind: 'EXTENSION' }
  | { kind: 'FIRST' }
  | { kind: 'REPEAT_ALLOWED' }
  | { kind: 'REFUSED'; message: string; details: Record<string, unknown> };

/**
 * Trials are ledgered against the *owning identity*, not the tenant — otherwise
 * "archive the company, make another" is an unlimited free tier.
 *
 * Three cases the ledger must keep apart, because collapsing any two of them
 * breaks a real workflow:
 *
 *  · **Extension.** The same company's own trial being lengthened is not a new
 *    trial at all, and support does this constantly.
 *  · **First.** No owner of this company has ever had one. The ordinary path.
 *  · **Repeat.** An owner has had one elsewhere. Refused *by default* — but a
 *    super admin can proceed with an acknowledgement and a reason, because a
 *    genuine second business legitimately gets a second evaluation and the
 *    alternative (an entitlement override) would leave no trial record at all.
 */
export function resolveTrialEligibility(facts: TrialEligibilityFacts): TrialEligibility {
  if (facts.targetHasTrial) return { kind: 'EXTENSION' };

  const owners = new Set(facts.ownerUserIds);
  const prior = facts.priorGrants.filter(
    (g) => owners.has(g.userId) && g.companyId !== facts.targetCompanyId
  );
  if (prior.length === 0) return { kind: 'FIRST' };
  if (facts.acknowledgeRepeat) return { kind: 'REPEAT_ALLOWED' };

  return {
    kind: 'REFUSED',
    message:
      'An owner of this company has already had a trial on another company. Creating a new ' +
      'company does not reset trial eligibility (§3.1.1). Re-send with an acknowledgement and ' +
      'a reason if this is a genuine second business.',
    details: { priorGrants: prior.length, requires: 'acknowledgeRepeatTrial' },
  };
}

// ── Contracts ─────────────────────────────────────────────────────────────────

/** ISO 3166-1 alpha-2, matching the DB check constraint. */
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'must be a 2-letter ISO 3166-1 country code');

/**
 * POST /v1/company-creation-requests.
 *
 * `password` **or** `googleIdToken` is the step-up re-authentication §3.1.1(7)
 * asks for: an access token is re-minted by refresh without anyone re-proving
 * anything, so its age is not evidence of a recent human — re-entry is.
 *
 * `attestation` is `z.literal(true)`, so an unticked box is a 422 rather than a
 * silently unattested request.
 */
export const createCompanyCreationRequestSchema = z
  .object({
    legalName: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200).optional(),
    country: countryCodeSchema,
    registrationId: z.string().trim().max(80).optional().nullable(),
    intendedPlanId: z.string().trim().max(60).optional().nullable(),
    currency: currencyCodeSchema.default(DEFAULT_CURRENCY),
    attestation: z.literal(true, {
      errorMap: () => ({ message: 'You must confirm this is a separate legal business' }),
    }),
    password: z.string().min(1).max(200).optional(),
    googleIdToken: z.string().min(1).optional(),
    /** Acknowledges a name-only warning that was shown on a previous attempt. */
    acknowledgeNameWarning: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.password) || Boolean(v.googleIdToken), {
    message: 'Confirm your password to continue',
    path: ['password'],
  });
export type CreateCompanyCreationRequest = z.infer<typeof createCompanyCreationRequestSchema>;

export const companyCreationRequestViewSchema = z.object({
  id: z.string().uuid(),
  status: companyRequestStatusSchema,
  legalName: z.string(),
  displayName: z.string(),
  country: z.string(),
  registrationId: z.string().nullable(),
  intendedPlanId: z.string().nullable(),
  currency: z.string(),
  approvalRoute: z.enum(['CHECKOUT', 'ADMIN']),
  decisionReason: z.string().nullable(),
  decidedAt: z.string().nullable(),
  expiresAt: z.string(),
  companyId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type CompanyCreationRequestView = z.infer<typeof companyCreationRequestViewSchema>;

/**
 * GET /v1/company-creation-requests — everything the profile screen needs to
 * decide which of the three things it should show: the plain create form, the
 * request form, or a filed request's status.
 */
export const companyCreationStateSchema = z.object({
  allowanceAvailable: z.boolean(),
  allowanceCompanyId: z.string().uuid().nullable(),
  canRequest: z.boolean(),
  /** Why not, when `canRequest` is false — rendered verbatim. */
  blockedReason: z.string().nullable(),
  attestationText: z.string(),
  openRequest: companyCreationRequestViewSchema.nullable(),
  history: z.array(companyCreationRequestViewSchema),
});
export type CompanyCreationState = z.infer<typeof companyCreationStateSchema>;

export const companyCreationRequestResponseSchema = z.object({
  request: companyCreationRequestViewSchema,
  warning: z.string().nullable(),
});
export type CompanyCreationRequestResponse = z.infer<typeof companyCreationRequestResponseSchema>;

// ── Admin contracts ───────────────────────────────────────────────────────────

export const adminCompanyCreationRequestSchema = companyCreationRequestViewSchema.extend({
  userId: z.string().uuid(),
  userName: z.string(),
  userEmail: z.string(),
  emailVerified: z.boolean(),
  /** Companies the requester already owns — the reviewer's whole job, in one number. */
  ownedCompanies: z.number().int(),
  duplicateWarning: z.string().nullable(),
  decidedByName: z.string().nullable(),
});
export type AdminCompanyCreationRequest = z.infer<typeof adminCompanyCreationRequestSchema>;

export const adminCompanyCreationRequestsResponseSchema = z.object({
  data: z.array(adminCompanyCreationRequestSchema),
});
export type AdminCompanyCreationRequestsResponse = z.infer<
  typeof adminCompanyCreationRequestsResponseSchema
>;

export const adminCompanyCreationRequestListQuerySchema = z.object({
  status: companyRequestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminCompanyCreationRequestListQuery = z.infer<
  typeof adminCompanyCreationRequestListQuerySchema
>;

/** A decision with no reason is indistinguishable from a mistake later (§3.3.1). */
export const adminCompanyCreationDecisionSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type AdminCompanyCreationDecision = z.infer<typeof adminCompanyCreationDecisionSchema>;

export const adminRecordCheckoutSchema = z.object({
  checkoutReference: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500),
});
export type AdminRecordCheckout = z.infer<typeof adminRecordCheckoutSchema>;
