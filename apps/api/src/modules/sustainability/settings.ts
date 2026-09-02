import { Router } from 'express';
import {
  DEFAULT_DATA_QUALITY_WEIGHTS,
  DEFAULT_REPORT_DISCLAIMER,
  dataQualityWeightsSchema,
  resolveDisplacementUpdate,
  updateSustainabilitySettingsSchema,
  type DataQualityWeights,
  type DisplacementBasis,
  type SustainabilitySettingsView,
} from '@crewquo/shared';
import type { Queryable } from '../../db';
import { queryOne, withTransaction } from '../../db';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { recordAudit } from '../audit/record';
import { recordRevision } from '../revisions/record';

/**
 * Sustainability settings (§39) — step 1 of the Phase 9 build order.
 *
 * **First, and before the factor tables** (`sustainability.md` §13.4): the
 * displacement basis, the data-quality weights and the display units are read by
 * three later steps, and building the engine against constants and then changing
 * every signature is the work this ordering avoids.
 *
 * The module is one file rather than the repo/routes pair the rest of the phase
 * uses, for the reason `massBalance.ts` gives: it is one row, two routes and a
 * loader everything else in the phase calls. Splitting it would be ceremony.
 */

export interface SettingsRow {
  company_id: string;
  default_country: string;
  default_factor_set_id: string | null;
  reporting_year: number | null;
  weight_unit: 'KG' | 'TONNE' | 'AUTO';
  distance_unit: 'KM' | 'MILE';
  carbon_display_unit: 'KGCO2E' | 'TCO2E' | 'AUTO';
  default_displacement_basis: DisplacementBasis;
  default_displacement_pct: string | null;
  allow_generic_product_factors: boolean;
  require_document_for_verified_weight: boolean;
  capture_gps_on_evidence: boolean;
  data_quality_weights: unknown;
  data_quality_warn_below: number;
  report_disclaimer: string;
  report_logo_file_id: string | null;
  report_accent_hex: string | null;
  enforce_compliance: boolean;
  updated_at: Date;
}

const COLUMNS = `company_id, default_country, default_factor_set_id, reporting_year,
  weight_unit, distance_unit, carbon_display_unit,
  default_displacement_basis, default_displacement_pct::text as default_displacement_pct,
  allow_generic_product_factors, require_document_for_verified_weight,
  capture_gps_on_evidence, data_quality_weights, data_quality_warn_below,
  report_disclaimer, report_logo_file_id, report_accent_hex, enforce_compliance, updated_at`;

/**
 * Read the company's settings, creating the row from **shared defaults** if it is
 * not there.
 *
 * `0037` backfilled every company that existed when it ran; this is what a company
 * created afterwards gets, and a read path that assumed the row existed would be a
 * 500 waiting for the first new customer.
 *
 * **The insert names the two values the packet cares about explicitly**, rather
 * than letting the DDL defaults supply them. Finding 5 requires the authority for
 * the weights and the disclaimer to be shared code — *"a default that lives only
 * in a migration cannot be read by the engine"* — so the row a company actually
 * gets comes from the engine's copy, and `parity.test.ts` keeps the DDL's copy in
 * step so the table stays insertable by hand.
 */
export async function ensureSettings(
  companyId: string,
  runner?: Queryable
): Promise<SettingsRow> {
  const existing = await queryOne<SettingsRow>(
    `select ${COLUMNS} from sustainability_settings where company_id = $1`,
    [companyId],
    runner
  );
  if (existing) return existing;

  const created = await queryOne<SettingsRow>(
    `insert into sustainability_settings (company_id, data_quality_weights, report_disclaimer)
     values ($1, $2::jsonb, $3)
     on conflict (company_id) do nothing
     returning ${COLUMNS}`,
    [companyId, JSON.stringify(DEFAULT_DATA_QUALITY_WEIGHTS), DEFAULT_REPORT_DISCLAIMER],
    runner
  );
  if (created) return created;

  // `do nothing` returns no row when somebody else inserted between the select and
  // the insert. Re-read rather than retry: the row is there, and it is theirs.
  const raced = await queryOne<SettingsRow>(
    `select ${COLUMNS} from sustainability_settings where company_id = $1`,
    [companyId],
    runner
  );
  /* c8 ignore next */
  if (!raced) throw new AppError('INTERNAL', 'Sustainability settings could not be created');
  return raced;
}

/**
 * The weights, validated on the way out of the database.
 *
 * A jsonb column can hold anything, and a set that does not sum to 1 silently
 * rescales the published percentage — so a malformed row falls back to the shipped
 * defaults rather than producing a plausible wrong score. The fallback is loud in
 * the only way a pure read can be: the score is computed from a known-good set, so
 * it is right, and the row is visibly not what the settings screen shows.
 */
