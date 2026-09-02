import { Router, json } from 'express';
import {
  MAX_IMPORT_ROWS,
  buildImportDiff,
  factorImportPreviewSchema,
  factorImportSchema,
  factorSetImportedEventPayload,
  guessColumnMapping,
  importRefusal,
  mapFactorRows,
  updateFactorSetSchema,
  type FactorImportPreviewResult,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, type Ctx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { query, queryOne, withTransaction } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { assertWithinLimit, hasFeature } from '../entitlements/guards';
import { enqueueOutboxEvent } from '../delivery/repo';
import { recordAudit } from '../audit/record';
import { recordRevision } from '../revisions/record';
import {
  factorSetExists,
  findFactorSet,
  insertFactorSet,
  insertFactors,
  listFactorSets,
  listFactors,
  toFactorSetView,
  toFactorView,
} from './factorsRepo';
import { readTable } from './spreadsheet';

/**
 * Factor sets, factors and the importer (§26.1–§26.2) — step 2 of the Phase 9 build
 * order.
 *
 * **Ama is the only persona who ever sees a factor set** (packet §1), and she uses
 * it twice a year. That shapes everything here: the flow is deliberately three
 * requests rather than one — preview the file, dry-run the mapping, confirm the
 * import — because the alternative is a single upload that either works or leaves
 * somebody guessing which column was wrong in a workbook with forty of them.
 *
 * ── THE ENTITLEMENT IS THE IMPORTER'S, NOT A PROJECT OWNER'S ────────────────
 *
 * `custom_factors` and the `factor_sets` limit are checked against **the company
 * doing the importing** (packet §13.3, finding 9). A factor set is company
 * reference data used across every project that company owns; there is no project
 * to find an owner of. Recorded rather than assumed precisely because the last
 * three phases all transferred the 2026-09-01 rule by analogy, and this is the
 * first noun it does not fit.
 */

/**
 * A body limit for this router alone.
 *
 * The app's global ceiling is 256 KB because *"every payload this API accepts is a
 * form; file content goes to object storage through a presigned URL"*. This is the
 * one route where that is not true, and packet §10 says why the file does not take
 * the presign path: the caps that matter are on content the API has not yet looked
 * at, and the cheapest place to refuse an oversize workbook is before it is stored
 * anywhere. The limit is stated here rather than raised globally, so no other route
 * inherits it.
 */
const importBodyLimit = json({ limit: '12mb' });

async function assertFactorFeature(ctx: Ctx & { companyId: string }): Promise<void> {
  if (!(await hasFeature(ctx.companyId, 'custom_factors'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: custom_factors', {
      feature: 'custom_factors',
    });
  }
}

/** Reading a set needs the section, not the ability to curate it. */
async function assertReadFeature(ctx: Ctx & { companyId: string }): Promise<void> {
  if (!(await hasFeature(ctx.companyId, 'sustainability'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: sustainability', {
      feature: 'sustainability',
    });
  }
}

export const factorSetsRouter = Router();

factorSetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertReadFeature(ctx);
    await assertCapability(ctx, 'sustainability.read');
    const rows = await listFactorSets(ctx.companyId, req.query.includeInactive === 'true');
    res.json({ factorSets: rows.map(toFactorSetView) });
  })
);

factorSetsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertReadFeature(ctx);
    await assertCapability(ctx, 'sustainability.read');
    const row = await findFactorSet(uuidParam(req, 'id'), ctx.companyId);
    if (!row) throw new AppError('NOT_FOUND', 'Factor set not found');
    res.json({ factorSet: toFactorSetView(row) });
  })
);

/**
 * GET /v1/factor-sets/:id/factors — the rows, paged.
 *
 * Paged rather than whole, because a published set is thousands of rows and this is
 * a screen somebody scrolls. The engine takes the other path (`loadFactors`), which
 * reads the set whole exactly once per calculation run.
 */
factorSetsRouter.get(
  '/:id/factors',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertReadFeature(ctx);
    await assertCapability(ctx, 'sustainability.read');
    const set = await findFactorSet(uuidParam(req, 'id'), ctx.companyId);
    if (!set) throw new AppError('NOT_FOUND', 'Factor set not found');

    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const search = typeof req.query.search === 'string' && req.query.search.trim() !== ''
      ? req.query.search.trim()
      : undefined;

    const rows = await listFactors(set.id, { search, limit, offset });
    res.json({
      factors: rows.map(toFactorView),
      total: Number(set.factor_count),
      limit,
      offset,
    });
  })
);

