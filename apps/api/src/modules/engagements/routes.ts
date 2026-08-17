import { Router } from 'express';
import {
  DEFAULT_CURRENCY,
  createClientSchema,
  createEngagementSchema,
  createProviderSchema,
  inviteMemberSchema,
  updateEngagementSchema,
  updateMemberSchema,
  type ClientView,
  type CreateClientResponse,
  type CreateProviderResponse,
  type ProviderView,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param, uuidParam } from '../../http/params';
import { requireRole } from '../../http/middleware/auth';
import { withTransaction } from '../../db';
import {
  canManage,
  isEngagementParticipant,
  membershipChangeRefusal,
  membershipRemovalRefusal,
} from '../../authorization/policies';
import { assertWithinLimit, hasFeature, operatesDownstream } from '../entitlements/guards';
import { findCompanyById, insertCompany } from '../companies/repo';
import {
  countActiveOwners,
  deleteMembership,
  findMembershipInCompany,
  listMembers,
  toMemberView,
  updateMembership,
} from '../memberships/repo';
import { insertInvite } from '../invites/repo';
import { recordAudit } from '../audit/record';
import {
  findEngagementEdge,
  getEngagementView,
  insertEngagement,
  listClients,
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
    const currency = input.currency ?? me?.currency ?? DEFAULT_CURRENCY;

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

// ── /v1/clients ──────────────────────────────────────────────────────────────────

export const clientsRouter = Router();

clientsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ data: await listClients(ctx.companyId) });
  })
);

/**
 * Create a client: placeholder company + engagement (active company = provider)
 * + CLIENT_PORTAL invite, atomically. The mirror of POST /v1/providers, and the
 * only origin of a CLIENT_PORTAL invite.
 *
 * Gated on `client_portal` rather than `operates_downstream`: adding a client is
 * about being *hired*, which every plan permits — but only a plan that sells a
 * portal has anywhere to send them. Meters against `clients` (§5B: real portal
 * logins are the billable ones).
 */
clientsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    if (!canManage(ctx.role)) throw new AppError('FORBIDDEN', 'Requires a manager role');
    const input = createClientSchema.parse(req.body);

    if (!(await hasFeature(ctx.companyId, 'client_portal'))) {
      throw new AppError('FORBIDDEN', 'Your plan does not include: client_portal', {
        feature: 'client_portal',
      });
    }
    await assertWithinLimit(ctx.companyId, 'clients');

    const me = await findCompanyById(ctx.companyId);
    const currency = input.currency ?? me?.currency ?? DEFAULT_CURRENCY;

    const { client: created, inviteToken } = await withTransaction(async (tx) => {
      const placeholder = await insertCompany(
        { name: input.name, currency, isPlaceholder: true },
        tx
      );
      const edge = await insertEngagement(
        {
          clientCompanyId: placeholder.id,
          providerCompanyId: ctx.companyId,
          createdByCompanyId: ctx.companyId,
          status: 'PENDING',
        },
        tx
      );
      const invite = await insertInvite(
        {
          kind: 'CLIENT_PORTAL',
          targetCompanyId: placeholder.id,
          email: input.email,
          engagementId: edge.id,
          invitedByUserId: ctx.userId,
        },
        tx
      );
      const view: ClientView = {
        engagementId: edge.id,
        clientCompanyId: placeholder.id,
        name: placeholder.name,
        currency: placeholder.currency,
        isPlaceholder: true,
        status: 'PENDING',
      };
      return { client: view, inviteToken: invite.invite_token };
    });

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'invite.created',
      entityType: 'INVITE',
      entityId: created.engagementId,
      changes: { kind: 'CLIENT_PORTAL', email: input.email },
      description: `Client "${input.name}" invited to the portal`,
    });

    const body: CreateClientResponse = { client: created, inviteToken };
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

/**
 * Change a member's role or status (§7). OWNER/ADMIN, with the two lock-out
 * invariants in `membershipChangeRefusal`: an admin never touches an owner or
 * mints one, and the company keeps at least one active owner.
 */
membersRouter.patch(
  '/:membershipId',
  requireRole('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const patch = updateMemberSchema.parse(req.body);
    const membershipId = uuidParam(req, 'membershipId');

    const target = await findMembershipInCompany(ctx.companyId, membershipId);
    if (!target) throw new AppError('NOT_FOUND', 'Member not found');

    const refusal = membershipChangeRefusal({
      actorRole: ctx.role,
      target: { userId: target.user_id, role: target.role, status: target.status },
      activeOwnerCount: await countActiveOwners(ctx.companyId),
      patch,
    });
    if (refusal) throw new AppError('FORBIDDEN', refusal);

    const updated = await updateMembership(membershipId, patch);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'membership.updated',
      entityType: 'MEMBERSHIP',
      entityId: membershipId,
      changes: {
        ...(patch.role !== undefined ? { role: { from: target.role, to: updated.role } } : {}),
        ...(patch.status !== undefined
          ? { status: { from: target.status, to: updated.status } }
          : {}),
      },
      description: `${target.user_name}'s membership was updated`,
    });

    res.json({
      member: toMemberView({ ...target, role: updated.role, status: updated.status }),
    });
  })
);

/**
 * Remove a member (§7). Distinct from suspending: this deletes the membership
 * row, which frees a seat and ends their access. Their work rows are untouched —
 * `time_logs.logged_by_user_id` references `users`, not the membership, so
 * history survives the person leaving.
 */
membersRouter.delete(
  '/:membershipId',
  requireRole('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const membershipId = uuidParam(req, 'membershipId');

    const target = await findMembershipInCompany(ctx.companyId, membershipId);
    if (!target) throw new AppError('NOT_FOUND', 'Member not found');

    const refusal = membershipRemovalRefusal({
      actorRole: ctx.role,
      target: { userId: target.user_id, role: target.role, status: target.status },
      activeOwnerCount: await countActiveOwners(ctx.companyId),
    });
    if (refusal) throw new AppError('FORBIDDEN', refusal);

    await deleteMembership(membershipId);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'membership.removed',
      entityType: 'MEMBERSHIP',
      entityId: membershipId,
      changes: { role: target.role, status: target.status },
      description: `${target.user_name} was removed from the company`,
    });
    res.status(204).end();
  })
);

function toEdge(edge: { client_company_id: string; provider_company_id: string }) {
  return { clientCompanyId: edge.client_company_id, providerCompanyId: edge.provider_company_id };
}
