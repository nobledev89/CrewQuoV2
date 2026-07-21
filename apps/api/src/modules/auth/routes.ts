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
import { login, loginWithGoogle, logout, refresh, register } from './service';

export const authRouter = Router();

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const input = registerRequestSchema.parse(req.body);
    const result = await register(input);
    await sendVerificationEmail(result.user.id, result.user.email);
    res.status(201).json(result);
  })
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = loginRequestSchema.parse(req.body);
    res.json(await login(input));
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
    await requestPasswordReset(email);
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
