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
