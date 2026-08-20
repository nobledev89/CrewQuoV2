import { AppError } from '../../http/errors';
import { findUserById } from '../users/repo';
import { verifyGoogleIdToken } from './google';
import { verifyPassword } from './passwords';

/**
 * Step-up re-authentication — proving a human is still at the keyboard.
 * Operating-model packet: `docs/operating-model/access.md` §4.
 *
 * **Extracted rather than copied.** This was written for §3.1.1(7)'s "recent
 * authentication" on additional-company requests and lived inside that router;
 * removing a second factor needs exactly the same proof, and two copies of an
 * authentication check are two things that drift — the Google arm gets fixed in one
 * and not the other, and nobody notices until an account with no password cannot
 * remove its own factor.
 *
 * The reasoning it carries over: an access token is re-minted by refresh without
 * anybody re-proving anything, so its age is not evidence of a recent human.
 * Re-entry is. A Google-only account has no password hash, which is why the
 * ID-token arm exists rather than being an alternative offered for convenience.
 */
export async function requireStepUpAuth(
  userId: string,
  input: { password?: string; googleIdToken?: string },
  /** What the caller is about to do, so the refusal names it. */
  intent = 'continue'
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw new AppError('NOT_FOUND', 'User not found');

  if (input.password && user.password_hash) {
    if (await verifyPassword(input.password, user.password_hash)) return;
    throw new AppError('UNAUTHENTICATED', 'That password was not correct');
  }

  if (input.googleIdToken) {
    const identity = await verifyGoogleIdToken(input.googleIdToken);
    if (identity.googleSub && identity.googleSub === user.google_sub) return;
    throw new AppError('UNAUTHENTICATED', 'That Google account does not match this login');
  }

  throw new AppError(
    'VALIDATION',
    user.password_hash
      ? `Confirm your password to ${intent}`
      : `Confirm your Google sign-in to ${intent}`
  );
}
