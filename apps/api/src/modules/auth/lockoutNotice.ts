import { lockoutWindowBucket } from '@crewquo/shared';
import { env } from '../../env';
import { recordPlatformAudit } from '../admin/platform.repo';
import { dispatchNotification } from '../notifications/dispatch';
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
 *
 * **The in-product row landed with 0018, which is what changed here.** The first
 * version of this file sent an email inline and said why the inbox half was
 * missing: `notifications.company_id` was `not null`, so the inbox could only hold
 * something belonging to a company, and a lockout belongs to a *person*. That
 * comment expected the column to be widened by the MFA slice; session lineage got
 * there first, because a detected token reuse and an operator revocation are the
 * same shape and needed it too. So this now goes through the ordinary notification
 * path — one durable row, and email with the retries and delivery evidence every
 * other notification gets, instead of a `void sendEmail(...)` whose failure left
 * no trace.
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

  await dispatchNotification({
    kind: 'auth.lockout',
    // Account-scoped: this happened to a person, not inside a tenant.
    companyId: null,
    recipientUserIds: [user.id],
    title: 'Too many sign-in attempts on your CrewQuo account',
    body:
      'Someone made repeated failed sign-in attempts on your account, so we have ' +
      'paused sign-in for a short time. If that was you, nothing is wrong — try ' +
      'again shortly. If it was not, change your password: whoever it was does not ' +
      'have it yet.',
    actionUrl: '/security',
    subjectType: 'USER',
    subjectId: user.id,
    topic: 'auth.lockout',
    // One notification per lockout window. There is no lockout *row* to key on —
    // the budget is a count over `auth_attempts`, not an entity — so the window
    // bucket is the identity. See `lockoutWindowBucket`.
    aggregateId: `${user.id}:${lockoutWindowBucket(Date.now())}`,
  });
}
