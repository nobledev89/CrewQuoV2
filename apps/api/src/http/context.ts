import type { Request } from 'express';
import type { MembershipRole } from '@crewquo/shared';
import { AppError } from './errors';

/**
 * The auth context resolved once per authenticated request (CREWQUO_V2_PLAN.md §4).
 * There is deliberately NO CLIENT/SUBCONTRACTOR role — those are engagement
 * positions resolved per-resource, never a user role.
 */
export interface Ctx {
  userId: string;
  companyId: string | null; // active company (null when the caller sent no X-Company-Id)
  role: MembershipRole | null; // role in the active company
  isSuperAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: Ctx;
    }
  }
}

/** Read the context set by `requireAuth`, or throw if the route is unguarded. */
export function getCtx(req: Request): Ctx {
  if (!req.ctx) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return req.ctx;
}

/** Read the context AND require an active company (X-Company-Id was provided). */
export function getCompanyCtx(req: Request): Ctx & { companyId: string; role: MembershipRole } {
  const ctx = getCtx(req);
  if (!ctx.companyId || !ctx.role) {
    throw new AppError('VALIDATION', 'X-Company-Id header is required for this request');
  }
  return { ...ctx, companyId: ctx.companyId, role: ctx.role };
}
