import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../env';

const paddleTransactionResponseSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    checkout: z.object({ url: z.string().url().nullable() }).nullable(),
  }),
});

/**
 * The two hosted URLs Paddle owns.
 *
 * Fetched on demand and handed straight to the customer, never stored: they are
 * short-lived links into Paddle's own flows, and a stored copy is a stale link
 * to somebody's payment details.
 */
const paddleManagementUrlsSchema = z
  .object({
    update_payment_method: z.string().url().nullable().optional(),
    cancel: z.string().url().nullable().optional(),
  })
  .nullable()
  .optional();

const paddleSubscriptionResponseSchema = z.object({
  data: z.object({ management_urls: paddleManagementUrlsSchema }).passthrough(),
});

/**
 * Verify Paddle's `Paddle-Signature` header against the exact bytes received.
 * Multiple h1 values are accepted so endpoint-secret rotation has an overlap.
 */
export function verifyPaddleSignature(input: {
  rawBody: Buffer;
  signatureHeader: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const components = input.signatureHeader.split(';').map((part) => part.trim());
  const timestampText = components.find((part) => part.startsWith('ts='))?.slice(3);
  const signatures = components
    .filter((part) => part.startsWith('h1='))
    .map((part) => part.slice(3))
    .filter((value) => /^[a-f0-9]{64}$/i.test(value));
  if (!timestampText || !/^\d+$/.test(timestampText) || signatures.length === 0) return false;

  const timestamp = Number(timestampText);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 5;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) return false;

  const signed = Buffer.concat([Buffer.from(`${timestamp}:`, 'utf8'), input.rawBody]);
  const expected = createHmac('sha256', input.secret).update(signed).digest();
  return signatures.some((candidate) => {
    const actual = Buffer.from(candidate, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export class PaddleApiError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'PaddleApiError';
    this.retryable = retryable;
  }
}

function paddleApiBase(): string {
  return env.PADDLE_ENVIRONMENT === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';
}

/**
 * One place every Paddle call goes through, so the three things that have to be
 * true of all of them are true once.
 *
 *  1. **A missing API key is a permanent failure, not a network error.** Nothing
 *     retries its way out of unconfigured credentials.
 *  2. **Paddle's response body never becomes an error message.** It can carry
 *     customer and merchant configuration data, and an error message flows into
 *     logs, API envelopes and dead letters. The status is enough to act on.
 *  3. **Retryable is decided from the status, not by the caller** — 429 and 5xx
 *     only. A 400 replayed eight times is eight identical refusals.
 */
async function paddleRequest(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown
): Promise<unknown> {
  if (!env.PADDLE_API_KEY) throw new PaddleApiError('Paddle API key is not configured', false);

  let response: Response;
  try {
    response = await fetch(`${paddleApiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.PADDLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new PaddleApiError(
      `Paddle ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }

  if (!response.ok) {
    throw new PaddleApiError(
      `Paddle ${method} ${path} returned HTTP ${response.status}`,
      response.status === 429 || response.status >= 500
    );
  }
  return response.json();
}

/**
 * Create a hosted transaction for either subject: a company buying a plan, or a
 * request paying for the additional company it authorises (§3.1.1(3)).
 *
 * `custom_data` carries only the keys that apply. A `crewquo_company_id: null`
 * round-tripping through the provider comes back as present-but-empty, and the
 * reconciler would then have to tell that apart from absent.
 */
export async function createPaddleTransaction(input: {
  providerPriceId: string;
  checkoutId: string;
  companyId: string | null;
  companyRequestId?: string | null;
  planId: string;
  planPriceId: string;
  userId: string;
}): Promise<{ transactionId: string; checkoutUrl: string }> {
  const customData: Record<string, string> = {
    crewquo_checkout_id: input.checkoutId,
    crewquo_plan_id: input.planId,
    crewquo_plan_price_id: input.planPriceId,
    crewquo_user_id: input.userId,
  };
  if (input.companyId) customData.crewquo_company_id = input.companyId;
  if (input.companyRequestId) customData.crewquo_company_request_id = input.companyRequestId;

  const json = await paddleRequest('POST', '/transactions', {
    items: [{ price_id: input.providerPriceId, quantity: 1 }],
    collection_mode: 'automatic',
    checkout: { url: `${env.APP_BASE_URL.replace(/\/$/, '')}/plan` },
    custom_data: customData,
  });

  const parsed = paddleTransactionResponseSchema.safeParse(json);
  if (!parsed.success || !parsed.data.data.checkout?.url) {
    throw new PaddleApiError(
      'Paddle did not return a checkout URL; verify the approved default payment link',
      false
    );
  }
  return {
    transactionId: parsed.data.data.id,
    checkoutUrl: parsed.data.data.checkout.url,
  };
}

/**
 * Paddle's own hosted page for replacing a card.
 *
 * Absent is a real answer: a manually-collected subscription has no self-serve
 * payment method to update, and inventing a link would send somebody to a page
 * that cannot help them.
 */
export async function fetchPaddleManagementUrls(
  subscriptionId: string
): Promise<{ updatePaymentMethod: string | null; cancel: string | null }> {
  const json = await paddleRequest('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const parsed = paddleSubscriptionResponseSchema.safeParse(json);
  if (!parsed.success) throw new PaddleApiError('Paddle returned an unreadable subscription', false);
  const urls = parsed.data.data.management_urls;
  return {
    updatePaymentMethod: urls?.update_payment_method ?? null,
    cancel: urls?.cancel ?? null,
  };
}

/**
 * Schedule cancellation for the **end of the paid period**, never immediately.
 *
 * Paddle is the merchant of record and would prorate an immediate cancellation
 * into a refund; somebody clicking "cancel" is saying *stop billing me*, not
 * *end the service I have already paid for today*. The subscription therefore
 * stays `ACTIVE` with `cancel_at_period_end` until the period runs out, which is
 * also what keeps entitlements resolving for time already bought.
 */
export async function cancelPaddleSubscription(subscriptionId: string): Promise<unknown> {
  const json = await paddleRequest(
    'POST',
    `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    { effective_from: 'next_billing_period' }
  );
  return (json as { data?: unknown })?.data;
}

/** Withdraw a scheduled cancellation while the period is still running. */
export async function resumePaddleSubscription(subscriptionId: string): Promise<unknown> {
  const json = await paddleRequest('PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    scheduled_change: null,
  });
  return (json as { data?: unknown })?.data;
}

/**
 * Move an existing subscription to another price.
 *
 * `prorated_immediately` because the alternative — bill the difference at the
 * next renewal — means an upgrade grants a month of a more expensive plan for
 * nothing, and a downgrade charges a month for a plan the customer no longer has.
 */
export async function changePaddleSubscriptionPrice(
  subscriptionId: string,
  providerPriceId: string
): Promise<unknown> {
  const json = await paddleRequest('PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    items: [{ price_id: providerPriceId, quantity: 1 }],
    proration_billing_mode: 'prorated_immediately',
  });
  return (json as { data?: unknown })?.data;
}
