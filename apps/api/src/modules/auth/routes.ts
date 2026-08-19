import { Router } from 'express';
import {
  googleRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  requestPasswordResetRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import {
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  verifyEmail,
} from './accountService';
import { googleConfigured } from './google';
import { AppError } from '../../http/errors';
import {
  enforceAuthRateLimit,
  evaluateAuthRateLimit,
  lockoutIsNotifiable,
  recordAuthAttempt,
} from './rateLimit';
import { notifyLockout } from './lockoutNotice';
import { login, loginWithGoogle, logout, refresh, register } from './service';

export const authRouter = Router();

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const input = registerRequestSchema.parse(req.body);
    // Source-keyed only: there is no account yet to key an identity budget to,
    // and keying on the requested address would let somebody reserve an address
    // by failing at it (`AUTH_RATE_POLICIES.REGISTER`).
    const limit = await enforceAuthRateLimit(req, 'REGISTER', null);
    try {
      const result = await register(input);
      await recordAuthAttempt(limit, true);
      await sendVerificationEmail(result.user.id, result.user.email);
      res.status(201).json(result);
    } catch (err) {
      await recordAuthAttempt(limit, false);
      throw err;
    }
  })
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = loginRequestSchema.parse(req.body);
    // Enforced *before* `login()` so an attacker with a word list cannot make the
    // server run bcrypt tens of thousands of times. A limiter checked after the
    // comparison would still burn the CPU it exists to protect.
    const limit = await enforceAuthRateLimit(req, 'LOGIN', input.email);
    try {
      const result = await login(input);
      await recordAuthAttempt(limit, true);
      res.json(result);
    } catch (err) {
      await recordAuthAttempt(limit, false);
      // Re-read the budget *without* enforcing: this failure may be the one that
      // exhausted it. Asking the enforcing version here would record a second
      // attempt and count every failure twice, halving the real limit.
      //
      // Naturally once per lockout — the next attempt is refused at the gate
      // above and never reaches this line. An alert per attempt would turn the
      // sign-in form into a mail bomb aimed at any address an attacker picks.
      const after = await evaluateAuthRateLimit(req, 'LOGIN', input.email);
      if (lockoutIsNotifiable(after)) await notifyLockout(input.email);
      throw err;
    }
  })
);

authRouter.post(
  '/google',
  asyncHandler(async (req, res) => {
    if (!googleConfigured()) {
      throw new AppError('VALIDATION', 'Google sign-in is not configured on this server');
    }
    const input = googleRequestSchema.parse(req.body);
    res.json(await loginWithGoogle(input));
  })
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshRequestSchema.parse(req.body);
    res.json(await refresh(refreshToken));
  })
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const { refreshToken } = logoutRequestSchema.parse(req.body);
    await logout(refreshToken);
    res.status(204).end();
  })
);

authRouter.post(
  '/request-password-reset',
  asyncHandler(async (req, res) => {
    const { email } = requestPasswordResetRequestSchema.parse(req.body);
    // The abuse here is mail-bombing an inbox rather than guessing a secret, so
    // this is the one scope whose identity budget protects the *recipient*.
    // Counted as a "failure" unconditionally: every request sends mail, so every
    // request has to consume budget, or the limit only bites on addresses that
    // do not exist.
    const limit = await enforceAuthRateLimit(req, 'RESET', email);
    await requestPasswordReset(email);
    await recordAuthAttempt(limit, false);
    // Always 202 — never reveal whether the account exists.
    res.status(202).json({ ok: true });
  })
);

authRouter.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const { token, password } = resetPasswordRequestSchema.parse(req.body);
    await resetPassword(token, password);
    res.json({ ok: true });
  })
);

authRouter.post(
  '/verify-email',
  asyncHandler(async (req, res) => {
    const { token } = verifyEmailRequestSchema.parse(req.body);
    await verifyEmail(token);
    res.json({ ok: true });
  })
);
