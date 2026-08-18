import { z } from 'zod';
import { membershipSummarySchema } from './auth';

/**
 * Customer-facing navigation perspectives (§9.2). These are deliberately not
 * membership roles and are never authorization input.
 */
export const WORKSPACE_VIEWS = ['OPERATIONS', 'SUBCONTRACTOR', 'CLIENT'] as const;
export const workspaceViewSchema = z.enum(WORKSPACE_VIEWS);
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

/** One canonical post-auth/view-switch destination decision for every client. */
export function resolveLandingRoute(input: {
  view?: WorkspaceView | null;
  isSuperAdmin?: boolean;
  requestedPath?: string | null;
}): string {
  const requested = input.requestedPath;
  // A single leading slash is an internal path. Reject protocol-relative URLs
  // and backslashes so an auth `next` value cannot become an open redirect.
  if (requested?.startsWith('/') && !requested.startsWith('//') && !requested.includes('\\')) {
    return requested;
  }
  if (input.isSuperAdmin) return '/admin';
  if (input.view === 'SUBCONTRACTOR') return '/work';
  if (input.view === 'CLIENT') return '/portal';
  if (input.view === 'OPERATIONS') return '/app';
  return '/profile';
}

export interface WorkspaceEligibilityFacts {
  operationsEntitled: boolean;
  hasProviderRelationship: boolean;
  hasAssignedWork: boolean;
  hasClientRelationship: boolean;
  hasPortalProject: boolean;
}

/** Stable order is also the default-selection priority in the web shell. */
export function resolveWorkspaceViews(facts: WorkspaceEligibilityFacts): WorkspaceView[] {
  const views: WorkspaceView[] = [];
  if (facts.operationsEntitled) views.push('OPERATIONS');
  if (facts.hasProviderRelationship || facts.hasAssignedWork) views.push('SUBCONTRACTOR');
  if (facts.hasClientRelationship || facts.hasPortalProject) views.push('CLIENT');
  return views;
}

export const companyWorkspaceSchema = membershipSummarySchema.extend({
  views: z.array(workspaceViewSchema),
});
export type CompanyWorkspace = z.infer<typeof companyWorkspaceSchema>;

/** GET /v1/me/workspaces — all valid company/view switcher entries. */
export const workspacesResponseSchema = z.object({
  workspaces: z.array(companyWorkspaceSchema),
});
export type WorkspacesResponse = z.infer<typeof workspacesResponseSchema>;

/**
 * Select a valid lens without treating it as permission. The route wins only when
 * that view is eligible; otherwise current/device preferences fall back safely.
 */
export function resolveSelectedWorkspaceView(
  eligible: WorkspaceView[],
  allowedForRoute: readonly WorkspaceView[] | null,
  current: WorkspaceView | null,
  stored: WorkspaceView | null
): WorkspaceView | null {
  const eligibleForRoute = allowedForRoute
    ? eligible.filter((view) => allowedForRoute.includes(view))
    : eligible;
  const candidates = eligibleForRoute.length > 0 ? eligibleForRoute : eligible;
  if (current && candidates.includes(current)) return current;
  if (stored && candidates.includes(stored)) return stored;
  if (candidates.length > 0) return candidates[0] ?? null;
  return eligible[0] ?? null;
}
