import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_SPECS,
  isOpenAction,
  isWithinQuietHours,
  notificationDedupeKey,
  notificationState,
  notificationTransitionRefusal,
  quietHoursDelayMinutes,
  resolveChannels,
  updateNotificationPreferencesSchema,
  type NotificationStateFacts,
} from './notifications';

/**
 * One test per rule (§13, §44). Two of these are the kind that go quietly wrong
 * and stay wrong — a quiet-hours window across midnight, and the precedence
 * between a user override and a kind default — so both are pinned exhaustively
 * rather than by sampling.
 */

const facts = (over: Partial<NotificationStateFacts> = {}): NotificationStateFacts => ({
  requiresAction: true,
  readAt: null,
  resolvedAt: null,
  dismissedAt: null,
  ...over,
});

describe('the kind catalog', () => {
  it('specifies every declared kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_SPECS[kind]).toBeDefined();
    }
    expect(Object.keys(NOTIFICATION_KIND_SPECS).sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });

  it('keeps URGENT to operator alerts only', () => {
    // A customer's work will still be there at 8am. Waking somebody for it would
    // make the setting worthless, because they would turn it off entirely.
    const urgent = NOTIFICATION_KINDS.filter((k) => NOTIFICATION_KIND_SPECS[k].urgency === 'URGENT');
    expect(urgent).toEqual(['delivery.dead_lettered']);
  });

  it('marks a decision somebody must take as actionable, and news as not', () => {
    expect(NOTIFICATION_KIND_SPECS['work.submitted'].requiresAction).toBe(true);
    expect(NOTIFICATION_KIND_SPECS['rate_proposal.submitted'].requiresAction).toBe(true);
    expect(NOTIFICATION_KIND_SPECS['invoice.issued'].requiresAction).toBe(true);
    expect(NOTIFICATION_KIND_SPECS['work.approved'].requiresAction).toBe(false);
    expect(NOTIFICATION_KIND_SPECS['rate_proposal.decided'].requiresAction).toBe(false);
  });
});

describe('resolveChannels', () => {
  it('uses the kind default when the user has said nothing', () => {
    expect(resolveChannels('work.submitted')).toEqual(['PUSH']);
    expect(resolveChannels('rate_proposal.submitted')).toEqual(['EMAIL', 'PUSH']);
  });

  it('lets a user turn a default channel off', () => {
    expect(resolveChannels('rate_proposal.submitted', {
      'rate_proposal.submitted': { email: false },
    })).toEqual(['PUSH']);
  });

  it('lets a user turn a channel on that the kind does not use by default', () => {
    // Asking for more email is a preference, not a risk.
    expect(resolveChannels('work.submitted', { 'work.submitted': { email: true } }))
      .toEqual(['EMAIL', 'PUSH']);
  });

  it('applies an override only to the kind it names', () => {
    const overrides = { 'work.submitted': { push: false } };
    expect(resolveChannels('work.submitted', overrides)).toEqual([]);
    expect(resolveChannels('work.approved', overrides)).toEqual(['PUSH']);
  });

  it('can silence every intrusive channel — and in-product is not one of them', () => {
    // The returned list is what gets *pushed at* the user. The inbox row is
    // written regardless, which is why in-product can never appear here.
    const silenced = resolveChannels('work.submitted', {
      'work.submitted': { email: false, push: false },
    });
    expect(silenced).toEqual([]);
    expect(silenced).not.toContain('IN_PRODUCT');
  });
});

