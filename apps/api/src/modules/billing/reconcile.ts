import { entitlementsSchema, type Entitlements, type FeatureKey, type LimitKey, type SubscriptionStatus } from '@crewquo/shared';
import { z } from 'zod';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { DeferredDeliveryError, PermanentDeliveryError } from '../delivery/model';
import type { InboxEvent } from '../delivery/repo';
import { recordPlatformAudit } from '../admin/platform.repo';

const customDataSchema = z.record(z.unknown()).nullable().optional();
const paddleSubscriptionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['trialing', 'active', 'past_due', 'paused', 'canceled']),
  customer_id: z.string().min(1),
  items: z.array(z.object({ price: z.object({ id: z.string().min(1) }) })).min(1),
  current_billing_period: z.object({ ends_at: z.string().datetime() }).nullable().optional(),
  trial_dates: z.object({ ends_at: z.string().datetime() }).nullable().optional(),
  scheduled_change: z.object({ action: z.string() }).nullable().optional(),
  /** Present on API responses; webhooks carry the same clock as `occurred_at`. */
  updated_at: z.string().datetime().nullable().optional(),
  custom_data: customDataSchema,
});
export type PaddleSubscription = z.infer<typeof paddleSubscriptionSchema>;

const paddleTransactionSchema = z.object({
  id: z.string().min(1),
  custom_data: customDataSchema,
});

const paddleEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string().datetime(),
  data: z.record(z.unknown()),
});

/**
 * How long a paid additional-company subscription waits for its company to be
 * created (see `DeferredDeliveryError`).
 *
 * Fifteen minutes rather than something tighter because the wait is on a person,
 * not a service — and it is not the *only* wake-up: creating the company from
 * the approval makes the parked event available immediately, so this interval is
 * the fallback for the paths that do not go through that code.
 */
const REQUEST_WAIT_SECONDS = 15 * 60;

export function paddleSubscriptionStatus(status: PaddleSubscription['status']): SubscriptionStatus {
  switch (status) {
    case 'trialing': return 'TRIALING';
    case 'active': return 'ACTIVE';
    case 'canceled': return 'CANCELED';
    case 'past_due':
    case 'paused': return 'PAST_DUE';
  }
}

/** Parse a subscription object from an API response. Throws on an unusable shape. */
export function parsePaddleSubscription(data: unknown): PaddleSubscription {
  const parsed = paddleSubscriptionSchema.safeParse(data);
  if (!parsed.success) throw new Error('Paddle returned an unreadable subscription');
  return parsed.data;
}

