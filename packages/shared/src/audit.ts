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
  /*
   * Project locations (§21, 0028). Their own actions rather than
   * `project.updated`: a location is a spatial key that evidence, assets and
   * diary entries hang off, and "somebody retired Floor 3" is a different
   * question from "somebody renamed the project".
   */
  'location.created',
  'location.updated',
  'location.deleted',
  /*
   * Project evidence (§22, 0030). `evidence.published` and `.unpublished` are two
   * actions rather than one with a boolean, because "who shared this with the
   * client, and when" and "who stopped sharing it" are different questions — and
   * collapsing them makes the second unanswerable without reading every row's
   * changes. Publishing is a disclosure; both edges are recorded.
   *
   * `evidence.created` is written once per **batch**. Forty photographs is one act
   * by one person, and forty audit rows is a trail nobody can read.
   */
  'evidence.created',
  'evidence.updated',
  'evidence.published',
  'evidence.unpublished',
  'evidence.deleted',
  /*
   * Project documents (§24, 0031). `document.superseded` rather than
   * `document.updated` for a re-issue, because they are different acts: an update
   * corrects what a row says about the same bytes, and a supersession is new bytes
   * with the old ones deliberately kept. A trail that called both "updated" could
   * not answer "when did this RAMS change", which is the question a document trail
   * exists for.
   */
  'document.created',
  'document.updated',
  'document.superseded',
  'document.deleted',
  /*
   * The site diary (§23, 0032). `diary.updated` and `diary.amended` are two
   * actions and the split is the whole point of the record: an update is ordinary
   * work on an open day, an amendment is a change to a day somebody may already
   * have relied on. A trail that called both "updated" would make "was this
   * changed after it was closed" — the only question anybody asks a diary trail —
   * answerable only by reading every row's payload.
   *
   * The three attendance actions are separate from the entry's own for the same
   * reason `evidence.published` is separate from `evidence.updated`: who was
   * recorded as being on site is the part of a closed day a dispute is most likely
   * to be about, and it must be findable without a full-text search of `changes`.
   */
  'diary.opened',
  'diary.updated',
  'diary.closed',
  'diary.amended',
  'diary.attendance_added',
  'diary.attendance_updated',
  'diary.attendance_removed',
  // A whole-company export (packet §14 step 5). Audited because it is a disclosure of
  // the company's record by one of its members, and the other owners are entitled to
  // know it happened. A *personal* export is not here on purpose: it has no company
  // whose trail it belongs in, and filing it under whichever company was active would
  // record somebody's subject-access request as an event in their employer's log.
  'company.exported',
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
  'company.created',
  'company.updated',
  'membership.updated',
  /*
   * Capability assignment (§37). Distinct from `membership.updated`, which is a
   * change of *role* — the four roles are the tenancy relationship and a bundle
   * is the job function. Collapsing them would make "why can this person suddenly
   * close a day" unanswerable from the action alone.
   */
  'membership.capabilities_updated',
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
  // Money identity (§3.3 decision #5). A project's currency is the label its whole
  // history is printed with, so changing it is evidence rather than telemetry.
  // `fx_rate.recorded` / `.deleted` were removed on 2026-08-19 with the exchange
  // rates themselves — a company works in one currency and nothing is converted.
  'project.reporting_currency_set',
  /*
   * Closure (`observability-data-lifecycle.md` §13.1). Company scope only, and the
   * absence of a personal equivalent is the same reasoning as `company.exported`
   * above: a personal closure has no company whose trail it belongs in, and filing
   * one under whichever company happened to be active would record somebody's
   * erasure request as an event in their employer's log. It goes to
   * `deletion_requests` and `platform_audit_logs` instead.
   *
   * None of these is client-visible. That a company is winding down is its own
   * business; a counterparty learns the relationship is ending from the notice they
   * are sent, not by reading somebody else's audit trail.
   */
  'company.closure_requested',
  'company.closure_cancelled',
  'company.closed',
  /*
   * Subscription self-management (§3.1.1, §5B). The company's own trail, not the
   * platform's: these are the owner's decisions about what the company is paying
   * for, and the person who finds an unexpected downgrade next quarter is a
   * colleague, not an operator.
   *
   * `company.plan_changed` above is deliberately not reused. It is the *operator*
   * setting a plan by hand, and collapsing the two would make "who decided this"
   * unanswerable from the action alone.
   */
  'subscription.cancel_scheduled',
  'subscription.cancel_withdrawn',
  'subscription.plan_changed',
  /*
   * Assets & materials (§25). Four actions and no `asset.weight_verified` among
   * them: `audit_logs` records *that* something happened, and the before/after of
   * a weight is `record_revisions`' job (§36) — which is where §25.3 puts it, and
   * where it sits behind the same authorization as the line itself.
   *
   * `asset.imported` is on the PROJECT rather than on any line, because sixty
   * pasted rows is one act and sixty trail entries is a trail nobody reads.
   */
  'asset.created',
  'asset.imported',
  'asset.updated',
  'asset.deleted',
  /*
   * The movement ledger (§25.4). `recorded` and `continued` are separate actions
   * rather than one with a flag, because they answer different questions six
   * months later: "where did this go" and "where did it go NEXT". Collapsing them
   * would make the storage chain unreadable from the trail alone.
   */
  'asset.movement_recorded',
  'asset.movement_continued',
  'asset.movement_corrected',
  'asset.movement_removed',
  'destination_org.created',
  'destination_org.updated',
  /*
   * Sustainability (§26–§28). Five actions, and the shape of the list is decided
   * by who did what.
   *
   * `factor_set.imported` and `factor_set.deactivated` are acts of a person, and
   * an import is a single act however many thousand rows it wrote — the same
   * reasoning `asset.imported` applies, one noun over.
   *
   * `carbon.recalculated` is the exception in this whole catalog: **the actor is
   * frequently nobody.** A recalculation triggered by tombstoning a movement has a
   * person behind it; one triggered by a factor-set re-import across forty projects
   * does not have one per project. The trail records what changed and by how much
   * (the per-bucket delta rides in `changes`), because a year later the question is
   * "why did this number move", and the superseded rows can only answer what it
   * was.
   *
   * There is deliberately no `carbon.calculated`. Every read of a project's
   * sustainability section can produce calculations where none existed, and an
   * audit row per read is a trail nobody can find anything in.
   */
  'factor_set.imported',
  'factor_set.deactivated',
  'product_factor.created',
  'product_factor.updated',
  'carbon.recalculated',
  'activity.recorded',
  'activity.updated',
  'activity.removed',
  'sustainability_settings.updated',
  /*
   * Reporting and sign-off (§29, §34). Six actions, and the shape of the list is
   * decided by which of them a client can observe.
   *
   * `report.generated` is internal: which documents a company produced for itself
   * is nobody else's business. `report.disclosed` and `report.undisclosed` are two
   * actions rather than one with a boolean, for the reason `evidence.published`
   * and `evidence.unpublished` are — "who stopped sharing this, and when" is a
   * question somebody asks, and collapsing them makes it answerable only by
   * reading every row's payload.
   *
   * `report.voided` is separate from a supersession, which has no action at all:
   * superseding is a side effect of generating a successor and is recorded on the
   * successor's own `report.generated` row, so a second action would double-count
   * one act. Voiding is its own decision, with its own required reason.
   *
   * `signoff.captured` is client-visible, and it is the one row in this block that
   * is. The client is a party to it — they signed it — and a trail that recorded
   * somebody else's signature as invisible to the signer would be the wrong way
   * round.
   */
  'report.generated',
  'report.disclosed',
  'report.undisclosed',
  'report.voided',
  'signoff.captured',
  'signoff.superseded',
  /**
   * Commercial & operations (§30, §31) — Phase 11.
   *
   * **`variation.approved` and `variation.completed` are client-visible and
   * `variation.rejected` is not**, which is the one disclosure decision in this
   * block (`commercial-operations.md` §13.6). An approved variation is money the
   * client agreed to pay and they are entitled to see the decision; a client seeing
   * a variation their own contractor's team refused internally is a conversation the
   * product should not start.
   *
   * `variation.client_approval_recorded` exists as its own action rather than as a
   * second `variation.approved` because it is a different act by a different person
   * at a different time: approval is the contractor deciding to charge, and this is
   * the paperwork arriving on Friday for work the crew did on Wednesday. Collapsing
   * them would make the trail unable to answer *"was the client's agreement on file
   * when we invoiced?"*
   *
   * **`schedule.assigned` is one row for a whole batch**, matching its single
   * outbox event: Priya's Monday morning is eleven people onto three jobs, and
   * eleven audit rows for one act is a trail nobody reads.
   *
   * There is deliberately no `variation.priced` and no `budget.viewed`. A price is
   * carried by the `record_revisions` row that already records what changed, and an
   * audit action for a *read* would be the first one in this catalog — a decision
   * about surveillance rather than about accountability.
   */
  'variation.created',
  'variation.updated',
  'variation.deleted',
  'variation.submitted',
  'variation.withdrawn',
  'variation.approved',
  'variation.rejected',
  'variation.completed',
  'variation.client_approval_recorded',
  'budget.set',
  'budget.updated',
  'vehicle.created',
  'vehicle.updated',
  'vehicle.retired',
  'vehicle.deleted',
  'schedule.assigned',
  'schedule.changed',
  'schedule.cancelled',
  'schedule.confirmed',
  'schedule.requirements_set',
  /* Phase 12 (§33). Renewals are distinct from metadata corrections. */
  'compliance.created',
  'compliance.updated',
  'compliance.renewed',
  'compliance.rejected',
  'compliance.deleted',
  'availability.recorded',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const AUDIT_ENTITY_TYPES = [
  'PROJECT',
  'LOCATION',
  'EVIDENCE',
  'DOCUMENT',
  'SITE_DIARY_ENTRY',
  'PROJECT_ASSET',
  'ASSET_MOVEMENT',
  'EMISSION_FACTOR_SET',
  'PRODUCT_CARBON_FACTOR',
  'PROJECT_ACTIVITY',
  'SUSTAINABILITY_SETTINGS',
  'GENERATED_REPORT',
  'CLIENT_SIGNOFF',
  'DESTINATION_ORGANISATION',
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
  'FX_RATE',
  // Phase 11 (§30, §31). `PROJECT_BUDGET`'s entity id is the **project** id, not a
  // budget id: there is one budget per project (`project_budgets_one_per_project`),
  // so the project is what a trail entry is about and what a reader would look up.
  'VARIATION',
  'PROJECT_BUDGET',
  'VEHICLE',
  'SCHEDULE_ASSIGNMENT',
  'RESOURCE_AVAILABILITY',
  'COMPLIANCE_DOCUMENT',
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
