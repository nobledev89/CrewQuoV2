import { Router } from 'express';
import {
  createProductFactorSchema,
  deriveIsEstimate,
  resolveProductFactor,
  updateProductFactorSchema,
  type ProductFactorResolution,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, type Ctx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { queryOne, withTransaction } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { recordAudit } from '../audit/record';
import { recordRevision } from '../revisions/record';
import { ensureSettings } from './settings';
import {
  PRODUCT_COLUMNS,
  findProductFactor,
  listProductFactors,
  loadProductFactors,
  toProductFactorView,
} from './factorsRepo';

/**
 * The product carbon factor library (§26.3) — step 3 of the Phase 9 build order.
 *
 * The embodied carbon of the item that did **not** have to be manufactured, which
 * is the only input to an avoided-emissions claim. §26.3's preferred-source order
 * lives in `resolveProductFactor` and has been exhaustively tested since 9.0; this
 * file is the CRUD around it plus one route that exposes the resolver itself, so an
 * operator can ask *"what would this chair resolve to, and why"* without recording
 * a movement to find out.
 *
 * **Uniqueness first** (packet §14 step 9.3), which is `0039`'s two partial indexes:
 * the five-tier walk means a duplicate can outrank itself, and an `ORG_SPECIFIC`
 * factor entered twice is indistinguishable from an organisation that genuinely
 * holds two.
 */

async function assertFactorFeature(ctx: Ctx & { companyId: string }): Promise<void> {
  if (!(await hasFeature(ctx.companyId, 'custom_factors'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: custom_factors', {
      feature: 'custom_factors',
    });
  }
}

async function assertReadFeature(ctx: Ctx & { companyId: string }): Promise<void> {
  if (!(await hasFeature(ctx.companyId, 'sustainability'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: sustainability', {
      feature: 'sustainability',
    });
  }
}

/** The identity `0039`'s unique index is over, for the refusal message. */
function describeIdentity(input: {
  itemCategory: string;
  manufacturer?: string | null;
  productModel?: string | null;
  verificationStatus: string;
}): string {
  return [input.manufacturer, input.productModel, input.itemCategory]
    .filter((v) => v != null && v !== '')
    .join(' ')
    .concat(` (${input.verificationStatus})`);
}

/** A unique-violation from `0039`, turned into a sentence that names the duplicate. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export const productFactorsRouter = Router();

productFactorsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertReadFeature(ctx);
    await assertCapability(ctx, 'sustainability.read');
    const rows = await listProductFactors(ctx.companyId, {
      includeInactive: req.query.includeInactive === 'true',
    });
    res.json({ productFactors: rows.map(toProductFactorView) });
  })
);

/**
 * GET /v1/product-factors/resolve — §26.3's walk, answered directly.
 *
 * **Its purpose is the `GENERIC_REFUSED` answer**, which is the one an operator
 * cannot work out from the list. Being told "no factor exists" when a generic is
 * sitting there switched off sends somebody to find a factor that is already
 * present; the resolver distinguishes the two and so does this route.
 */
productFactorsRouter.get(
  '/resolve',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertReadFeature(ctx);
    await assertCapability(ctx, 'sustainability.read');

    const settings = await ensureSettings(ctx.companyId);
    const factors = await loadProductFactors(ctx.companyId);
    const str = (key: string): string | undefined =>
      typeof req.query[key] === 'string' && req.query[key] !== '' ? String(req.query[key]) : undefined;

    const resolution: ProductFactorResolution = resolveProductFactor(factors, {
      assetTypeId: str('assetTypeId') ?? null,
      itemCategory: str('itemCategory') ?? null,
      manufacturer: str('manufacturer') ?? null,
      productModel: str('productModel') ?? null,
      allowGeneric: settings.allow_generic_product_factors,
    });

    res.json({
      resolution: {
        kind: resolution.kind,
        factorId: 'factor' in resolution ? resolution.factor.id : null,
        tier: 'tier' in resolution ? resolution.tier : null,
        candidateIds: 'candidates' in resolution ? resolution.candidates.map((c) => c.id) : [],
      },
      allowGenericProductFactors: settings.allow_generic_product_factors,
    });
  })
);

productFactorsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertFactorFeature(ctx);
    await assertCapability(ctx, 'sustainability.factors.manage');

    const input = createProductFactorSchema.parse(req.body);

    if (input.assetTypeId != null) {
      // Reachable by this company — its own catalog or the system one. A forged id
      // would let a factor point at another tenant's asset type, which the resolver
      // would then match on.
      const type = await queryOne<{ id: string }>(
        `select id from asset_types where id = $1 and (company_id = $2 or company_id is null)`,
        [input.assetTypeId, ctx.companyId]
      );
      if (!type) throw new AppError('NOT_FOUND', 'Asset type not found');
    }

    const created = await withTransaction(async (client) => {
      let row: { id: string } | null;
      try {
        row = await queryOne<{ id: string }>(
          `insert into product_carbon_factors
             (company_id, item_category, asset_type_id, manufacturer, product_model,
              kg_co2e_per_item, kg_co2e_per_kg, lifecycle_boundary, source, source_url,
              publication_year, region, verification_status, is_estimate, notes,
              created_by_user_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           returning id`,
          [
            ctx.companyId,
            input.itemCategory,
            input.assetTypeId ?? null,
            input.manufacturer ?? null,
            input.productModel ?? null,
            input.kgCo2ePerItem ?? null,
            input.kgCo2ePerKg ?? null,
            input.lifecycleBoundary,
            input.source,
            input.sourceUrl ?? null,
            input.publicationYear ?? null,
            input.region ?? null,
            input.verificationStatus,
            // Derived, never accepted. A client-supplied boolean beside a
            // verification status is two answers to one question.
            deriveIsEstimate(input.verificationStatus),
            input.notes ?? null,
            ctx.userId,
          ],
          client
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError(
            'CONFLICT',
            `A ${input.verificationStatus} factor already exists for ${describeIdentity(input)}. Edit that one, or record this as a different verification status.`,
            { reason: 'DUPLICATE_FACTOR' }
          );
        }
        throw err;
      }
      /* c8 ignore next */
      if (!row) throw new AppError('CONFLICT', 'That factor could not be created.');

      const full = await findProductFactor(row.id, ctx.companyId, client);
      /* c8 ignore next */
      if (!full) throw new AppError('CONFLICT', 'That factor could not be created.');
      const view = toProductFactorView(full);

      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'product_factor.created',
          entityType: 'PRODUCT_CARBON_FACTOR',
          entityId: row.id,
          description: describeIdentity(input),
        },
        client
      );
      await recordRevision(
        {
          companyId: ctx.companyId,
          entityType: 'PRODUCT_CARBON_FACTOR',
          entityId: row.id,
          action: 'CREATE',
          before: null,
          after: factorFacts(view),
          changedByUserId: ctx.userId,
        },
        client
      );
      return view;
    });

    res.status(201).json({ productFactor: created });
  })
);

/**
 * PATCH /v1/product-factors/:id
 *
 * **A product factor may be edited and an emission factor may not**, and the two
 * are different for a stated reason (packet §2). An emission factor is a
 * transcription of a published workbook, so a correction is a new set at a new
 * version — the publisher's own mechanism. A product factor is the organisation's
 * own assumption about a chair, and an assumption that cannot be refined as better
 * data arrives is an assumption people work around in a spreadsheet.
 *
 * The protection is the same one Phase 8 gives an asset line: every edit writes a
 * `record_revisions` row, and every calculation that cited the old value keeps
 * citing the value it used, because the citation is denormalised onto the
 * calculation row.
 */
productFactorsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertFactorFeature(ctx);
    await assertCapability(ctx, 'sustainability.factors.manage');

    const id = uuidParam(req, 'id');
    const existing = await findProductFactor(id, ctx.companyId);
    if (!existing) throw new AppError('NOT_FOUND', 'Product factor not found');
    if (existing.company_id === null) {
      throw new AppError(
        'FORBIDDEN',
        'The platform factor library is read-only. Add your own factor to hold a different value.'
      );
    }

    const input = updateProductFactorSchema.parse(req.body);
    const before = toProductFactorView(existing);

    const updated = await withTransaction(async (client) => {
      let row: { id: string } | null;
      try {
        row = await queryOne<{ id: string }>(
          `update product_carbon_factors set
             item_category = coalesce($2, item_category),
             asset_type_id = case when $3::boolean then $4::uuid else asset_type_id end,
             manufacturer  = case when $5::boolean then $6::text else manufacturer end,
             product_model = case when $7::boolean then $8::text else product_model end,
             kg_co2e_per_item = case when $9::boolean then $10::numeric else kg_co2e_per_item end,
             kg_co2e_per_kg   = case when $11::boolean then $12::numeric else kg_co2e_per_kg end,
             lifecycle_boundary = coalesce($13, lifecycle_boundary),
             source = coalesce($14, source),
             source_url = case when $15::boolean then $16::text else source_url end,
             publication_year = case when $17::boolean then $18::int else publication_year end,
             region = case when $19::boolean then $20::text else region end,
             verification_status = coalesce($21, verification_status),
             is_estimate = coalesce($22, is_estimate),
             notes = case when $23::boolean then $24::text else notes end,
             active = coalesce($25, active),
             updated_at = now()
           where id = $1 and company_id = $26
           returning id`,
          [
            id,
            input.itemCategory ?? null,
            input.assetTypeId !== undefined, input.assetTypeId ?? null,
            input.manufacturer !== undefined, input.manufacturer ?? null,
            input.productModel !== undefined, input.productModel ?? null,
            input.kgCo2ePerItem !== undefined, input.kgCo2ePerItem ?? null,
            input.kgCo2ePerKg !== undefined, input.kgCo2ePerKg ?? null,
            input.lifecycleBoundary ?? null,
            input.source ?? null,
            input.sourceUrl !== undefined, input.sourceUrl ?? null,
            input.publicationYear !== undefined, input.publicationYear ?? null,
            input.region !== undefined, input.region ?? null,
            input.verificationStatus ?? null,
            input.verificationStatus === undefined
              ? null
              : deriveIsEstimate(input.verificationStatus),
            input.notes !== undefined, input.notes ?? null,
            input.active ?? null,
            ctx.companyId,
          ],
          client
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError(
            'CONFLICT',
            'Another factor already covers that item at that verification status.',
            { reason: 'DUPLICATE_FACTOR' }
          );
        }
        throw err;
      }
      /* c8 ignore next */
      if (!row) throw new AppError('CONFLICT', 'That factor could not be updated.');

      // The rate pair is checked after the write rather than before, because the
      // patch is partial: clearing one and setting the other in one request is a
      // legitimate change of basis, and only the resulting row can be checked.
      const after = await findProductFactor(id, ctx.companyId, client);
      /* c8 ignore next */
      if (!after) throw new AppError('CONFLICT', 'That factor could not be updated.');
      if ((after.kg_co2e_per_item === null) === (after.kg_co2e_per_kg === null)) {
        throw new AppError(
          'VALIDATION',
          'A factor carries exactly one rate — either per item or per kilogram.'
        );
      }
      const view = toProductFactorView(after);

      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'product_factor.updated',
          entityType: 'PRODUCT_CARBON_FACTOR',
          entityId: id,
          description: describeIdentity({
            itemCategory: view.itemCategory,
            manufacturer: view.manufacturer,
            productModel: view.productModel,
            verificationStatus: view.verificationStatus,
          }),
        },
        client
      );
      await recordRevision(
        {
          companyId: ctx.companyId,
          entityType: 'PRODUCT_CARBON_FACTOR',
          entityId: id,
          action: 'UPDATE',
          before: factorFacts(before),
          after: factorFacts(view),
          changedByUserId: ctx.userId,
        },
        client
      );
      return view;
    });

    res.json({
      productFactor: updated,
      /*
       * The half an operator would otherwise assume the opposite of. Correcting an
       * embodied-carbon figure does not restate a claim already made against it —
       * the claim cites what it used, and it changes when the movement behind it
       * changes.
       */
      notice:
        'Claims already made against this factor still cite the value they used. New calculations use the corrected value.',
    });
  })
);

function factorFacts(view: ReturnType<typeof toProductFactorView>): Record<string, unknown> {
  return {
    itemCategory: view.itemCategory,
    assetTypeId: view.assetTypeId,
    manufacturer: view.manufacturer,
    productModel: view.productModel,
    kgCo2ePerItem: view.kgCo2ePerItem,
    kgCo2ePerKg: view.kgCo2ePerKg,
    lifecycleBoundary: view.lifecycleBoundary,
    source: view.source,
    verificationStatus: view.verificationStatus,
    isEstimate: view.isEstimate,
    active: view.active,
  };
}

export { PRODUCT_COLUMNS };
