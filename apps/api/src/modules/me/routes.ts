import { Router } from 'express';
import {
  createCompanyRequestSchema,
  resolveWorkspaceViews,
  updateMeSchema,
  type MeResponse,
  type MembershipsResponse,
  type WorkspacesResponse,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { findUserById, toPublicUser, updateUserProfile } from '../users/repo';
import { listMembershipSummaries } from '../memberships/repo';
import { toCompanySummary } from '../companies/repo';
import { createCompanyForUser } from '../company-creation/service';
import { recordAudit } from '../audit/record';
import { resolveEntitlements } from '../entitlements/cache';
import { listWorkspaceFacts } from './workspaces.repo';

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

// GET /v1/me/workspaces — every valid company/view entry for the combined switcher.
meRouter.get(
  '/workspaces',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const facts = await listWorkspaceFacts(ctx.userId);
    const workspaces = await Promise.all(
      facts.map(async (row) => {
        const entitlements = await resolveEntitlements(row.companyId);
        return {
          companyId: row.companyId,
          companyName: row.companyName,
          currency: row.currency,
          role: row.role,
          views: resolveWorkspaceViews({
            // Effective feature overrides count: an explicitly enabled operational
            // capability should not leave its company trapped in Account setup.
            operationsEntitled:
              entitlements.operatesDownstream || entitlements.features.length > 0,
            hasProviderRelationship: row.hasProviderRelationship,
            hasAssignedWork: row.hasAssignedWork,
            hasClientRelationship: row.hasClientRelationship,
            hasPortalProject: row.hasPortalProject,
          }),
        };
      })
    );
    const body: WorkspacesResponse = { workspaces };
    res.json(body);
  })
);

/**
 * POST /v1/me/companies — create a company; the caller becomes OWNER.
 *
 * One endpoint, two authorities (§3.1.1): the once-per-identity automatic
 * allowance, and an `APPROVED` additional-company request. Which one applies is
 * the server's decision, resolved in `company-creation/service` — a first-time
 * creator never learns the second concept exists, and a second-time creator
 * cannot avoid it.
 *
 * `201` when this call created the company; `200` when an idempotent retry found
 * the one an earlier call already made, so a dropped response is not a second
 * tenant.
 */
meRouter.post(
  '/companies',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const input = createCompanyRequestSchema.parse(req.body);
    const user = await findUserById(ctx.userId);
    if (!user) throw new AppError('NOT_FOUND', 'User not found');

    const result = await createCompanyForUser({
      userId: ctx.userId,
      isSuperAdmin: ctx.isSuperAdmin,
      emailVerified: user.email_verified_at !== null,
      body: input,
    });

    res.status(result.created ? 201 : 200).json({
      company: toCompanySummary(result.company),
      path: result.path,
      requestId: result.requestId,
    });
  })
);
