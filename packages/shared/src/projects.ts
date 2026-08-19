import { z } from 'zod';
import { assignmentAcceptanceSchema, projectStatusSchema } from './enums';
import { conversionGapSchema } from './money';
import { timeZoneSchema } from './time';

/**
 * Projects, assignments & the server-computed summary (CREWQUO_V2_PLAN.md §3.4, §7).
 * Costs/margins are computed server-side from the rate engine (§6) — never trusted
 * from the client.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const projectViewSchema = z.object({
  id: z.string().uuid(),
  ownerCompanyId: z.string().uuid(),
  clientCompanyId: z.string().uuid().nullable(),
  clientCompanyName: z.string().nullable(),
  engagementId: z.string().uuid().nullable(),
  name: z.string(),
  status: projectStatusSchema,
  clientVisible: z.boolean(),
  /**
   * The single unit this project's cost/bill/margin are reported in (§3.3
   * decision #5). Snapshotted from the owner company when the project is created
   * rather than read live, so changing the company currency next year cannot
   * silently restate a project that closed last year. Immutable once the project
   * holds committed money — see `reportingCurrencyPinRefusal`.
   */
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/),
  /**
   * IANA zone for work that happens somewhere other than the office. **Null means
   * inherit the company**, not unset: a project that copied the company zone at
   * creation would silently stop tracking it (§ `docs/operating-model/time.md`).
   */
  timeZone: z.string().nullable(),
  startsOn: isoDate.nullable(),
  endsOn: isoDate.nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectView = z.infer<typeof projectViewSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  clientCompanyId: z.string().uuid().nullable().default(null),
  engagementId: z.string().uuid().nullable().default(null),
  status: projectStatusSchema.default('ACTIVE'),
  clientVisible: z.boolean().default(false),
  /** Omitted means "the owner company's currency" — the majority case never sets it. */
  reportingCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  /** Omitted or null means "wherever the company is" — the majority case. */
  timeZone: timeZoneSchema.nullable().optional(),
  startsOn: isoDate.nullable().default(null),
  endsOn: isoDate.nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    clientCompanyId: z.string().uuid().nullable(),
    engagementId: z.string().uuid().nullable(),
    status: projectStatusSchema,
    clientVisible: z.boolean(),
    reportingCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    timeZone: timeZoneSchema.nullable(),
    startsOn: isoDate.nullable(),
    endsOn: isoDate.nullable(),
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial();
export type UpdateProject = z.infer<typeof updateProjectSchema>;

// ── Assignments ────────────────────────────────────────────────────────────────

export const assignmentViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  providerCompanyId: z.string().uuid(),
  providerCompanyName: z.string(),
  engagementId: z.string().uuid(),
  /**
   * The provider's answer to being put on this project (Phase 6 acceptance rules).
   * Recorded and surfaced, and deliberately **not** a gate on work capture: gating
   * it would stop a crew logging hours they had already worked, hours after a
   * decision taken by a different company. See §9 of
   * `docs/operating-model/commercial-agreements.md`.
   */
  acceptance: assignmentAcceptanceSchema,
  acceptedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  createdAt: z.string(),
});
export type AssignmentView = z.infer<typeof assignmentViewSchema>;

/** Assign a provider to a project; the engagement is derived (owner⇄provider edge). */
export const createAssignmentSchema = z.object({
  providerCompanyId: z.string().uuid(),
});
export type CreateAssignment = z.infer<typeof createAssignmentSchema>;

// ── Project summary ────────────────────────────────────────────────────────────

/** Per-provider rollup within a project summary. */
export const providerRollupSchema = z.object({
  providerCompanyId: z.string().uuid(),
  providerCompanyName: z.string(),
  approvedTimeLogs: z.number().int(),
  laborCostCents: z.number().int(),
  expenseCostCents: z.number().int(),
});
export type ProviderRollup = z.infer<typeof providerRollupSchema>;

/**
 * Server-computed project summary. `cost` is what the owner pays providers (PAY,
 * from each log's rate snapshot) plus approved expenses. `bill`/`margin` are
 * present only when the project has a client and BILL cards resolve.
 */
export const projectSummarySchema = z.object({
  projectId: z.string().uuid(),
  /**
   * The project's reporting currency — every figure below is in this unit. Read
   * from `projects.reporting_currency` rather than the owner company's live
   * column, so a company that changes currency does not restate closed projects.
   */
  currency: z.string(),
  approvedTimeLogs: z.number().int(),
  approvedExpenses: z.number().int(),
  laborCostCents: z.number().int(),
  expenseCostCents: z.number().int(),
  totalCostCents: z.number().int(),
  billCents: z.number().int().nullable(),
  marginCents: z.number().int().nullable(),
  marginPct: z.number().nullable(),
  byProvider: z.array(providerRollupSchema),
  /**
   * Money this project holds that could not be reported, because no recorded
   * exchange rate covers it (§41.1 — CrewQuo never estimates a rate).
   *
   * A non-empty list means the totals above are **incomplete, and knowingly so**.
   * The alternative — folding an unconvertible amount in at zero, or quietly
   * dropping it — would produce a total that looks complete and is not, which is
   * the one outcome the money boundary exists to prevent.
   */
  conversionGaps: z.array(conversionGapSchema).default([]),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
