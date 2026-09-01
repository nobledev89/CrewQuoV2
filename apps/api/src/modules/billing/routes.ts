import { createHash } from 'node:crypto';
import express, { Router } from 'express';
import {
  billingCheckoutRequestSchema,
  billingCheckoutResponseSchema,
  billingPaymentMethodResponseSchema,
  billingSubscriptionActionResponseSchema,
  publicPricingResponseSchema,
} from '@crewquo/shared';
import { z } from 'zod';
import { env } from '../../env';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/middleware/auth';
import { recordVerifiedWebhook } from '../delivery/repo';
import { verifyPaddleSignature } from './paddle';
import {
  cancelSubscription,
  changeSubscriptionPrice,
  getBillingOverview,
  getPaymentMethodUpdateUrl,
  getPublicPricing,
  resumeSubscription,
  startCheckout,
} from './repo';

const paddleEnvelopeSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string().datetime(),
  data: z.record(z.unknown()),
});

export const billingRouter = Router();

billingRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json(await getBillingOverview(ctx.companyId));
  })
);

billingRouter.post(
  '/checkout',
  requireRole('OWNER'),
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = billingCheckoutRequestSchema.parse(req.body);
    res.status(201).json(billingCheckoutResponseSchema.parse(await startCheckout({
      companyId: ctx.companyId,
      userId: ctx.userId,
      priceId: input.priceId,
    })));
  })
);

/*
 * Subscription self-management.
 *
 * `OWNER` throughout, matching checkout: an ADMIN runs the company's work, and
 * ending or re-pricing the company's subscription is a commitment only the owner
 * makes. Every one of these calls Paddle and then reconciles, so none of them
 * invents local state the provider does not agree with.
 */
billingRouter.post(
  '/subscription/cancel',
  requireRole('OWNER'),
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json(billingSubscriptionActionResponseSchema.parse(
      await cancelSubscription({ companyId: ctx.companyId, userId: ctx.userId })
    ));
  })
);

billingRouter.post(
  '/subscription/resume',
  requireRole('OWNER'),
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json(billingSubscriptionActionResponseSchema.parse(
      await resumeSubscription({ companyId: ctx.companyId, userId: ctx.userId })
    ));
  })
);

billingRouter.post(
  '/subscription/plan',
  requireRole('OWNER'),
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = billingCheckoutRequestSchema.parse(req.body);
    res.json(billingSubscriptionActionResponseSchema.parse(
      await changeSubscriptionPrice({
        companyId: ctx.companyId,
        userId: ctx.userId,
        priceId: input.priceId,
      })
    ));
  })
);

/**
 * A POST for a read, deliberately: this fetches a short-lived link into Paddle's
 * hosted payment-details page. Making it a GET would put that link in browser
 * history, referrers and any cache that ignores `no-store`.
 */
billingRouter.post(
  '/subscription/payment-method',
  requireRole('OWNER'),
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json(billingPaymentMethodResponseSchema.parse(
      await getPaymentMethodUpdateUrl(ctx.companyId)
    ));
  })
);

/**
 * `GET /v1/public/pricing` — unauthenticated, and the only public read in this
 * module.
 *
 * Cacheable, unlike every other response this API sends: the global `no-store`
 * exists because an error body can name a project or an invoice, and this body
 * is the plan catalog every visitor is shown. Five minutes is long enough to
 * absorb a link doing the rounds and short enough that a price correction is
 * visible while somebody is still on the phone about it.
 */
export const publicBillingRouter = Router();
publicBillingRouter.get(
  '/pricing',
  asyncHandler(async (_req, res) => {
    const body = publicPricingResponseSchema.parse(await getPublicPricing());
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(body);
  })
);

/** Mounted before `express.json()` so the signed bytes remain byte-for-byte intact. */
export const billingWebhookRouter = Router();
billingWebhookRouter.post(
  '/paddle',
  express.raw({ type: 'application/json', limit: '256kb' }),
  asyncHandler(async (req, res) => {
    if (!env.PADDLE_WEBHOOK_SECRET) {
      res.status(503).json({ error: { code: 'INTERNAL', message: 'Paddle webhook is not configured' } });
      return;
    }
    if (!Buffer.isBuffer(req.body)) throw new AppError('VALIDATION', 'Raw webhook body required');
    const signature = req.header('paddle-signature');
    if (!signature || !verifyPaddleSignature({
      rawBody: req.body,
      signatureHeader: signature,
      secret: env.PADDLE_WEBHOOK_SECRET,
    })) {
      throw new AppError('VALIDATION', 'Invalid Paddle webhook signature');
    }

    let json: unknown;
    try {
      json = JSON.parse(req.body.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION', 'Webhook body is not valid JSON');
    }
    const event = paddleEnvelopeSchema.parse(json);
    const recorded = await recordVerifiedWebhook({
      provider: 'PADDLE',
      externalEventId: event.event_id,
      eventType: event.event_type,
      bodySha256: createHash('sha256').update(req.body).digest('hex'),
      payload: event,
    });
    res.status(recorded.duplicate ? 200 : 202).json({ received: true, duplicate: recorded.duplicate });
  })
);
