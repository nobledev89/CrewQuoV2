import { deliveryFailureState } from '../delivery/model';
import { query, queryOne } from '../../db';
import { sendEmail, sendPush, type ChannelOutcome, type OutgoingMessage } from './channels';

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
 */

interface DueRow {
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
               (select u.name  from users u where u.id = n.recipient_user_id) as recipient_name`,
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

export async function runNotificationDeliveryBatch(
  limit = 25
): Promise<{ claimed: number; sent: number; skipped: number; failed: number }> {
  const due = await claimDue(limit);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of due) {
    if (!row.recipient_user_id) {
      // The recipient was deleted between dispatch and delivery. Their inbox row
      // is anonymised and kept as company-side evidence; sending to nobody is not
      // a failure worth retrying.
      await record(row.id, { status: 'skipped', reason: 'Recipient no longer exists' }, row.attempts);
      skipped += 1;
      continue;
    }
    const message: OutgoingMessage = {
      recipientUserId: row.recipient_user_id,
      recipientEmail: row.recipient_email,
      recipientName: row.recipient_name,
      title: row.title,
      body: row.body,
      actionUrl: row.action_url,
    };
    const outcome =
      row.channel === 'EMAIL' ? await sendEmail(message) : await sendPush(message);
    await record(row.id, outcome, row.attempts);
    if (outcome.status === 'sent') sent += 1;
    else if (outcome.status === 'skipped') skipped += 1;
    else failed += 1;
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
