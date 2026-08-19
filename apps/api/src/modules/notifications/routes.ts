import { Router } from 'express';
import {
  listNotificationsQuerySchema,
  notificationActionSchema,
  notificationTransitionRefusal,
  updateNotificationPreferencesSchema,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import {
  countOpenActions,
  getNotification,
  getNotificationPreferences,
  listNotifications,
  transitionNotification,
  upsertNotificationPreferences,
} from './repo';

/**
 * `/v1/notifications` — the inbox, and the Action Centre as its actionable subset.
 * Operating-model packet: `docs/operating-model/notifications.md`.
 *
 * The rules that shape every handler here:
 *
 *  - **The caller is the only recipient there is.** No role reads another user's
 *    inbox and none ever will; a notification id that is not yours is a 404, the
 *    same answer a forged one gets. That is why `getNotification` takes the user
 *    id rather than checking ownership afterwards — there is no code path that
 *    loads the row first and decides later.
 *  - **No entitlement gate, and §43 adds no key.** A Crew-plan subcontractor still
 *    has to find out their hours were rejected. Gating that would make the free
 *    tier quietly broken rather than merely limited.
 *  - **Preferences are not company-scoped**, so they hang off the plain auth
 *    context: a person has one set of quiet hours, not one per company they
 *    happen to belong to.
 */

export const notificationsRouter = Router();
export const notificationPreferencesRouter = Router();

notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const filter = listNotificationsQuerySchema.parse(req.query);
    const { data, nextBefore } = await listNotifications(ctx.userId, ctx.companyId, filter);
    res.json({ data, nextBefore });
  })
);

/** The badge. Separate from the list so a header does not fetch fifty rows. */
notificationsRouter.get(
  '/open-count',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ openCount: await countOpenActions(ctx.userId, ctx.companyId) });
  })
);

notificationsRouter.post(
  '/:id/actions',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { verb } = notificationActionSchema.parse(req.body);

    const existing = await getNotification(id, ctx.userId);
    if (!existing) throw new AppError('NOT_FOUND', 'Notification not found');

    const refusal = notificationTransitionRefusal(
      {
        requiresAction: existing.requiresAction,
        readAt: existing.readAt,
        resolvedAt: existing.resolvedAt,
        dismissedAt: existing.dismissedAt,
      },
      verb
    );
    // A replayed offline action is a no-op, not an error: the repo's `where … is
    // null` already makes the write idempotent, so re-resolving what this caller
    // already resolved returns the row rather than a conflict. Only a genuine
    // contradiction — resolving something dismissed, or a notice that was never a
    // task — is refused.
    if (refusal && !(verb === 'resolve' && existing.resolvedAt)) {
      throw new AppError('CONFLICT', refusal);
    }

    await transitionNotification({ id, recipientUserId: ctx.userId, verb });
    res.json({ notification: await getNotification(id, ctx.userId) });
  })
);

notificationPreferencesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    res.json({ preferences: await getNotificationPreferences(ctx.userId) });
  })
);

notificationPreferencesRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const patch = updateNotificationPreferencesSchema.parse(req.body);
    res.json({ preferences: await upsertNotificationPreferences(ctx.userId, patch) });
  })
);
