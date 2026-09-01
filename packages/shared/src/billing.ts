import { z } from 'zod';
import { entitlementsSchema } from './entitlements';
import { priceIntervalSchema, subscriptionStatusSchema } from './enums';

/** Customer-safe plan and price data. Provider identifiers never leave the API. */
export const billingPriceSchema = z.object({
  id: z.string().uuid(),
  interval: priceIntervalSchema,
  amountCents: z.number().int().nonnegative(),
  currency: z.literal('USD'),
});
export type BillingPrice = z.infer<typeof billingPriceSchema>;

export const billingPlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  trialDays: z.number().int().nonnegative(),
  entitlements: entitlementsSchema,
  prices: z.array(billingPriceSchema),
});
export type BillingPlan = z.infer<typeof billingPlanSchema>;

export const billingSubscriptionSchema = z.object({
  planId: z.string(),
  status: subscriptionStatusSchema,
  currency: z.literal('USD').nullable(),
  interval: priceIntervalSchema.nullable(),
  currentPeriodEnd: z.string().nullable(),
  trialEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  /** The merchant of record holding this subscription, when one does. */
  provider: z.enum(['PADDLE']).nullable(),
  /**
   * Whether the customer may cancel, resume, change plan or replace a card
   * themselves.
   *
   * False for the subscriptions a super admin set by hand and for comped trials:
   * those exist *because* somebody decided them outside the provider, and
   * offering a cancel button that calls Paddle with no subscription to cancel
   * would be a button that can only fail.
   */
  selfManageable: z.boolean(),
});
export type BillingSubscription = z.infer<typeof billingSubscriptionSchema>;

export const billingOverviewSchema = z.object({
  checkoutEnabled: z.boolean(),
  plans: z.array(billingPlanSchema),
  subscription: billingSubscriptionSchema.nullable(),
});
export type BillingOverview = z.infer<typeof billingOverviewSchema>;

export const billingCheckoutRequestSchema = z.object({
  priceId: z.string().uuid(),
});
export type BillingCheckoutRequest = z.infer<typeof billingCheckoutRequestSchema>;

export const billingCheckoutResponseSchema = z.object({
  transactionId: z.string(),
  checkoutUrl: z.string().url(),
});
export type BillingCheckoutResponse = z.infer<typeof billingCheckoutResponseSchema>;

export const billingSubscriptionActionResponseSchema = z.object({
  subscription: billingSubscriptionSchema.nullable(),
  /** What the provider was asked to do, in words a customer can act on. */
  message: z.string(),
});
export type BillingSubscriptionActionResponse = z.infer<
  typeof billingSubscriptionActionResponseSchema
>;

/**
 * Paddle's own hosted page for replacing a card, fetched on demand.
 *
 * Nullable because absent is a real answer: a manually-collected subscription has
 * no self-serve payment method, and a placeholder link would send somebody to a
 * page that cannot help them.
 */
export const billingPaymentMethodResponseSchema = z.object({
  updatePaymentMethodUrl: z.string().url().nullable(),
});
export type BillingPaymentMethodResponse = z.infer<typeof billingPaymentMethodResponseSchema>;

/**
 * `GET /v1/public/pricing` — the unauthenticated plan catalog behind the public
 * pricing page.
 *
 * Carries no platform flags. Whether checkout is switched on is an operator
 * setting, and a public endpoint that reports it is a public endpoint that
 * reports platform configuration to anybody who asks.
 */
export const publicPricingResponseSchema = z.object({
  plans: z.array(billingPlanSchema),
});
export type PublicPricingResponse = z.infer<typeof publicPricingResponseSchema>;
