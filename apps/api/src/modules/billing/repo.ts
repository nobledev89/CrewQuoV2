import type {
  BillingOverview,
  BillingPlan,
  BillingSubscription,
  Entitlements,
  FeatureKey,
  LimitKey,
  SubscriptionStatus,
} from '@crewquo/shared';
import { effectiveCompanyRequestStatus, type CompanyRequestStatus } from '@crewquo/shared';
import { query, queryOne } from '../../db';
import { env } from '../../env';
import { AppError } from '../../http/errors';
import { getPlatformSettings } from '../admin/platform.repo';
import { recordAudit } from '../audit/record';
import {
  cancelPaddleSubscription,
  changePaddleSubscriptionPrice,
  createPaddleTransaction,
  fetchPaddleManagementUrls,
  PaddleApiError,
  resumePaddleSubscription,
} from './paddle';
import { applyPaddleSubscription, parsePaddleSubscription } from './reconcile';

interface PriceRow {
  id: string;
  plan_id: string;
  provider_price_id: string | null;
}

interface SubscriptionRow {
  plan_id: string;
  status: SubscriptionStatus;
  currency: string | null;
  interval: 'MONTH' | 'YEAR' | null;
  current_period_end: Date | null;
  trial_end: Date | null;
  cancel_at_period_end: boolean;
  provider: string | null;
  provider_subscription_id: string | null;
  provider_price_id: string | null;
}

const SUBSCRIPTION_COLUMNS = `plan_id, status, currency, interval, current_period_end, trial_end,
  cancel_at_period_end, provider, provider_subscription_id, provider_price_id`;

/**
 * A subscription a customer may act on themselves.
 *
 * Both halves matter. `provider = 'PADDLE'` without a subscription id is a
 * checkout that never completed; a super admin's hand-set plan or comped trial
 * has no provider at all. In either case the self-service buttons would call
 * Paddle with nothing to name, so the answer is to not offer them.
 */
function isSelfManageable(row: SubscriptionRow): boolean {
  return row.provider === 'PADDLE' && row.provider_subscription_id !== null;
}

function toSubscriptionView(row: SubscriptionRow): BillingSubscription {
  return {
    planId: row.plan_id,
    status: row.status,
    currency: row.currency === 'USD' ? 'USD' : null,
    interval: row.interval,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    trialEnd: row.trial_end?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    provider: row.provider === 'PADDLE' ? 'PADDLE' : null,
    selfManageable: isSelfManageable(row),
  };
}

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  trial_days: number;
  operates_downstream: boolean;
}

interface CatalogPriceRow {
  id: string;
  plan_id: string;
  interval: 'MONTH' | 'YEAR';
  amount_cents: number;
}

/**
 * Assemble the customer-facing plan catalog. Provider identifiers never leave
 * the API, so the caller decides which prices to pass in and nothing here can
 * leak a `pri_…`.
 */
function toPlanViews(
  plans: PlanRow[],
  prices: CatalogPriceRow[],
  features: { plan_id: string; feature_key: FeatureKey }[],
  limits: { plan_id: string; limit_key: LimitKey; value: number | null }[]
): BillingPlan[] {
  return plans.map((plan) => {
    const limitMap: Partial<Record<LimitKey, number | null>> = {};
    for (const row of limits) if (row.plan_id === plan.id) limitMap[row.limit_key] = row.value;
    const entitlements: Entitlements = {
      planId: plan.id,
      operatesDownstream: plan.operates_downstream,
      features: features.filter((row) => row.plan_id === plan.id).map((row) => row.feature_key),
      limits: limitMap as Record<LimitKey, number | null>,
    };
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      trialDays: plan.trial_days,
      entitlements,
      prices: prices.filter((price) => price.plan_id === plan.id).map((price) => ({
        id: price.id,
        interval: price.interval,
        amountCents: price.amount_cents,
        currency: 'USD' as const,
      })),
    };
  });
}

const PUBLIC_PLANS_SQL = `select id, name, description, trial_days, operates_downstream
   from plans where status = 'ACTIVE' and is_public = true order by sort_order, id`;
const PLAN_FEATURES_SQL = `select plan_id, feature_key from plan_features order by feature_key`;
const PLAN_LIMITS_SQL = `select plan_id, limit_key, value from plan_limits order by limit_key`;

