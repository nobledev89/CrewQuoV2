import { Router } from 'express';
import {
  createEngagementSchema,
  createProviderSchema,
  inviteMemberSchema,
  updateEngagementSchema,
  type CreateProviderResponse,
  type ProviderView,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import { requireRole } from '../../http/middleware/auth';
import { withTransaction } from '../../db';
import { canManage, isEngagementParticipant } from '../../authorization/policies';
import { assertWithinLimit, operatesDownstream } from '../entitlements/guards';
import { findCompanyById, insertCompany } from '../companies/repo';
import { listMembers } from '../memberships/repo';
import { insertInvite } from '../invites/repo';
import { recordAudit } from '../audit/record';
import {
  findEngagementEdge,
  getEngagementView,
  insertEngagement,
  listEngagements,
  listProviders,
  updateEngagementStatus,
} from './repo';

// ── /v1/engagements ──────────────────────────────────────────────────────────────

export const engagementsRouter = Router();

engagementsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ data: await listEngagements(ctx.companyId) });
  })
);

engagementsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    if (!canManage(ctx.role)) throw new AppError('FORBIDDEN', 'Requires a manager role');
    const input = createEngagementSchema.parse(req.body);

    if (input.providerCompanyId === ctx.companyId) {
      throw new AppError('VALIDATION', 'A company cannot engage itself');
    }
    if (!(await operatesDownstream(ctx.companyId))) {
      throw new AppError('FORBIDDEN', 'Your plan cannot add subcontractors', {
        feature: 'operates_downstream',
      });
    }
    const provider = await findCompanyById(input.providerCompanyId);
    if (!provider) throw new AppError('VALIDATION', 'providerCompanyId not found');
    await assertWithinLimit(ctx.companyId, 'active_subcontractors');

    const edge = await insertEngagement({
      clientCompanyId: ctx.companyId,
      providerCompanyId: input.providerCompanyId,
      createdByCompanyId: ctx.companyId,
    }).catch((err: unknown) => {
      // The (client, provider) unique constraint → a friendly conflict.
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        throw new AppError('CONFLICT', 'An engagement with that provider already exists');
      }
      throw err;
    });

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'engagement.created',
      entityType: 'ENGAGEMENT',
      entityId: edge.id,
      description: `Engagement with ${provider.name} created`,
    });
    res.status(201).json({ engagement: await getEngagementView(edge.id, ctx.companyId) });
  })
);

engagementsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    if (!canManage(ctx.role)) throw new AppError('FORBIDDEN', 'Requires a manager role');
    const { status } = updateEngagementSchema.parse(req.body);

    const edge = await findEngagementEdge(param(req, 'id'));
    if (!edge || !isEngagementParticipant(ctx.companyId, toEdge(edge))) {
      throw new AppError('NOT_FOUND', 'Engagement not found');
    }
    await updateEngagementStatus(edge.id, status);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'engagement.updated',
      entityType: 'ENGAGEMENT',
      entityId: edge.id,
      changes: { status },
      description: `Engagement set to ${status}`,
    });
    res.json({ engagement: await getEngagementView(edge.id, ctx.companyId) });
  })
);

// ── /v1/providers ────────────────────────────────────────────────────────────────

export const providersRouter = Router();

providersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ data: await listProviders(ctx.companyId) });
  })
);

// Create a provider: placeholder company + engagement + ENGAGEMENT invite, atomically.
providersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    if (!canManage(ctx.role)) throw new AppError('FORBIDDEN', 'Requires a manager role');
    const input = createProviderSchema.parse(req.body);

    if (!(await operatesDownstream(ctx.companyId))) {
      throw new AppError('FORBIDDEN', 'Your plan cannot add subcontractors', {
        feature: 'operates_downstream',
      });
    }
    await assertWithinLimit(ctx.companyId, 'active_subcontractors');

    const me = await findCompanyById(ctx.companyId);
    const currency = input.currency ?? me?.currency ?? 'USD';

    const { provider, inviteToken } = await withTransaction(async (client) => {
      const placeholder = await insertCompany(
        { name: input.name, currency, isPlaceholder: true },
        client
      );
      const edge = await insertEngagement(
        {
          clientCompanyId: ctx.companyId,
          providerCompanyId: placeholder.id,
          createdByCompanyId: ctx.companyId,
          status: 'PENDING',
        },
        client
      );
      const invite = await insertInvite(
        {
          kind: 'ENGAGEMENT',
          targetCompanyId: placeholder.id,
          email: input.email,
          engagementId: edge.id,
          invitedByUserId: ctx.userId,
        },
        client
      );
      const view: ProviderView = {
        engagementId: edge.id,
        providerCompanyId: placeholder.id,
        name: placeholder.name,
        currency: placeholder.currency,
        isPlaceholder: true,
        status: 'PENDING',
      };
      return { provider: view, inviteToken: invite.invite_token };
    });

    // After commit — a failed audit write must not roll back the provider.
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'invite.created',
      entityType: 'INVITE',
      entityId: provider.engagementId,
      changes: { kind: 'ENGAGEMENT', email: input.email },
      description: `Provider "${input.name}" invited`,
    });

    const body: CreateProviderResponse = { provider, inviteToken };
    res.status(201).json(body);
  })
);

// ── /v1/members ──────────────────────────────────────────────────────────────────

export const membersRouter = Router();

membersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ data: await listMembers(ctx.companyId) });
  })
);

// Invite a member (MEMBER-kind invite). OWNER/ADMIN only; counts against internal_seats.
membersRouter.post(
  '/invite',
  requireRole('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = inviteMemberSchema.parse(req.body);
    await assertWithinLimit(ctx.companyId, 'internal_seats');
    const invite = await insertInvite({
      kind: 'MEMBER',
      targetCompanyId: ctx.companyId,
      email: input.email,
      role: input.role,
      invitedByUserId: ctx.userId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'invite.created',
      entityType: 'INVITE',
      entityId: invite.id,
      changes: { kind: 'MEMBER', email: input.email, role: input.role },
      description: `Member invited (${input.role})`,
    });
    res.status(201).json({ inviteToken: invite.invite_token });
  })
);

function toEdge(edge: { client_company_id: string; provider_company_id: string }) {
  return { clientCompanyId: edge.client_company_id, providerCompanyId: edge.provider_company_id };
}
