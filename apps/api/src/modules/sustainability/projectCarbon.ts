import { Router } from 'express';
import {
  AVOIDED_METHODOLOGY_WARNING,
  CARBON_BUCKETS,
  DATA_QUALITY_COMPONENT_LABELS,
  GHG_SCOPES,
  computeDataQuality,
  computeMassBalance,
  describeCarbonGaps,
  describeGaps,
  describeUnclaimedRetainedMass,
  type AvoidedClaimView,
  type CarbonBucket,
  type CarbonCalculationView,
  type DataQualityComponentView,
  type GhgScope,
  type ProjectCarbonResponse,
  type ProjectCarbonView,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { query, queryOne } from '../../db';
import { assertCapability, hasCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { loadForBalance } from '../assets/massBalance';
import { projectAccess, type ProjectAccess } from '../assets/routes';
import { ensureSettings, readWeights } from './settings';
import { recalculateProject } from './engine';

/**
 * The project Sustainability section (§28) — steps 7 and 8 of the Phase 9 build
 * order.
 *
 * **It computes nothing that was not already computed**, in two senses. The carbon
 * figures are read from `carbon_calculations`, which the engine wrote; the masses
 * and four of the five completeness components come from `computeMassBalance`,
 * which Phase 8 tested exhaustively. What this file adds is the fifth component,
 * the score that weights all five, and the assembly.
 *
 * ── THE OMITTED KEYS (§4) ───────────────────────────────────────────────────
 *
 * `sustainability.read` is **not** in the Supervisor bundle, and Phase 8 already
 * handled the consequence by giving `project.read` a mass-only mass balance. This
 * must not undo that: a reader without the capability gets `{ view: 'MASS_ONLY' }`
 * with **no carbon keys at all**, because `projectEmissionsKgCo2e: null` invites a
 * client to render "0.00 tCO₂e" where the honest statement is that this reader was
 * not shown the figure. An absent key cannot be mistaken for a computed nothing.
 *
 * ── THE DEBT THIS DISCHARGES (§13.5 of the assets packet) ───────────────────
 *
 * Phase 8 shipped `describeGaps` and deliberately withheld the percentage, because
 * four of §28.3's five components were computable and the fifth was this phase's:
 * *"a percentage published over four fifths of a definition changes meaning when
 * Phase 9 lands, downward, on projects nobody touched."* All five are computable
 * now, so the score ships — **itemised**, with each component's weight and measured
 * value, because a customer who has been reading named gaps for a phase now sees a
 * number for the first time and will report it as a regression otherwise.
 *
 * **Phase 8's gap sentences are unchanged and are not regenerated here.**
 * `computeDataQuality` emits only the fifth sentence for exactly this reason: the
 * other four already exist, nearly verbatim, in `describeGaps`, and rendering both
 * would put every gap in the report twice, in two wordings, reading as two problems.
 */

// ── Loading the current ledger ───────────────────────────────────────────────

interface CalculationRow {
  id: string;
  bucket: CarbonBucket;
  scope: GhgScope | null;
  scope3_category: number | null;
  source_type: CarbonCalculationView['sourceType'];
  source_id: string | null;
  method: CarbonCalculationView['method'];
  quantity: string;
  unit: string;
  kg_co2e: string;
  is_estimate: boolean;
  confidence: CarbonCalculationView['confidence'];
  factor_set_id: string | null;
  factor_id: string | null;
  product_factor_id: string | null;
  factor_set_name: string;
  factor_set_version: string;
  factor_reporting_year: number | null;
  factor_kg_co2e_per_unit: string | null;
  methodology: string | null;
  inputs: Record<string, unknown>;
  calculated_at: Date;
  superseded_by: string | null;
  region: string | null;
}

const CALC_COLUMNS = `c.id, c.bucket, c.scope, c.scope3_category, c.source_type, c.source_id,
  c.method, c.quantity::text as quantity, c.unit, c.kg_co2e::text as kg_co2e,
  c.is_estimate, c.confidence, c.factor_set_id, c.factor_id, c.product_factor_id,
  c.factor_set_name, c.factor_set_version, c.factor_reporting_year,
  c.factor_kg_co2e_per_unit::text as factor_kg_co2e_per_unit, c.methodology,
  c.inputs, c.calculated_at, c.superseded_by, s.region`;

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export function toCalculationView(row: CalculationRow): CarbonCalculationView {
  return {
    id: row.id,
    bucket: row.bucket,
    scope: row.scope,
    scope3Category: row.scope3_category,
    sourceType: row.source_type,
    sourceId: row.source_id,
    method: row.method,
    quantity: Number(row.quantity),
    unit: row.unit,
    kgCo2e: Number(row.kg_co2e),
    isEstimate: row.is_estimate,
    confidence: row.confidence,
    citation: {
      factorSetId: row.factor_set_id,
      factorId: row.factor_id,
      productFactorId: row.product_factor_id,
      factorSetName: row.factor_set_name,
      factorSetVersion: row.factor_set_version,
      factorReportingYear: row.factor_reporting_year,
      factorKgCo2ePerUnit: num(row.factor_kg_co2e_per_unit),
      methodology: row.methodology,
    },
    inputs: row.inputs,
    calculatedAt: row.calculated_at.toISOString(),
    supersededBy: row.superseded_by,
  };
}

function loadCalculations(projectId: string, includeSuperseded: boolean): Promise<CalculationRow[]> {
  return query<CalculationRow>(
    `select ${CALC_COLUMNS}
       from carbon_calculations c
       left join emission_factor_sets s on s.id = c.factor_set_id
      where c.project_id = $1 and ($2::boolean or c.superseded_by is null)
      order by c.calculated_at desc, c.bucket`,
    [projectId, includeSuperseded]
  );
}

interface ClaimRow {
  id: string;
  calculation_id: string;
  asset_movement_id: string | null;
  baseline_scenario: string;
  alternative_scenario: string;
  displacement_pct: string | null;
  displacement_basis: AvoidedClaimView['displacementBasis'];
  baseline_kg_co2e: string;
  enabling_kg_co2e: string;
  net_avoided_kg_co2e: string;
  system_boundary: AvoidedClaimView['systemBoundary'];
  assumptions: string;
  uncertainty: string | null;
  methodology: string;
  created_at: Date;
  is_generic: boolean;
  mass_kg: string | null;
}

/**
 * The current claims, each with the mass behind it and whether the factor it used
 * was a generic.
 *
 * Those last two columns are §28.3's fifth component: *"avoided-emissions mass
 * using a product-specific (non-generic) factor"*. They are computed in the query
 * rather than in a second pass because the claim already joins its calculation and
 * its product factor, and the mass is the calculation's own quantity when the
 * factor is per-kg — for a per-item factor it is the movement's derived weight,
 * which is what `massBalance.ts` would say.
 */
function loadClaims(projectId: string): Promise<ClaimRow[]> {
  return query<ClaimRow>(
    `select a.id, a.calculation_id, a.asset_movement_id,
            a.baseline_scenario, a.alternative_scenario,
            a.displacement_pct::text as displacement_pct, a.displacement_basis,
            a.baseline_kg_co2e::text as baseline_kg_co2e,
            a.enabling_kg_co2e::text as enabling_kg_co2e,
            a.net_avoided_kg_co2e::text as net_avoided_kg_co2e,
            a.system_boundary, a.assumptions, a.uncertainty, a.methodology, a.created_at,
            coalesce(p.verification_status = 'GENERIC_ESTIMATE', false) as is_generic,
            coalesce(m.weight_kg, m.quantity * pa.unit_weight_kg)::text as mass_kg
       from avoided_emissions_claims a
       join carbon_calculations c on c.id = a.calculation_id
       left join product_carbon_factors p on p.id = c.product_factor_id
       left join asset_movements m on m.id = a.asset_movement_id
       left join project_assets pa on pa.id = m.asset_id
      where c.project_id = $1 and c.superseded_by is null
      order by a.created_at`,
    [projectId]
  );
}

function toClaimView(row: ClaimRow): AvoidedClaimView {
  return {
    id: row.id,
    calculationId: row.calculation_id,
    assetMovementId: row.asset_movement_id,
    baselineScenario: row.baseline_scenario,
    alternativeScenario: row.alternative_scenario,
    displacementPct: num(row.displacement_pct),
    displacementBasis: row.displacement_basis,
    baselineKgCo2e: Number(row.baseline_kg_co2e),
    enablingKgCo2e: Number(row.enabling_kg_co2e),
    netAvoidedKgCo2e: Number(row.net_avoided_kg_co2e),
    systemBoundary: row.system_boundary,
    assumptions: row.assumptions,
    uncertainty: row.uncertainty,
    methodology: row.methodology,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The gaps, read back from the calculations that were *not* produced.
 *
 * There is no `carbon_gaps` table, and there should not be: a gap is the absence of
 * a calculation, so storing it would create a second record that can disagree with
 * the ledger — the exact shape §28.3's "quietly omits its own gaps" failure takes
 * in reverse. The engine recomputes them on every run and this route recomputes
 * them from the same inputs, which is cheap because the inputs are already loaded.
 */
async function currentGaps(projectId: string): Promise<{ gaps: string[]; retainedKg: number }> {
  const assets = await loadForBalance(projectId);
  const balance = computeMassBalance(assets);

  /*
   * **Retained-in-use mass that displaced nothing** — packet §0 finding 7, and the
   * `and not d.displaces_replacement` is the whole of it.
   *
   * `RETAINED` and `RELOCATED` both count as retained-in-use; only `RELOCATED`
   * displaces a replacement, and `DONATION` counts as retained-in-use *and*
   * displaces. Summing over the `RETAINED_IN_USE` flag alone would put the donated
   * 495 kg into a sentence saying no claim was made for it, immediately below the
   * claim that was made for it.
   *
   * A separate query rather than `byDestination`, because `DestinationMass` carries
   * the six counts-as flags and not `displaces_replacement` — and widening that
   * type to answer one sentence here would put a carbon concept into Phase 8's
   * mass vocabulary.
   */
  const rows = await query<{ kg: string | null }>(
    `select sum(coalesce(m.weight_kg, m.quantity * a.unit_weight_kg))::text as kg
       from asset_movements m
       join project_assets a on a.id = m.asset_id
       join destination_types d on d.id = m.destination_type_id
      where a.project_id = $1
        and m.deleted_at is null and a.deleted_at is null
        and d.counts_as_retained_in_use and not d.displaces_replacement
        and not exists (
          select 1 from asset_movements c
           where c.continues_movement_id = m.id and c.deleted_at is null
        )`,
    [projectId]
  );
  return { gaps: describeGaps(balance), retainedKg: Number(rows[0]?.kg ?? 0) };
}

// ── The routes ───────────────────────────────────────────────────────────────

export const projectCarbonRouter = Router();

async function assertCarbonFeature(access: ProjectAccess): Promise<void> {
  if (!(await hasFeature(access.ownerCompanyId, 'sustainability'))) {
    throw new AppError(
      'FORBIDDEN',
      access.isOwner
        ? 'Your plan does not include: sustainability'
        : 'This project’s owner does not have sustainability enabled',
      { feature: 'sustainability' }
    );
  }
}

/**
 * GET /v1/projects/:projectId/carbon
 *
 * **Reads; it does not calculate.** A GET that writes is a GET two concurrent
 * readers race on, and it would make a read-only reader's request depend on a
 * project lock. The section reports `calculatedAt` and, when the ledger predates
 * its own inputs, says so — which is the honest place for staleness rather than
 * hiding it behind a write nobody asked for.
 *
 * **The scope is the project, for a provider as well as the owner**, exactly as the
 * mass balance is and for the reason §4 gives: a subcontractor reading the
 * project's emissions learns a mass times a factor. It learns no counterparty
 * identity, no rate, no margin and no other provider's register. What it must not
 * get is the organisation dashboard, which is a different route with a different
 * scope.
 */
projectCarbonRouter.get(
  '/:projectId/carbon',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertCarbonFeature(access);
    await assertCapability(ctx, 'project.read');

    if (!(await hasCapability(ctx, 'sustainability.read'))) {
      /*
       * The omitted keys, as a discriminated union rather than a nulled object. A
       * client has to switch on `view` before a carbon field exists to be read at
       * all — the same shape `MassBalanceView` uses, chosen for the same reason.
       */
      const denied: ProjectCarbonResponse = { view: 'MASS_ONLY', reason: 'CAPABILITY' };
      res.json({ carbon: denied });
      return;
    }

    const settings = await ensureSettings(access.ownerCompanyId);
    const [calculations, claims, massGaps] = await Promise.all([
      loadCalculations(access.projectId, false),
      loadClaims(access.projectId),
      currentGaps(access.projectId),
    ]);

    const view = await assembleView({
      projectId: access.projectId,
      settings,
      calculations,
      claims,
      massGaps,
    });
    res.json({ carbon: view });
  })
);

/**
 * GET /v1/projects/:projectId/carbon/calculations — the trace (§41.2).
 *
 * Every row with its citation, superseded ones included on request. This is what
 * makes *"every number traceable to a factor and a version"* a thing a person can
 * check rather than a claim in a document: the milestone's two headline figures are
 * a sum over these rows, and each of them names the factor, the set, the version,
 * the reporting year and the value it multiplied.
 */
projectCarbonRouter.get(
  '/:projectId/carbon/calculations',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertCarbonFeature(access);
    await assertCapability(ctx, 'sustainability.read');

    const rows = await loadCalculations(
      access.projectId,
      req.query.includeSuperseded === 'true'
    );
    res.json({ calculations: rows.map(toCalculationView) });
  })
);