describe('isWithinQuietHours', () => {
  it('is never quiet when no window is set', () => {
    expect(isWithinQuietHours('23:30', null, null)).toBe(false);
  });

  it('handles a same-day window', () => {
    expect(isWithinQuietHours('13:00', '12:00', '14:00')).toBe(true);
    expect(isWithinQuietHours('11:59', '12:00', '14:00')).toBe(false);
    expect(isWithinQuietHours('15:00', '12:00', '14:00')).toBe(false);
  });

  it('handles the window that spans midnight, which is the usual one', () => {
    // 22:00–07:00. A naive `start <= t && t < end` gets every one of these
    // backwards: it would silence the working day and deliver all night.
    expect(isWithinQuietHours('23:30', '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours('02:00', '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours('06:59', '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours('12:00', '22:00', '07:00')).toBe(false);
    expect(isWithinQuietHours('21:59', '22:00', '07:00')).toBe(false);
  });

  it('includes the start instant and excludes the end instant', () => {
    // Half-open, so a notification at exactly the end goes out now rather than
    // waiting a further whole day.
    expect(isWithinQuietHours('22:00', '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours('07:00', '22:00', '07:00')).toBe(false);
  });

  it('treats an empty window as no window rather than as all day', () => {
    // "Quiet from 09:00 to 09:00" almost certainly means somebody did not finish
    // setting it up; silencing them for 24 hours is the worse reading.
    expect(isWithinQuietHours('09:00', '09:00', '09:00')).toBe(false);
    expect(isWithinQuietHours('17:00', '09:00', '09:00')).toBe(false);
  });
});

describe('quietHoursDelayMinutes', () => {
  const quiet = { quietHoursStart: '22:00', quietHoursEnd: '07:00' } as const;

  it('sends immediately outside the window', () => {
    expect(quietHoursDelayMinutes({ localTime: '12:00', ...quiet, urgency: 'NORMAL' })).toBe(0);
  });

  it('holds until the window ends, across midnight', () => {
    // 23:00 -> 07:00 is 8 hours.
    expect(quietHoursDelayMinutes({ localTime: '23:00', ...quiet, urgency: 'NORMAL' })).toBe(480);
  });

  it('holds only the remainder when the window ends later the same day', () => {
    // 02:00 -> 07:00 is 5 hours, not 8: the delay is from now, not from the start.
    expect(quietHoursDelayMinutes({ localTime: '02:00', ...quiet, urgency: 'NORMAL' })).toBe(300);
  });

  it('never holds an urgent notification', () => {
    // The point of an operator alert is to arrive when things are broken.
    expect(quietHoursDelayMinutes({ localTime: '03:00', ...quiet, urgency: 'URGENT' })).toBe(0);
  });

  it('never holds anything when no window is set', () => {
    expect(
      quietHoursDelayMinutes({
        localTime: '03:00',
        quietHoursStart: null,
        quietHoursEnd: null,
        urgency: 'NORMAL',
      })
    ).toBe(0);
  });
});

describe('state and transitions', () => {
  it('reads the four timestamps as one state', () => {
    expect(notificationState(facts())).toBe('UNREAD');
    expect(notificationState(facts({ readAt: 'x' }))).toBe('READ');
    expect(notificationState(facts({ readAt: 'x', resolvedAt: 'y' }))).toBe('RESOLVED');
    expect(notificationState(facts({ dismissedAt: 'y' }))).toBe('DISMISSED');
  });

  it('keeps a read task open — seeing a task is not doing it', () => {
    expect(isOpenAction(facts({ readAt: 'x' }))).toBe(true);
  });

  it('closes a task once resolved or dismissed', () => {
    expect(isOpenAction(facts({ resolvedAt: 'x' }))).toBe(false);
    expect(isOpenAction(facts({ dismissedAt: 'x' }))).toBe(false);
  });

  it('never counts a plain notice as an open action', () => {
    expect(isOpenAction(facts({ requiresAction: false }))).toBe(false);
  });

  it('refuses to resolve something that was never a task', () => {
    expect(notificationTransitionRefusal(facts({ requiresAction: false }), 'resolve'))
      .toMatch(/not a task/);
  });

  it('allows read at any point, including on a closed task', () => {
    expect(notificationTransitionRefusal(facts({ resolvedAt: 'x' }), 'read')).toBeNull();
  });

  it('does not reopen: resolve and dismiss are terminal', () => {
    // A recurring event arrives as a new row with a new dedupe key. Reopening
    // would lose when the task was first raised, which is the number "how long
    // has this been outstanding" depends on.
    expect(notificationTransitionRefusal(facts({ resolvedAt: 'x' }), 'resolve'))
      .toMatch(/already resolved/);
    expect(notificationTransitionRefusal(facts({ dismissedAt: 'x' }), 'resolve'))
      .toMatch(/already dismissed/);
    expect(notificationTransitionRefusal(facts({ resolvedAt: 'x' }), 'dismiss'))
      .toMatch(/already resolved/);
  });
});

describe('dedupe key', () => {
  it('keys on the event and the recipient together', () => {
    expect(notificationDedupeKey('work.submitted', 'log-1', 'user-1'))
      .toBe('work.submitted:log-1:user-1');
  });

  it('separates two recipients of the same event', () => {
    // A fan-out that failed halfway through must be able to finish. Keying on the
    // event alone would make the retry skip the recipients it never reached.
    expect(notificationDedupeKey('work.submitted', 'log-1', 'user-1'))
      .not.toBe(notificationDedupeKey('work.submitted', 'log-1', 'user-2'));
  });
});

describe('preferences', () => {
  it('defaults to no quiet hours and immediate delivery', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES.quietHoursStart).toBeNull();
    expect(DEFAULT_NOTIFICATION_PREFERENCES.digest).toBe('IMMEDIATE');
    expect(DEFAULT_NOTIFICATION_PREFERENCES.channels).toEqual({});
  });

  it('refuses half a quiet-hours window', () => {
    const half = updateNotificationPreferencesSchema.safeParse({
      quietHoursStart: '22:00',
      quietHoursEnd: null,
    });
    expect(half.success).toBe(false);
  });

  it('accepts both ends, or neither', () => {
    expect(
      updateNotificationPreferencesSchema.safeParse({
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
      }).success
    ).toBe(true);
    expect(
      updateNotificationPreferencesSchema.safeParse({
        quietHoursStart: null,
        quietHoursEnd: null,
      }).success
    ).toBe(true);
  });

  it('rejects a time that is not HH:MM on a 24-hour clock', () => {
    for (const bad of ['24:00', '7:00', '22:60', 'evening']) {
      expect(
        updateNotificationPreferencesSchema.safeParse({
          quietHoursStart: bad,
          quietHoursEnd: '07:00',
        }).success
      ).toBe(false);
    }
  });
});