export async function getBillingOverview(companyId: string): Promise<BillingOverview> {
  const [settings, plans, prices, features, limits, subscription] = await Promise.all([
    getPlatformSettings(),
    query<PlanRow>(PUBLIC_PLANS_SQL),
    query<CatalogPriceRow>(
      `select id, plan_id, interval, amount_cents from plan_prices
        where active = true and currency = 'USD' and amount_cents > 0
          and provider_price_id is not null order by interval`
    ),
    query<{ plan_id: string; feature_key: FeatureKey }>(PLAN_FEATURES_SQL),
    query<{ plan_id: string; limit_key: LimitKey; value: number | null }>(PLAN_LIMITS_SQL),
    queryOne<SubscriptionRow>(
      `select ${SUBSCRIPTION_COLUMNS} from company_subscriptions where company_id = $1`,
      [companyId]
    ),
  ]);

  return {
    checkoutEnabled: settings.companyCheckoutEnabled && Boolean(env.PADDLE_API_KEY),
    plans: toPlanViews(plans, prices, features, limits),
    subscription: subscription ? toSubscriptionView(subscription) : null,
  };
}

/**
 * The unauthenticated pricing catalog.
 *
 * Unlike the company-scoped overview this does **not** require a
 * `provider_price_id`: a price is the product's price, and whether the merchant
 * account has been wired up to charge it is an operational fact about us, not a
 * fact about the plan. Hiding published prices until the plumbing is finished
 * would leave a pricing page that says nothing about pricing.
 */
export async function getPublicPricing(): Promise<{ plans: BillingPlan[] }> {
  const [plans, prices, features, limits] = await Promise.all([
    query<PlanRow>(PUBLIC_PLANS_SQL),
    query<CatalogPriceRow>(
      `select id, plan_id, interval, amount_cents from plan_prices
        where active = true and currency = 'USD' order by interval`
    ),
    query<{ plan_id: string; feature_key: FeatureKey }>(PLAN_FEATURES_SQL),
    query<{ plan_id: string; limit_key: LimitKey; value: number | null }>(PLAN_LIMITS_SQL),
  ]);
  return { plans: toPlanViews(plans, prices, features, limits) };
}

/** A price a checkout may actually be started against. */
async function findPurchasablePrice(priceId: string): Promise<PriceRow & { provider_price_id: string }> {
  const price = await queryOne<PriceRow>(
    `select pp.id, pp.plan_id, pp.provider_price_id
       from plan_prices pp join plans p on p.id = pp.plan_id
      where pp.id = $1 and pp.active = true and pp.currency = 'USD'
        and pp.amount_cents > 0 and pp.provider_price_id is not null
        and p.status = 'ACTIVE' and p.is_public = true`,
    [priceId]
  );
  if (!price?.provider_price_id) throw new AppError('NOT_FOUND', 'That price is not available');
  return { ...price, provider_price_id: price.provider_price_id };
}

function requireCheckoutConfigured(settings: { companyCheckoutEnabled: boolean }): void {
  if (!settings.companyCheckoutEnabled) {
    throw new AppError('CONFLICT', 'Checkout is currently disabled by the platform operator');
  }
  if (!env.PADDLE_API_KEY) {
    throw new AppError('CONFLICT', 'Checkout is not configured yet');
  }
}

/**
 * Create the Paddle transaction and record the attempt either way.
 *
 * The row is inserted *before* the provider call so a failure has somewhere to be
 * written down: a checkout that Paddle refused is the thing support is asked
 * about, and it is invisible if the only record of it was going to be created on
 * success.
 */
