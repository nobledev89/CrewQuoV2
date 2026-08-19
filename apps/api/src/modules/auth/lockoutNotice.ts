import { env } from '../../env';
import { recordPlatformAudit } from '../admin/platform.repo';
import { sendEmail } from '../notifications/channels';
import { findUserByEmail } from '../users/repo';

/**
 * Tell somebody their account was locked out by failed sign-ins.
 * Operating-model packet: `docs/operating-model/access.md` §6.
 *
 * **Only ever called once per lockout window.** The caller reaches this line only
 * on the attempt that exhausts the budget; every later attempt is refused at the
 * gate. That matters more than it looks: an email per failed attempt turns the
 * sign-in form into a mail bomb aimed at whatever address an attacker types, which
 * is a worse hole than the one being closed.
 */

/**
 * **In-product delivery is missing here, and that is a schema fact rather than an
 * oversight.** `notifications.company_id` is `not null`, so the inbox can only hold
 * something that belongs to a company — and a lockout belongs to a *person*. Their
 * account may span several companies or none at all.
 *
 * Picking one of their companies to hang it on would put a security alert in a
 * tenant's audit-visible inbox and imply the event happened there, which is false
 * and leaks between tenants. So this slice sends the email and records the
 * platform-side evidence, and the account-scoped inbox arrives with the MFA slice,
 * where the rest of this domain's notification kinds land together and the column
 * can be widened once for all of them rather than bent here for one.
 */
export async function notifyLockout(email: string): Promise<void> {
  const user = await findUserByEmail(email);

  // The audit row is written whether or not an account exists, because "somebody
  // burned a budget against this address" is exactly as interesting when the
  // address is fictional — that is what enumeration looks like from the inside.
  await recordPlatformAudit({
    actorUserId: null,
    action: 'auth.lockout',
    entityType: 'USER',
    entityId: user?.id ?? null,
    changes: { scope: 'LOGIN', accountExists: Boolean(user) },
    description: 'Sign-in attempts for an address were rate-limited',
  });

  // No account, nothing to warn. Sending anyway would confirm to whoever asked
  // that the address is not registered — the same oracle the sign-in path itself
  // refuses to be.
  if (!user) return;

  if (env.NODE_ENV !== 'production') {
    console.log(`[auth] lockout notice for ${email}`);
  }

  const outcome = await sendEmail({
    recipientEmail: user.email,
    recipientName: user.name,
    title: 'Too many sign-in attempts on your CrewQuo account',
    body:
      'Someone made repeated failed sign-in attempts on your account, so we have ' +
      'paused sign-in for a short time. If that was you, nothing is wrong — try ' +
      'again shortly. If it was not, change your password: whoever it was does not ' +
      'have it yet.',
    actionUrl: '/reset-password',
  });
  if (outcome.status === 'failed') {
    console.error(`[auth] lockout notice to ${user.email} failed: ${outcome.error}`);
  }
}
