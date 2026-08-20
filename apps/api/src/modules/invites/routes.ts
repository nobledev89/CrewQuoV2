import { Router } from 'express';
import type { AcceptInviteResponse, MergeOutcome, MembershipRole } from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { AppError, TokenRejected } from '../../http/errors';
import { param } from '../../http/params';
import { requireAuth } from '../../http/middleware/auth';
import { withTransaction } from '../../db';
import { findUserById } from '../users/repo';
import { findMembership, insertMembership } from '../memberships/repo';
import { findEngagementEdge, updateEngagementStatus } from '../engagements/repo';
import { applyMerge, planMerge } from '../companies/merge';
import { markCompanyClaimed } from '../companies/repo';
import { findInviteRowByToken, findInviteView, markInviteAccepted } from './repo';
import { recordAudit } from '../audit/record';

/**
 * Invite accept flow (CREWQUO_V2_PLAN.md §3.6, §7). GET is public (renders the
 * landing page); accept requires the invitee to be signed in and matches their
 * email to the invite.
 *
 *   MEMBER         → joins the inviting company at the invited role.
 *   ENGAGEMENT     → the invitee is the subcontractor; the placeholder standing in
 *                    for them sits on the provider side of the edge.
 *   CLIENT_PORTAL  → the invitee is the client; their placeholder sits on the
 *                    client side, and accepting gives them the portal.
 *
 * For both edge kinds the placeholder is auto-merged into the invitee's existing
 * company when they already have one (owner decision, 2026-08-17) — see
 * `companies/merge.ts` for the one case that declines rather than lose data.
 */

export const invitesRouter = Router();

// GET /v1/invites/:token — public invite details.
invitesRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const invite = await findInviteView(param(req, 'token'));
    if (!invite) throw new AppError('NOT_FOUND', 'Invite not found');
    res.json({ invite });
  })
);

// POST /v1/invites/:token/accept — requires auth (no X-Company-Id).
invitesRouter.post(
  '/:token/accept',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const user = await findUserById(ctx.userId);
    if (!user) throw new TokenRejected('Account no longer exists');

    const invite = await findInviteRowByToken(param(req, 'token'));
    if (!invite) throw new AppError('NOT_FOUND', 'Invite not found');
    if (invite.status !== 'PENDING') throw new AppError('CONFLICT', 'Invite is no longer pending');
    if (invite.expires_at.getTime() < Date.now()) {
      throw new AppError('CONFLICT', 'Invite has expired');
    }
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new AppError('FORBIDDEN', 'This invite was issued to a different email');
    }

    const isEdgeInvite = invite.kind === 'ENGAGEMENT' || invite.kind === 'CLIENT_PORTAL';
    if (isEdgeInvite && !invite.engagement_id) {
      throw new AppError('VALIDATION', 'This invite is not attached to an engagement');
    }

    // Accepting an edge invite makes you the owner of the company it stands for.
    const role: MembershipRole = isEdgeInvite ? 'OWNER' : invite.role ?? 'MEMBER';

    const existing = await findMembership(user.id, invite.target_company_id);
    if (existing) {
      await markInviteAccepted(invite.id);
      const body: AcceptInviteResponse = {
        companyId: invite.target_company_id,
        role: existing.role,
      };
      res.json(body);
      return;
    }

    if (!isEdgeInvite) {
      await withTransaction(async (client) => {
        await insertMembership(
          { userId: user.id, companyId: invite.target_company_id, role },
          client
        );
        await markInviteAccepted(invite.id, client);
      });
      await recordAudit({
        companyId: invite.target_company_id,
        actorUserId: user.id,
        action: 'invite.accepted',
        entityType: 'INVITE',
        entityId: invite.id,
        changes: { kind: invite.kind, role },
        description: `${user.name} joined as ${role}`,
      });
      const body: AcceptInviteResponse = { companyId: invite.target_company_id, role };
      res.status(201).json(body);
      return;
    }

    // ── Edge invite: activate the engagement, then claim or merge ──────────────
    const edge = await findEngagementEdge(invite.engagement_id!);
    if (!edge) throw new AppError('VALIDATION', 'The engagement no longer exists');

    const placeholderId = invite.target_company_id;
    const placeholderIsProvider = edge.provider_company_id === placeholderId;
    if (!placeholderIsProvider && edge.client_company_id !== placeholderId) {
      throw new AppError('VALIDATION', 'This invite does not match its engagement');
    }
    const counterpartyCompanyId = placeholderIsProvider
      ? edge.client_company_id
      : edge.provider_company_id;

    const plan = await planMerge({
      userId: user.id,
      placeholderCompanyId: placeholderId,
      counterpartyCompanyId,
      placeholderIsProvider,
      preferredCompanyId: ctx.companyId,
    });

    const merged = plan.outcome === 'MERGED' && plan.targetCompanyId !== null;
    const joinedCompanyId = merged ? plan.targetCompanyId! : placeholderId;

    await withTransaction(async (client) => {
      if (merged) {
        await applyMerge(
          {
            placeholderCompanyId: placeholderId,
            targetCompanyId: plan.targetCompanyId!,
            engagementId: invite.engagement_id!,
            placeholderIsProvider,
          },
          client
        );
      } else {
        // CLAIMED: the invitee had no company of their own, so the stub becomes
        // theirs — and stops being a stub. See `markCompanyClaimed`.
        await insertMembership({ userId: user.id, companyId: placeholderId, role }, client);
        await markCompanyClaimed(placeholderId, client);
      }
      await updateEngagementStatus(invite.engagement_id!, 'ACTIVE', client);
      await markInviteAccepted(invite.id, client);
    });

    const membership = merged ? await findMembership(user.id, joinedCompanyId) : null;
    const finalRole: MembershipRole = merged ? membership?.role ?? 'OWNER' : role;

    await recordAudit({
      companyId: joinedCompanyId,
      actorUserId: user.id,
      action: 'invite.accepted',
      entityType: 'INVITE',
      entityId: invite.id,
      changes: { kind: invite.kind, role: finalRole, merge: plan.outcome },
      description: `${user.name} accepted an invitation`,
    });
    if (merged) {
      await recordAudit({
        companyId: joinedCompanyId,
        actorUserId: user.id,
        action: 'company.merged',
        entityType: 'COMPANY',
        entityId: placeholderId,
        changes: { placeholderCompanyId: placeholderId, mergedInto: joinedCompanyId },
        description: 'A placeholder company was merged into this one',
      });
    }

    const merge: MergeOutcome = {
      outcome: plan.outcome,
      placeholderCompanyId: placeholderId,
      mergedIntoCompanyId: merged ? plan.targetCompanyId : null,
      reason: plan.reason,
    };
    const body: AcceptInviteResponse = { companyId: joinedCompanyId, role: finalRole, merge };
    res.status(201).json(body);
  })
);
