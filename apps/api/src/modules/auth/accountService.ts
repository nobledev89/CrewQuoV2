import { env } from '../../env';
import { sendEmail } from '../notifications/channels';
import { findUserByEmail, markEmailVerified, updatePasswordHash } from '../users/repo';
import { hashPassword } from './passwords';
import { revokeAllSessions } from './sessions.repo';
import { signPurposeToken, verifyPurposeToken } from './tokens';

const RESET_TTL_SECONDS = 60 * 60; // 1 hour
const VERIFY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Deliver an account link through the same adapter notifications use, so there is
 * one email path in the codebase rather than two that drift.
 *
 * **Deliberately not routed through the notification tables.** A password reset
 * belongs to a *user*, not to a company, and it must work for somebody who cannot
 * sign in — so it has no inbox row, no preferences and no quiet hours. Holding a
 * reset link until 07:00 because somebody set quiet hours would be an outage
 * dressed up as a feature. It shares the transport and nothing else.
 *
 * Fire-and-forget on purpose: `requestPasswordReset` must resolve identically
 * whether or not the account exists (see below), so it cannot wait on a provider
 * call whose timing would leak the answer.
 */
function deliverLink(kind: string, email: string, url: string): void {
  if (env.NODE_ENV !== 'production') {
    console.log(`[auth] ${kind} link for ${email}: ${url}`);
  }
  void sendEmail({
    recipientEmail: email,
    recipientName: null,
    title: kind === 'password-reset' ? 'Reset your CrewQuo password' : 'Verify your CrewQuo email',
    body:
      kind === 'password-reset'
        ? 'Use the link below to choose a new password. It expires in one hour.'
        : 'Use the link below to confirm your email address. It expires in 24 hours.',
    actionUrl: url,
  }).then((outcome) => {
    if (outcome.status === 'failed') {
      console.error(`[auth] ${kind} email to ${email} failed: ${outcome.error}`);
    }
  });
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
  /*
   * Every session ends, on every device, and the cause is recorded as the reset
   * rather than left blank.
   *
   * That distinction is what the device list needs afterwards: a person who resets
   * their password *because* they suspect somebody else has it opens this screen
   * next, and "ended by the password reset" is the row that tells them the thing
   * they hoped for actually happened. A revocation with no cause reads like
   * something unexplained, which is precisely the wrong feeling on that screen.
   */
  await revokeAllSessions(userId, { cause: 'PASSWORD_RESET' });
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
