import type { NotificationDigest } from '@crewquo/shared';
import { deliveryFailureState } from '../delivery/model';
import { query, queryOne } from '../../db';
import {
  sendDigestEmail,
  sendEmail,
  sendPush,
  type ChannelOutcome,
  type PushMessage,
} from './channels';

/**
 * Drains `notification_deliveries` — the intrusive half of a notification, after
 * the in-product row has already been written and is already visible.
 *
 * This is a **second** claim loop rather than more work inside the outbox
 * handler, and that separation is the point: writing the inbox row must not be
 * held up by, or fail because of, an email provider. The outbox event is
 * delivered the moment the durable row exists; whether an email ever leaves is a
 * separate, separately-retryable question with its own history.
 *
 * Retry policy is `deliveryFailureState` — the same backoff and attempt budget
 * the outbox uses (0012), so there is one answer in the codebase to "how hard do
 * we try", not two that drift.
 *
 * **Digests are honoured here, not only at dispatch.** Holding six emails until
 * 10:00 and then sending six emails at 10:00 is a delay, not a digest: the
 * preference says *one send per window*. So a batch groups the due email of each
 * recipient who asked for one and sends a single message covering all of it.
 */

export interface DueRow {
  id: string;
  notification_id: string;
  channel: 'EMAIL' | 'PUSH';
  attempts: number;
  title: string;
  body: string;
  action_url: string | null;
  recipient_user_id: string | null;
  recipient_email: string | null;
  recipient_name: string | null;
  /** The recipient's setting, read at send time so a change takes effect at once. */
  digest: NotificationDigest;
}

/**
 * Claim due deliveries with `for update skip locked`, so two workers can run
 * without sending the same email twice — the same lease shape as the outbox.
 */
async function claimDue(limit: number): Promise<DueRow[]> {
  return query<DueRow>(
    `with picked as (
       select d.id from notification_deliveries d
        where d.status = 'PENDING' and d.deliver_after <= now()
        order by d.deliver_after, d.created_at
        for update skip locked limit $1
     )
     update notification_deliveries d
        set attempts = d.attempts + 1, updated_at = now()
       from picked
       join notifications n on true
      where d.id = picked.id and n.id = d.notification_id
     returning d.id, d.notification_id, d.channel, d.attempts,
               n.title, n.body, n.action_url, n.recipient_user_id,
               (select u.email from users u where u.id = n.recipient_user_id) as recipient_email,
               (select u.name  from users u where u.id = n.recipient_user_id) as recipient_name,
               coalesce((select p.digest from notification_preferences p
                          where p.user_id = n.recipient_user_id), 'IMMEDIATE') as digest`,
    [limit]
  );
}

async function record(id: string, outcome: ChannelOutcome, attempts: number): Promise<void> {
  if (outcome.status === 'sent') {
    await query(
      `update notification_deliveries
          set status = 'SENT', sent_at = now(), provider_message_id = $2,
              error = null, updated_at = now()
        where id = $1`,
      [id, outcome.providerMessageId]
    );
    return;
  }
  if (outcome.status === 'skipped') {
    await query(
      `update notification_deliveries
          set status = 'SKIPPED', skip_reason = $2, updated_at = now() where id = $1`,
      [id, outcome.reason]
    );
    return;
  }
  // Failed. `PENDING` means try again later; `DEAD_LETTER` from the shared policy
  // maps to `FAILED` here, which is what Platform Operations surfaces.
  const next = deliveryFailureState({ failedAttempt: attempts, retryable: outcome.retryable });
  await query(
    `update notification_deliveries
        set status = $2, error = $3,
            deliver_after = case when $4::int is null then deliver_after
                                 else now() + ($4 || ' seconds')::interval end,
            updated_at = now()
      where id = $1`,
    [id, next.status === 'PENDING' ? 'PENDING' : 'FAILED', outcome.error.slice(0, 4000),
      next.delaySeconds]
  );
}

