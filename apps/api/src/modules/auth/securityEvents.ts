import { randomUUID } from 'node:crypto';
import { withTransaction, type Queryable } from '../../db';
import { recordPlatformAudit } from '../admin/platform.repo';
import { enqueueOutboxEvent } from '../delivery/repo';
import { revokeAllSessions, revokeSession } from './sessions.repo';

/**
 * The security events of the access domain, and what each one costs the holder.
 * Operating-model packet: `docs/operating-model/access.md` §5, §6.
 *
 * **Everything here is durable, and nothing here is fire-and-forget.** Each event
 * writes three things in one transaction: the state change, the insert-only
 * platform-audit row, and an outbox event that becomes the holder's notification.
 * If any of the three fails, none of them happened — because a session revoked
 * with nobody told, or a holder told about a revocation that did not commit, are
 * both worse than the failure.
 *
 * The alternative — sending the email inline from the request — is what 0016 did
 * for lockouts, and it loses the alert whenever the provider blips. For a reuse
 * alarm that is the *only* warning a victim gets, that is not an acceptable
 * failure mode, so it goes through `delivery_outbox` and gets the same retries,
 * dead-lettering and evidence as everything else.
 */

/**
 * A retired refresh token came back. Revoke the family and tell the holder.
 *
 * The audit row is written whichever way this goes, because "a token from this
 * family was replayed" is the fact an incident is reconstructed from later, and it
 * must survive both the notification failing and the tenant's audit retention
 * expiring — `platform_audit_logs` is insert-only and outside every purge.
 *
 * **The idempotency key is the session**, so a family raises exactly one alarm
 * however many times its retired tokens are presented. It cannot in practice
 * happen twice — once the session is revoked, every later presentation classifies
 * as `DEAD` — but a key that would allow it is a key that eventually does.
 */
export async function reportTokenReuse(input: {
  userId: string;
  sessionId: string;
  deviceLabel: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    const ended = await revokeSession(
      input.sessionId,
      input.userId,
      { cause: 'TOKEN_REUSE' },
      client
    );

    await recordPlatformAudit(
      {
        actorUserId: null,
        action: 'auth.token_reuse',
        entityType: 'USER',
        entityId: input.userId,
        changes: {
          sessionId: input.sessionId,
          sessionsEnded: ended,
          // The device that presented the retired token — which is the thief's, if
          // there is one, and the single most useful line in the record.
          presentedBy: input.deviceLabel,
        },
        description: 'A retired refresh token was presented; the session family was revoked',
      },
      client
    );

    await enqueueOutboxEvent(
      {
        topic: 'auth.token_reuse',
        aggregateType: 'AUTH_SESSION',
        aggregateId: input.sessionId,
        companyId: null,
        payload: { recipientUserId: input.userId, deviceLabel: input.deviceLabel },
        idempotencyKey: `auth.token_reuse:${input.sessionId}`,
      },
      client
    );
  });
}

/**
 * A super admin ends every session a user has (§4, §13.2).
 *
 * The narrow, recorded, notified path the packet chose over the two it rejected —
 * impersonation, and a per-tenant operator read. **It grants the operator nothing:**
 * ending somebody's sessions is the one thing platform staff can do to a customer
 * account, and it takes access away rather than granting any.
 *
 * Three conditions, all of them non-negotiable and all of them in one transaction:
 * a stated reason, an unconditional notification to the holder, and a
 * platform-audit row. This lived in `platform.repo` before this slice and did the
 * first and third; the holder was never told, which made a legitimate support
 * action indistinguishable from a compromise for the person it happened to.
 */
export async function revokeSessionsAsOperator(input: {
  actorUserId: string;
  userId: string;
  reason: string;
}): Promise<number> {
  return withTransaction(async (client) => {
    const ended = await revokeAllSessions(
      input.userId,
      { cause: 'OPERATOR', reason: input.reason, revokedByUserId: input.actorUserId },
      client
    );

    await recordPlatformAudit(
      {
        actorUserId: input.actorUserId,
        action: 'user.sessions_revoked',
        entityType: 'USER',
        entityId: input.userId,
        changes: { revoked: ended, reason: input.reason },
        description: 'Active sessions were revoked by a super admin',
      },
      client
    );

    // Told even when nothing was live. "An operator acted on your account" is the
    // fact worth knowing, and it is exactly as true when the account happened to
    // have no session open at the time.
    await emitSessionsRevokedByOperator(client, { userId: input.userId, sessionsEnded: ended });
    return ended;
  });
}

/**
 * The notification half, separated so it commits with whatever revoked the
 * sessions.
 *
 * **The aggregate id is a fresh uuid, not the user id**, and that is the difference
 * between a working alert and a silent one. The notification's dedupe key is
 * `<topic>:<aggregateId>:<recipient>`, so keying on the user would make the
 * *second* revocation of the same account, months later, deduplicate against the
 * first and never reach them. A new id per action keeps the replay protection
 * (which only ever needs to dedupe retries of one enqueue) and drops the accidental
 * lifetime uniqueness.
 */
async function emitSessionsRevokedByOperator(
  client: Queryable,
  input: { userId: string; sessionsEnded: number }
): Promise<void> {
  const occurrence = randomUUID();
  await enqueueOutboxEvent(
    {
      topic: 'auth.session_revoked',
      aggregateType: 'AUTH_SESSION',
      aggregateId: occurrence,
      companyId: null,
      payload: {
        recipientUserId: input.userId,
        sessionsEnded: input.sessionsEnded,
        // Deliberately neither the reason nor the operator's identity. The reason
        // is their stated justification, it lives in `platform_audit_logs` as
        // evidence, and it is not a message to the customer — internal support
        // notes rendered into somebody else's inbox would be a private field with
        // a public reader. Naming the individual operator adds nothing the holder
        // can act on and a target they can aim at.
        byOperator: true,
      },
      idempotencyKey: `auth.session_revoked:${occurrence}`,
    },
    client
  );
}