function customString(custom: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = custom?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function customUuid(
  custom: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = customString(custom, key);
  if (value === null) return null;
  if (!z.string().uuid().safeParse(value).success) {
    throw new PermanentDeliveryError(`Paddle custom data '${key}' is malformed`);
  }
  return value;
}

async function snapshotForPlan(planId: string, runner: Queryable): Promise<Entitlements> {
  const plan = await queryOne<{ id: string; operates_downstream: boolean }>(
    `select id, operates_downstream from plans where id = $1`, [planId], runner
  );
  if (!plan) throw new Error(`Plan '${planId}' no longer exists`);
  const [features, limits] = await Promise.all([
    query<{ feature_key: FeatureKey }>(
      `select feature_key from plan_features where plan_id = $1 order by feature_key`, [planId], runner
    ),
    query<{ limit_key: LimitKey; value: number | null }>(
      `select limit_key, value from plan_limits where plan_id = $1 order by limit_key`, [planId], runner
    ),
  ]);
  const limitMap: Partial<Record<LimitKey, number | null>> = {};
  for (const row of limits) limitMap[row.limit_key] = row.value;
  return entitlementsSchema.parse({
    planId,
    operatesDownstream: plan.operates_downstream,
    features: features.map((row) => row.feature_key),
    limits: limitMap,
  });
}

/**
 * The one writer of `company_subscriptions` from provider state.
 *
 * Shared by the webhook reconciler and by the routes that act on a subscription
 * through Paddle's API, because a PATCH response *is* the authoritative
 * subscription object — mapping it twice would be two chances to disagree about
 * what `paused` means. Both callers pass the provider's own clock as
 * `occurredAt`, which is what makes the ordering guard below work across the two
 * paths rather than within each one.
 */
export async function applyPaddleSubscription(input: {
  subscription: PaddleSubscription;
  companyId: string;
  occurredAt: string;
  eventId: string;
  /** True when CrewQuo has never recorded this provider subscription before. */
  firstSight: boolean;
}): Promise<void> {
  const data = input.subscription;
  const providerPriceIds = data.items.map((item) => item.price.id);
  const price = await queryOne<{
    id: string;
    plan_id: string;
    interval: 'MONTH' | 'YEAR';
    currency: string;
    provider_price_id: string;
  }>(
    `select id, plan_id, interval, currency, provider_price_id from plan_prices
      where provider_price_id = any($1::text[])
      order by updated_at desc limit 1`,
    [providerPriceIds]
  );
  // This is retryable: an operator can attach the missing Paddle price id, then
  // replay the dead letter from the existing admin operations screen.
  if (!price) throw new Error(`No active CrewQuo price maps Paddle prices ${providerPriceIds.join(', ')}`);
  if (price.currency !== 'USD') throw new PermanentDeliveryError('Paddle checkout must reconcile to USD');

  // Checked only at first sight, and that limit is the point: `custom_data` is
  // frozen at purchase, so after a legitimate plan change it names the *previous*
  // price for the rest of the subscription's life. Enforcing it every time would
  // turn every renewal of an upgraded subscription into a permanent failure.
  if (input.firstSight) {
    const customPriceId = customUuid(data.custom_data, 'crewquo_plan_price_id');
    if (customPriceId && customPriceId !== price.id) {
      throw new PermanentDeliveryError('Paddle subscription price identity does not match its item');
    }
  }

  await withTransaction(async (client) => {
    const current = await queryOne<{ provider_updated_at: Date | null; provider_event_id: string | null }>(
      `select provider_updated_at, provider_event_id from company_subscriptions
        where company_id = $1 for update`,
      [input.companyId],
      client
    );
    const occurredAt = new Date(input.occurredAt);
    if (current?.provider_updated_at) {
      const delta = current.provider_updated_at.getTime() - occurredAt.getTime();
      if (delta > 0 || (delta === 0 && (current.provider_event_id ?? '') >= input.eventId)) return;
    }

    const snapshot = await snapshotForPlan(price.plan_id, client);
    await query(
      `insert into company_subscriptions
         (company_id, plan_id, status, currency, interval, current_period_end, trial_end,
          provider, provider_customer_id, provider_price_id, provider_subscription_id,
          provider_status, provider_updated_at, provider_event_id, cancel_at_period_end,
          entitlements_snapshot)
       values ($1,$2,$3,'USD',$4,$5,$6,'PADDLE',$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
       on conflict (company_id) do update set
         plan_id = excluded.plan_id, status = excluded.status, currency = excluded.currency,
         interval = excluded.interval, current_period_end = excluded.current_period_end,
         trial_end = excluded.trial_end, provider = excluded.provider,
         provider_customer_id = excluded.provider_customer_id,
         provider_price_id = excluded.provider_price_id,
         provider_subscription_id = excluded.provider_subscription_id,
         provider_status = excluded.provider_status,
         provider_updated_at = excluded.provider_updated_at,
         provider_event_id = excluded.provider_event_id,
         cancel_at_period_end = excluded.cancel_at_period_end,
         entitlements_snapshot = excluded.entitlements_snapshot, updated_at = now()`,
      [
        input.companyId,
        price.plan_id,
        paddleSubscriptionStatus(data.status),
        price.interval,
        data.current_billing_period?.ends_at ?? null,
        data.trial_dates?.ends_at ?? null,
        data.customer_id,
        price.provider_price_id,
        data.id,
        data.status,
        input.occurredAt,
        input.eventId,
        data.scheduled_change?.action === 'cancel',
        JSON.stringify(snapshot),
      ],
      client
    );

    const checkoutId = customUuid(data.custom_data, 'crewquo_checkout_id');
    if (checkoutId) {
      // The company clause survives for a company-scoped attempt and is skipped
      // for a request-scoped one, whose `company_id` is null by design. Dropping
      // it outright would have let a mismatched checkout id — ours, but for
      // somebody else's tenant — be marked completed here.
      await query(
        `update billing_checkouts set status = 'COMPLETED', updated_at = now()
          where id = $1 and status in ('CREATING','PENDING')
            and (company_id is null or company_id = $2)`,
        [checkoutId, input.companyId],
        client
      );
    }
  });
}

/**
 * Which company does this subscription belong to?
 *
 * Three sources, in order of how much they can be trusted: the subscription we
 * have already seen, the company id we sent to Paddle, and — for an
 * additional-company purchase — the *request* we sent, whose company does not
 * exist at the moment the money is taken.
 */
async function resolveCompanyForSubscription(
  data: PaddleSubscription
): Promise<{ companyId: string; firstSight: boolean }> {
  const existing = await queryOne<{ company_id: string }>(
    `select company_id from company_subscriptions
      where provider = 'PADDLE' and provider_subscription_id = $1`,
    [data.id]
  );
  const customCompanyId = customUuid(data.custom_data, 'crewquo_company_id');
  if (existing && customCompanyId && existing.company_id !== customCompanyId) {
    throw new PermanentDeliveryError('Paddle subscription company identity changed');
  }
  if (existing) return { companyId: existing.company_id, firstSight: false };
  if (customCompanyId) return { companyId: customCompanyId, firstSight: true };

  const requestId = customUuid(data.custom_data, 'crewquo_company_request_id');
  if (requestId) {
    const request = await queryOne<{ status: string; company_id: string | null; expires_at: Date }>(
      `select status, company_id, expires_at from company_creation_requests where id = $1`,
      [requestId]
    );
    if (!request) {
      throw new PermanentDeliveryError(
        'Paddle subscription names a company request that no longer exists'
      );
    }
    if (request.company_id) return { companyId: request.company_id, firstSight: true };
    // Still becoming a company: wait, without spending the retry budget.
    const stillLive =
      (request.status === 'PENDING_CHECKOUT' || request.status === 'APPROVED') &&
      request.expires_at.getTime() > Date.now();
    if (stillLive) {
      throw new DeferredDeliveryError(
        `Waiting for company creation request ${requestId} to become a company`,
        REQUEST_WAIT_SECONDS
      );
    }
    // The money was taken and the approval will never become a tenant. Dead-letter
    // it so an operator is told rather than leaving a paid subscription attached to
    // nothing — a refund or a re-approval is a human decision, not a retry.
    throw new PermanentDeliveryError(
      `Company request ${requestId} is ${request.status.toLowerCase()} and can no longer ` +
        'become a company; this paid subscription needs an operator decision'
    );
  }

  throw new Error('Paddle subscription has no CrewQuo company identity');
}

async function reconcileSubscription(event: z.infer<typeof paddleEventSchema>): Promise<void> {
  const parsed = paddleSubscriptionSchema.safeParse(event.data);
  if (!parsed.success) throw new PermanentDeliveryError('Malformed Paddle subscription event');
  const resolved = await resolveCompanyForSubscription(parsed.data);
  await applyPaddleSubscription({
    subscription: parsed.data,
    companyId: resolved.companyId,
    occurredAt: event.occurred_at,
    eventId: event.event_id,
    firstSight: resolved.firstSight,
  });
}

/**
 * A completed transaction is what turns an additional-company request into an
 * approval (§3.1.1(3)) — the `PENDING_CHECKOUT → APPROVED` edge the operator
 * `record-checkout` route has held on its own until now.
 *
 * Driven from our own `billing_checkouts` row rather than from the event's
 * `custom_data`: the row is the record of what we asked to be charged for, and
 * reading the subject back out of the provider's echo would trust the round trip
 * for the one fact that decides whether somebody gets a tenant.
 */
async function approveRequestForCheckout(input: {
  checkout: { id: string; company_creation_request_id: string; requested_by_user_id: string | null };
  transactionId: string;
}): Promise<void> {
  const requestId = input.checkout.company_creation_request_id;
  await withTransaction(async (client) => {
    const current = await queryOne<{ status: string; checkout_reference: string | null }>(
      `select status, checkout_reference from company_creation_requests where id = $1 for update`,
      [requestId],
      client
    );
    if (!current) throw new PermanentDeliveryError(`Company request ${requestId} no longer exists`);

    const approved = await queryOne<{ id: string; legal_name: string; expires_at: Date }>(
      `update company_creation_requests set
         status = 'APPROVED',
         decided_at = now(),
         decision_reason = $2,
         expires_at = now() + interval '30 days',
         checkout_reference = coalesce(checkout_reference, $3),
         updated_at = now()
       where id = $1 and status = 'PENDING_CHECKOUT' and expires_at > now()
       returning id, legal_name, expires_at`,
      [requestId, `Paid through Paddle transaction ${input.transactionId}`, input.transactionId],
      client
    );

    if (!approved) {
      // Already approved (a redelivery), or already a company. Both are the
      // intended end state, so the event has nothing left to do.
      if (current.status === 'APPROVED' || current.status === 'CONSUMED') return;
      throw new PermanentDeliveryError(
        `Company request ${requestId} is ${current.status.toLowerCase()} and cannot be approved ` +
          'against a completed payment; this charge needs an operator decision'
      );
    }

    // `decided_by_user_id` stays null on purpose: nobody decided. A payment
    // cleared, and attributing that to the payer would read in the platform trail
    // as the requester having approved their own request.
    await recordPlatformAudit(
      {
        actorUserId: null,
        action: 'company_creation_request.checkout_recorded',
        entityType: 'COMPANY_CREATION_REQUEST',
        entityId: requestId,
        changes: {
          checkoutReference: input.transactionId,
          before: { status: current.status },
          after: { status: 'APPROVED', expiresAt: approved.expires_at.toISOString() },
          checkoutId: input.checkout.id,
          requestedByUserId: input.checkout.requested_by_user_id,
          source: 'PADDLE_TRANSACTION',
        },
        description: `${approved.legal_name} was approved by a completed Paddle payment`,
      },
      client
    );
  });
}

async function reconcileTransaction(event: z.infer<typeof paddleEventSchema>): Promise<void> {
  const parsed = paddleTransactionSchema.safeParse(event.data);
  if (!parsed.success) throw new PermanentDeliveryError('Malformed Paddle transaction event');
  const checkoutId = customUuid(parsed.data.custom_data, 'crewquo_checkout_id');
  const completed = event.event_type === 'transaction.completed';

  /*
   * Two properties in one statement, and both are needed.
   *
   * A completion is applied unconditionally and still returns the row, because
   * the approval below runs in its own transaction: a retryable failure there
   * must be able to come back and find the attempt again. A cancellation only
   * moves an attempt that is still open — an `EXPIRED` written over a
   * `COMPLETED` would say the payment never happened.
   */
  const checkout = await queryOne<{
    id: string;
    company_creation_request_id: string | null;
    requested_by_user_id: string | null;
  }>(
    `update billing_checkouts set
       status = case
         when $3 = 'COMPLETED' then 'COMPLETED'
         when status in ('CREATING','PENDING') then $3
         else status end,
       updated_at = now()
      where provider = 'PADDLE' and
        (provider_transaction_id = $1 or ($2::uuid is not null and id = $2::uuid))
      returning id, company_creation_request_id, requested_by_user_id`,
    [parsed.data.id, checkoutId, completed ? 'COMPLETED' : 'EXPIRED']
  );

  if (completed && checkout?.company_creation_request_id) {
    await approveRequestForCheckout({
      checkout: {
        id: checkout.id,
        company_creation_request_id: checkout.company_creation_request_id,
        requested_by_user_id: checkout.requested_by_user_id,
      },
      transactionId: parsed.data.id,
    });
  }
}

/** Handler registered with the durable inbox worker. Unknown event types are safe no-ops. */
export async function handlePaddleInboxEvent(inbox: InboxEvent): Promise<void> {
  const event = paddleEventSchema.safeParse(inbox.payload);
  if (!event.success) throw new PermanentDeliveryError('Malformed Paddle event envelope');
  if (event.data.event_type.startsWith('subscription.')) {
    await reconcileSubscription(event.data);
  } else if (event.data.event_type === 'transaction.completed' || event.data.event_type === 'transaction.canceled') {
    await reconcileTransaction(event.data);
  }
}

export const BILLING_INBOX_HANDLERS = new Map([['PADDLE', handlePaddleInboxEvent]]);
