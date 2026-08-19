import { z } from 'zod';

/**
 * Notifications and the Universal Action Centre (CREWQUO_V2_PLAN.md §42).
 * Operating-model packet: `docs/operating-model/notifications.md`.
 *
 * **A notification is a message about something that happened. An Action Centre
 * item is something somebody still has to do.** They live in one table because
 * the plan asks for "one durable task projection … later phases add their own
 * task kinds rather than their own inbox architecture" — so the Action Centre is
 * the actionable subset of the inbox, not a second system that could disagree
 * with it about what is outstanding.
 *
 * Everything in this file is pure, because two of the rules below are the kind
 * that go quietly wrong and stay wrong: a quiet-hours window that spans midnight,
 * and the precedence between a user's per-kind override and the kind's own
 * default. Both are cheap to pin here and expensive to debug in production.
 */

// ── Kinds ─────────────────────────────────────────────────────────────────────

export const NOTIFICATION_KINDS = [
  'work.submitted',
  'work.approved',
  'work.rejected',
  'expense.submitted',
  'expense.approved',
  'expense.rejected',
  'rate_proposal.submitted',
  'rate_proposal.decided',
  'invoice.issued',
  'delivery.dead_lettered',
] as const;
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const NOTIFICATION_CHANNELS = ['EMAIL', 'PUSH'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export type NotificationUrgency = 'NORMAL' | 'URGENT';

export interface NotificationKindSpec {
  /** Does this land in the Action Centre as something to do, or is it just news? */
  requiresAction: boolean;
  /** `URGENT` bypasses quiet hours. Exactly one kind is, and it is not a customer one. */
  urgency: NotificationUrgency;
  /** Channels attempted unless the user says otherwise. In-product is always on. */
  defaultChannels: readonly NotificationChannel[];
}

/**
 * The catalog. `requiresAction` is a property of the *kind*, not of the sender's
 * judgement on the day — otherwise the same event would be a task for one
 * recipient and news for another, and "what is outstanding" would stop being
 * answerable.
 */
export const NOTIFICATION_KIND_SPECS: Readonly<Record<NotificationKind, NotificationKindSpec>> = {
  'work.submitted': { requiresAction: true, urgency: 'NORMAL', defaultChannels: ['PUSH'] },
  'work.approved': { requiresAction: false, urgency: 'NORMAL', defaultChannels: ['PUSH'] },
  'work.rejected': { requiresAction: false, urgency: 'NORMAL', defaultChannels: ['PUSH', 'EMAIL'] },
  'expense.submitted': { requiresAction: true, urgency: 'NORMAL', defaultChannels: ['PUSH'] },
  'expense.approved': { requiresAction: false, urgency: 'NORMAL', defaultChannels: ['PUSH'] },
  'expense.rejected': { requiresAction: false, urgency: 'NORMAL', defaultChannels: ['PUSH', 'EMAIL'] },
  // Money being negotiated is worth an email: it is rarer than a timesheet and
  // the person who must decide is often not the person watching the app.
  'rate_proposal.submitted': { requiresAction: true, urgency: 'NORMAL', defaultChannels: ['PUSH', 'EMAIL'] },
  'rate_proposal.decided': { requiresAction: false, urgency: 'NORMAL', defaultChannels: ['PUSH', 'EMAIL'] },
  'invoice.issued': { requiresAction: true, urgency: 'NORMAL', defaultChannels: ['EMAIL'] },
  // The only URGENT kind, and deliberately an operator one. A customer event is
  // never urgent enough to wake somebody: their work will still be there at 8am.
  'delivery.dead_lettered': { requiresAction: true, urgency: 'URGENT', defaultChannels: ['EMAIL'] },
};

// ── Preferences ───────────────────────────────────────────────────────────────

/** `{"work.submitted": {"email": false}}` — an absent key means the kind default. */
export const notificationChannelOverridesSchema = z.record(
  z.object({ email: z.boolean().optional(), push: z.boolean().optional() })
);
export type NotificationChannelOverrides = z.infer<typeof notificationChannelOverridesSchema>;

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export const notificationPreferencesSchema = z.object({
  /** IANA zone. Quiet hours are a property of the person, so the zone is too. */
  timeZone: z.string().min(1).max(64),
  quietHoursStart: timeOfDay.nullable(),
  quietHoursEnd: timeOfDay.nullable(),
  digest: z.enum(['IMMEDIATE', 'HOURLY', 'DAILY']),
  channels: notificationChannelOverridesSchema,
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesSchema = notificationPreferencesSchema
  .partial()
  .refine(
    (v) =>
      v.quietHoursStart === undefined ||
      v.quietHoursEnd === undefined ||
      (v.quietHoursStart === null) === (v.quietHoursEnd === null),
    { message: 'Set both ends of the quiet-hours window, or neither', path: ['quietHoursEnd'] }
  );
export type UpdateNotificationPreferences = z.infer<typeof updateNotificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  timeZone: 'UTC',
  quietHoursStart: null,
  quietHoursEnd: null,
  digest: 'IMMEDIATE',
  channels: {},
};

/**
 * Which intrusive channels this notification should attempt.
 *
 * **In-product is not in this list and never can be.** Preferences and quiet
 * hours govern email and push only: a task the product hid because somebody
 * turned off email is a task nobody did. That is the single rule in this domain
 * most likely to be "optimised" away later, so the function that would have to
 * change to break it does not take in-product as an input at all.
 *
 * Precedence is user override → kind default. An override of `true` can also turn
 * a channel *on* that the kind does not use by default, because a user asking for
 * more email is a preference, not a risk.
 */
export function resolveChannels(
  kind: NotificationKind,
  overrides: NotificationChannelOverrides = {}
): NotificationChannel[] {
  const spec = NOTIFICATION_KIND_SPECS[kind];
  const override = overrides[kind] ?? {};
  return NOTIFICATION_CHANNELS.filter((channel) => {
    const chosen = channel === 'EMAIL' ? override.email : override.push;
    return chosen ?? spec.defaultChannels.includes(channel);
  });
}

// ── Quiet hours ───────────────────────────────────────────────────────────────

function minutesOfDay(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Is this local time inside the quiet window?
 *
 * **The window may span midnight, and usually does** — 22:00 to 07:00 is the
 * obvious setting and the one a naive `start <= t && t < end` gets exactly
 * backwards, quietening the entire working day and delivering all night. Handled
 * explicitly rather than left to the caller.
 *
 * The window is half-open: it starts *at* `start` and ends *before* `end`, so a
 * notification at exactly the end of quiet hours goes out rather than waiting a
 * further whole day.
 */
export function isWithinQuietHours(
  localTime: string,
  start: string | null,
  end: string | null
): boolean {
  if (!start || !end) return false;
  const t = minutesOfDay(localTime);
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  // A window whose ends are equal is empty, not all day: "quiet from 9 to 9"
  // almost certainly means somebody has not finished setting it up, and silencing
  // a person for 24 hours on that reading would be the worse guess.
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/**
 * How long to hold an intrusive delivery, in minutes, or 0 to send now.
 *
 * Returns a delay rather than a timestamp so the decision stays pure and
 * testable; the caller adds it to `now`. An urgent notification is never held —
 * the whole point of an operator alert is to arrive when things are broken.
 */
export function quietHoursDelayMinutes(args: {
  localTime: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  urgency: NotificationUrgency;
}): number {
  if (args.urgency === 'URGENT') return 0;
  if (!isWithinQuietHours(args.localTime, args.quietHoursStart, args.quietHoursEnd)) return 0;
  const now = minutesOfDay(args.localTime);
  const end = minutesOfDay(args.quietHoursEnd!);
  const untilEnd = end > now ? end - now : 24 * 60 - now + end;
  return untilEnd;
}

// ── Identity and state ────────────────────────────────────────────────────────

/**
 * The key that makes a replayed outbox event produce one row per recipient.
 *
 * Includes the recipient because a fan-out writes one row per person and each is
 * separately deduplicated; keying on the event alone would let a retry that
 * failed halfway through skip the recipients it never reached.
 */
export function notificationDedupeKey(
  topic: string,
  aggregateId: string,
  recipientUserId: string
): string {
  return `${topic}:${aggregateId}:${recipientUserId}`;
}

export type NotificationState = 'UNREAD' | 'READ' | 'RESOLVED' | 'DISMISSED';

export interface NotificationStateFacts {
  requiresAction: boolean;
  readAt: string | null;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

/** The single place the four timestamps are turned into one state to render. */
export function notificationState(facts: NotificationStateFacts): NotificationState {
  if (facts.resolvedAt) return 'RESOLVED';
  if (facts.dismissedAt) return 'DISMISSED';
  return facts.readAt ? 'READ' : 'UNREAD';
}

/**
 * Is this still something to do? The Action Centre's whole query, as a predicate.
 *
 * Read *and* still open is deliberately still open: seeing a task is not doing it,
 * and an inbox that closed items on sight would be a to-do list that empties
 * itself.
 */
export function isOpenAction(facts: NotificationStateFacts): boolean {
  return facts.requiresAction && !facts.resolvedAt && !facts.dismissedAt;
}

/**
 * Why this transition is refused, or null when it is allowed.
 *
 * Resolution and dismissal are set-once and terminal. **Nothing reopens:** a
 * recurring event arrives as a new row with a new dedupe key, because reopening
 * would lose when the task was first raised — which is the number the Action
 * Centre's "how long has this been outstanding" reading depends on.
 */
export function notificationTransitionRefusal(
  facts: NotificationStateFacts,
  verb: 'read' | 'resolve' | 'dismiss'
): string | null {
  if (verb === 'resolve' && !facts.requiresAction) {
    return 'This is a notification, not a task — there is nothing to resolve';
  }
  if (verb === 'read') return null;
  if (facts.resolvedAt) return 'This task is already resolved';
  if (facts.dismissedAt) return 'This task was already dismissed';
  return null;
}

// ── API contracts (§7) ────────────────────────────────────────────────────────

export const notificationViewSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  kind: notificationKindSchema,
  title: z.string(),
  body: z.string(),
  subjectType: z.string().nullable(),
  subjectId: z.string().uuid().nullable(),
  actionUrl: z.string().nullable(),
  requiresAction: z.boolean(),
  urgency: z.enum(['NORMAL', 'URGENT']),
  state: z.enum(['UNREAD', 'READ', 'RESOLVED', 'DISMISSED']),
  readAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  /** Null when the system closed it because somebody else did the work. */
  resolvedByName: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

export const listNotificationsQuerySchema = z.object({
  /** `open` is the Action Centre; `all` is the inbox. */
  filter: z.enum(['open', 'unread', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationActionSchema = z.object({
  verb: z.enum(['read', 'resolve', 'dismiss']),
});
export type NotificationAction = z.infer<typeof notificationActionSchema>;
