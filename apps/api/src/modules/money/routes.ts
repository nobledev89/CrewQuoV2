import { Router } from 'express';
import {
  createFxRateSchema,
  fxRateDeletionRefusal,
  listFxRatesQuerySchema,
} from '@crewquo/shared';
import { isOwnerOrAdmin } from '../../authorization/policies';
import { withTransaction } from '../../db';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { recordAudit } from '../audit/record';
import { enqueueOutboxEvent } from '../delivery/repo';
import { deleteFxRate, getFxRate, insertFxRate, listFxRates } from './repo';

/**
 * `/v1/fx-rates` — the money boundary's only customer surface (§3.3 decision #5).
 * Operating-model packet: `docs/operating-model/money-boundary.md`.
 *
 * Three rules run through every handler:
 *
 *  - **No entitlement gate, and §43 adds no key.** Gating multi-currency behind a
 *    plan would mean a company that legitimately operates in two currencies gets
 *    *wrong* numbers rather than fewer features — the failure mode §41 exists to
 *    prevent. A plan says what a company may do, not whether its arithmetic is
 *    allowed to be correct.
 *  - **Writing a rate is OWNER/ADMIN.** A rate is an input to money owed, so the
 *    writer is recorded on the row and the action is audited; a MEMBER may read
 *    the rates their figures cite but cannot change what anyone is paid.
 *  - **Company-scoped, always.** Every statement filters on the acting company,
 *    so a forged id is a 404 rather than a cross-tenant read — the same answer a
 *    malformed id gets.
 */

export const fxRatesRouter = Router();

fxRatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const filter = listFxRatesQuerySchema.parse(req.query);
    const data = await listFxRates(ctx.companyId, filter);
    res.json({ data });
  })
);

fxRatesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    if (!isOwnerOrAdmin(ctx.role)) {
      throw new AppError('FORBIDDEN', 'Only an owner or admin may record an exchange rate');
    }
    const input = createFxRateSchema.parse(req.body);

    const rate = await withTransaction(async (client) => {
      const created = await insertFxRate(
        { ...input, companyId: ctx.companyId, actorUserId: ctx.userId },
        client
      );
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'fx_rate.recorded',
          entityType: 'FX_RATE',
          entityId: created.id,
          changes: {
            pair: `${created.baseCurrency}/${created.quoteCurrency}`,
            rate: created.rate,
            asOf: created.asOf,
            source: created.source,
          },
          description:
            `1 ${created.baseCurrency} = ${created.rate} ${created.quoteCurrency} ` +
            `as of ${created.asOf} (${created.source})`,
          // Commercial data: a rate reveals what a company pays and charges
          // across borders, and never crosses the portal boundary (packet §7).
          visibleToClient: false,
        },
        client
      );
      await enqueueOutboxEvent(
        {
          topic: 'fx_rate.recorded',
          aggregateType: 'FX_RATE',
          aggregateId: created.id,
          companyId: ctx.companyId,
          payload: {
            fxRateId: created.id,
            baseCurrency: created.baseCurrency,
            quoteCurrency: created.quoteCurrency,
            asOf: created.asOf,
            actorUserId: ctx.userId,
          },
          idempotencyKey: `fx_rate.recorded:${created.id}`,
        },
        client
      );
      return created;
    });

    res.status(201).json({ fxRate: rate });
  })
);

fxRatesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    if (!isOwnerOrAdmin(ctx.role)) {
      throw new AppError('FORBIDDEN', 'Only an owner or admin may delete an exchange rate');
    }
    const id = uuidParam(req, 'id');

    await withTransaction(async (client) => {
      const existing = await getFxRate(id, ctx.companyId, client);
      if (!existing) throw new AppError('NOT_FOUND', 'Exchange rate not found');

      // The route refuses first with a count and a repair path, because the
      // `on delete restrict` foreign key behind it reaches a caller as a 500.
      const refusal = fxRateDeletionRefusal(existing.citationCount);
      if (refusal) throw new AppError('CONFLICT', refusal);

      await deleteFxRate(id, ctx.companyId, client);
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'fx_rate.deleted',
          entityType: 'FX_RATE',
          entityId: id,
          changes: {
            pair: `${existing.baseCurrency}/${existing.quoteCurrency}`,
            rate: existing.rate,
            asOf: existing.asOf,
          },
          description:
            `the ${existing.baseCurrency}/${existing.quoteCurrency} rate of ` +
            `${existing.asOf} was deleted`,
          visibleToClient: false,
        },
        client
      );
    });

    res.status(204).end();
  })
);
