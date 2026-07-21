import { Router } from 'express';
import {
  adminPlanCreateSchema,
  adminPlanPriceSchema,
  adminPlanUpdateSchema,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import { clearEntitlementsCache } from '../entitlements/cache';
import {
  createPlan,
  getPlan,
  listFeatureCatalog,
  listLimitCatalog,
  listPlans,
  updatePlan,
  upsertPlanPrice,
} from './repo';

/**
 * Super-admin console API (§5B). Mounted behind requireAuth + requireSuperAdmin.
 * Every plan/price change clears the entitlement cache so gates re-resolve.
 */
export const adminRouter = Router();

adminRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    res.json({ plans: await listPlans() });
  })
);

adminRouter.post(
  '/plans',
  asyncHandler(async (req, res) => {
    const input = adminPlanCreateSchema.parse(req.body);
    const plan = await createPlan(input);
    clearEntitlementsCache();
    res.status(201).json({ plan });
  })
);

adminRouter.get(
  '/plans/:id',
  asyncHandler(async (req, res) => {
    const plan = await getPlan(param(req, 'id'));
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    res.json({ plan });
  })
);

adminRouter.patch(
  '/plans/:id',
  asyncHandler(async (req, res) => {
    const patch = adminPlanUpdateSchema.parse(req.body);
    const plan = await updatePlan(param(req, 'id'), patch);
    clearEntitlementsCache();
    res.json({ plan });
  })
);

adminRouter.post(
  '/plans/:id/prices',
  asyncHandler(async (req, res) => {
    const price = adminPlanPriceSchema.parse(req.body);
    const saved = await upsertPlanPrice(param(req, 'id'), price);
    clearEntitlementsCache();
    res.status(201).json({ price: saved });
  })
);

adminRouter.get(
  '/features',
  asyncHandler(async (_req, res) => {
    res.json({ features: await listFeatureCatalog() });
  })
);

adminRouter.get(
  '/limits',
  asyncHandler(async (_req, res) => {
    res.json({ limits: await listLimitCatalog() });
  })
);
