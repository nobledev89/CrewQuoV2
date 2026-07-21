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
