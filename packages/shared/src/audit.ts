import { z } from 'zod';

/**
 * Audit trail & per-engagement portal settings (CREWQUO_V2_PLAN.md §3.6, §7).
 *
 * An audit row records *one company's* activity: `companyId` is the actor's
 * active company, and `visibleToClient` says whether the company that hired them
 * (the client side of their engagement) may see the row in the portal. The
 * counterparty read is additionally gated by the `audit_visibility` feature and
 * `audit_settings.show_audit_trail` — see the API's audit module.
 */

/**
 * Actions the writer emits. The DB column is free text on purpose, so adding an
 * action is a code change with no migration; this union keeps call sites honest.
 */
export const AUDIT_ACTIONS = [
  'time_log.submitted',
  'time_log.approved',
  'time_log.rejected',
  'expense.submitted',
  'expense.approved',
  'expense.rejected',
  'submission.submitted',
  'submission.approved',
  'submission.rejected',
  'project.created',
  'project.updated',
  'project.deleted',
  'project.exported',
  'assignment.created',
  'assignment.accepted',
  'assignment.declined',
  'engagement.created',
  'engagement.updated',
  // Commercial agreements (§3.3.1). `rate_proposal.*` rows are written against the
  // company whose record moved — the provider for submit/withdraw, the hiring
  // company for approve/reject — so each side's trail reads as its own actions.
  'rate_proposal.created',
  'rate_proposal.updated',
  'rate_proposal.deleted',
  'rate_proposal.submitted',
  'rate_proposal.approved',
  'rate_proposal.rejected',
  'rate_proposal.withdrawn',
  'rate_schedule.recorded',
  'engagement.terms_updated',
  'engagement.accepted',
  'engagement.declined',
  'invite.created',
  'invite.accepted',
  'audit_settings.updated',
  'note.created',
  'note.updated',
  'note.deleted',
  'company.merged',
  // No `company.created`: a company has no subscription at the instant it is
  // created, so it resolves to the free plan and `audit_retention_days: 0` would
  // discard the row anyway. Creation is recorded in `platform_audit_logs`, which
  // no plan can suppress (§3.1.1).
  'company.updated',
  'membership.updated',
  'membership.removed',
  'user.updated',
  'invoice.created',
  'invoice.updated',
  'invoice.issued',
  'invoice.paid',
  'invoice.voided',
  'invoice.deleted',
  // Platform-staff actions (§5B super-admin console). Recorded against the
  // *subject* company, since that is whose entitlements changed — the operator's
  // own company is irrelevant to the company reading its trail later.
  'company.plan_changed',
  'company.trial_comped',
  'company.override_applied',
  'company.override_removed',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const AUDIT_ENTITY_TYPES = [
  'PROJECT',
  'TIME_LOG',
  'EXPENSE',
  'PROJECT_SUBMISSION',
  'ASSIGNMENT',
  'ENGAGEMENT',
  'INVITE',
  'NOTE',
  'COMPANY',
  'MEMBERSHIP',
  'USER',
  'INVOICE',
  'RATE_PROPOSAL',
  'RATE_CARD',
  'SUBSCRIPTION',
  'ENTITLEMENT_OVERRIDE',
] as const;
export const auditEntityTypeSchema = z.enum(AUDIT_ENTITY_TYPES);
export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>;

export const auditLogViewSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().uuid().nullable(),
  changes: z.record(z.unknown()).nullable(),
  description: z.string().nullable(),
  visibleToClient: z.boolean(),
  createdAt: z.string(),
});
export type AuditLogView = z.infer<typeof auditLogViewSchema>;

/**
 * GET /v1/audit-logs. Without `engagementId` this reads the active company's own
 * trail; with it, the active company must be the client side of that engagement
 * and gets only the provider's client-visible rows.
 */
export const listAuditLogsQuerySchema = z.object({
  engagementId: z.string().uuid().optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(), // keyset cursor on created_at
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export const auditLogsResponseSchema = z.object({
  data: z.array(auditLogViewSchema),
  nextBefore: z.string().nullable(),
});
export type AuditLogsResponse = z.infer<typeof auditLogsResponseSchema>;

// ── Per-engagement portal settings ────────────────────────────────────────────

export const auditSettingsSchema = z.object({
  engagementId: z.string().uuid(),
  clientCanComment: z.boolean(),
  showAuditTrail: z.boolean(),
});
export type AuditSettings = z.infer<typeof auditSettingsSchema>;

export const updateAuditSettingsSchema = z
  .object({
    clientCanComment: z.boolean(),
    showAuditTrail: z.boolean(),
  })
  .partial();
export type UpdateAuditSettings = z.infer<typeof updateAuditSettingsSchema>;
