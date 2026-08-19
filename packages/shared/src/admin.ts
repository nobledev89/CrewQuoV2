import { z } from 'zod';
import { planStatusSchema, priceIntervalSchema, subscriptionStatusSchema } from './enums';
import { entitlementsSchema, featureKeySchema, limitKeySchema, limitUsageSchema } from './entitlements';

/**
 * Super-admin plan management contracts (CREWQUO_V2_PLAN.md §5B, §7).
 * Plans are configurable data — these schemas type the console + api-client.
 */

const planIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{1,40}$/, 'slug: lowercase letters, digits, - or _');

// limits: key -> value, null = unlimited.
const limitsMapSchema = z.record(limitKeySchema, z.number().int().min(0).nullable());

export const adminPlanCreateSchema = z.object({
  id: planIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  status: planStatusSchema.default('DRAFT'),
  isPublic: z.boolean().default(true),
  operatesDownstream: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  trialDays: z.number().int().min(0).default(0),
  features: z.array(featureKeySchema).default([]),
  limits: limitsMapSchema.default({}),
});
export type AdminPlanCreate = z.infer<typeof adminPlanCreateSchema>;

// Update: everything except id is optional; features/limits replace when provided.
export const adminPlanUpdateSchema = adminPlanCreateSchema
  .omit({ id: true })
  .partial();
export type AdminPlanUpdate = z.infer<typeof adminPlanUpdateSchema>;

export const adminPlanPriceSchema = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
  interval: priceIntervalSchema,
  amountCents: z.number().int().min(0),
  providerPriceId: z.string().optional(),
  active: z.boolean().default(true),
});
export type AdminPlanPrice = z.infer<typeof adminPlanPriceSchema>;

export const adminPlanPriceViewSchema = adminPlanPriceSchema.extend({
  id: z.string().uuid(),
});
export type AdminPlanPriceView = z.infer<typeof adminPlanPriceViewSchema>;

// ── Companies console (§5B, §7: GET /v1/admin/companies + /overrides + /comp-trial) ──

/**
 * One row of the companies list: who they are, what they resolve to, and how
 * close they are to their caps.
 *
 * `planId` is the plan they *resolve* against, which is the free default when
 * `subscriptionStatus` is null — a company with no subscription row is not a
 * company with no entitlements, and conflating the two is how support ends up
 * telling someone their plan is broken.
 */
export const adminCompanySummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  currency: z.string(),
  isPlaceholder: z.boolean(),
  /** Set when this company is a placeholder that was folded into a real one (§3.6). */
  claimedByCompanyId: z.string().uuid().nullable(),
  planId: z.string(),
  subscriptionStatus: subscriptionStatusSchema.nullable(),
  trialEnd: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  memberCount: z.number().int(),
  overrideCount: z.number().int(),
  createdAt: z.string(),
});
export type AdminCompanySummary = z.infer<typeof adminCompanySummarySchema>;

export const adminCompaniesResponseSchema = z.object({
  data: z.array(adminCompanySummarySchema),
  nextCursor: z.string().nullable(),
});
export type AdminCompaniesResponse = z.infer<typeof adminCompaniesResponseSchema>;

/**
 * A query-string boolean. `z.coerce.boolean()` is wrong here: `Boolean('false')`
 * is `true`, so `?includePlaceholders=false` would switch the flag *on*.
 */
const queryBoolean = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

/**
 * GET /v1/admin/companies. Keyset cursor on `(created_at, id)` per §7 — an
 * opaque string the caller echoes back, never an offset.
 *
 * Placeholders are excluded by default. Every invited provider and portal client
 * creates one (§3.6), so they outnumber real companies and would bury a support
 * search under stubs nobody can sign in to.
 */
export const adminCompanyListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  planId: z.string().trim().max(64).optional(),
  includePlaceholders: queryBoolean,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
export type AdminCompanyListQuery = z.infer<typeof adminCompanyListQuerySchema>;

/** A live override row. Either the feature pair or the limit pair is set, never both. */
export const adminOverrideViewSchema = z.object({
  id: z.string().uuid(),
  featureKey: featureKeySchema.nullable(),
  featureEnabled: z.boolean().nullable(),
  limitKey: limitKeySchema.nullable(),
  limitValue: z.number().int().nullable(),
  note: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  /** True once `expiresAt` has passed — the resolver already ignores it. */
  expired: z.boolean(),
});
export type AdminOverrideView = z.infer<typeof adminOverrideViewSchema>;

/**
 * GET /v1/admin/companies/:id — the support view. Resolved entitlements and live
 * usage come from the same resolver and meters the company itself hits, so this
 * screen cannot disagree with what that company is actually allowed to do.
 */
export const adminCompanyDetailSchema = z.object({
  company: adminCompanySummarySchema,
  entitlements: entitlementsSchema,
  usage: z.array(limitUsageSchema),
  overrides: z.array(adminOverrideViewSchema),
});
export type AdminCompanyDetail = z.infer<typeof adminCompanyDetailSchema>;

