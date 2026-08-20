import type { NotificationKind } from '@crewquo/shared';
import {
  NOTIFICATION_KIND_SPECS,
  deliveryHoldMinutes,
  notificationDedupeKey,
  resolveChannels,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';
import { getNotificationPreferences, insertNotification } from './repo';

/**
 * Turning one domain event into the rows that make it durable.
 * Operating-model packet: `docs/operating-model/notifications.md`.
 *
 * The shape that matters: **the in-product row is written first and
 * unconditionally, and the intrusive channels are derived from it.** Preferences,
 * quiet hours and digests only ever subtract from, or delay, the channel list —
 * they can never stop the notification existing. A person who has turned
 * everything off still opens the app and sees what is waiting for them, which is
 * the difference between a preference and a way to lose work.
 */

/** Approvers of a company — the cohort a "needs a decision" event goes to. */
export async function managerRecipients(
  companyId: string,
  runner?: Queryable
): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `select m.user_id from memberships m
      where m.company_id = $1 and m.status = 'ACTIVE'
        and m.role in ('OWNER','ADMIN','MANAGER')`,
    [companyId],
    runner
  );
  return rows.map((r) => r.user_id);
}

/** The local wall-clock time for a user, as `HH:MM`, in their own zone. */
async function localTimeFor(timeZone: string): Promise<string> {
  // Asked of Postgres rather than computed in Node so an invalid zone fails here,
  // where it can fall back, rather than at delivery time in a worker.
  try {
    const row = await queryOne<{ hhmm: string }>(
      `select to_char(now() at time zone $1, 'HH24:MI') as hhmm`,
      [timeZone]
    );
    return row?.hhmm ?? '12:00';
  } catch {
    // An unrecognised zone must not stop a notification. Treating it as "outside
    // quiet hours" errs toward delivering, which is the safe direction: a person
    // can silence a channel, but they cannot un-miss a task they were never told
    // about.
    return '12:00';
  }
}

export interface DispatchInput {
  kind: NotificationKind;
  /**
   * Null for an account-scoped notification — a security event about the person
   * rather than about a tenant (0018). Hanging one on a company would claim the
   * event happened inside that tenant, which is false and crosses a boundary the
   * rest of the product spends four checks defending.
   */
  companyId: string | null;
  recipientUserIds: readonly string[];
  title: string;
  /** Composed server-side from resolved facts — never from caller-supplied text. */
  body: string;
  subjectType: string;
  subjectId: string;
  actionUrl?: string | null;
  /** The outbox topic + aggregate this came from, for the dedupe key. */
  topic: string;
  aggregateId: string;
}

/**
 * Write one notification per recipient, plus its channel deliveries.
 *
 * Idempotent end to end: the notification insert is keyed on
 * `<topic>:<aggregate>:<recipient>` and the delivery insert on
 * `(notification, channel)`, so a redelivered outbox event — or one that died
 * halfway through a fan-out — completes without duplicating anything already
 * written. That is the durable-delivery packet's "consumers must be idempotent
 * before acknowledging", as two unique indexes rather than two promises.
 */
export async function dispatchNotification(input: DispatchInput): Promise<{ written: number }> {
  const spec = NOTIFICATION_KIND_SPECS[input.kind];
  let written = 0;

  for (const recipientUserId of input.recipientUserIds) {
    const { id, created } = await insertNotification({
      recipientUserId,
      companyId: input.companyId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      actionUrl: input.actionUrl ?? null,
      requiresAction: spec.requiresAction,
      urgency: spec.urgency,
      dedupeKey: notificationDedupeKey(input.topic, input.aggregateId, recipientUserId),
    });
    if (!created) continue; // already delivered on an earlier attempt
    written += 1;

    const prefs = await getNotificationPreferences(recipientUserId);
    const channels = resolveChannels(input.kind, prefs.channels);
    if (channels.length === 0) continue;

    // Resolved once per recipient, then per channel: email may be held to a
    // digest boundary while push goes out on quiet hours alone, so the two
    // channels of one notification can legitimately have different due times.
    const localTime = await localTimeFor(prefs.timeZone);

    for (const channel of channels) {
      const delayMinutes = deliveryHoldMinutes({
        channel,
        localTime,
        digest: prefs.digest,
        quietHoursStart: prefs.quietHoursStart,
        quietHoursEnd: prefs.quietHoursEnd,
        urgency: spec.urgency,
      });
      await query(
        `insert into notification_deliveries (notification_id, channel, deliver_after)
         values ($1, $2, now() + ($3 || ' minutes')::interval)
         on conflict (notification_id, channel) do nothing`,
        [id, channel, String(delayMinutes)]
      );
    }
  }

  return { written };
}
