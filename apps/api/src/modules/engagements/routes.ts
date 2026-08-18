import { Router } from 'express';
import {
  DEFAULT_CURRENCY,
  acceptanceDecisionSchema,
  createClientSchema,
  createEngagementSchema,
  createProviderSchema,
  inviteMemberSchema,
  updateEngagementSchema,
  updateEngagementTermsSchema,
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
  canDecideAcceptance,
  canManage,
  canManageEngagementTerms,
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
import { recordRevision } from '../revisions/record';
import {
  decideEngagementAcceptance,
  getEngagementTerms,
  listCommittedInvoiceCents,
  updateEngagementTerms,
} from './terms.repo';
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
      // PENDING until the provider accepts (Phase 6 acceptance rules). This used to
      // be ACTIVE immediately, which let one company bind another to a commercial
      // relationship it had never agreed to. The placeholder/invite path below was
      // already PENDING-until-accepted, so the two paths now agree.
      status: 'PENDING',
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
      changes: { status: edge.status },
      description: `Engagement with ${provider.name} created, awaiting their acceptance`,
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

// ── Commercial terms + acceptance (Phase 6, §3.3.1 sibling rules) ────────────────

/** Load an edge the active company is an endpoint of, or 404 (never "not yours"). */
async function loadEngagementEdge(req: Parameters<typeof getCompanyCtx>[0], id: string) {
  const ctx = getCompanyCtx(req);
  const row = await findEngagementEdge(id);
  if (!row || !isEngagementParticipant(ctx.companyId, toEdge(row))) {
    throw new AppError('NOT_FOUND', 'Engagement not found');
  }
  return { ctx, row, edge: toEdge(row) };
}

/**
 * Payment terms, PO reference and PO ceiling — the hiring company's to set, because
 * it is the party that pays, holds the purchase order and carries the ceiling.
 *
 * Revision-tracked (§36) with an optional reason: these are commercial terms, and
 * "who changed the ceiling from £50k to £5k, and why" is a question that gets asked.
 */
engagementsRouter.patch(
  '/:id/terms',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const { ctx, edge } = await loadEngagementEdge(req, id);
    if (!canManageEngagementTerms(ctx.companyId, ctx.role, edge)) {
      throw new AppError(
        'FORBIDDEN',
        'Only a manager in the hiring company may set the commercial terms of an engagement'
      );
    }
    const patch = updateEngagementTermsSchema.parse(req.body);
    const before = await getEngagementTerms(id);
    if (!before) throw new AppError('NOT_FOUND', 'Engagement not found');

    const after = await updateEngagementTerms(id, patch);
    const snapshot = (terms: typeof after) => ({
      paymentTermsDays: terms.paymentTermsDays,
      purchaseOrderReference: terms.purchaseOrderReference,
      purchaseOrderCeilingCents: terms.purchaseOrderCeilingCents,
    });
    await recordRevision({
      companyId: ctx.companyId,
      entityType: 'engagement_terms',
      entityId: id,
      action: 'UPDATE',
      before: snapshot(before),
      after: snapshot(after),
      reason: patch.reason ?? null,
      changedByUserId: ctx.userId,
    });
    // Client-visible: the provider needs to know the terms it is working under, and
    // its own payment days and PO are not a secret from it.
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'engagement.terms_updated',
      entityType: 'ENGAGEMENT',
      entityId: id,
      changes: { before: snapshot(before), after: snapshot(after), reason: patch.reason ?? null },
      description: 'Engagement commercial terms updated',
      visibleToClient: true,
    });
    res.json({ terms: after });
  })
);

engagementsRouter.get(
  '/:id/terms',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    await loadEngagementEdge(req, id);
    const [terms, committedCents] = await Promise.all([
      getEngagementTerms(id),
      listCommittedInvoiceCents(id),
    ]);
    if (!terms) throw new AppError('NOT_FOUND', 'Engagement not found');
    res.json({ terms: { ...terms, committedCents } });
  })
);

/**
 * The provider accepts or declines an engagement it has been offered. Nobody
 * accepts on the provider's behalf — that is the entire point of the step.
 */
for (const [path, accept] of [
  ['/:id/accept', true],
  ['/:id/decline', false],
] as const) {
  engagementsRouter.post(
    path,
    asyncHandler(async (req, res) => {
      const id = uuidParam(req, 'id');
      const { ctx, edge } = await loadEngagementEdge(req, id);
      if (!canDecideAcceptance(ctx.companyId, ctx.role, edge)) {
        throw new AppError(
          'FORBIDDEN',
          'Only a manager in the provider company may accept or decline an engagement'
        );
      }
      const { reason } = acceptanceDecisionSchema.parse(req.body ?? {});
      const terms = await decideEngagementAcceptance({
        engagementId: id,
        accept,
        reason,
        actorUserId: ctx.userId,
      });
      await recordAudit({
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: accept ? 'engagement.accepted' : 'engagement.declined',
        entityType: 'ENGAGEMENT',
        entityId: id,
        changes: { status: terms.status, reason },
        description: accept ? 'Engagement accepted' : 'Engagement declined',
      });
      res.json({ engagement: await getEngagementView(id, ctx.companyId), terms });
    })
  );
}

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