/**
 * POST /v1/admin/companies/:id/overrides — grant or revoke one thing for one
 * company.
 *
 * Exactly one of the two pairs must be supplied. A row carrying both a feature
 * and a limit would be two decisions in one record with one expiry, and
 * `resolveEntitlements` applies each half independently — so the shape is
 * enforced here rather than left to whoever reads the merge code next.
 *
 * `limitValue: null` is *unlimited*, not zero, and `undefined` is "not this kind
 * of override". The two are opposite instructions, which is why the field is
 * nullable-and-optional rather than one or the other.
 */
export const adminOverrideCreateSchema = z
  .object({
    featureKey: featureKeySchema.optional(),
    featureEnabled: z.boolean().optional(),
    limitKey: limitKeySchema.optional(),
    limitValue: z.number().int().min(0).nullable().optional(),
    note: z.string().trim().max(1000).optional(),
    /** ISO timestamp. Omitted = permanent until removed. */
    expiresAt: z.string().datetime().optional(),
  })
  .superRefine((v, ctx) => {
    const isFeature = v.featureKey !== undefined;
    const isLimit = v.limitKey !== undefined;
    if (isFeature === isLimit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supply exactly one of featureKey or limitKey',
      });
      return;
    }
    if (isFeature && v.featureEnabled === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['featureEnabled'],
        message: 'featureEnabled is required with featureKey',
      });
    }
    if (isLimit && v.limitValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limitValue'],
        message: 'limitValue is required with limitKey (null = unlimited)',
      });
    }
  });
export type AdminOverrideCreate = z.infer<typeof adminOverrideCreateSchema>;

/**
 * POST /v1/admin/companies/:id/comp-trial — put a company on a plan as a trial
 * for N days, or extend the one it has.
 *
 * Separate from the subscription endpoint below because it is the support action
 * with a different intent: no money is involved, the end date is the whole point,
 * and the status is always `TRIALING`.
 */
export const adminCompTrialSchema = z.object({
  planId: z.string().trim().min(1).max(64),
  days: z.number().int().min(1).max(3650),
  /**
   * Trials are ledgered against the owning identity, not the tenant (§3.1.1(5)),
   * so comping one to a company whose owner already trialled elsewhere is refused
   * by default. A genuine second business does deserve a second evaluation — this
   * is how an operator says so, on the record, rather than reaching for an
   * entitlement override that would leave no trial history at all.
   */
  acknowledgeRepeatTrial: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});
export type AdminCompTrial = z.infer<typeof adminCompTrialSchema>;

/**
 * POST /v1/admin/companies/:id/subscription — force a plan or status.
 *
 * §5B's console lists "force plan change" beside overrides and comped trials;
 * §7 names only the other two routes, so this one is the addition recorded in
 * §46. It writes `company_subscriptions` directly — there is no merchant of
 * record yet (Phase 6), and until there is, a platform operator changing a plan
 * *is* the billing system.
 */
export const adminSetSubscriptionSchema = z.object({
  planId: z.string().trim().min(1).max(64),
  status: subscriptionStatusSchema.default('ACTIVE'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  interval: priceIntervalSchema.optional(),
  currentPeriodEnd: z.string().datetime().nullable().optional(),
});
export type AdminSetSubscription = z.infer<typeof adminSetSubscriptionSchema>;

export const adminPlanViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: planStatusSchema,
  isPublic: z.boolean(),
  operatesDownstream: z.boolean(),
  sortOrder: z.number().int(),
  trialDays: z.number().int(),
  features: z.array(featureKeySchema),
  limits: z.record(limitKeySchema, z.number().int().nullable()),
  prices: z.array(adminPlanPriceViewSchema),
});
export type AdminPlanView = z.infer<typeof adminPlanViewSchema>;

// ── Platform workspace ────────────────────────────────────────────────────────

export const adminPlatformAuditSchema = z.object({
  id: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  changes: z.record(z.unknown()),
  description: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminPlatformAudit = z.infer<typeof adminPlatformAuditSchema>;

export const adminDashboardSchema = z.object({
  totals: z.object({
    users: z.number().int(),
    verifiedUsers: z.number().int(),
    superAdmins: z.number().int(),
    companies: z.number().int(),
    placeholders: z.number().int(),
    paidCompanies: z.number().int(),
    trialingCompanies: z.number().int(),
    activeProjects: z.number().int(),
    pendingWork: z.number().int(),
    issuedInvoices: z.number().int(),
  }),
  attention: z.object({
    pendingInvites: z.number().int(),
    pastDueSubscriptions: z.number().int(),
    trialsExpiringSoon: z.number().int(),
    overridesExpiringSoon: z.number().int(),
  }),
  planDistribution: z.array(z.object({ key: z.string(), count: z.number().int() })),
  recentUsers: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    isSuperAdmin: z.boolean(),
    createdAt: z.string(),
  })),
  recentCompanies: z.array(adminCompanySummarySchema),
});
export type AdminDashboard = z.infer<typeof adminDashboardSchema>;