async function startProviderCheckout(input: {
  companyId: string | null;
  companyRequestId: string | null;
  userId: string;
  price: PriceRow & { provider_price_id: string };
}): Promise<{ transactionId: string; checkoutUrl: string }> {
  const checkout = await queryOne<{ id: string }>(
    `insert into billing_checkouts
       (company_id, company_creation_request_id, requested_by_user_id, plan_price_id, provider)
     values ($1, $2, $3, $4, 'PADDLE') returning id`,
    [input.companyId, input.companyRequestId, input.userId, input.price.id]
  );
  if (!checkout) throw new AppError('INTERNAL', 'Could not create the checkout attempt');

  try {
    const created = await createPaddleTransaction({
      providerPriceId: input.price.provider_price_id,
      checkoutId: checkout.id,
      companyId: input.companyId,
      companyRequestId: input.companyRequestId,
      planId: input.price.plan_id,
      planPriceId: input.price.id,
      userId: input.userId,
    });
    await query(
      `update billing_checkouts set provider_transaction_id = $2, checkout_url = $3,
              status = 'PENDING', updated_at = now() where id = $1`,
      [checkout.id, created.transactionId, created.checkoutUrl]
    );
    return created;
  } catch (error) {
    const message = error instanceof PaddleApiError ? error.message : 'Paddle checkout creation failed';
    await query(
      `update billing_checkouts set status = 'FAILED', failure_reason = $2, updated_at = now()
        where id = $1`,
      [checkout.id, message.slice(0, 1000)]
    );
    throw new AppError('INTERNAL', 'Checkout could not be started. Please try again.');
  }
}

export async function startCheckout(input: {
  companyId: string;
  userId: string;
  priceId: string;
}): Promise<{ transactionId: string; checkoutUrl: string }> {
  requireCheckoutConfigured(await getPlatformSettings());
  const price = await findPurchasablePrice(input.priceId);

  const current = await queryOne<{ provider_subscription_id: string | null; status: string }>(
    `select provider_subscription_id, status from company_subscriptions where company_id = $1`,
    [input.companyId]
  );
  if (current?.provider_subscription_id && current.status !== 'CANCELED') {
    throw new AppError(
      'CONFLICT',
      'This company already has a provider-managed subscription. Change its plan instead of buying a second one.'
    );
  }

  return startProviderCheckout({
    companyId: input.companyId,
    companyRequestId: null,
    userId: input.userId,
    price,
  });
}

/**
 * `POST /v1/company-creation-requests/:id/checkout` — the paid arm of §3.1.1(3).
 *
 * The request is the subject, not a company, because the whole point of the
 * safeguard is that the tenant does not exist until the authority to create it
 * has been obtained. Completing this transaction is what moves the request
 * `PENDING_CHECKOUT → APPROVED` (see `approveRequestForCheckout`); creating the
 * company from that approval is still a separate, deliberate act by the customer.
 */
export async function startRequestCheckout(input: {
  requestId: string;
  userId: string;
  priceId: string;
}): Promise<{ transactionId: string; checkoutUrl: string }> {
  // Order of refusals is the policy, and it runs from most fundamental to least:
  // whose request this is, then whether it is awaiting payment, then whether we
  // can take payment at all. Checking configuration first would answer somebody
  // poking at a stranger's request id with a report on our merchant setup.
  //
  // Scoped to the caller, so somebody else's request id is a 404 rather than a
  // 403 — a 403 would confirm the request exists.
  const request = await queryOne<{
    id: string;
    status: CompanyRequestStatus;
    approval_route: 'CHECKOUT' | 'ADMIN';
    intended_plan_id: string | null;
    expires_at: Date;
    legal_name: string;
  }>(
    `select id, status, approval_route, intended_plan_id, expires_at, legal_name
       from company_creation_requests where id = $1 and user_id = $2`,
    [input.requestId, input.userId]
  );
  if (!request) throw new AppError('NOT_FOUND', 'Request not found');

  const status = effectiveCompanyRequestStatus(request.status, request.expires_at, new Date());
  if (status !== 'PENDING_CHECKOUT') {
    throw new AppError(
      'CONFLICT',
      status === 'EXPIRED'
        ? 'This request expired before it was paid for. File a new one.'
        : `This request is already ${status.toLowerCase()} and does not need paying for.`
    );
  }

  requireCheckoutConfigured(await getPlatformSettings());

  const price = await findPurchasablePrice(input.priceId);
  // The reviewed intent wins over what the button sends. A request filed for one
  // plan and paid at another price would leave the approval, the charge and the
  // eventual subscription describing three different purchases.
  if (request.intended_plan_id && request.intended_plan_id !== price.plan_id) {
    throw new AppError(
      'VALIDATION',
      `This request was filed for the ${request.intended_plan_id} plan. Pay for that plan, or file a new request.`,
      { intendedPlanId: request.intended_plan_id }
    );
  }

  const live = await queryOne<{ id: string; checkout_url: string | null; provider_transaction_id: string | null }>(
    `select id, checkout_url, provider_transaction_id from billing_checkouts
      where company_creation_request_id = $1 and status in ('CREATING','PENDING')`,
    [request.id]
  );
  // Hand back the attempt already in flight rather than creating a second one:
  // the partial unique index would refuse the insert anyway, and a 409 to
  // somebody who simply clicked twice is a worse answer than the checkout they
  // asked for.
  if (live?.checkout_url && live.provider_transaction_id) {
    return { transactionId: live.provider_transaction_id, checkoutUrl: live.checkout_url };
  }
  if (live) {
    throw new AppError('CONFLICT', 'A checkout for this request is still being created. Try again shortly.');
  }

  return startProviderCheckout({
    companyId: null,
    companyRequestId: request.id,
    userId: input.userId,
    price,
  });
}