/**
 * Who gets a message of their own, and whose email is batched into one.
 *
 * Pure and exported because this is the *decision* the digest preference makes,
 * and a decision buried in a loop between two provider calls is one nobody can
 * test without a provider. Three outcomes, not two: a row whose recipient no
 * longer exists is neither, and folding it into `individual` would mean asking an
 * email adapter to send to a deleted user and calling the refusal a failure.
 *
 * Grouping happens only **within one claimed batch**, which bounds a digest
 * rather than guaranteeing it: a recipient with more due email than the batch
 * limit gets two messages instead of one. A deliberate ceiling — an unbounded
 * group would let one recipient's backlog hold up everybody else's delivery — and
 * it errs toward sending, which is the safe direction.
 */
export function partitionForDelivery(rows: readonly DueRow[]): {
  orphaned: DueRow[];
  individual: DueRow[];
  digestGroups: DueRow[][];
} {
  const orphaned: DueRow[] = [];
  const individual: DueRow[] = [];
  const byRecipient = new Map<string, DueRow[]>();

  for (const row of rows) {
    if (!row.recipient_user_id) {
      orphaned.push(row);
      continue;
    }
    // Push is never digested (packet §6, `deliveryHoldMinutes`): one knock
    // standing in for six is not a summary, it is five missing notifications.
    if (row.channel !== 'EMAIL' || row.digest === 'IMMEDIATE') {
      individual.push(row);
      continue;
    }
    const group = byRecipient.get(row.recipient_user_id) ?? [];
    group.push(row);
    byRecipient.set(row.recipient_user_id, group);
  }

  return { orphaned, individual, digestGroups: [...byRecipient.values()] };
}

function messageFor(row: DueRow): PushMessage {
  return {
    recipientUserId: row.recipient_user_id!,
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    title: row.title,
    body: row.body,
    actionUrl: row.action_url,
  };
}

export async function runNotificationDeliveryBatch(
  limit = 25
): Promise<{ claimed: number; sent: number; skipped: number; failed: number }> {
  const due = await claimDue(limit);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  const tally = (outcome: ChannelOutcome) => {
    if (outcome.status === 'sent') sent += 1;
    else if (outcome.status === 'skipped') skipped += 1;
    else failed += 1;
  };

  const { orphaned, individual, digestGroups } = partitionForDelivery(due);

  for (const row of orphaned) {
    // The recipient was deleted between dispatch and delivery. Their inbox row is
    // anonymised and kept as company-side evidence; sending to nobody is not a
    // failure worth retrying.
    await record(row.id, { status: 'skipped', reason: 'Recipient no longer exists' }, row.attempts);
    skipped += 1;
  }

  for (const row of individual) {
    const message = messageFor(row);
    const outcome =
      row.channel === 'EMAIL' ? await sendEmail(message) : await sendPush(message);
    await record(row.id, outcome, row.attempts);
    tally(outcome);
  }

  for (const group of digestGroups) {
    const first = group[0]!;
    // One provider call, one outcome, recorded against every row it covered —
    // so "was I told?" is answerable per notification even though one message
    // carried several. A failure retries the whole group, which is correct:
    // the message that failed contained all of them.
    const outcome = await sendDigestEmail({
      recipientEmail: first.recipient_email,
      recipientName: first.recipient_name,
      items: group.map(messageFor),
    });
    for (const row of group) {
      await record(row.id, outcome, row.attempts);
      tally(outcome);
    }
  }

  return { claimed: due.length, sent, skipped, failed };
}

/** Operational counts for the Platform Operations screen. */
export async function notificationDeliveryHealth(): Promise<{
  pending: number;
  failed: number;
  sentLastDay: number;
  skippedLastDay: number;
}> {
  const row = await queryOne<{
    pending: string; failed: string; sent_last_day: string; skipped_last_day: string;
  }>(
    `select
       count(*) filter (where status = 'PENDING')  as pending,
       count(*) filter (where status = 'FAILED')   as failed,
       count(*) filter (where status = 'SENT'    and updated_at > now() - interval '1 day')
         as sent_last_day,
       count(*) filter (where status = 'SKIPPED' and updated_at > now() - interval '1 day')
         as skipped_last_day
     from notification_deliveries`
  );
  return {
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0),
    sentLastDay: Number(row?.sent_last_day ?? 0),
    skippedLastDay: Number(row?.skipped_last_day ?? 0),
  };
}
