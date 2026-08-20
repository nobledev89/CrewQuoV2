import { randomUUID } from 'node:crypto';
import {
  TOTP_PERIOD_SECONDS,
  mfaIsRequired,
  totpUri,
  type MfaStatus,
} from '@crewquo/shared';
import { withTransaction, type Queryable } from '../../db';
import { AppError } from '../../http/errors';
import { recordPlatformAudit } from '../admin/platform.repo';
import { enqueueOutboxEvent } from '../delivery/repo';
import { findUserById } from '../users/repo';
import {
  activateFactor,
  beginEnrolment,
  countRecoveryCodes,
  factorState,
  findFactor,
  issueRecoveryCodes,
  removeFactor,
  verifyCode,
} from './mfa.repo';
import { revokeAllSessions } from './sessions.repo';

/**
 * Second factors: enrolment, confirmation, removal and the operator reset.
 * Operating-model packet: `docs/operating-model/access.md` §3, §4, §13.2.
 *
 * **Every state change here notifies the holder, unconditionally and durably.** The
 * reason is one sentence long: if it was not you who added, removed or reset the
 * factor on your account, that email is the only warning you get. So each mutation
 * commits its row, its platform-audit line and its outbox event together, exactly
 * as the session events do — and the notification kinds are marked
 * `unconditional`, so a preference switched off six months ago cannot silence them.
 */

const CHALLENGE_TTL_SECONDS = 5 * 60;

/** How long a challenge lives, exported so the login route and its test agree. */
export const MFA_CHALLENGE_TTL_SECONDS = CHALLENGE_TTL_SECONDS;

export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const [user, factor] = await Promise.all([findUserById(userId), findFactor(userId)]);
  if (!user) throw new AppError('NOT_FOUND', 'User not found');
  return {
    state: factorState(factor),
    required: mfaIsRequired({ isSuperAdmin: user.is_super_admin }),
    confirmedAt: factor?.confirmed_at?.toISOString() ?? null,
    recoveryCodesRemaining: await countRecoveryCodes(userId),
  };
}

/**
 * Start enrolment: issue a secret, return it once, and store it as `PENDING`.
 *
 * **Refuses when a factor is already `ACTIVE`.** Enrolment asks for no step-up —
 * adding protection is never the dangerous direction — so if it could overwrite a
 * confirmed factor, it would be a way for somebody holding a stolen access token to
 * swap your authenticator app for theirs without proving anything. Replacing a live
 * factor goes through removal, which does require step-up.
 */
export async function startMfaEnrolment(
  userId: string
): Promise<{ secret: string; uri: string }> {
  const user = await findUserById(userId);
  if (!user) throw new AppError('NOT_FOUND', 'User not found');

  const issued = await beginEnrolment(userId);
  if (!issued) {
    throw new AppError(
      'CONFLICT',
      'This account already has an authenticator app. Remove it before setting up a new one.'
    );
  }
  return {
    secret: issued.secret,
    uri: totpUri({ issuer: 'CrewQuo', account: user.email, secretBase32: issued.secret }),
  };
}

/**
 * Confirm enrolment with a real code, and hand back the recovery codes.
 *
 * **The codes are minted here rather than at enrolment**, and the ordering is the
 * point: codes handed over beside the QR are codes for a factor that may never
 * exist, and people save them anyway — so the set that matters would be the one for
 * an enrolment that was abandoned. Shown exactly once, and never again.
 */
export async function confirmMfaEnrolment(
  userId: string,
  code: string
): Promise<{ codes: string[] }> {
  const factor = await findFactor(userId);
  if (!factor) {
    throw new AppError('CONFLICT', 'Start setting up an authenticator app first');
  }
  if (factor.status === 'ACTIVE') {
    throw new AppError('CONFLICT', 'This account already has a confirmed authenticator app');
  }

  const verdict = await verifyCode(factor, code);
  if (verdict !== 'OK') {
    // `REPLAY` cannot reach this line in practice — a pending factor has consumed
    // no counter — so both non-OK answers are the same mistake to the person
    // typing: the app and the server disagree, usually because the clock does.
    throw new AppError('VALIDATION', 'That code did not match. Check your app and try again.');
  }

  await withTransaction(async (client) => {
    await activateFactor(factor.id, client);
    await recordFactorEvent(client, {
      userId,
      topic: 'auth.mfa_enrolled',
      action: 'auth.mfa_enrolled',
      description: 'A second factor was enrolled and confirmed',
      actorUserId: userId,
    });
  });

  // Minted outside the transaction on purpose: the codes are the one thing that cannot be
  // re-derived, so they are written after the factor is definitely active rather
  // than rolled back alongside it. A failure here leaves a working factor with no
  // recovery codes, which the status endpoint reports and the screen offers to fix
  // — the opposite ordering leaves codes for a factor that is not active.
  return { codes: await issueRecoveryCodes(userId) };
}