// ── Self-management (§3.1.1, §5B) ─────────────────────────────────────────────

/**
 * Load the subscription a self-service action is about, refusing the two cases
 * where the action cannot mean anything.
 *
 * Deliberately a `CONFLICT` rather than a `NOT_FOUND`: the company's plan is
 * real, and telling somebody their subscription does not exist when what is true
 * is *"this one is not ours to change"* sends them looking for a bug.
 */
async function requireProviderSubscription(companyId: string): Promise<{
  row: SubscriptionRow;
  providerSubscriptionId: string;
}> {
  const row = await queryOne<SubscriptionRow>(
    `select ${SUBSCRIPTION_COLUMNS} from company_subscriptions where company_id = $1`,
    [companyId]
  );
  if (!row) {
    throw new AppError('CONFLICT', 'This company has no subscription to manage. It is on the free plan.');
  }
  if (!isSelfManageable(row) || !row.provider_subscription_id) {
    throw new AppError(
      'CONFLICT',
      'This plan was set by CrewQuo support rather than bought through Paddle, so it cannot be ' +
        'changed here. Contact support to change it.'
    );
  }
  // Checked here rather than left to the provider call, which would refuse with
  // "Paddle refused this change" — a sentence that sends the customer looking for
  // a problem with their card when the problem is our own configuration.
  if (!env.PADDLE_API_KEY) {
    throw new AppError(
      'CONFLICT',
      'Subscription changes are not available yet. Contact support and nothing will be charged.'
    );
  }
  return { row, providerSubscriptionId: row.provider_subscription_id };
}

/**
 * Write the subscription object Paddle just returned, then read it back.
 *
 * The response to a cancel or a plan change *is* the authoritative subscription,
 * so it goes through the same writer the webhook uses rather than a second,
 * nearly-identical mapping. `updated_at` is the ordering key for the same reason
 * the webhook uses `occurred_at`: it is the provider's clock, so a genuinely
 * newer webhook still wins and this write cannot shadow it.
 */
async function applyProviderResponse(
  companyId: string,
  data: unknown
): Promise<BillingSubscription | null> {
  try {
    const subscription = parsePaddleSubscription(data);
    await applyPaddleSubscription({
      subscription,
      companyId,
      occurredAt: subscription.updated_at ?? new Date().toISOString(),
      eventId: `api:${subscription.id}:${subscription.updated_at ?? 'now'}`,
      firstSight: false,
    });
  } catch (error) {
    // The provider accepted the change; only our local projection of it failed.
    // Losing the customer's action here would be the wrong answer — the webhook
    // for the same change is still coming, and it is the authority anyway.
    console.error('[billing] could not apply the Paddle response locally:', error);
  }
  const row = await queryOne<SubscriptionRow>(
    `select ${SUBSCRIPTION_COLUMNS} from company_subscriptions where company_id = $1`,
    [companyId]
  );
  return row ? toSubscriptionView(row) : null;
}

function providerFailure(error: unknown): AppError {
  if (error instanceof PaddleApiError) {
    return new AppError(
      error.retryable ? 'INTERNAL' : 'CONFLICT',
      error.retryable
        ? 'Paddle could not be reached. Nothing was changed — please try again.'
        : 'Paddle refused this change. Nothing was changed.'
    );
  }
  return new AppError('INTERNAL', 'The subscription could not be changed.');
}