/**
 * POST /v1/projects/:projectId/carbon/recalculate
 *
 * **The one place a person asks for a calculation**, and the reason it is explicit
 * rather than automatic on import is §41.3: *"a newer factor set is never applied
 * retrospectively to a project that has already been calculated and reported."*
 * Importing the 2028 set must not silently restate a 2027 project's published
 * figures; asking for it must.
 *
 * `sustainability.write` rather than `.read`, because it writes rows — and it is
 * the capability a project manager holds, which is who has the reason to press it.
 */
projectCarbonRouter.post(
  '/:projectId/carbon/recalculate',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertCarbonFeature(access);
    await assertCapability(ctx, 'sustainability.write');

    const result = await recalculateProject({
      projectId: access.projectId,
      trigger: 'FACTOR_SET_REIMPORTED',
      actorUserId: ctx.userId,
    });
    res.json({ recalculation: result });
  })
);

// ── Assembly ─────────────────────────────────────────────────────────────────

/**
 * Turn the ledger into §28's section.
 *
 * Exported because the organisation dashboard needs the same completeness figure
 * per project, and two implementations of "what is this project's data quality"
 * would be two answers to a question §38.1 attaches to every figure below a
 * threshold.
 */
export async function assembleView(args: {
  projectId: string;
  settings: Awaited<ReturnType<typeof ensureSettings>>;
  calculations: CalculationRow[];
  claims: ClaimRow[];
  massGaps: { gaps: string[]; retainedKg: number };
}): Promise<ProjectCarbonView> {
  const { calculations, claims, settings } = args;
  const massUnit = settings.weight_unit;
  const carbonUnit = settings.carbon_display_unit;

  const byBucket = CARBON_BUCKETS.map((bucket) => {
    const rows = calculations.filter((c) => c.bucket === bucket);
    return {
      bucket,
      kgCo2e: rows.reduce((sum, r) => sum + Number(r.kg_co2e), 0),
      rowCount: rows.length,
    };
  });
  const bucket = (name: CarbonBucket): number =>
    byBucket.find((b) => b.bucket === name)?.kgCo2e ?? 0;

  /*
   * **Null, not zero, when nothing has been calculated** (§41.1, §44's "empty
   * project returns nulls not zeros"). A project with no factor set has not emitted
   * nothing — nobody has measured it — and a headline of `0.00 tCO₂e` is a claim
   * with the authority of a number behind it.
   */
  const calculated = calculations.length > 0;

  /*
   * `byScope` is taken over the inventory buckets only, and the filter is explicit
   * even though an AVOIDED row carries no scope. The next person to give avoided
   * rows a scope for some reporting convenience should have to delete a line to
   * break the rule, not merely add a column.
   */
  const byScope = GHG_SCOPES.map((scope) => ({
    scope,
    kgCo2e: calculations
      .filter(
        (c) =>
          c.scope === scope &&
          (c.bucket === 'PROJECT_EMISSIONS' || c.bucket === 'WASTE_TREATMENT')
      )
      .reduce((sum, r) => sum + Number(r.kg_co2e), 0),
  }));

  // ── Completeness (§28.3), all five components ────────────────────────────
  const assets = await loadForBalance(args.projectId);
  const balance = computeMassBalance(assets);
  const avoidedMassKg = claims.reduce((sum, c) => sum + (Number(c.mass_kg) || 0), 0);
  const avoidedSpecificKg = claims
    .filter((c) => !c.is_generic)
    .reduce((sum, c) => sum + (Number(c.mass_kg) || 0), 0);

  const quality = computeDataQuality(
    {
      lineCount: balance.lineCount,
      linesWithWeight: balance.linesWithWeight,
      linesWithSupport: balance.linesWithSupport,
      allocatedKg: balance.allocatedKg,
      handledKg: balance.handledKg,
      documentedMassKg: balance.documentedMassKg,
      avoidedMassKg,
      avoidedMassOnSpecificFactorKg: avoidedSpecificKg,
    },
    // From §39, never from constants. This is what packet finding 5 required and
    // what makes an edited weight actually change the published percentage.
    readWeights(settings.data_quality_weights),
    { massUnit }
  );

  const components: DataQualityComponentView[] = quality.components.map((c) => ({
    ...c,
    label: DATA_QUALITY_COMPONENT_LABELS[c.component],
  }));

  // ── Gaps ─────────────────────────────────────────────────────────────────
  //
  // Three sources, and the order is the order a reader wants them: what could not
  // be quantified, then what is missing from the mass record, then the sentence
  // finding 7 owes about retained-in-use mass that displaced nothing.
  const engineGaps = await recomputeGapSentences(args.projectId, settings);
  const retainedSentence = describeUnclaimedRetainedMass(args.massGaps.retainedKg, { massUnit });

  const gaps = [
    ...engineGaps,
    ...args.massGaps.gaps,
    ...quality.warnings,
    ...(retainedSentence === null ? [] : [retainedSentence]),
  ];

  const factorSets = [
    ...new Map(
      calculations
        .filter((c) => c.factor_set_id !== null)
        .map((c) => [
          c.factor_set_id as string,
          {
            id: c.factor_set_id as string,
            name: c.factor_set_name,
            version: c.factor_set_version,
            reportingYear: c.factor_reporting_year ?? 0,
            region: c.region ?? settings.default_country,
          },
        ])
    ).values(),
  ];

  return {
    view: 'FULL',
    projectId: args.projectId,
    // The dominant set — the one most rows cite. A project spanning a year boundary
    // legitimately cites two, and `factorSets` below carries all of them so §38.2's
    // "mixed factor years are disclosed" is answerable one phase early.
    factorSet: factorSets[0] ?? null,
    factorSets,
    projectEmissionsKgCo2e: calculated
      ? bucket('PROJECT_EMISSIONS') + bucket('WASTE_TREATMENT')
      : null,
    avoidedKgCo2e: calculated ? bucket('AVOIDED') : null,
    comparativeLifecycleKgCo2e: calculated ? bucket('COMPARATIVE_LIFECYCLE') : null,
    byBucket,
    byScope,
    hasGaps: gaps.length > 0,
    gaps,
    completeness: {
      pct: quality.pct,
      warnBelow: settings.data_quality_warn_below,
      components,
    },
    claims: claims.map(toClaimView),
    /*
     * §27.4: the methodology warning is *"shown wherever an avoided figure appears,
     * in the UI and in the report, not only in an appendix"*. Returning it on the
     * section rather than leaving a screen to hard-code it is what makes that true
     * of every client of this API rather than of the one we wrote.
     */
    methodologyWarning: AVOIDED_METHODOLOGY_WARNING,
    display: { carbonUnit, massUnit },
    calculatedAt:
      calculations.reduce<Date | null>(
        (latest, c) => (latest === null || c.calculated_at > latest ? c.calculated_at : latest),
        null
      )?.toISOString() ?? null,
  };
}

