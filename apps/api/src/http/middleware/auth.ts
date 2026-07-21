import type { RequestHandler } from 'express';
import type { MembershipRole } from '@crewquo/shared';
import { AppError } from '../errors';
import { getCompanyCtx, type Ctx } from '../context';
import { verifyAccessToken } from '../../modules/auth/tokens';
import { findUserById } from '../../modules/users/repo';
import { findMembership } from '../../modules/memberships/repo';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/**
 * Resolve the auth context once (§4). Verifies the access token, loads the user,
 * and — if an X-Company-Id header is present — validates it against an ACTIVE
 * membership. Cross-tenant access is impossible: the role comes from the DB, not
 * the token.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = bearer(req.header('authorization'));
    if (!token) throw new AppError('UNAUTHENTICATED', 'Missing bearer token');

    const claims = verifyAccessToken(token);
    const user = await findUserById(claims.sub);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Account no longer exists');

    const ctx: Ctx = {
      userId: user.id,
      companyId: null,
      role: null,
      isSuperAdmin: user.is_super_admin,
    };

    const requestedCompany = req.header('x-company-id');
    if (requestedCompany) {
      if (!UUID_RE.test(requestedCompany)) {
        throw new AppError('VALIDATION', 'X-Company-Id must be a UUID');
      }
      const membership = await findMembership(user.id, requestedCompany);
      if (!membership || membership.status !== 'ACTIVE') {
        throw new AppError('FORBIDDEN', 'You are not an active member of that company');
      }
      ctx.companyId = membership.company_id;
      ctx.role = membership.role;
    }

    req.ctx = ctx;
    next();
  } catch (err) {
    next(err);
  }
};

/** Require the active company role to be one of `roles`. Assumes requireAuth ran. */
export function requireRole(...roles: MembershipRole[]): RequestHandler {
  return (req, _res, next) => {
    try {
      const ctx = getCompanyCtx(req);
      if (!roles.includes(ctx.role)) {
        throw new AppError('FORBIDDEN', `Requires role: ${roles.join(', ')}`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Require platform staff (super-admin console only, §5B). */
export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  try {
    if (!req.ctx) throw new AppError('UNAUTHENTICATED', 'Authentication required');
    if (!req.ctx.isSuperAdmin) throw new AppError('FORBIDDEN', 'Super-admin only');
    next();
  } catch (err) {
    next(err);
  }
};
