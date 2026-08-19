import { z } from 'zod';
import { rateLabelSchema, rateModeSchema, shiftTypeSchema, workStatusSchema } from './enums';
import { fxSnapshotSchema } from './money';

/**
 * Work capture: time logs, expenses, submissions (CREWQUO_V2_PLAN.md §3.4, §7).
 * Workflow invariant: the provider side creates/edits only while DRAFT/REJECTED
 * and drives only DRAFT→SUBMITTED; the client side approves/rejects SUBMITTED.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const hours = z.number().min(0).max(24);

/** Rate snapshot frozen onto a time log at submit time (§6 PriceCalculation). */
export const resolvedRateSnapshotSchema = z.object({
  rateCardId: z.string().uuid(),
  label: rateLabelSchema,
  rateMode: rateModeSchema,
  baseCents: z.number().int(),
  otCents: z.number().int().nullable(),
  hoursRegular: z.number(),
  hoursOt: z.number(),
  costCents: z.number().int(),
  /**
   * The unit `costCents` is in (§3.3 decision #5). Optional because every log
   * frozen before the money boundary has none, and those inherit the project's
   * reporting currency — which is what they were already implicitly assumed to be.
   */
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  /**
   * The exchange rate used to report this cost, frozen here at submit for the
   * same reason `costCents` is: what a provider is owed must not move because
   * somebody recorded a new rate next month. Absent when no conversion was
   * needed, and absent when none was available — in which case the summary
   * withholds the figure and names the gap rather than guessing.
   */
  fx: fxSnapshotSchema.optional(),
});
export type ResolvedRateSnapshot = z.infer<typeof resolvedRateSnapshotSchema>;

// ── Time logs ─────────────────────────────────────────────────────────────────

export const timeLogViewSchema = z.object({
  id: z.string().uuid(),
  engagementId: z.string().uuid(),
  projectId: z.string().uuid(),
  providerCompanyId: z.string().uuid(),
  loggedByUserId: z.string().uuid(),
  roleId: z.string().uuid(),
  shiftType: shiftTypeSchema,
  workDate: isoDate,
  hoursRegular: z.number(),
  hoursOt: z.number(),
  status: workStatusSchema,
  resolvedRate: resolvedRateSnapshotSchema.nullable(),
  rejectReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TimeLogView = z.infer<typeof timeLogViewSchema>;

export const createTimeLogSchema = z.object({
  projectId: z.string().uuid(),
  roleId: z.string().uuid(),
  shiftType: shiftTypeSchema,
  workDate: isoDate,
  hoursRegular: hours.default(0),
  hoursOt: hours.default(0),
});
export type CreateTimeLog = z.infer<typeof createTimeLogSchema>;

export const updateTimeLogSchema = z
  .object({
    roleId: z.string().uuid(),
    shiftType: shiftTypeSchema,
    workDate: isoDate,
    hoursRegular: hours,
    hoursOt: hours,
  })
  .partial();
export type UpdateTimeLog = z.infer<typeof updateTimeLogSchema>;

// ── Expenses ────────────────────────────────────────────────────────────────────

export const expenseViewSchema = z.object({
  id: z.string().uuid(),
  engagementId: z.string().uuid(),
  projectId: z.string().uuid(),
  providerCompanyId: z.string().uuid(),
  loggedByUserId: z.string().uuid(),
  amountCents: z.number().int(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  receiptUrl: z.string().nullable(),
  status: workStatusSchema,
  rejectReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExpenseView = z.infer<typeof expenseViewSchema>;

export const createExpenseSchema = z.object({
  projectId: z.string().uuid(),
  amountCents: z.number().int().min(0),
  category: z.string().trim().max(80).nullable().default(null),
  description: z.string().trim().max(500).nullable().default(null),
});
export type CreateExpense = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = z
  .object({
    amountCents: z.number().int().min(0),
    category: z.string().trim().max(80).nullable(),
    description: z.string().trim().max(500).nullable(),
  })
  .partial();
export type UpdateExpense = z.infer<typeof updateExpenseSchema>;

// ── Project submissions ──────────────────────────────────────────────────────────

export const submissionViewSchema = z.object({
  id: z.string().uuid(),
  engagementId: z.string().uuid(),
  projectId: z.string().uuid(),
  providerCompanyId: z.string().uuid(),
  periodStart: isoDate.nullable(),
  periodEnd: isoDate.nullable(),
  status: workStatusSchema,
  rejectReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SubmissionView = z.infer<typeof submissionViewSchema>;

export const createSubmissionSchema = z.object({
  projectId: z.string().uuid(),
  periodStart: isoDate.nullable().default(null),
  periodEnd: isoDate.nullable().default(null),
});
export type CreateSubmission = z.infer<typeof createSubmissionSchema>;

// ── Shared review action (approve / reject) ───────────────────────────────────────

export const rejectSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type RejectInput = z.infer<typeof rejectSchema>;

// ── Provider work context (what the mobile log-time screen needs) ─────────────────

/**
 * The assignments a provider can log work against, each with the client's role
 * catalog so the mobile app can offer a role picker. Roles belong to the client
 * (the rate cards resolve against them), so they're surfaced here explicitly.
 */
export const workContextAssignmentSchema = z.object({
  projectId: z.string().uuid(),
  projectName: z.string(),
  clientCompanyId: z.string().uuid(),
  clientCompanyName: z.string(),
  engagementId: z.string().uuid(),
  /**
   * The zone the *project* counts its days in — the project's own override, or
   * the owner company's when it has none (`docs/operating-model/time.md` §2).
   *
   * Carried here because the device's zone is the wrong answer and the provider
   * company's is too: a Manila crew working a Dubai project asserts a Dubai day.
   * The log screen defaults `workDate` from this, which is the packet's
   * multi-region persona and the one case a device clock gets silently wrong.
   */
  timeZone: z.string(),
  roles: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});
export type WorkContextAssignment = z.infer<typeof workContextAssignmentSchema>;

export const workContextSchema = z.object({
  assignments: z.array(workContextAssignmentSchema),
});
export type WorkContext = z.infer<typeof workContextSchema>;

// ── Push tokens ────────────────────────────────────────────────────────────────

export const registerPushTokenSchema = z.object({
  token: z.string().trim().min(1),
  platform: z.enum(['ios', 'android', 'web']).optional(),
});
export type RegisterPushToken = z.infer<typeof registerPushTokenSchema>;
