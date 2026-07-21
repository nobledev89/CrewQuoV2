import type { RequestHandler } from 'express';
import type { FeatureKey, LimitKey } from '@crewquo/shared';
import { AppError } from '../../http/errors';
import { getCompanyCtx } from '../../http/context';
import { resolveEntitlements } from './cache';
import { getUsage } from './usage';

/** Does the company's plan (± overrides) enable this feature? */
export async function hasFeature(companyId: string, key: FeatureKey): Promise<boolean> {
  const ent = await resolveEntitlements(companyId);
  return ent.features.includes(key);
}

/** Read straight from the active plan (§5B): can this company add subcontractors? */
export async function operatesDownstream(companyId: string): Promise<boolean> {
  const ent = await resolveEntitlements(companyId);
  return ent.operatesDownstream;
}

/**
 * Would the company still be within `key` after adding `projected` more? A null
 * limit is unlimited. Checked at mutation time (§5B).
 */
export async function withinLimit(
  companyId: string,
  key: LimitKey,
  projected = 1
): Promise<boolean> {
  const ent = await resolveEntitlements(companyId);
  const limit = ent.limits[key];
  if (limit === undefined || limit === null) return true; // unlimited / unset
  const used = await getUsage(companyId, key);
  return used + projected <= limit;
}

/** Throwing variant for use in services. */
export async function assertWithinLimit(
  companyId: string,
  key: LimitKey,
  projected = 1
): Promise<void> {
  if (!(await withinLimit(companyId, key, projected))) {
    throw new AppError('LIMIT_EXCEEDED', `Plan limit reached for ${key}`, { limit: key });
  }
}

/** Route guard: 403 unless the active company's plan enables `key`. */
export function requireFeature(key: FeatureKey): RequestHandler {
  return async (req, _res, next) => {
    try {
      const ctx = getCompanyCtx(req);
      if (!(await hasFeature(ctx.companyId, key))) {
        throw new AppError('FORBIDDEN', `Your plan does not include: ${key}`, { feature: key });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
