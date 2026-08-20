import type { RequestHandler } from 'express';
import type { MembershipRole } from '@crewquo/shared';
import { AppError, TokenRejected } from '../errors';
import { getCompanyCtx, type Ctx } from '../context';
import { verifyAccessToken } from '../../modules/auth/tokens';
import { findUserById } from '../../modules/users/repo';
import { sessionIsLive } from '../../modules/auth/sessions.repo';
import { factorState, findFactor } from '../../modules/auth/mfa.repo';
import { platformAccessRefusal } from '@crewquo/shared';
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
    if (!token) throw new TokenRejected('Missing bearer token');

    const claims = verifyAccessToken(token);

    /*
     * **The session is checked here, not left to the next refresh.**
     *
     * The packet's honest bound was that a revocation applies when the device is
     * next online (§8) — but for an *access* token that meant a device stayed
     * usable for the rest of its fifteen minutes after somebody hit "end this
     * device" on a phone they had just lost. One indexed read closes that, and it
     * costs nothing: it runs in parallel with the user lookup this middleware
     * already does on every request, so the added latency is zero and the added
     * load is one primary-key hit.
     *
     * The §8 caveat still stands and is not weakened: no server check can reach
     * data a stolen device has already cached offline. That needs device
     * encryption and a short cache window, not a promise the server cannot keep.
     *
     * A token with no `sid` skips the check because there is nothing to check —
     * see `AccessTokenClaims.sessionId` for why those tokens are honoured rather
     * than rejected.
     */
    const [user, sessionLive] = await Promise.all([
      findUserById(claims.sub),
      claims.sessionId ? sessionIsLive(claims.sessionId, claims.sub) : Promise.resolve(true),
    ]);
    if (!user) throw new TokenRejected('Account no longer exists');
    if (!sessionLive) throw new TokenRejected('This session has ended');

    const ctx: Ctx = {
      userId: user.id,
      companyId: null,
      role: null,
      isSuperAdmin: user.is_super_admin,
      sessionId: claims.sessionId ?? null,
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

/**
 * Require platform staff (super-admin console only, §5B) **holding a confirmed
 * second factor** (§13.1).
 *
 * The mandate is enforced here rather than at sign-in, which is the narrowest place
 * that achieves it. Blocking a staff *login* would lock an operator out of their own
 * customer-side account — many of them own a real company — over a rule that exists
 * to protect the platform console. Blocking the console puts the requirement exactly
 * where the blast radius is: one compromised staff password should not read every
 * tenant on the platform.
 *
 * The factor is read per request rather than trusted from a claim, for the same
 * reason the role is: a token minted before enrolment must not carry an answer that
 * outlives it, in either direction.
 */
export const requireSuperAdmin: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.ctx) throw new AppError('UNAUTHENTICATED', 'Authentication required');
    if (!req.ctx.isSuperAdmin) throw new AppError('FORBIDDEN', 'Super-admin only');

    const refusal = platformAccessRefusal({
      isSuperAdmin: req.ctx.isSuperAdmin,
      factorState: factorState(await findFactor(req.ctx.userId)),
    });
    // 403 with the sentence that says what to do. A staff member reading "forbidden"
    // on a console they used yesterday will file a bug; one reading "set up an
    // authenticator app" will set up an authenticator app.
    if (refusal) throw new AppError('FORBIDDEN', refusal);
    next();
  } catch (err) {
    next(err);
  }
};