/**
 * PATCH /v1/factor-sets/:id — the short list of things that may change.
 *
 * **Platform rows are immutable to every customer**, which is `0033`'s rule for
 * `destination_types` transferred without change: system rows are immutable so the
 * seeded semantics are always there to compare a company's own against.
 *
 * Deactivating a set that live calculations cite raises an event naming the count.
 * Deactivating one nothing cites raises nothing — the difference between a warning
 * and a log line.
 */
factorSetsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertFactorFeature(ctx);
    await assertCapability(ctx, 'sustainability.factors.manage');

    const id = uuidParam(req, 'id');
    const existing = await findFactorSet(id, ctx.companyId);
    if (!existing) throw new AppError('NOT_FOUND', 'Factor set not found');
    if (existing.company_id === null) {
      throw new AppError(
        'FORBIDDEN',
        'The platform factor library is read-only. Import your own set to hold different values.'
      );
    }

    const input = updateFactorSetSchema.parse(req.body);
    const wasActive = existing.active;

    const updated = await withTransaction(async (client) => {
      const row = await queryOne<{ id: string }>(
        `update emission_factor_sets set
           source_document = case when $2::boolean then $3::text else source_document end,
           source_url      = case when $4::boolean then $5::text else source_url end,
           methodology     = case when $6::boolean then $7::text else methodology end,
           valid_to        = case when $8::boolean then $9::date else valid_to end,
           active          = coalesce($10, active),
           updated_at = now()
         where id = $1 and company_id = $11
         returning id`,
        [
          id,
          input.sourceDocument !== undefined, input.sourceDocument ?? null,
          input.sourceUrl !== undefined, input.sourceUrl ?? null,
          input.methodology !== undefined, input.methodology ?? null,
          input.validTo !== undefined, input.validTo ?? null,
          input.active ?? null,
          ctx.companyId,
        ],
        client
      );
      /* c8 ignore next */
      if (!row) throw new AppError('CONFLICT', 'That factor set could not be updated.');

      const after = await findFactorSet(id, ctx.companyId, client);
      /* c8 ignore next */
      if (!after) throw new AppError('CONFLICT', 'That factor set could not be updated.');

      if (wasActive && input.active === false) {
        await recordAudit(
          {
            companyId: ctx.companyId,
            actorUserId: ctx.userId,
            action: 'factor_set.deactivated',
            entityType: 'EMISSION_FACTOR_SET',
            entityId: id,
            description: `${existing.name} ${existing.version} deactivated`,
            changes: { citedByCalculations: Number(existing.cited_by_calculations) },
          },
          client
        );
        /*
         * Only when something cites it. A set nothing has used is an operational
         * tidy-up, and an Action Centre item for it is the noise that teaches people
         * to clear the channel without reading.
         */
        if (Number(existing.cited_by_calculations) > 0) {
          await enqueueOutboxEvent(
            {
              topic: 'sustainability.factor_set_deactivated',
              aggregateType: 'EMISSION_FACTOR_SET',
              aggregateId: id,
              companyId: ctx.companyId,
              payload: {
                companyId: ctx.companyId,
                factorSetId: id,
                name: existing.name,
                version: existing.version,
                citedByCalculations: Number(existing.cited_by_calculations),
                actorUserId: ctx.userId,
              },
              // One item per set per deactivation, so reactivating and deactivating
              // again is a second notice rather than a silently swallowed one.
              idempotencyKey: `sustainability.factor_set_deactivated:${id}:${Date.now()}`,
            },
            client
          );
        }
      }
      return toFactorSetView(after);
    });

    res.json({
      factorSet: updated,
      notice:
        updated.active
          ? undefined
          : 'Deactivating stops this set being selected for future calculations. Figures already calculated against it are unchanged and still cite it.',
    });
  })
);

