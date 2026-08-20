import { Router, type Request } from 'express';
import {
  deviceLabelFromUserAgent,
  googleRequestSchema,
  mfaChallengeAnswerSchema,
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
import {
  completeChallenge,
  login,
  loginWithGoogle,
  logout,
  refresh,
  register,
  userIdFromChallenge,
} from './service';
import { findFactor, spendRecoveryCode, verifyCode } from './mfa.repo';

export const authRouter = Router();

/**
 * What this request is willing to say about the device it came from.
 *
 * The User-Agent and nothing else — see `deviceLabelFromUserAgent` for why the
 * label is coarse, and the packet's §7 for why there is no address here. A caller
 * that sends no recognisable User-Agent gets a null label and a device list entry
 * that honestly says "Unknown device".
 */
function origin(req: Request): { deviceLabel: string | null } {
  return { deviceLabel: deviceLabelFromUserAgent(req.header('user-agent')) };
}

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const input = registerRequestSchema.parse(req.body);
    // Source-keyed only: there is no account yet to key an identity budget to,
    // and keying on the requested address would let somebody reserve an address
    // by failing at it (`AUTH_RATE_POLICIES.REGISTER`).
    const limit = await enforceAuthRateLimit(req, 'REGISTER', null);
    try {
      const result = await register(input, origin(req));
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
      const result = await login(input, origin(req));
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

/**
 * POST /v1/auth/mfa — answer a sign-in challenge with a code or a recovery code.
 *
 * **Rate-limited under its own budget, keyed on the account the challenge names.**
 * A six-digit code is a million possibilities with about three valid at any moment,
 * so an unlimited guesser reaches even odds in minutes of scripted traffic. The
 * login budget does not cover this: the password has already been accepted and this
 * is a different endpoint with a challenge the attacker legitimately holds.
 *
 * The refusal says the same thing for a wrong code, a spent code, an expired
 * challenge and a replayed one. Distinguishing them would tell whoever is guessing
 * which of their assumptions was right — and "that code was already used" in
 * particular confirms they are watching somebody's real session.
 */
authRouter.post(
  '/mfa',
  asyncHandler(async (req, res) => {
    const input = mfaChallengeAnswerSchema.parse(req.body);

    // The challenge is verified first, and only to learn whose budget to spend. A
    // limiter keyed on something the caller controls is a limiter an attacker
    // sidesteps by varying it.
    let userId: string;
    try {
      userId = userIdFromChallenge(input.challengeToken);
    } catch {
      throw new AppError('UNAUTHENTICATED', 'That sign-in attempt expired. Start again.');
    }

    const limit = await enforceAuthRateLimit(req, 'MFA', userId);
    const factor = await findFactor(userId);
    if (!factor || factor.status !== 'ACTIVE') {
      // The factor went away between the two steps — removed on another device, or
      // reset by an operator. Nothing to check, so nothing to accept.
      await recordAuthAttempt(limit, false);
      throw new AppError('UNAUTHENTICATED', 'That sign-in attempt expired. Start again.');
    }

    const verdict = input.recoveryCode
      ? await spendRecoveryCode(userId, input.recoveryCode)
      : await verifyCode(factor, input.code ?? '');

    if (verdict !== 'OK') {
      await recordAuthAttempt(limit, false);
      /*
       * **A spent code gets its own sentence, and that is a deliberate exception to
       * "one message for every failure".**
       *
       * The generic refusal is right for a wrong code: telling a guesser which of
       * their assumptions was wrong is free help. A *replay* is different in both
       * directions. What it leaks is that a guessed code was valid and is now
       * spent — worth nothing to somebody who cannot use it — and what it costs to
       * hide is real: the person in front of the screen is holding a correct code,
       * has no way to know it was already used, retypes it, and spends their ten
       * attempts on the only code their app will show them for the next thirty
       * seconds. The fix they need is "wait", and no generic message says that.
       *
       * Counted against the budget either way. A replay is still a failed attempt,
       * and ten of them is a generous allowance for a mistake with an obvious remedy.
       */
      throw new AppError(
        'UNAUTHENTICATED',
        verdict === 'REPLAY'
          ? input.recoveryCode
            ? 'That recovery code has already been used. Try another one from your list.'
            : 'That code has already been used. Wait for your app to show the next one.'
          : 'That code did not match. Try again.'
      );
    }

    await recordAuthAttempt(limit, true);
    res.json(await completeChallenge(input.challengeToken, origin(req)));
  })
);

authRouter.post(
  '/google',
  asyncHandler(async (req, res) => {
    if (!googleConfigured()) {
      throw new AppError('VALIDATION', 'Google sign-in is not configured on this server');
    }
    const input = googleRequestSchema.parse(req.body);
    res.json(await loginWithGoogle(input, origin(req)));
  })
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshRequestSchema.parse(req.body);
    // The origin is passed for the *failure* path as much as the success one: a
    // reuse alarm names the device that presented the retired token, which is the
    // thief's if there is one and the most useful line in the record.
    res.json(await refresh(refreshToken, origin(req)));
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
