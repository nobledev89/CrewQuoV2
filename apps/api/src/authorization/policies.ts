import type { MembershipRole, WorkStatus } from '@crewquo/shared';

/**
 * Centralized authorization policy (CREWQUO_V2_PLAN.md §4). Pure functions over
 * plain data so every rule is unit-testable in isolation — the parity surface
 * against v1's firestore.rules (§13: one test per rule). No I/O here; callers
 * load rows from Postgres and pass them in.
 */

/** Roles that may manage a company's resources (create/edit/invite). MEMBER = worker. */
const MANAGER_ROLES: readonly MembershipRole[] = ['OWNER', 'ADMIN', 'MANAGER'];

export function canManage(role: MembershipRole): boolean {
  return MANAGER_ROLES.includes(role);
}

export function isOwnerOrAdmin(role: MembershipRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** The two endpoints of an engagement — the only companies that may see it. */
export interface EngagementEdge {
  clientCompanyId: string;
  providerCompanyId: string;
}

/**
 * One-hop rule (§3.2): a company sees an engagement only if it is one of the two
 * endpoints. Visibility never traverses past a direct edge, at any depth.
 */
export function isEngagementParticipant(companyId: string, edge: EngagementEdge): boolean {
  return companyId === edge.clientCompanyId || companyId === edge.providerCompanyId;
}

export function isEngagementClientSide(companyId: string, edge: EngagementEdge): boolean {
  return companyId === edge.clientCompanyId;
}

export function isEngagementProviderSide(companyId: string, edge: EngagementEdge): boolean {
  return companyId === edge.providerCompanyId;
}

/**
 * PAY/BILL guard (§3.3): the provider side of an engagement can never read the
 * client side's BILL rate cards or computed margin. Only the client side may.
 */
export function canReadBillRates(companyId: string, edge: EngagementEdge): boolean {
  return isEngagementClientSide(companyId, edge);
}

/**
 * Work workflow invariant (§3.4, preserved from v1): the provider side may
 * create/edit a time_log/expense/submission only while DRAFT/REJECTED.
 */
export function canProviderEditWork(status: WorkStatus): boolean {
  return status === 'DRAFT' || status === 'REJECTED';
}

/** The only transition the provider may drive is DRAFT → SUBMITTED. */
export function canProviderSubmit(status: WorkStatus): boolean {
  return status === 'DRAFT';
}

/**
 * The client side (OWNER/ADMIN/MANAGER of the client company) approves/rejects
 * SUBMITTED work. Returns true only when all three conditions hold.
 */
export function canReviewWork(
  companyId: string,
  role: MembershipRole,
  edge: EngagementEdge,
  status: WorkStatus
): boolean {
  return isEngagementClientSide(companyId, edge) && canManage(role) && status === 'SUBMITTED';
}

/**
 * Portal audit read (§3.6): the client side of an engagement may read the
 * provider's trail only when the provider's plan includes `audit_visibility`
 * *and* the provider has switched the trail on for that engagement. Exposure is
 * opt-in twice over; the query additionally returns only `visible_to_client` rows.
 */
export function canReadCounterpartyAudit(args: {
  companyId: string;
  edge: EngagementEdge;
  providerHasAuditVisibility: boolean;
  showAuditTrail: boolean;
}): boolean {
  return (
    isEngagementClientSide(args.companyId, args.edge) &&
    args.providerHasAuditVisibility &&
    args.showAuditTrail
  );
}

/**
 * Portal settings belong to the side whose data is exposed — the provider on the
 * edge — and only its managers may change them.
 */
export function canManageAuditSettings(
  companyId: string,
  role: MembershipRole,
  edge: EngagementEdge
): boolean {
  return isEngagementProviderSide(companyId, edge) && canManage(role);
}

/**
 * Portal read (§3.6): only the client side of an edge has a portal, and only
 * when the provider's plan sells one. The per-project `client_visible` flag is
 * applied in the query — this gates the surface as a whole.
 */
export function canReadPortal(args: {
  companyId: string;
  edge: EngagementEdge;
  providerHasClientPortal: boolean;
}): boolean {
  return isEngagementClientSide(args.companyId, args.edge) && args.providerHasClientPortal;
}

/**
 * Note write (§3.6). `client_portal_notes` is the *provider's* feature — they're
 * the one selling the portal — so it gates both sides. The client additionally
 * needs `audit_settings.client_can_comment`; the provider can always annotate
 * its own work.
 */
export function canWriteLineItemNote(args: {
  companyId: string;
  role: MembershipRole;
  edge: EngagementEdge;
  providerHasNotes: boolean;
  clientCanComment: boolean;
}): boolean {
  if (!args.providerHasNotes) return false;
  if (!isEngagementParticipant(args.companyId, args.edge)) return false;
  if (args.role === 'MEMBER') return false;
  return isEngagementClientSide(args.companyId, args.edge)
    ? args.clientCanComment
    : true;
}

/**
 * A note's body belongs to whoever wrote it; `resolved` is a shared workflow flag
 * either side may toggle. Split so the route can allow a resolve without allowing
 * an edit of someone else's words.
 */
export function canEditLineItemNoteBody(userId: string, note: { authorUserId: string }): boolean {
  return userId === note.authorUserId;
}

export function canResolveLineItemNote(companyId: string, edge: EngagementEdge): boolean {
  return isEngagementParticipant(companyId, edge);
}

// ── Placeholder → real company merge (owner decision, 2026-08-17) ──────────────

/**
 * Decide what accepting an ENGAGEMENT/CLIENT_PORTAL invite should do with the
 * placeholder company the inviter created as a stand-in.
 *
 * Auto-merge is the owner's chosen policy, but it must never be *destructive*:
 * the DB holds `unique (client_company_id, provider_company_id)` on engagements,
 * `unique (project_id, provider_company_id)` on assignments and a
 * `client <> provider` check. When re-pointing would trip any of those, two real
 * histories are being asked to occupy one slot — merging would have to discard
 * one. We decline and claim the placeholder instead, so nothing is lost and the
 * conflict is visible in the response and the audit trail.
 *
 * Pure so every branch is unit-testable; the caller supplies the collision facts.
 */
export function decideMerge(args: {
  /** The invitee's existing real company, if we could identify exactly one. */
  targetCompanyId: string | null;
  placeholderCompanyId: string;
  /** The other endpoint of the edge being accepted. */
  counterpartyCompanyId: string;
  /** An edge between counterparty and target already exists. */
  edgeExists: boolean;
  /** The target is already assigned to a project the placeholder is on. */
  assignmentClash: boolean;
}): { outcome: 'CLAIMED' | 'MERGED' | 'SKIPPED'; reason: string | null } {
  if (args.targetCompanyId === null) {
    return { outcome: 'CLAIMED', reason: null };
  }
  if (args.targetCompanyId === args.placeholderCompanyId) {
    return { outcome: 'CLAIMED', reason: null };
  }
  if (args.targetCompanyId === args.counterpartyCompanyId) {
    return { outcome: 'SKIPPED', reason: 'A company cannot engage itself' };
  }
  if (args.edgeExists) {
    return {
      outcome: 'SKIPPED',
      reason: 'An engagement between these two companies already exists',
    };
  }
  if (args.assignmentClash) {
    return {
      outcome: 'SKIPPED',
      reason: 'That company is already assigned to one of these projects',
    };
  }
  return { outcome: 'MERGED', reason: null };
}