/**
 * POST /v1/factor-sets/preview — headers, a guess, and a sample.
 *
 * Writes nothing and creates nothing. It exists because §26.2 asks for a column
 * mapping UI, and a mapping UI needs to know what columns the file has before
 * anybody has committed to importing it.
 *
 * **The guess is a suggestion, never a mapping applied on its own.** A publisher
 * renames its columns between years, and a guesser that quietly guessed wrong would
 * import the well-to-tank column as the headline factor — a number roughly a fifth
 * the size, in the direction that flatters.
 */
factorSetsRouter.post(
  '/preview',
  importBodyLimit,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertFactorFeature(ctx);
    await assertCapability(ctx, 'sustainability.factors.manage');

    const input = factorImportPreviewSchema.parse(req.body);
    const table = await readTable(input);

    const result: FactorImportPreviewResult = {
      headers: table.headers,
      rowCount: table.rows.length,
      sheetNames: table.sheetNames,
      suggestedMapping: guessColumnMapping(table.headers),
      // Five rows. Enough to see what a column holds, few enough that a mapping
      // screen is not a data browser for somebody else's workbook.
      sample: table.rows.slice(0, 5),
    };
    res.json(result);
  })
);

/**
 * POST /v1/factor-sets/import — the dry run and the confirm, one route.
 *
 * **One route because they must be the same code.** A dry run that reports what a
 * different code path would do is a dry run that tells you the wrong thing, which
 * is worse than not having one: packet §2 makes this diff *the whole of the review
 * a factor set gets*, on the argument that seeing what will change before it
 * changes is a better guarantee than a second click by the same hand.
 *
 * `dryRun` defaults to **true**, so the write is the direction a caller has to ask
 * for.
 *
 * The order of the checks is deliberate and is packet §10's: **the plan limit and
 * the size caps are cleared before a byte is parsed**, because the importer's cost
 * is per row rather than per request and a ceiling checked afterwards is a ceiling
 * that has already been paid for.
 */
factorSetsRouter.post(
  '/import',
  importBodyLimit,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertFactorFeature(ctx);
    await assertCapability(ctx, 'sustainability.factors.manage');

    const input = factorImportSchema.parse(req.body);

    // Against the IMPORTING company, and only when a row would actually be
    // created: a dry run consumes no allowance and must not be refused by one.
    if (!input.dryRun) {
      await assertWithinLimit(ctx.companyId, 'factor_sets', 1);
    }

    const table = await readTable(input);
    const mapped = mapFactorRows(table, input.mapping);
    const exists = await factorSetExists(ctx.companyId, input.set.name, input.set.version);
    const diff = buildImportDiff(mapped, { setExists: exists });

    if (input.dryRun) {
      res.json({ dryRun: true, diff, refusal: importRefusal(diff) });
      return;
    }

    const refusal = importRefusal(diff);
    if (refusal) {
      /*
       * Every refusal is terminal and none is partial (packet §9). The code travels
       * in `details` so a screen can decide whether to offer "import as a new
       * version" or "open the file at row 412".
       */
      throw new AppError(
        refusal.code === 'SET_ALREADY_EXISTS' ? 'CONFLICT' : 'VALIDATION',
        refusal.message,
        { reason: refusal.code, failures: diff.failures.slice(0, 50) }
      );
    }

    const result = await withTransaction(async (client) => {
      const set = await insertFactorSet(
        {
          companyId: ctx.companyId,
          name: input.set.name,
          sourceOrganisation: input.set.sourceOrganisation,
          sourceDocument: input.set.sourceDocument ?? null,
          sourceUrl: input.set.sourceUrl ?? null,
          reportingYear: input.set.reportingYear,
          version: input.set.version,
          publishedOn: input.set.publishedOn ?? null,
          validFrom: input.set.validFrom,
          validTo: input.set.validTo ?? null,
          methodology: input.set.methodology ?? null,
          region: input.set.region,
          importedByUserId: ctx.userId,
        },
        client
      );

      const written = await insertFactors(set.id, mapped.rows, client);

      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'factor_set.imported',
          entityType: 'EMISSION_FACTOR_SET',
          entityId: set.id,
          description: `${input.set.name} ${input.set.version} — ${written} factors`,
          changes: { rowCount: written, countsByCategory: diff.countsByCategory },
        },
        client
      );
      /*
       * §36 stars emission factors. The revision is on the SET rather than per row,
       * which is `asset.imported`'s reasoning one noun over: twenty thousand rows is
       * one act, and twenty thousand trail entries is a trail nobody reads.
       */
      await recordRevision(
        {
          companyId: ctx.companyId,
          entityType: 'EMISSION_FACTOR_SET',
          entityId: set.id,
          action: 'CREATE',
          before: null,
          after: {
            name: input.set.name,
            version: input.set.version,
            reportingYear: input.set.reportingYear,
            region: input.set.region,
            rowCount: written,
            countsByCategory: diff.countsByCategory,
          },
          changedByUserId: ctx.userId,
        },
        client
      );
      await enqueueOutboxEvent(
        {
          topic: 'sustainability.factor_set_imported',
          aggregateType: 'EMISSION_FACTOR_SET',
          aggregateId: set.id,
          companyId: ctx.companyId,
          payload: factorSetImportedEventPayload({
            companyId: ctx.companyId,
            factorSetId: set.id,
            name: input.set.name,
            version: input.set.version,
            reportingYear: input.set.reportingYear,
            rowCount: written,
            countsByCategory: diff.countsByCategory,
            actorUserId: ctx.userId,
          }),
          idempotencyKey: `sustainability.factor_set_imported:${set.id}`,
        },
        client
      );

      const created = await findFactorSet(set.id, ctx.companyId, client);
      /* c8 ignore next */
      if (!created) throw new AppError('INTERNAL', 'Factor set could not be read back');
      return { factorSet: toFactorSetView(created), imported: written };
    });

    res.status(201).json({
      ...result,
      countsByCategory: diff.countsByCategory,
      units: diff.units,
      /*
       * §41.3 said out loud at the moment somebody could most easily assume the
       * opposite: a set imported today does not restate a figure calculated last
       * quarter. Selection is by date and reporting year, and existing calculations
       * keep citing what they cited.
       */
      notice:
        'This set applies to calculations made from now on. Projects already calculated against an earlier set are unchanged and still cite it.',
    });
  })
);

