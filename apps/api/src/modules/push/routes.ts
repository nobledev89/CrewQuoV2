import { Router } from 'express';
import { registerPushTokenSchema } from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { upsertPushToken } from './repo';

/** Device push-token registration (§3.4). Auth only — no active company needed. */
export const pushRouter = Router();

pushRouter.post(
  '/tokens',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const input = registerPushTokenSchema.parse(req.body);
    await upsertPushToken(ctx.userId, input.token, input.platform ?? null);
    res.status(204).end();
  })
);
