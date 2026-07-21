import { env } from '../../env';
import { findUserByEmail, markEmailVerified, updatePasswordHash } from '../users/repo';
import { hashPassword } from './passwords';
import { revokeAllRefreshTokens } from './refreshTokens';
import { signPurposeToken, verifyPurposeToken } from './tokens';

const RESET_TTL_SECONDS = 60 * 60; // 1 hour
const VERIFY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Deliver a link. Email (Resend) lands in Phase 5 (§5); until then we log the
 * link in non-production so the flow is testable end to end.
 */
function deliverLink(kind: string, email: string, url: string): void {
  if (env.NODE_ENV !== 'production') {
    console.log(`[auth] ${kind} link for ${email}: ${url}`);
  }
  // TODO(Phase 5): send via Resend.
}

/** Always resolves the same way — never reveal whether the account exists. */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (user && user.password_hash) {
    const token = signPurposeToken(user.id, 'password_reset', RESET_TTL_SECONDS);
    deliverLink('password-reset', email, `${env.APP_BASE_URL}/reset-password?token=${token}`);
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const userId = verifyPurposeToken(token, 'password_reset');
  const passwordHash = await hashPassword(newPassword);
  await updatePasswordHash(userId, passwordHash);
  // Invalidate existing sessions after a password change.
  await revokeAllRefreshTokens(userId);
}

export async function verifyEmail(token: string): Promise<void> {
  const userId = verifyPurposeToken(token, 'email_verify');
  await markEmailVerified(userId);
}

/** Issue a verification link for a freshly-registered user (called from routes). */
export async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  const token = signPurposeToken(userId, 'email_verify', VERIFY_TTL_SECONDS);
  deliverLink('verify-email', email, `${env.APP_BASE_URL}/verify-email?token=${token}`);
}
