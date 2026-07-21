import { Router } from 'express';
import type { EntitlementsResponse } from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { resolveEntitlements } from './cache';
import { getAllUsage } from './usage';

export const entitlementsRouter = Router();

// GET /v1/entitlements — resolved entitlements + live usage for the active company.
entitlementsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const ent = await resolveEntitlements(ctx.companyId);
    const usage = await getAllUsage(ctx.companyId, ent.limits);
    const body: EntitlementsResponse = { ...ent, usage };
    res.json(body);
  })
);
