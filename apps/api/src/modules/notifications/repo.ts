import type {
  ListNotificationsQuery,
  NotificationChannelOverrides,
  NotificationKind,
  NotificationPreferences,
  NotificationView,
  UpdateNotificationPreferences,
} from '@crewquo/shared';
import { DEFAULT_NOTIFICATION_PREFERENCES, notificationState } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * Notification persistence (CREWQUO_V2_PLAN.md §42).
 * Operating-model packet: `docs/operating-model/notifications.md`.
 *
 * **Every read in this file filters on `recipient_user_id`, not on company and
 * not on role.** This is the one surface whose whole purpose is handing a user
 * facts from elsewhere, so there is deliberately no query shape here in which one
 * user can reach another's inbox — no "as an admin" variant, no company-wide
 * listing. Support diagnoses delivery through `notification_deliveries`, which
 * carries status without bodies.
 */

interface NotificationRow {
  id: string;
  company_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  subject_type: string | null;
  subject_id: string | null;
  action_url: string | null;
  requires_action: boolean;
  urgency: 'NORMAL' | 'URGENT';
  read_at: Date | null;
  resolved_at: Date | null;
  resolved_by_name: string | null;
  dismissed_at: Date | null;
  created_at: Date;
}

const NOTIFICATION_COLS = `n.id, n.company_id, n.kind, n.title, n.body, n.subject_type,
  n.subject_id, n.action_url, n.requires_action, n.urgency, n.read_at, n.resolved_at,
  ru.name as resolved_by_name, n.dismissed_at, n.created_at`;

function toView(row: NotificationRow): NotificationView {
  const readAt = row.read_at?.toISOString() ?? null;
  const resolvedAt = row.resolved_at?.toISOString() ?? null;
  const dismissedAt = row.dismissed_at?.toISOString() ?? null;
  return {
    id: row.id,
    companyId: row.company_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    actionUrl: row.action_url,
    requiresAction: row.requires_action,
    urgency: row.urgency,
    // Derived in one shared place so the API and the UI cannot disagree about
    // what "open" means.
    state: notificationState({
      requiresAction: row.requires_action,
      readAt,
      resolvedAt,
      dismissedAt,
    }),
    readAt,
    resolvedAt,
    resolvedByName: row.resolved_by_name,
    dismissedAt,
    createdAt: row.created_at.toISOString(),
  };
}

export interface NewNotification {
  recipientUserId: string;
  /** Null is account-scoped: a security event about the person (0018). */
  companyId: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  subjectType?: string | null;
  subjectId?: string | null;
  actionUrl?: string | null;
  requiresAction: boolean;
  urgency: 'NORMAL' | 'URGENT';
  dedupeKey: string;
}

/**
 * Write one recipient's copy, idempotently.
 *
 * `on conflict do nothing` plus a null return is the whole replay story: a
 * redelivered outbox event finds the row already there and the caller writes no
 * second delivery for it. A fan-out that died halfway through still completes on
 * retry, because the key includes the recipient.
 */
export async function insertNotification(
  input: NewNotification,
  runner?: Queryable
): Promise<{ id: string; created: boolean }> {
  const inserted = await queryOne<{ id: string }>(
    `insert into notifications
       (recipient_user_id, company_id, kind, title, body, subject_type, subject_id,
        action_url, requires_action, urgency, dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (dedupe_key) do nothing
     returning id`,
    [input.recipientUserId, input.companyId, input.kind, input.title, input.body,
      input.subjectType ?? null, input.subjectId ?? null, input.actionUrl ?? null,
      input.requiresAction, input.urgency, input.dedupeKey],
    runner
  );
  if (inserted) return { id: inserted.id, created: true };
  const existing = await queryOne<{ id: string }>(
    `select id from notifications where dedupe_key = $1`,
    [input.dedupeKey],
    runner
  );
  return { id: existing!.id, created: false };
}

export async function listNotifications(
  recipientUserId: string,
  companyId: string,
  filter: ListNotificationsQuery
): Promise<{ data: NotificationView[]; nextBefore: string | null }> {
  /*
   * **Account-scoped rows are in every company's inbox for their holder.**
   *
   * A security alert belongs to the person, so the alternative — showing it only
   * while some particular company is selected — would hide "somebody signed you
   * out of everything" behind a company switcher, which is precisely the moment
   * nobody is thinking about which tenant they are looking at.
   */
  const clauses = ['n.recipient_user_id = $1', '(n.company_id = $2 or n.company_id is null)'];
  if (filter.filter === 'open') {
    clauses.push('n.requires_action and n.resolved_at is null and n.dismissed_at is null');
  } else if (filter.filter === 'unread') {
    clauses.push('n.read_at is null and n.dismissed_at is null');
  }
  if (filter.before) clauses.push('n.created_at < $4');

  const rows = await query<NotificationRow>(
    `select ${NOTIFICATION_COLS}
       from notifications n
       left join users ru on ru.id = n.resolved_by_user_id
      where ${clauses.join(' and ')}
      order by n.created_at desc
      limit $3`,
    filter.before
      ? [recipientUserId, companyId, filter.limit + 1, filter.before]
      : [recipientUserId, companyId, filter.limit + 1]
  );
  const page = rows.slice(0, filter.limit);
  return {
    data: page.map(toView),
    nextBefore:
      rows.length > filter.limit ? (page[page.length - 1]?.created_at.toISOString() ?? null) : null,
  };
}

