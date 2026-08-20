import { Router } from 'express';
import {
  mfaConfirmSchema,
  mfaRemoveSchema,
  type MfaEnrolment,
  type MfaRecoveryCodes,
  type MfaStatus,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import {
  confirmMfaEnrolment,
  mfaStatus,
  regenerateRecoveryCodes,
  removeMfa,
  startMfaEnrolment,
} from './mfa.service';
import { requireStepUpAuth } from './stepUp';

/**
 * The account holder's own second factor (`access.md` §4).
 *
 * Mounted under `/v1/me`, like sessions, because a factor belongs to a person
 * rather than to a company — and, like sessions, **no entitlement key gates any of
 * it**. Selling a security floor as a plan feature would make the cheapest tenant
 * the softest target on a platform where every tenant shares one database.
 *
 * **Adding is unguarded; removing needs step-up.** Friction on adding protection is
 * how you end up with people who never turn it on, and removal is the first thing
 * somebody holding a stolen access token would reach for.
 */
export const mfaRouter = Router();

// GET /v1/me/mfa — what this account holds, and whether it is required to.
mfaRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const body: MfaStatus = await mfaStatus(getCtx(req).userId);
    res.json(body);
  })
);

/**
 * POST /v1/me/mfa — begin enrolment.
 *
 * The response carries the secret, and this is the only time anything ever will.
 * There is no endpoint that reads it back: a screen that wants one is a bug in the
 * request rather than a missing feature (§2).
 */
mfaRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body: MfaEnrolment = await startMfaEnrolment(getCtx(req).userId);
    res.status(201).json(body);
  })
);

/**
 * POST /v1/me/mfa/confirm — prove the app works, and get the recovery codes.
 *
 * Not rate-limited under the `MFA` budget, deliberately: this path is reached by
 * somebody already holding a valid access token for the account they are securing,
 * so a guessing attack here is an attacker guessing at a factor they are in the
 * middle of installing for themselves. The budget exists for the *sign-in*
 * challenge, where the guesser has a password and needs a code.
 */
mfaRouter.post(
  '/confirm',
  asyncHandler(async (req, res) => {
    const { code } = mfaConfirmSchema.parse(req.body);
    const body: MfaRecoveryCodes = await confirmMfaEnrolment(getCtx(req).userId, code);
    res.json(body);
  })
);

/** POST /v1/me/mfa/recovery-codes — regenerate, invalidating every previous code. */
mfaRouter.post(
  '/recovery-codes',
  asyncHandler(async (req, res) => {
    const body: MfaRecoveryCodes = await regenerateRecoveryCodes(getCtx(req).userId);
    res.json(body);
  })
);

/** DELETE /v1/me/mfa — remove the factor, after re-proving who is asking. */
mfaRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const input = mfaRemoveSchema.parse(req.body ?? {});
    await requireStepUpAuth(ctx.userId, input, 'remove your authenticator app');
    await removeMfa(ctx.userId);
    res.status(204).end();
  })
);
