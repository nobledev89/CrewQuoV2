import { Router } from 'express';
import {
  updateMembershipCapabilitiesSchema,
  type CapabilityCatalog,
  type MembershipCapabilities,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { requireRole } from '../../http/middleware/auth';
import { withTransaction } from '../../db';
import { recordAudit } from '../audit/record';
import {
  bundleIsAvailable,
  findMembershipForCapabilities,
  loadBundles,
  loadCapabilityCatalog,
  replaceOverrides,
  setMembershipBundle,
} from './repo';
import { resolveMembershipCapabilities, resolveOwnCapabilities } from './resolve';

// ── /v1/capabilities ─────────────────────────────────────────────────────────

export const capabilitiesRouter = Router();

/**
 * The catalog, the bundles available to this company, and the caller's own
 * resolved set.
 *
 * `mine` is here rather than on a separate endpoint because a permissions screen
 * needs all three to render one sentence — "you have 14 of 29, through the
 * Supervisor bundle" — and three round trips to say it would be three chances
 * for the three answers to disagree.
 */
capabilitiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const [capabilities, bundles, mine] = await Promise.all([
      loadCapabilityCatalog(),
      loadBundles(ctx.companyId),
      resolveOwnCapabilities(ctx.userId, ctx.companyId),
    ]);
    const body: CapabilityCatalog = {
      capabilities,
      bundles: bundles.map((b) => ({
        key: b.key,
        name: b.name,
        description: b.description,
        isSystem: b.is_system,
        capabilities: b.capabilities,
      })),
      mine,
    };
    res.json(body);
  })
);

// ── /v1/members/:membershipId/capabilities ───────────────────────────────────

export const memberCapabilitiesRouter = Router();

/**
 * Read one member's effective capabilities.
 *
 * Any member of the company may read this, not only an admin. Who may do what is
 * not a secret from colleagues — it is the answer to "who can close the day if I
 * am not here", and hiding it produces the phone call the screen exists to
 * prevent. Editing it is another matter, below.
 */
memberCapabilitiesRouter.get(
  '/:membershipId/capabilities',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const membershipId = uuidParam(req, 'membershipId');
    const resolved = await resolveMembershipCapabilities(membershipId);
    // A membership in another company answers exactly as one that never existed.
    if (!resolved || resolved.companyId !== ctx.companyId) {
      throw new AppError('NOT_FOUND', 'Member not found');
    }
    res.json({ capabilities: toView(resolved) });
  })
);

/**
 * Assign a bundle and per-membership exceptions. OWNER/ADMIN.
 *
 * **An OWNER's membership is refused outright**, and the refusal says why. The
 * resolver already ignores both bundle and overrides for an owner (the lock-out
 * rule in `resolveCapabilities`), so accepting the write would store settings
 * that do nothing — which is worse than refusing, because the screen would then
 * show a restriction that is not in force.
 */
memberCapabilitiesRouter.patch(
  '/:membershipId/capabilities',
  requireRole('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const membershipId = uuidParam(req, 'membershipId');
    const patch = updateMembershipCapabilitiesSchema.parse(req.body);

    const target = await findMembershipForCapabilities(membershipId);
    if (!target || target.company_id !== ctx.companyId) {
      throw new AppError('NOT_FOUND', 'Member not found');
    }
    if (target.role === 'OWNER') {
      throw new AppError(
        'FORBIDDEN',
        "An owner always holds every capability. Change their role first if that is what you meant."
      );
    }
    if (patch.bundleKey != null && !(await bundleIsAvailable(patch.bundleKey, ctx.companyId))) {
      throw new AppError('VALIDATION', `Unknown capability bundle: ${patch.bundleKey}`);
    }

    const before = await resolveMembershipCapabilities(membershipId);

    await withTransaction(async (client) => {
      if (patch.bundleKey !== undefined) {
        await setMembershipBundle(membershipId, patch.bundleKey, client);
      }
      if (patch.overrides !== undefined) {
        await replaceOverrides(membershipId, patch.overrides, ctx.userId, client);
      }
    });

    const after = await resolveMembershipCapabilities(membershipId);
    if (!after) throw new AppError('NOT_FOUND', 'Member not found');

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'membership.capabilities_updated',
      entityType: 'MEMBERSHIP',
      entityId: membershipId,
      // The resolved sets, not the patch. What was sent is a bundle name and a
      // list of exceptions; what somebody reading this trail six months later
      // needs is what the person could actually do before and after.
      changes: {
        bundleKey: { from: before?.effectiveBundleKey ?? null, to: after.effectiveBundleKey },
        capabilities: { from: before?.capabilities ?? [], to: after.capabilities },
      },
      description: `Capabilities updated (${after.effectiveBundleKey})`,
    });

    res.json({ capabilities: toView(after) });
  })
);

function toView(resolved: MembershipCapabilities): MembershipCapabilities {
  return {
    membershipId: resolved.membershipId,
    role: resolved.role,
    bundleKey: resolved.bundleKey,
    effectiveBundleKey: resolved.effectiveBundleKey,
    bundleIsDerived: resolved.bundleIsDerived,
    overrides: resolved.overrides,
    capabilities: resolved.capabilities,
    locked: resolved.locked,
  };
}
