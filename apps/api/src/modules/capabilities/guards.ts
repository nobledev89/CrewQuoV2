import type { RequestHandler } from 'express';
import type { CapabilityKey } from '@crewquo/shared';
import { AppError } from '../../http/errors';
import { getCompanyCtx, type Ctx } from '../../http/context';
import { resolveOwnCapabilities } from './resolve';

/**
 * The capability half of a route's authorization (§37).
 *
 * **Both halves are required and neither substitutes for the other.** A route
 * asks `hasFeature(companyId, …)` — does the plan sell this? — *and*
 * `hasCapability(ctx, …)` — may this person do it? The two answer different
 * questions and a route that checks only one is a hole in whichever direction it
 * skipped.
 *
 * **A capability never widens company scope or the one-hop rule.** Those are
 * checked first, independently, in `policies.ts`, and this can only narrow what
 * they already allowed. Granting somebody `evidence.publish` does not let them
 * publish on a project belonging to a company they have no edge to — the
 * capability decides what a person may do *inside* a boundary that has already
 * been established, and it has no opinion about the boundary.
 */
export async function hasCapability(
  ctx: Ctx & { companyId: string },
  key: CapabilityKey
): Promise<boolean> {
  const capabilities = await resolveOwnCapabilities(ctx.userId, ctx.companyId);
  return capabilities.includes(key);
}

/** Throwing variant, for use inside a service rather than as middleware. */
export async function assertCapability(
  ctx: Ctx & { companyId: string },
  key: CapabilityKey
): Promise<void> {
  if (!(await hasCapability(ctx, key))) {
    throw new AppError('FORBIDDEN', `You do not have permission to: ${key}`, { capability: key });
  }
}

/**
 * Route guard: 403 unless the caller holds `key` in their active company.
 *
 * The refusal names the capability, which is a deliberate disclosure. It is a
 * fact about the caller's own membership, not about anybody else's data, and the
 * alternative — an unexplained 403 — sends somebody to support to ask a question
 * their own permissions screen can answer.
 */
export function requireCapability(key: CapabilityKey): RequestHandler {
  return async (req, _res, next) => {
    try {
      const ctx = getCompanyCtx(req);
      await assertCapability(ctx, key);
      next();
    } catch (err) {
      next(err);
    }
  };
}