export const adminUserListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  access: z.enum(['ALL', 'SUPER_ADMIN', 'CUSTOMER']).default('ALL'),
  verification: z.enum(['ALL', 'VERIFIED', 'UNVERIFIED']).default('ALL'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export const adminUserSummarySchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  isSuperAdmin: z.boolean(),
  emailVerified: z.boolean(),
  membershipCount: z.number().int(),
  activeSessionCount: z.number().int(),
  createdAt: z.string(),
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const adminUserDetailSchema = z.object({
  user: adminUserSummarySchema,
  memberships: z.array(z.object({
    membershipId: z.string().uuid(),
    companyId: z.string().uuid(),
    companyName: z.string(),
    role: z.enum(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']),
    status: z.enum(['ACTIVE', 'INVITED', 'SUSPENDED']),
  })),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const adminReasonSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});
export type AdminReason = z.infer<typeof adminReasonSchema>;

export const adminSetSuperAdminSchema = adminReasonSchema.extend({ enabled: z.boolean() });
export type AdminSetSuperAdmin = z.infer<typeof adminSetSuperAdminSchema>;

export const adminReportingQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
});

export const adminReportingSchema = z.object({
  days: z.number().int(),
  signupsByDay: z.array(z.object({ day: z.string(), count: z.number().int() })),
  companiesByDay: z.array(z.object({ day: z.string(), count: z.number().int() })),
  planDistribution: z.array(z.object({ key: z.string(), count: z.number().int() })),
  subscriptionDistribution: z.array(z.object({ key: z.string(), count: z.number().int() })),
  workflow: z.object({
    projects: z.number().int(),
    timeLogs: z.number().int(),
    submittedTimeLogs: z.number().int(),
    invoices: z.number().int(),
    issuedInvoices: z.number().int(),
    activeEngagements: z.number().int(),
  }),
});
export type AdminReporting = z.infer<typeof adminReportingSchema>;

export const adminOperationsSchema = z.object({
  delivery: z.object({
    pendingOutbox: z.number().int().nonnegative(),
    processingOutbox: z.number().int().nonnegative(),
    deadOutbox: z.number().int().nonnegative(),
    receivedWebhooks: z.number().int().nonnegative(),
    processingWebhooks: z.number().int().nonnegative(),
    deadWebhooks: z.number().int().nonnegative(),
  }),
  /**
   * The intrusive half of notifications — the queue an operator cannot see from
   * the outbox figures above, because a channel send is separately claimed,
   * separately retried and separately failed (notifications packet §6).
   *
   * `skippedLastDay` is here on purpose and is not a rounding error: a skip is a
   * deliberate non-send with a recorded reason — no API key, no registered
   * device, channel turned off — and a rising count usually means a
   * misconfiguration rather than a user preference.
   */
  notifications: z.object({
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    sentLastDay: z.number().int().nonnegative(),
    skippedLastDay: z.number().int().nonnegative(),
  }),
  deadLetters: z.array(z.object({
    id: z.string().uuid(),
    source: z.enum(['OUTBOX', 'WEBHOOK']),
    kind: z.string(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    failedAt: z.string(),
  })),
  pendingInvites: z.array(z.object({
    id: z.string().uuid(),
    kind: z.string(),
    email: z.string(),
    companyName: z.string(),
    expiresAt: z.string(),
  })),
  expiringOverrides: z.array(z.object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    companyName: z.string(),
    subject: z.string(),
    expiresAt: z.string(),
  })),
  recentAudit: z.array(adminPlatformAuditSchema),
  services: z.array(z.object({
    name: z.string(),
    status: z.enum(['HEALTHY', 'ATTENTION', 'NOT_CONFIGURED']),
    detail: z.string(),
  })),
});
export type AdminOperations = z.infer<typeof adminOperationsSchema>;

export const adminPlatformSettingsSchema = z.object({
  platformName: z.string().trim().min(1).max(120),
  supportEmail: z.string().trim().email().or(z.literal('')),
  registrationOpen: z.boolean(),
  maintenanceMode: z.boolean(),
  maintenanceMessage: z.string().trim().max(500),
  /**
   * Company-creation policy (§3.1.1). Both ship **off**, and both are waiting on
   * a different Phase 6 bullet rather than on a decision:
   *
   *  · `requireVerifiedEmail` gates the *automatic* first company on a verified
   *    address. Verification links are only logged until Resend lands, so turning
   *    it on today would lock every new signup out of its own company. The
   *    additional-company request requires verification unconditionally and never
   *    reads this flag — that user has had time.
   *  · `checkoutEnabled` routes a paid-plan request to PENDING_CHECKOUT instead
   *    of the review queue. False until Gumroad exists.
   */
  requireVerifiedEmailForFirstCompany: z.boolean(),
  companyCheckoutEnabled: z.boolean(),
});
export type AdminPlatformSettings = z.infer<typeof adminPlatformSettingsSchema>;

export const adminPlatformSettingsUpdateSchema = adminPlatformSettingsSchema.partial();
export type AdminPlatformSettingsUpdate = z.infer<typeof adminPlatformSettingsUpdateSchema>;
