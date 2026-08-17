import { Router } from 'express';
import type { AcceptInviteResponse, MembershipRole } from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import { requireAuth } from '../../http/middleware/auth';
import { withTransaction } from '../../db';
import { findUserById } from '../users/repo';
import { findMembership, insertMembership } from '../memberships/repo';
import { updateEngagementStatus } from '../engagements/repo';
import { findInviteRowByToken, findInviteView, markInviteAccepted } from './repo';

/**
 * Invite accept flow (CREWQUO_V2_PLAN.md §3.6, §7). GET is public (renders the
 * landing page); accept requires the invitee to be signed in and matches their
 * email to the invite. MEMBER → joins the inviting company at the invited role;
 * ENGAGEMENT → becomes OWNER of the (placeholder) provider company and activates
 * the edge. Full placeholder→real merge is Phase 4.
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
    if (!user) throw new AppError('UNAUTHENTICATED', 'Account no longer exists');

    const invite = await findInviteRowByToken(param(req, 'token'));
    if (!invite) throw new AppError('NOT_FOUND', 'Invite not found');
    if (invite.status !== 'PENDING') throw new AppError('CONFLICT', 'Invite is no longer pending');
    if (invite.expires_at.getTime() < Date.now()) {
      throw new AppError('CONFLICT', 'Invite has expired');
    }
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new AppError('FORBIDDEN', 'This invite was issued to a different email');
    }
    if (invite.kind === 'CLIENT_PORTAL') {
      throw new AppError('VALIDATION', 'Client-portal invites arrive in Phase 4');
    }

    const role: MembershipRole = invite.kind === 'ENGAGEMENT' ? 'OWNER' : invite.role ?? 'MEMBER';

    const existing = await findMembership(user.id, invite.target_company_id);
    if (existing) {
      await markInviteAccepted(invite.id);
      const body: AcceptInviteResponse = { companyId: invite.target_company_id, role: existing.role };
      res.json(body);
      return;
    }

    await withTransaction(async (client) => {
      await insertMembership(
        { userId: user.id, companyId: invite.target_company_id, role },
        client
      );
      // An accepted ENGAGEMENT invite activates the pending edge.
      if (invite.kind === 'ENGAGEMENT' && invite.engagement_id) {
        await updateEngagementStatus(invite.engagement_id, 'ACTIVE', client);
      }
      await markInviteAccepted(invite.id, client);
    });

    const body: AcceptInviteResponse = { companyId: invite.target_company_id, role };
    res.status(201).json(body);
  })
);