export async function cancelSubscription(input: {
  companyId: string;
  userId: string;
}): Promise<{ subscription: BillingSubscription | null; message: string }> {
  const { row, providerSubscriptionId } = await requireProviderSubscription(input.companyId);
  if (row.status === 'CANCELED') {
    throw new AppError('CONFLICT', 'This subscription is already cancelled.');
  }
  if (row.cancel_at_period_end) {
    throw new AppError('CONFLICT', 'This subscription is already scheduled to cancel.');
  }

  let data: unknown;
  try {
    data = await cancelPaddleSubscription(providerSubscriptionId);
  } catch (error) {
    throw providerFailure(error);
  }

  const subscription = await applyProviderResponse(input.companyId, data);
  await recordAudit({
    companyId: input.companyId,
    actorUserId: input.userId,
    action: 'subscription.cancel_scheduled',
    entityType: 'SUBSCRIPTION',
    entityId: input.companyId,
    changes: { planId: row.plan_id, effectiveFrom: 'next_billing_period' },
    description: 'Subscription scheduled to cancel at the end of the paid period',
  });

  return {
    subscription,
    message:
      subscription?.currentPeriodEnd
        ? `Cancelled. Your plan stays active until ${subscription.currentPeriodEnd.slice(0, 10)} and will not renew.`
        : 'Cancelled. Your plan stays active until the end of the period you have paid for.',
  };
}

export async function resumeSubscription(input: {
  companyId: string;
  userId: string;
}): Promise<{ subscription: BillingSubscription | null; message: string }> {
  const { row, providerSubscriptionId } = await requireProviderSubscription(input.companyId);
  if (!row.cancel_at_period_end) {
    throw new AppError('CONFLICT', 'This subscription is not scheduled to cancel.');
  }

  let data: unknown;
  try {
    data = await resumePaddleSubscription(providerSubscriptionId);
  } catch (error) {
    throw providerFailure(error);
  }

  const subscription = await applyProviderResponse(input.companyId, data);
  await recordAudit({
    companyId: input.companyId,
    actorUserId: input.userId,
    action: 'subscription.cancel_withdrawn',
    entityType: 'SUBSCRIPTION',
    entityId: input.companyId,
    changes: { planId: row.plan_id },
    description: 'Scheduled cancellation withdrawn; the subscription will renew',
  });

  return { subscription, message: 'Your subscription will renew as normal.' };
}

export async function changeSubscriptionPrice(input: {
  companyId: string;
  userId: string;
  priceId: string;
}): Promise<{ subscription: BillingSubscription | null; message: string }> {
  const { row, providerSubscriptionId } = await requireProviderSubscription(input.companyId);
  if (row.status === 'CANCELED') {
    throw new AppError('CONFLICT', 'This subscription is cancelled. Start a new checkout instead.');
  }
  const price = await findPurchasablePrice(input.priceId);
  // Compared on the *provider* price id, which is the identity Paddle is holding.
  // Comparing plan ids would refuse a monthly-to-yearly move on the same plan,
  // which is the most common change there is.
  if (price.provider_price_id === row.provider_price_id) {
    throw new AppError('CONFLICT', 'This subscription is already on that price.');
  }

  let data: unknown;
  try {
    data = await changePaddleSubscriptionPrice(providerSubscriptionId, price.provider_price_id);
  } catch (error) {
    throw providerFailure(error);
  }

  const subscription = await applyProviderResponse(input.companyId, data);
  await recordAudit({
    companyId: input.companyId,
    actorUserId: input.userId,
    action: 'subscription.plan_changed',
    entityType: 'SUBSCRIPTION',
    entityId: input.companyId,
    changes: { before: { planId: row.plan_id, interval: row.interval }, after: { planId: price.plan_id } },
    description: `Subscription moved from ${row.plan_id} to ${price.plan_id}`,
  });

  return {
    subscription,
    message: `Moved to ${price.plan_id}. Paddle has prorated the difference against the current period.`,
  };
}

export async function getPaymentMethodUpdateUrl(
  companyId: string
): Promise<{ updatePaymentMethodUrl: string | null }> {
  const { providerSubscriptionId } = await requireProviderSubscription(companyId);
  try {
    const urls = await fetchPaddleManagementUrls(providerSubscriptionId);
    return { updatePaymentMethodUrl: urls.updatePaymentMethod };
  } catch (error) {
    throw providerFailure(error);
  }
}