export function readWeights(raw: unknown): DataQualityWeights {
  const parsed = dataQualityWeightsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_DATA_QUALITY_WEIGHTS;
}

export function toSettingsView(row: SettingsRow): SustainabilitySettingsView {
  return {
    companyId: row.company_id,
    defaultCountry: row.default_country,
    defaultFactorSetId: row.default_factor_set_id,
    reportingYear: row.reporting_year,
    weightUnit: row.weight_unit,
    distanceUnit: row.distance_unit,
    carbonDisplayUnit: row.carbon_display_unit,
    defaultDisplacementBasis: row.default_displacement_basis,
    defaultDisplacementPct:
      row.default_displacement_pct === null ? null : Number(row.default_displacement_pct),
    allowGenericProductFactors: row.allow_generic_product_factors,
    requireDocumentForVerifiedWeight: row.require_document_for_verified_weight,
    captureGpsOnEvidence: row.capture_gps_on_evidence,
    dataQualityWeights: readWeights(row.data_quality_weights),
    dataQualityWarnBelow: row.data_quality_warn_below,
    reportDisclaimer: row.report_disclaimer,
    reportLogoFileId: row.report_logo_file_id,
    reportAccentHex: row.report_accent_hex,
    enforceCompliance: row.enforce_compliance,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * `sustainability` on the acting company, and this one is **not** the project-owner
 * rule.
 *
 * Settings are company configuration read and written by that company about its own
 * assumptions; there is no project to find an owner of. The same reasoning that
 * puts `custom_factors` on the importing company (finding 9), one noun over.
 */
async function assertSustainabilityFeature(companyId: string): Promise<void> {
  if (!(await hasFeature(companyId, 'sustainability'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: sustainability', {
      feature: 'sustainability',
    });
  }
}

/** The subset of a settings row a revision trail should carry. */
function settingsFacts(view: SustainabilitySettingsView): Record<string, unknown> {
  return {
    defaultCountry: view.defaultCountry,
    defaultFactorSetId: view.defaultFactorSetId,
    reportingYear: view.reportingYear,
    weightUnit: view.weightUnit,
    distanceUnit: view.distanceUnit,
    carbonDisplayUnit: view.carbonDisplayUnit,
    defaultDisplacementBasis: view.defaultDisplacementBasis,
    defaultDisplacementPct: view.defaultDisplacementPct,
    allowGenericProductFactors: view.allowGenericProductFactors,
    requireDocumentForVerifiedWeight: view.requireDocumentForVerifiedWeight,
    captureGpsOnEvidence: view.captureGpsOnEvidence,
    dataQualityWeights: view.dataQualityWeights,
    dataQualityWarnBelow: view.dataQualityWarnBelow,
    reportDisclaimer: view.reportDisclaimer,
    enforceCompliance: view.enforceCompliance,
  };
}

export const sustainabilitySettingsRouter = Router();

/**
 * GET /v1/sustainability-settings
 *
 * `sustainability.read` rather than `.settings.manage`: a project manager reading a
 * carbon figure needs to know what assumptions produced it, and a settings screen
 * nobody but an admin may look at is how an assumption becomes invisible. The write
 * is the privileged half.
 */
sustainabilitySettingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertSustainabilityFeature(ctx.companyId);
    await assertCapability(ctx, 'sustainability.read');
    res.json({ settings: toSettingsView(await ensureSettings(ctx.companyId)) });
  })
);

/**
 * PATCH /v1/sustainability-settings
 *
 * **The displacement pair is resolved against the stored row before it is
 * validated**, which is the one thing a schema cannot do. Sending
 * `{ defaultDisplacementBasis: 'USER_DEFINED' }` alone is a valid patch and an
 * invalid settings row, and `0037`'s check constraint would refuse it with a
 * constraint name rather than a sentence.
 *
 * Everything here writes a `record_revisions` row. §36 stars *"sustainability
 * classifications"*, and these assumptions are upstream of every figure the company
 * publishes: a displacement basis changed in November is the reason a March figure
 * and a December figure disagree, and the before/after is the only thing that can
 * say so.
 *
 * **Changing settings does not recalculate anything.** That is deliberate and it is
 * the §41.3 rule: a newer assumption is never applied retrospectively to a project
 * that has already been calculated and reported. The next recalculation of a
 * project — triggered by its own inputs changing — picks up the new settings, and
 * the screen says which assumptions its current figures were computed under.
 */
sustainabilitySettingsRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertSustainabilityFeature(ctx.companyId);
    await assertCapability(ctx, 'sustainability.settings.manage');

    const input = updateSustainabilitySettingsSchema.parse(req.body);

    const updated = await withTransaction(async (client) => {
      const before = await ensureSettings(ctx.companyId, client);
      const beforeView = toSettingsView(before);

      const displacement = resolveDisplacementUpdate({
        current: {
          basis: before.default_displacement_basis,
          pct:
            before.default_displacement_pct === null
              ? null
              : Number(before.default_displacement_pct),
        },
        patch: {
          basis: input.defaultDisplacementBasis,
          pct: input.defaultDisplacementPct,
        },
      });
      if (displacement.error !== null) {
        throw new AppError('VALIDATION', displacement.error, { field: 'defaultDisplacementBasis' });
      }

      if (input.defaultFactorSetId != null) {
        // Reachability by this caller, not existence — the attack `projectAccess`
        // closes for projects. Citing another tenant's set would make every figure
        // this company publishes cite a set it cannot read.
        const set = await queryOne<{ id: string }>(
          `select id from emission_factor_sets
            where id = $1 and (company_id = $2 or company_id is null)`,
          [input.defaultFactorSetId, ctx.companyId],
          client
        );
        if (!set) throw new AppError('NOT_FOUND', 'Factor set not found');
      }

      const row = await queryOne<SettingsRow>(
        `update sustainability_settings set
           default_country = coalesce($2, default_country),
           default_factor_set_id = case when $3::boolean then $4::uuid else default_factor_set_id end,
           reporting_year = case when $5::boolean then $6::int else reporting_year end,
           weight_unit = coalesce($7, weight_unit),
           distance_unit = coalesce($8, distance_unit),
           carbon_display_unit = coalesce($9, carbon_display_unit),
           default_displacement_basis = $10,
           default_displacement_pct = $11::numeric,
           allow_generic_product_factors = coalesce($12, allow_generic_product_factors),
           require_document_for_verified_weight =
             coalesce($13, require_document_for_verified_weight),
           capture_gps_on_evidence = coalesce($14, capture_gps_on_evidence),
           data_quality_weights = coalesce($15::jsonb, data_quality_weights),
           data_quality_warn_below = coalesce($16, data_quality_warn_below),
           report_disclaimer = coalesce($17, report_disclaimer),
           report_logo_file_id = case when $18::boolean then $19::uuid else report_logo_file_id end,
           report_accent_hex = case when $20::boolean then $21::text else report_accent_hex end,
           enforce_compliance = coalesce($22, enforce_compliance),
           updated_by_user_id = $23,
           updated_at = now()
         where company_id = $1
         returning ${COLUMNS}`,
        [
          ctx.companyId,
          input.defaultCountry ?? null,
          // Two parameters per nullable field: "was it sent" and "what was sent".
          // `coalesce` alone cannot express "set this to null", which is exactly
          // what clearing a pinned factor set is.
          input.defaultFactorSetId !== undefined,
          input.defaultFactorSetId ?? null,
          input.reportingYear !== undefined,
          input.reportingYear ?? null,
          input.weightUnit ?? null,
          input.distanceUnit ?? null,
          input.carbonDisplayUnit ?? null,
          displacement.basis,
          displacement.pct,
          input.allowGenericProductFactors ?? null,
          input.requireDocumentForVerifiedWeight ?? null,
          input.captureGpsOnEvidence ?? null,
          input.dataQualityWeights === undefined
            ? null
            : JSON.stringify(input.dataQualityWeights),
          input.dataQualityWarnBelow ?? null,
          input.reportDisclaimer ?? null,
          input.reportLogoFileId !== undefined,
          input.reportLogoFileId ?? null,
          input.reportAccentHex !== undefined,
          input.reportAccentHex ?? null,
          input.enforceCompliance ?? null,
          ctx.userId,
        ],
        client
      );
      /* c8 ignore next */
      if (!row) throw new AppError('INTERNAL', 'Settings could not be updated');

      const afterView = toSettingsView(row);
      await recordRevision(
        {
          companyId: ctx.companyId,
          entityType: 'SUSTAINABILITY_SETTINGS',
          entityId: ctx.companyId,
          action: 'UPDATE',
          before: settingsFacts(beforeView),
          after: settingsFacts(afterView),
          changedByUserId: ctx.userId,
        },
        client
      );
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'sustainability_settings.updated',
          entityType: 'SUSTAINABILITY_SETTINGS',
          entityId: ctx.companyId,
          description:
            displacement.basis !== before.default_displacement_basis
              ? `Displacement assumption changed to ${displacement.basis}`
              : 'Sustainability settings changed',
        },
        client
      );
      return afterView;
    });

    res.json({
      settings: updated,
      /*
       * Said on the response rather than only in a doc, because the alternative
       * reading — that a new assumption restates last quarter's published figure —
       * is the one §41.3 forbids and the one an operator would assume.
       */
      notice:
        'These assumptions apply to figures calculated from now on. Existing calculations are unchanged until their own inputs change, so a report already issued still says what it said.',
    });
  })
);
