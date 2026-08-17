import { z } from 'zod';
import { projectStatusSchema } from './enums';

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
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