/**
 * DELETE /v1/factor-sets/:id — refused while cited, which is the answer rather than
 * an omission.
 *
 * Packet §7: *"refused while cited; deactivation is the operation"*. The foreign key
 * on `carbon_calculations` is a plain reference with no cascade, so the database
 * would refuse it anyway — this exists so the refusal is a sentence naming the
 * count and pointing at deactivation, rather than a constraint violation.
 */
factorSetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertFactorFeature(ctx);
    await assertCapability(ctx, 'sustainability.factors.manage');

    const id = uuidParam(req, 'id');
    const existing = await findFactorSet(id, ctx.companyId);
    if (!existing) throw new AppError('NOT_FOUND', 'Factor set not found');
    if (existing.company_id === null) {
      throw new AppError('FORBIDDEN', 'The platform factor library is read-only.');
    }

    const cited = Number(existing.cited_by_calculations);
    if (cited > 0) {
      throw new AppError(
        'CONFLICT',
        `${cited} current calculation${cited === 1 ? '' : 's'} cite this set. Deactivate it instead — that stops it being selected and leaves those figures intact.`,
        { reason: 'CITED_BY_CALCULATIONS', citedByCalculations: cited }
      );
    }
    // Superseded rows count too: a superseded calculation is what a report issued
    // last quarter cited, and §41.3 promises that report still reconstructs.
    const historic = await queryOne<{ n: string }>(
      `select count(*)::text as n from carbon_calculations where factor_set_id = $1`,
      [id]
    );
    if (Number(historic?.n ?? 0) > 0) {
      throw new AppError(
        'CONFLICT',
        'A superseded calculation still cites this set, and a report issued against it must still reconstruct. Deactivate it instead.',
        { reason: 'CITED_BY_HISTORY' }
      );
    }

    await withTransaction(async (client) => {
      await query(`delete from emission_factor_sets where id = $1 and company_id = $2`, [
        id,
        ctx.companyId,
      ], client);
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'factor_set.deactivated',
          entityType: 'EMISSION_FACTOR_SET',
          entityId: id,
          description: `${existing.name} ${existing.version} deleted (never cited)`,
        },
        client
      );
    });
    res.status(204).end();
  })
);

export { MAX_IMPORT_ROWS };
