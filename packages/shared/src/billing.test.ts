import { describe, expect, it } from 'vitest';
import {
  billingPaymentMethodResponseSchema,
  billingSubscriptionSchema,
  publicPricingResponseSchema,
} from './billing';

const subscription = {
  planId: 'pro',
  status: 'ACTIVE',
  currency: 'USD',
  interval: 'MONTH',
  currentPeriodEnd: '2026-09-30T00:00:00.000Z',
  trialEnd: null,
  cancelAtPeriodEnd: false,
  provider: 'PADDLE',
  selfManageable: true,
};

describe('billingSubscriptionSchema', () => {
  it('carries who holds the subscription and whether the customer may change it', () => {
    const parsed = billingSubscriptionSchema.parse(subscription);
    expect(parsed.provider).toBe('PADDLE');
    expect(parsed.selfManageable).toBe(true);
  });

  it('describes a support-set plan as having no provider and no self-service', () => {
    // A comped trial or a hand-set plan exists *because* somebody decided it
    // outside the provider. Offering a cancel button for it would be a button
    // whose only possible outcome is an error.
    const parsed = billingSubscriptionSchema.parse({
      ...subscription,
      provider: null,
      selfManageable: false,
    });
    expect(parsed.provider).toBeNull();
    expect(parsed.selfManageable).toBe(false);
  });

  it('will not parse a subscription that omits either new field', () => {
    // Both are required rather than defaulted: a default would silently decide
    // whether a screen shows destructive billing controls.
    const { provider: _provider, ...noProvider } = subscription;
    const { selfManageable: _self, ...noSelfManageable } = subscription;
    expect(billingSubscriptionSchema.safeParse(noProvider).success).toBe(false);
    expect(billingSubscriptionSchema.safeParse(noSelfManageable).success).toBe(false);
  });

  it('refuses a currency other than USD, because nothing converts one', () => {
    expect(billingSubscriptionSchema.safeParse({ ...subscription, currency: 'GBP' }).success)
      .toBe(false);
  });
});

describe('publicPricingResponseSchema', () => {
  const plan = {
    id: 'crew',
    name: 'Crew',
    description: 'Be a subcontractor.',
    trialDays: 0,
    entitlements: {
      planId: 'crew',
      operatesDownstream: false,
      features: [],
      limits: {
        active_subcontractors: 0,
        internal_seats: 1,
        clients: 0,
        audit_retention_days: 0,
      },
    },
    prices: [],
  };

  it('accepts a plan with no price at all — that is how the free plan is modelled', () => {
    const parsed = publicPricingResponseSchema.parse({ plans: [plan] });
    expect(parsed.plans[0]!.prices).toEqual([]);
  });

  it('accepts a USD price and refuses any other currency', () => {
    const priced = {
      ...plan,
      prices: [{ id: '11111111-1111-4111-8111-111111111111', interval: 'MONTH', amountCents: 4700, currency: 'USD' }],
    };
    expect(publicPricingResponseSchema.safeParse({ plans: [priced] }).success).toBe(true);
    expect(
      publicPricingResponseSchema.safeParse({
        plans: [{ ...priced, prices: [{ ...priced.prices[0], currency: 'EUR' }] }],
      }).success
    ).toBe(false);
  });

  it('carries no platform flags, so a public read cannot leak operator settings', () => {
    const parsed = publicPricingResponseSchema.parse({
      plans: [plan],
      checkoutEnabled: true,
    } as unknown);
    // Zod strips unknown keys, so even a server that starts sending one cannot
    // publish it through this contract.
    expect('checkoutEnabled' in parsed).toBe(false);
    expect(Object.keys(parsed)).toEqual(['plans']);
  });
});

describe('billingPaymentMethodResponseSchema', () => {
  it('allows a null URL, because absent is a real answer', () => {
    expect(billingPaymentMethodResponseSchema.parse({ updatePaymentMethodUrl: null })
      .updatePaymentMethodUrl).toBeNull();
  });

  it('refuses anything that is not a URL', () => {
    expect(billingPaymentMethodResponseSchema.safeParse({ updatePaymentMethodUrl: 'later' }).success)
      .toBe(false);
  });
});