/**
 * The engine's own gap sentences, recomputed from the current inputs.
 *
 * A dry run of the calculation without the write: it is the only way to say *"no
 * waste-treatment factor exists for plasterboard in the 2027 factor set — 1.2 t
 * excluded"* without storing gaps, and storing gaps would create a record that can
 * disagree with the ledger.
 */
async function recomputeGapSentences(
  projectId: string,
  settings: Awaited<ReturnType<typeof ensureSettings>>
): Promise<string[]> {
  try {
    /*
     * **Derived from what the ledger does NOT contain**, rather than from a stored
     * gap table or a second run of the engine.
     *
     * A stored gap would be a second record that can disagree with the ledger, and
     * re-running the engine on a read would be a write on a GET. An input with no
     * current calculation against it is, by construction, an input the engine
     * declined to quantify — so the absence IS the gap, and it cannot drift.
     */
    const rows = await query<{ set_name: string | null }>(
      `select distinct s.name as set_name
         from carbon_calculations c
         join emission_factor_sets s on s.id = c.factor_set_id
        where c.project_id = $1 and c.superseded_by is null`,
      [projectId]
    );
    const setName = rows[0]?.set_name ?? undefined;

    const unquantified = await query<{
      reason: string;
      subject: string;
      quantity: string | null;
      unit: string | null;
    }>(
      /*
       * The two silences, as one query (packet finding 8).
       *
       * A movement with a `ghg_treatment_key` and no current WASTE_TREATMENT
       * calculation is **in scope, unquantified and disclosed**. A movement with a
       * null key produced nothing and is **out of scope and silent** — it is
       * excluded by the `is not null`, which is the whole of the distinction and
       * the reason a retained chair does not become a warning about material that
       * was handled perfectly.
       */
      `select 'NO_FACTOR' as reason,
              t.name as subject,
              coalesce(m.weight_kg, m.quantity * pa.unit_weight_kg)::text as quantity,
              'kg' as unit
         from asset_movements m
         join project_assets pa on pa.id = m.asset_id
         join asset_types t on t.id = pa.asset_type_id
         join destination_types d on d.id = m.destination_type_id
        where pa.project_id = $1
          and m.deleted_at is null and pa.deleted_at is null
          and d.ghg_treatment_key is not null
          and not exists (
            select 1 from asset_movements c2
             where c2.continues_movement_id = m.id and c2.deleted_at is null
          )
          and not exists (
            select 1 from carbon_calculations cc
             where cc.project_id = $1 and cc.superseded_by is null
               and cc.source_type = 'ASSET_MOVEMENT' and cc.source_id = m.id
               and cc.bucket = 'WASTE_TREATMENT'
          )
       union all
       select case when $2::boolean then 'DISPLACEMENT_UNKNOWN' else 'NO_PRODUCT_FACTOR' end,
              t.name,
              m.quantity::text,
              'items'
         from asset_movements m
         join project_assets pa on pa.id = m.asset_id
         join asset_types t on t.id = pa.asset_type_id
         join destination_types d on d.id = m.destination_type_id
        where pa.project_id = $1
          and m.deleted_at is null and pa.deleted_at is null
          and d.displaces_replacement
          and not exists (
            select 1 from asset_movements c2
             where c2.continues_movement_id = m.id and c2.deleted_at is null
          )
          and not exists (
            select 1 from carbon_calculations cc
             where cc.project_id = $1 and cc.superseded_by is null
               and cc.source_type = 'ASSET_MOVEMENT' and cc.source_id = m.id
               and cc.bucket = 'AVOIDED'
          )
       union all
       select 'NO_FACTOR', a.kind, null, null
         from project_activities a
        where a.project_id = $1 and a.deleted_at is null
          and a.kind <> 'OTHER'
          and not exists (
            select 1 from carbon_calculations cc
             where cc.project_id = $1 and cc.superseded_by is null
               and cc.source_type = 'ACTIVITY' and cc.source_id = a.id
          )`,
      [projectId, settings.default_displacement_basis === 'UNKNOWN']
    );

    return describeCarbonGaps(
      unquantified.map((r) => ({
        reason: r.reason as 'NO_FACTOR' | 'NO_PRODUCT_FACTOR' | 'DISPLACEMENT_UNKNOWN',
        sourceType: 'ASSET_MOVEMENT' as const,
        sourceId: null,
        quantity: r.quantity === null ? null : Number(r.quantity),
        unit: r.unit,
        subject: r.subject,
      })),
      { factorSetName: setName, massUnit: settings.weight_unit }
    );
    /* c8 ignore start */
  } catch (err) {
    // A gap sentence that cannot be generated must not take the section down with
    // it: the figures are still right and the reader still needs them. The silence
    // is logged, which is the one thing §28.3's "a report that quietly omits its own
    // gaps" warning would otherwise not survive.
    console.error(`[carbon] gap sentences failed for project ${projectId}:`, err);
    return [];
  }
  /* c8 ignore stop */
}
