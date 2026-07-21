import { Router } from 'express';
import {
  createCompanyRequestSchema,
  type MeResponse,
  type MembershipsResponse,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTransaction } from '../../db';
import { findUserById, toPublicUser } from '../users/repo';
import { insertMembership, listMembershipSummaries } from '../memberships/repo';
import { insertCompany, toCompanySummary } from '../companies/repo';

export const meRouter = Router();

// GET /v1/me — the authenticated profile.
meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const user = await findUserById(ctx.userId);
    if (!user) throw new AppError('NOT_FOUND', 'User not found');
    const body: MeResponse = { user: toPublicUser(user) };
    res.json(body);
  })
);

// GET /v1/me/memberships — company switcher source.
meRouter.get(
  '/memberships',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const memberships = await listMembershipSummaries(ctx.userId);
    const body: MembershipsResponse = { memberships };
    res.json(body);
  })
);

// POST /v1/me/companies — create a company; the caller becomes OWNER.
meRouter.post(
  '/companies',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const input = createCompanyRequestSchema.parse(req.body);

    const company = await withTransaction(async (client) => {
      const created = await insertCompany({ name: input.name, currency: input.currency }, client);
      await insertMembership({ userId: ctx.userId, companyId: created.id, role: 'OWNER' }, client);
      return created;
    });

    res.status(201).json({ company: toCompanySummary(company) });
  })
);