/** How many tasks are still outstanding — the badge, and only ever the caller's. */
export async function countOpenActions(
  recipientUserId: string,
  companyId: string
): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*) as n from notifications
      where recipient_user_id = $1 and company_id = $2
        and requires_action and resolved_at is null and dismissed_at is null`,
    [recipientUserId, companyId]
  );
  return Number(row?.n ?? 0);
}

export async function getNotification(
  id: string,
  recipientUserId: string,
  runner?: Queryable
): Promise<NotificationView | null> {
  const row = await queryOne<NotificationRow>(
    `select ${NOTIFICATION_COLS}
       from notifications n
       left join users ru on ru.id = n.resolved_by_user_id
      where n.id = $1 and n.recipient_user_id = $2`,
    [id, recipientUserId],
    runner
  );
  return row ? toView(row) : null;
}

/**
 * Apply a recipient-side transition. Read/resolve/dismiss are all set-once, so
 * each `where … is null` clause makes a replayed offline action a no-op rather
 * than a second write — which is what lets the inbox participate in offline sync
 * with no version column at all.
 */
export async function transitionNotification(args: {
  id: string;
  recipientUserId: string;
  verb: 'read' | 'resolve' | 'dismiss';
}): Promise<void> {
  const column =
    args.verb === 'read' ? 'read_at' : args.verb === 'resolve' ? 'resolved_at' : 'dismissed_at';
  const resolver = args.verb === 'resolve' ? ', resolved_by_user_id = $2' : '';
  await queryOne(
    `update notifications
        set ${column} = now()${resolver}, updated_at = now()
      where id = $1 and recipient_user_id = $2 and ${column} is null
      returning id`,
    [args.id, args.recipientUserId]
  );
}

/**
 * Close every open task pointing at a subject, because the work behind it is done.
 *
 * This is what stops the Action Centre lying. A time log approved by one manager
 * leaves every *other* approver holding a task for something that no longer needs
 * doing, and an inbox full of already-handled work is one people stop reading.
 * `resolved_by_user_id` is left null when the closer is not the recipient, so the
 * UI can honestly say "resolved because the work was done" rather than naming
 * somebody who never opened it.
 */
export async function resolveActionsForSubject(args: {
  subjectType: string;
  subjectId: string;
  runner?: Queryable;
}): Promise<number> {
  const rows = await query<{ id: string }>(
    `update notifications
        set resolved_at = now(), updated_at = now()
      where subject_type = $1 and subject_id = $2
        and requires_action and resolved_at is null and dismissed_at is null
      returning id`,
    [args.subjectType, args.subjectId],
    args.runner
  );
  return rows.length;
}

// ── Preferences ───────────────────────────────────────────────────────────────

interface PreferencesRow {
  time_zone: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  digest: 'IMMEDIATE' | 'HOURLY' | 'DAILY';
  channels: NotificationChannelOverrides;
}

/** `time` comes back as `HH:MM:SS`; the contract is `HH:MM`. */
function toHhMm(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

/**
 * A user who has never opened the settings screen has no row, and that is a
 * complete answer rather than a missing one: absent means "every default", so
 * nothing has to be backfilled when a new kind is added.
 */
export async function getNotificationPreferences(
  userId: string,
  runner?: Queryable
): Promise<NotificationPreferences> {
  const row = await queryOne<PreferencesRow>(
    `select time_zone, quiet_hours_start::text, quiet_hours_end::text, digest, channels
       from notification_preferences where user_id = $1`,
    [userId],
    runner
  );
  if (!row) return DEFAULT_NOTIFICATION_PREFERENCES;
  return {
    timeZone: row.time_zone,
    quietHoursStart: toHhMm(row.quiet_hours_start),
    quietHoursEnd: toHhMm(row.quiet_hours_end),
    digest: row.digest,
    channels: row.channels,
  };
}

export async function upsertNotificationPreferences(
  userId: string,
  patch: UpdateNotificationPreferences
): Promise<NotificationPreferences> {
  const current = await getNotificationPreferences(userId);
  const next: NotificationPreferences = {
    timeZone: patch.timeZone ?? current.timeZone,
    quietHoursStart:
      patch.quietHoursStart !== undefined ? patch.quietHoursStart : current.quietHoursStart,
    quietHoursEnd: patch.quietHoursEnd !== undefined ? patch.quietHoursEnd : current.quietHoursEnd,
    digest: patch.digest ?? current.digest,
    channels: patch.channels ?? current.channels,
  };
  await queryOne(
    `insert into notification_preferences
       (user_id, time_zone, quiet_hours_start, quiet_hours_end, digest, channels)
     values ($1,$2,$3::time,$4::time,$5,$6::jsonb)
     on conflict (user_id) do update
       set time_zone = excluded.time_zone,
           quiet_hours_start = excluded.quiet_hours_start,
           quiet_hours_end = excluded.quiet_hours_end,
           digest = excluded.digest,
           channels = excluded.channels,
           updated_at = now()
     returning user_id`,
    [userId, next.timeZone, next.quietHoursStart, next.quietHoursEnd, next.digest,
      JSON.stringify(next.channels)]
  );
  return next;
}