/** Regenerate the set, invalidating every previous code. */
export async function regenerateRecoveryCodes(userId: string): Promise<{ codes: string[] }> {
  const factor = await findFactor(userId);
  if (!factor || factor.status !== 'ACTIVE') {
    throw new AppError('CONFLICT', 'Set up an authenticator app before generating recovery codes');
  }
  return { codes: await issueRecoveryCodes(userId) };
}

/**
 * Remove the factor. The caller has already passed step-up re-authentication.
 *
 * Sessions are deliberately **not** revoked: the person doing this has just proven
 * who they are, and signing them out of every device as a reward for changing their
 * own security settings is the sort of behaviour that teaches people not to touch
 * them.
 */
export async function removeMfa(userId: string): Promise<void> {
  const factor = await findFactor(userId);
  if (!factor) throw new AppError('NOT_FOUND', 'This account has no authenticator app');

  await withTransaction(async (client) => {
    await removeFactor(userId, client);
    await recordFactorEvent(client, {
      userId,
      topic: 'auth.mfa_removed',
      action: 'auth.mfa_removed',
      description: 'A second factor was removed by the account holder',
      actorUserId: userId,
    });
  });
}

/**
 * A super admin resets somebody's lost factor (§13.2).
 *
 * The path the packet chose over "genuinely unrecoverable", with its cost stated
 * rather than hidden: **this makes the operator the weakest link**, which is
 * exactly why the same operators are the ones under a mandatory factor themselves,
 * and why this is counted as a metric. The alternative was worse in practice — a
 * lost phone destroying a company owner's access to their own books, and the
 * realistic outcome being somebody doing it directly against the database, unlogged.
 *
 * **Every session goes with it.** The factor is being removed without the holder
 * present, so any session still alive is one the reset cannot vouch for; the
 * holder signs in again and re-enrols. That is also what makes this useless as an
 * access path: it takes access away and grants the operator none.
 */
export async function resetMfaAsOperator(input: {
  actorUserId: string;
  userId: string;
  reason: string;
}): Promise<{ removed: number; sessionsEnded: number }> {
  const target = await findUserById(input.userId);
  if (!target) throw new AppError('NOT_FOUND', 'User not found');

  return withTransaction(async (client) => {
    const removed = await removeFactor(input.userId, client);
    const sessionsEnded = await revokeAllSessions(
      input.userId,
      { cause: 'OPERATOR', reason: input.reason, revokedByUserId: input.actorUserId },
      client
    );
    await recordPlatformAudit(
      {
        actorUserId: input.actorUserId,
        action: 'auth.mfa_reset_by_operator',
        entityType: 'USER',
        entityId: input.userId,
        changes: { factorsRemoved: removed, sessionsEnded, reason: input.reason },
        description: 'A second factor was reset by a super admin',
      },
      client
    );
    await enqueueFactorNotification(client, {
      userId: input.userId,
      topic: 'auth.mfa_reset_by_operator',
    });
    return { removed, sessionsEnded };
  });
}

/**
 * One place that writes the audit row and the notification for a factor change.
 *
 * Both or neither, in the caller's transaction. A factor change nobody was told
 * about is the failure this domain is most concerned with, and a notification for a
 * change that rolled back is the same failure pointing the other way.
 */
async function recordFactorEvent(
  client: Queryable,
  input: {
    userId: string;
    topic: 'auth.mfa_enrolled' | 'auth.mfa_removed';
    action: string;
    description: string;
    actorUserId: string | null;
  }
): Promise<void> {
  await recordPlatformAudit(
    {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'USER',
      entityId: input.userId,
      changes: {},
      description: input.description,
    },
    client
  );
  await enqueueFactorNotification(client, { userId: input.userId, topic: input.topic });
}

/**
 * The outbox event that becomes the holder's email.
 *
 * **The aggregate id is per-occurrence, not the user**, for the reason 0018 wrote
 * down: the notification dedupe key is `<topic>:<aggregate>:<recipient>`, so keying
 * on the user would make the *second* enrolment on an account deduplicate against
 * the first and never be mentioned. Enrol, remove, re-enrol is an ordinary sequence
 * and all three have to arrive.
 */
async function enqueueFactorNotification(
  client: Queryable,
  input: { userId: string; topic: string }
): Promise<void> {
  const occurrence = randomUUID();
  await enqueueOutboxEvent(
    {
      topic: input.topic,
      aggregateType: 'AUTH_FACTOR',
      // The occurrence, not the user. `delivery_outbox.aggregate_id` is text, and
      // the handler passes this straight into the notification's dedupe key — so a
      // per-user value would make enrol → remove → re-enrol, an entirely ordinary
      // sequence, silently deliver only its first step. The *subject* is still the
      // user; the two are separate inputs for exactly this reason.
      aggregateId: occurrence,
      companyId: null,
      payload: { recipientUserId: input.userId },
      idempotencyKey: `${input.topic}:${occurrence}`,
    },
    client
  );
}

/** Seconds a code stays valid, for a screen that wants to say so. */
export const MFA_CODE_PERIOD_SECONDS = TOTP_PERIOD_SECONDS;
