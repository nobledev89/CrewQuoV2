import { Router } from 'express';
import {
  createCompanyRequestSchema,
  updateMeSchema,
  type MeResponse,
  type MembershipsResponse,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTransaction } from '../../db';
import { findUserById, toPublicUser, updateUserProfile } from '../users/repo';
import { insertMembership, listMembershipSummaries } from '../memberships/repo';
import { insertCompany, toCompanySummary } from '../companies/repo';
import { recordAudit } from '../audit/record';

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

/**
 * PATCH /v1/me — the caller's own profile (name, avatar).
 *
 * Audited against every company the user is an active member of, because a
 * display name is what their counterparties and their own team see on approvals
 * and audit rows; a rename with no trace would make an old row read as somebody
 * else's. Email is not editable here — see `updateMeSchema`.
 */
meRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const patch = updateMeSchema.parse(req.body);

    const before = await findUserById(ctx.userId);
    if (!before) throw new AppError('NOT_FOUND', 'User not found');
    const user = await updateUserProfile(ctx.userId, patch);

    if (patch.name !== undefined && patch.name !== before.name) {
      for (const membership of await listMembershipSummaries(ctx.userId)) {
        await recordAudit({
          companyId: membership.companyId,
          actorUserId: ctx.userId,
          action: 'user.updated',
          entityType: 'USER',
          entityId: ctx.userId,
          changes: { name: { from: before.name, to: user.name } },
          description: `${before.name} is now shown as ${user.name}`,
        });
      }
    }

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
