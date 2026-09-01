import { describe, expect, it } from 'vitest';
import { paddleSubscriptionStatus, parsePaddleSubscription } from './reconcile';

describe('paddleSubscriptionStatus', () => {
  it('maps every Paddle lifecycle state to a CrewQuo entitlement state', () => {
    expect(paddleSubscriptionStatus('trialing')).toBe('TRIALING');
    expect(paddleSubscriptionStatus('active')).toBe('ACTIVE');
    expect(paddleSubscriptionStatus('past_due')).toBe('PAST_DUE');
    expect(paddleSubscriptionStatus('paused')).toBe('PAST_DUE');
    expect(paddleSubscriptionStatus('canceled')).toBe('CANCELED');
  });
});

describe('parsePaddleSubscription', () => {
  const base = {
    id: 'sub_1',
    status: 'active',
    customer_id: 'ctm_1',
    items: [{ price: { id: 'pri_1' } }],
  };

  it('reads an API response, including the fields only API responses carry', () => {
    // `updated_at` is what the API path uses as its ordering key, in place of a
    // webhook's `occurred_at`. Without it here, every cancel and plan change would
    // fall back to the local clock and could shadow a genuinely newer webhook.
    const parsed = parsePaddleSubscription({
      ...base,
      updated_at: '2026-08-31T10:00:00.000Z',
      scheduled_change: { action: 'cancel' },
    });
    expect(parsed.updated_at).toBe('2026-08-31T10:00:00.000Z');
    expect(parsed.scheduled_change?.action).toBe('cancel');
  });

  it('accepts a webhook-shaped object with no updated_at', () => {
    expect(parsePaddleSubscription(base).updated_at).toBeUndefined();
  });

  it('refuses an object it cannot map, rather than writing a half-read subscription', () => {
    // No items means no price, and no price means no plan — a subscription written
    // from this would silently be for whatever plan the query happened to return.
    expect(() => parsePaddleSubscription({ ...base, items: [] })).toThrow();
    expect(() => parsePaddleSubscription({ ...base, status: 'refunded' })).toThrow();
    expect(() => parsePaddleSubscription(null)).toThrow();
  });
});
