import type { PoolClient } from 'pg';
import {
  AVOIDED_METHODOLOGY_WARNING,
  UNIT_FOR_MEASURE,
  calculateActivityEmissions,
  calculateAvoidedEmissions,
  calculateWasteTreatmentEmissions,
  calculationsSupersededEventPayload,
  claimBlockedEventPayload,
  resolveDisplacementPct,
  resolveFactor,
  resolveProductFactor,
  selectFactorSet,
  type ActivityInput,
  type AnyCarbonOutcome,
  type AvoidedClaim,
  type CarbonBucket,
  type CarbonGap,
  type CarbonResult,
  type ClaimBlockedReason,
  type EmissionFactorInput,
  type EmissionFactorSetInput,
  type FactorQuery,
  type MovementInput,
  type ProductCarbonFactorInput,
  type SupersessionTrigger,
} from '@crewquo/shared';
import { query, queryOne, withTransaction } from '../../db';
import { AppError } from '../../http/errors';
import { enqueueOutboxEvent } from '../delivery/repo';
import { hasFeature } from '../entitlements/guards';
import { recordAudit } from '../audit/record';
import { loadFactorSetsForSelection, loadFactors, loadProductFactors } from './factorsRepo';
import { ensureSettings, type SettingsRow } from './settings';

/**
 * The calculation service (§27.2–§27.4) — steps 5 and 6 of the Phase 9 build order.
 *
 * **It computes nothing.** Every figure comes out of `packages/shared/carbon-engine/`,
 * which has had 126 tests since 9.0 for the reason §27.1 states for this phase
 * specifically: *"exhaustive tests before anything renders a number."* This file
 * loads rows, hands them to the pure functions, and writes what comes back. If a
 * total is ever wrong it is wrong in a module a unit test can pin, not in a SQL
 * aggregate nobody can reproduce.
 *
 * ── THE THREE RULES THIS FILE EXISTS TO KEEP ────────────────────────────────
 *
 * **1. Nobody corrects a calculation; you correct its input and it supersedes**
 * (§27.2). Recalculation writes new rows and stamps `superseded_by` on the old
 * ones in the same transaction. Nothing is updated in place, so a report generated
 * last quarter can still be reconstructed exactly.
 *
 * **2. Any write that changes what `massBalance.ts` would return must supersede the
 * calculations derived from it** (packet §0 finding 6). Correcting a weight,
 * tombstoning a line or movement, recording a continuation. Without this the mass
 * balance and the carbon roll-up — rendered side by side in the same §28 section —
 * disagree about whether the material exists, and every query still returns a
 * plausible number.
 *
 * **3. No factor is not a failure** (§41.1). It does not raise, does not retry,
 * does not dead-letter and does not produce a zero. It produces an unquantified
 * input, a named gap and, for the two claim reasons, an Action Centre item. This is
 * the single most important behavioural rule in the phase and the one most likely
 * to be "fixed" by somebody adding a fallback factor.
 *
 * ── CONCURRENCY ─────────────────────────────────────────────────────────────
 *
 * The lock is on the **project**, taken at the top of every recalculation
 * transaction — `money-boundary.md` §3's row-lock-then-recalculate rather than
 * check-then-act, which the assets packet already reused for the movement chain.
 * Two actors correcting two weights at once must not produce two recalculations
 * that each supersede the other's rows, leaving a project with two current sets for
 * the same bucket. Locking the calculation rows instead cannot work: the set of rows
 * to supersede is not known until after the recalculation has run.
 *
 * **No path takes the project lock and then an asset lock**, which is what keeps
 * this deadlock-free against the movement ledger: `movementsRoutes.ts` takes the
 * asset lock first and this second, and recalculation reads assets without locking
 * them.
 */

// ── What comes back ──────────────────────────────────────────────────────────

export interface RecalculationResult {
  projectId: string;
  /** Null when the project has no owner-side entitlement, so nothing was attempted. */
  skipped: 'NO_FEATURE' | 'UNCHANGED' | null;
  supersededCount: number;
  newCount: number;
  deltaByBucket: Record<string, number>;
  gaps: CarbonGap[];
}

interface PreparedRow {
  result: CarbonResult;
  claim: AvoidedClaim | null;
}

// ── Loading ──────────────────────────────────────────────────────────────────

interface ActivityRow {
  id: string;
  kind: ActivityInput['kind'];
  activity_date: string;
  vehicle_category: string | null;
  fuel_type: string | null;
  distance_km: string | null;
  litres: string | null;
  kwh: string | null;
  tonne_km: string | null;
  entered_value: string | null;
  entered_unit: string | null;
  source: ActivityInput['source'];
  provider_company_id: string | null;
  asset_movement_id: string | null;
}

interface MovementRow {
  id: string;
  quantity: string;
  weight_kg: string | null;
  unit_weight_kg: string | null;
  manufacturer: string | null;
  model: string | null;
  asset_type_id: string;
  asset_type_name: string;
  asset_type_category: string;
  weight_confidence: MovementInput['weightConfidence'];
  destination_code: string;
  destination_name: string;
  is_final_outcome: boolean;
  displaces_replacement: boolean;
  ghg_treatment_key: string | null;
  moved_on: string;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function loadActivities(projectId: string, client: PoolClient): Promise<ActivityRow[]> {
  return query<ActivityRow>(
    `select id, kind, to_char(activity_date, 'YYYY-MM-DD') as activity_date,
            vehicle_category, fuel_type,
            distance_km::text as distance_km, litres::text as litres,
            kwh::text as kwh, tonne_km::text as tonne_km,
            entered_value::text as entered_value, entered_unit,
            source, provider_company_id, asset_movement_id
       from project_activities
      where project_id = $1 and deleted_at is null
      order by activity_date, created_at`,
    [projectId],
    client
  );
}

/**
 * Every live movement on the project, with the asset facts the two movement
 * calculations need.
 *
 * **Tombstoned rows are excluded on both sides**, exactly as `massBalance.ts`
 * excludes them — which is finding 6 in one `where` clause: recalculating from this
 * query is what makes the carbon roll-up agree with the mass balance after a
 * tombstone, and the whole reason tombstoning has to *call* this function.
 *
 * **Continued movements are excluded.** A storage leg that has been carried onward
 * counts toward nothing in `massBalance.ts` — not the ceiling, not allocated mass,
 * not pending mass — and counting its treatment emission here would attribute a
 * disposal to material that has not been disposed of.
 */
function loadMovements(projectId: string, client: PoolClient): Promise<MovementRow[]> {
  return query<MovementRow>(
    `select m.id, m.quantity::text as quantity, m.weight_kg::text as weight_kg,
            a.unit_weight_kg::text as unit_weight_kg, a.manufacturer, a.model,
            a.asset_type_id, t.name as asset_type_name, t.category as asset_type_category,
            a.weight_confidence,
            d.code as destination_code, d.name as destination_name,
            d.is_final_outcome, d.displaces_replacement, d.ghg_treatment_key,
            to_char(m.moved_on, 'YYYY-MM-DD') as moved_on
       from asset_movements m
       join project_assets a on a.id = m.asset_id
       join asset_types t on t.id = a.asset_type_id
       join destination_types d on d.id = m.destination_type_id
      where a.project_id = $1
        and m.deleted_at is null and a.deleted_at is null
        and not exists (
          select 1 from asset_movements c
           where c.continues_movement_id = m.id and c.deleted_at is null
        )
      order by m.moved_on, m.sequence`,
    [projectId],
    client
  );
}

// ── Factor selection ─────────────────────────────────────────────────────────

/**
 * Which set applies to a row dated `date`.
 *
 * **Per row rather than per project**, because a project spanning a year boundary
 * legitimately uses two sets and §38.2 requires that to be disclosed rather than
 * silently resolved to one. A pinned `default_factor_set_id` overrides the walk
 * entirely — that is what a pin is for.
 *
 * **`AMBIGUOUS` refuses rather than guesses** (packet §9). Overlapping validity
 * windows are an operator error with no correct resolution: picking the newer one
 * silently would change which factors a project uses based on a data-entry mistake
 * nobody has noticed. The refusal names both sets, which makes it fixable in one
 * step.
 */
function chooseSet(
  sets: readonly EmissionFactorSetInput[],
  settings: SettingsRow,
  date: string
): EmissionFactorSetInput | null {
  if (settings.default_factor_set_id !== null) {
    return sets.find((s) => s.id === settings.default_factor_set_id) ?? null;
  }
  const selection = selectFactorSet(sets, {
    date,
    region: settings.default_country,
    reportingYear: settings.reporting_year,
  });
  if (selection.kind === 'SELECTED') return selection.set;
  if (selection.kind === 'AMBIGUOUS') {
    throw new AppError(
      'CONFLICT',
      `More than one factor set applies on ${date}: ${selection.candidates
        .map((c) => `${c.name} ${c.version}`)
        .join(' and ')}. Correct their validity windows, or pin one as the default.`,
      { reason: 'AMBIGUOUS_FACTOR_SET', candidates: selection.candidates.map((c) => c.id) }
    );
  }
  return null;
}

/**
 * The factor query for an activity kind.
 *
 * **Only the unit and the discriminators the person actually recorded.** A factor
 * set's `category` and `activity` are the publisher's free text — "Freighting
 * goods", "HGV (all diesel) — rigid, >7.5t–17t" — and nobody typing a fuel fill on a
 * phone chose a row in a workbook. So the query pins the unit, plus whichever of
 * vehicle category and fuel type the activity carries, and lets `resolveFactor`'s
 * specificity ranking pick the most specific match.
 *
 * When that leaves more than one equally specific candidate the resolver answers
 * `AMBIGUOUS`, which becomes a **disclosed gap naming what was looked for** rather
 * than a guess. That is the honest outcome: a set with two equally-good kWh factors
 * has an operator decision in it, and the alternative — taking the first — is a
 * number chosen by join order.
 */
function activityQuery(activity: ActivityRow, unit: string): FactorQuery {
  const q: FactorQuery = { unit: unit as FactorQuery['unit'] };
  if (activity.vehicle_category !== null && activity.vehicle_category !== '') {
    q.vehicleType = activity.vehicle_category;
  }
  if (activity.fuel_type !== null && activity.fuel_type !== '') {
    q.fuelType = activity.fuel_type;
  }
  return q;
}

/** The measure a kind is priced from, and the factor unit it is expressed in. */
function activityQuantity(row: ActivityRow): { quantity: number; unit: string } | null {
  const pairs: [string | null, keyof typeof UNIT_FOR_MEASURE][] = [
    [row.distance_km, 'distanceKm'],
    [row.litres, 'litres'],
    [row.kwh, 'kwh'],
    [row.tonne_km, 'tonneKm'],
  ];
  for (const [value, measure] of pairs) {
    const n = num(value);
    if (n !== null && n > 0) return { quantity: n, unit: UNIT_FOR_MEASURE[measure] };
  }
  return null;
}

/**
 * Resolve a treatment factor, most specific first, **asking twice rather than
 * widening silently**.
 *
 * `resolveFactor` deliberately applies no fallback on the way down: *"if the caller
 * wants the generic freight factor when the vehicle-specific one is missing, it asks
 * a second time with a looser query, and the report can then say which of the two it
 * got."* This is that second ask, and `matchedOn` is what the report says.
 */
function resolveTreatment(
  factors: readonly EmissionFactorInput[],
  treatment: string,
  material: string
): { factor: EmissionFactorInput | null; matchedOn: 'MATERIAL' | 'TREATMENT' | null; ambiguous: boolean } {
  const specific = resolveFactor(factors, { unit: 'tonne', treatment, material });
  if (specific.kind === 'RESOLVED') return { factor: specific.factor, matchedOn: 'MATERIAL', ambiguous: false };
  if (specific.kind === 'AMBIGUOUS') return { factor: null, matchedOn: null, ambiguous: true };

  const loose = resolveFactor(factors, { unit: 'tonne', treatment });
  if (loose.kind === 'RESOLVED') return { factor: loose.factor, matchedOn: 'TREATMENT', ambiguous: false };
  return { factor: null, matchedOn: null, ambiguous: loose.kind === 'AMBIGUOUS' };
}

// ── The run ──────────────────────────────────────────────────────────────────

interface RunInput {
  settings: SettingsRow;
  sets: readonly EmissionFactorSetInput[];
  factorsBySet: Map<string, EmissionFactorInput[]>;
  productFactors: readonly ProductCarbonFactorInput[];
  activities: readonly ActivityRow[];
  movements: readonly MovementRow[];
}

interface RunOutput {
  rows: PreparedRow[];
  outcomes: AnyCarbonOutcome[];
  gaps: CarbonGap[];
  blocked: { reason: ClaimBlockedReason; subject: string; quantity: number }[];
}

/**
 * Everything the engine produces for one project, from rows already loaded.
 *
 * Pure but for the loaded inputs, so the whole of what the phase computes is one
 * function whose behaviour is decided by its arguments — which is what makes the
 * acceptance script able to assert on figures rather than on a sequence of writes.
 */
function run(input: RunInput): RunOutput {
  const rows: PreparedRow[] = [];
  const outcomes: AnyCarbonOutcome[] = [];
  const gaps: CarbonGap[] = [];
  const blocked: RunOutput['blocked'] = [];
  /** Enabling emissions per movement, summed as activities are calculated. */
  const enablingByMovement = new Map<string, number>();

  const factorsFor = (set: EmissionFactorSetInput): EmissionFactorInput[] =>
    input.factorsBySet.get(set.id) ?? [];

  // ── Operational emissions (§27.3) ──────────────────────────────────────────
  for (const activity of input.activities) {
    const measure = activityQuantity(activity);
    if (measure === null) {
      /*
       * An OTHER activity with no measure. Nothing was quantified because nothing
       * quantifiable was recorded — a note, not a hole — so it is OUT_OF_SCOPE
       * rather than a gap. Reporting it would fill a client's report with warnings
       * about a line somebody added to say "the skip was collected".
       */
      outcomes.push({
        kind: 'OUT_OF_SCOPE',
        reason: 'NOT_A_WASTE_TREATMENT',
        subject: activity.kind,
      });
      continue;
    }

    const set = chooseSet(input.sets, input.settings, activity.activity_date);
    if (set === null) {
      const gap: CarbonGap = {
        reason: 'NO_FACTOR_SET',
        sourceType: 'ACTIVITY',
        sourceId: activity.id,
        quantity: measure.quantity,
        unit: measure.unit,
        subject: activity.kind.toLowerCase().replace(/_/g, ' '),
      };
      gaps.push(gap);
      outcomes.push({ kind: 'GAP', gap });
      continue;
    }

    const resolution = resolveFactor(factorsFor(set), activityQuery(activity, measure.unit));
    if (resolution.kind !== 'RESOLVED') {
      const gap: CarbonGap = {
        reason: resolution.kind === 'AMBIGUOUS' ? 'AMBIGUOUS_FACTOR' : 'NO_FACTOR',
        sourceType: 'ACTIVITY',
        sourceId: activity.id,
        quantity: measure.quantity,
        unit: measure.unit,
        subject: [activity.vehicle_category, activity.fuel_type]
          .filter((v) => v !== null && v !== '')
          .join(' ') || activity.kind.toLowerCase().replace(/_/g, ' '),
      };
      gaps.push(gap);
      outcomes.push({ kind: 'GAP', gap });
      continue;
    }

    const engineActivity: ActivityInput = {
      id: activity.id,
      kind: activity.kind,
      activityDate: activity.activity_date,
      quantity: measure.quantity,
      unit: measure.unit as ActivityInput['unit'],
      vehicleCategory: activity.vehicle_category,
      fuelType: activity.fuel_type,
      source: activity.source,
      providerCompanyId: activity.provider_company_id,
    };
    const outcome = calculateActivityEmissions(engineActivity, resolution.factor, set);
    outcomes.push(outcome);
    if (outcome.kind === 'GAP') {
      gaps.push(outcome.gap);
      continue;
    }
    /* c8 ignore next */
    if (outcome.kind !== 'QUANTIFIED') continue;

    /*
     * ELECTRICITY IS LABELLED, WHICH IS THE OPEN DECISION BUILT AS RECOMMENDED
     * (`sustainability.md` §13.1). The GHG Protocol requires dual reporting where a
     * company holds contractual instruments; CrewQuo holds none and can verify none,
     * so it computes the location-based figure and SAYS SO on the row, rather than
     * leaving a reader to assume the favourable one. The label rides in `inputs`,
     * which is what the report and the export both read.
     */
    const result: CarbonResult =
      activity.kind === 'ELECTRICITY'
        ? {
            ...outcome.result,
            inputs: { ...outcome.result.inputs, scope2Basis: 'LOCATION_BASED' },
          }
        : outcome.result;
    rows.push({ result, claim: null });

    if (activity.asset_movement_id !== null) {
      enablingByMovement.set(
        activity.asset_movement_id,
        (enablingByMovement.get(activity.asset_movement_id) ?? 0) + result.kgCo2e
      );
    }

    /*
     * WELL-TO-TANK AS A SECOND ROW, NOT ADDED IN (§27.3). WTT is a Scope 3
     * component of an activity that may be Scope 1, so folding it into `kg_co2e`
     * would put two scopes in one figure. The engine computes it and refuses to add
     * it; this is where it lands.
     */
    if (result.wttKgCo2e !== null && result.wttKgCo2e !== 0) {
      rows.push({
        result: {
          ...result,
          scope: 'SCOPE_3',
          scope3Category: null,
          kgCo2e: result.wttKgCo2e,
          wttKgCo2e: null,
          inputs: { ...result.inputs, component: 'WTT' },
        },
        claim: null,
      });
      if (activity.asset_movement_id !== null) {
        enablingByMovement.set(
          activity.asset_movement_id,
          (enablingByMovement.get(activity.asset_movement_id) ?? 0) + result.wttKgCo2e
        );
      }
    }
  }

  // ── Waste treatment and avoided (§27.3, §27.4) ─────────────────────────────
  for (const movement of input.movements) {
    const massKg =
      num(movement.weight_kg) ??
      (num(movement.unit_weight_kg) === null
        ? null
        : Number(movement.quantity) * (num(movement.unit_weight_kg) as number));

    const engineMovement: MovementInput = {
      id: movement.id,
      massKg,
      quantity: Number(movement.quantity),
      destination: {
        code: movement.destination_code,
        name: movement.destination_name,
        isFinalOutcome: movement.is_final_outcome,
        displacesReplacement: movement.displaces_replacement,
        ghgTreatmentKey: movement.ghg_treatment_key,
      },
      weightConfidence: movement.weight_confidence,
      materialName: movement.asset_type_name,
    };

    // ── Treatment ───────────────────────────────────────────────────────────
    if (movement.ghg_treatment_key === null) {
      /*
       * FINDING 8'S FIRST SILENCE. A retained or relocated line was never a waste
       * treatment, so there is nothing to compute and NOTHING TO DISCLOSE. Read
       * naively every retained chair becomes a warning about material that was
       * handled perfectly.
       */
      outcomes.push({
        kind: 'OUT_OF_SCOPE',
        reason: 'NOT_A_WASTE_TREATMENT',
        subject: movement.destination_name,
      });
    } else {
      const set = chooseSet(input.sets, input.settings, movement.moved_on);
      const resolved =
        set === null
          ? { factor: null, matchedOn: null, ambiguous: false }
          : resolveTreatment(factorsFor(set), movement.ghg_treatment_key, movement.asset_type_name);

      if (resolved.ambiguous) {
        const gap: CarbonGap = {
          reason: 'AMBIGUOUS_FACTOR',
          sourceType: 'ASSET_MOVEMENT',
          sourceId: movement.id,
          quantity: massKg,
          unit: 'kg',
          subject: movement.asset_type_name,
        };
        gaps.push(gap);
        outcomes.push({ kind: 'GAP', gap });
      } else {
        const outcome = calculateWasteTreatmentEmissions(engineMovement, resolved.factor, set);
        outcomes.push(outcome);
        if (outcome.kind === 'GAP') {
          gaps.push(outcome.gap);
        } else if (outcome.kind === 'QUANTIFIED') {
          rows.push({
            result: {
              ...outcome.result,
              inputs: {
                ...outcome.result.inputs,
                // Which of the two asks matched, so the report can say whether the
                // material-specific factor or the treatment-wide one was used.
                factorMatchedOn: resolved.matchedOn,
                destinationCode: movement.destination_code,
              },
            },
            claim: null,
          });
        }
      }
    }

    // ── Avoided (§27.4) ─────────────────────────────────────────────────────
    if (!movement.displaces_replacement) {
      /*
       * FINDING 7, as an outcome rather than a gap. `RETAINED` counts as
       * retained-in-use and displaces nothing, while `RELOCATED` does both — so a
       * project where the client kept everything reports high retained-in-use
       * beside zero avoided emissions in the same section. That is CORRECT and it
       * reads as a bug; the sentence the section owes is generated by
       * `describeUnclaimedRetainedMass`, not by a gap here.
       */
      outcomes.push({
        kind: 'OUT_OF_SCOPE',
        reason: 'NO_REPLACEMENT_DISPLACED',
        subject: movement.destination_name,
      });
      continue;
    }

    /*
     * **Displacement is checked BEFORE the product factor, and the order is the
     * finding rather than a detail.**
     *
     * Both are reasons a claim cannot be made, and `calculateAvoidedEmissions`
     * checks displacement first for its own part. But resolving the factor first
     * *here* would report `NO_PRODUCT_FACTOR` to a company whose displacement basis
     * is `UNKNOWN` — and adding the factor it names would produce no claim either,
     * because the assumption is still missing. That is an Action Centre item that
     * sends somebody to do work which changes nothing.
     *
     * An unstated displacement assumption blocks every claim on the project
     * regardless of the library, so it is the one to report. §12's step 6 expects
     * exactly this: settings untouched, and the item says `DISPLACEMENT_UNKNOWN`.
     */
    if (
      resolveDisplacementPct(
        input.settings.default_displacement_basis,
        input.settings.default_displacement_pct === null
          ? null
          : Number(input.settings.default_displacement_pct)
      ) === null
    ) {
      const gap: CarbonGap = {
        reason: 'DISPLACEMENT_UNKNOWN',
        sourceType: 'ASSET_MOVEMENT',
        sourceId: movement.id,
        quantity: Number(movement.quantity),
        unit: 'items',
        subject: movement.asset_type_name,
      };
      gaps.push(gap);
      outcomes.push({ kind: 'GAP', gap });
      blocked.push({
        reason: 'DISPLACEMENT_UNKNOWN',
        subject: movement.asset_type_name,
        quantity: Number(movement.quantity),
      });
      continue;
    }

    const productResolution = resolveProductFactor(input.productFactors, {
      assetTypeId: movement.asset_type_id,
      itemCategory: movement.asset_type_category,
      manufacturer: movement.manufacturer,
      productModel: movement.model,
      allowGeneric: input.settings.allow_generic_product_factors,
    });

    if (productResolution.kind !== 'RESOLVED') {
      const reason: ClaimBlockedReason =
        productResolution.kind === 'GENERIC_REFUSED' ? 'GENERIC_NOT_ALLOWED' : 'NO_PRODUCT_FACTOR';
      const gap: CarbonGap = {
        reason: reason === 'GENERIC_NOT_ALLOWED' ? 'GENERIC_NOT_ALLOWED' : 'NO_PRODUCT_FACTOR',
        sourceType: 'ASSET_MOVEMENT',
        sourceId: movement.id,
        quantity: Number(movement.quantity),
        unit: 'items',
        subject: movement.asset_type_name,
      };
      gaps.push(gap);
      outcomes.push({ kind: 'GAP', gap });
      blocked.push({ reason, subject: movement.asset_type_name, quantity: Number(movement.quantity) });
      continue;
    }

    const factor = productResolution.factor;
    const outcome = calculateAvoidedEmissions({
      movement: engineMovement,
      factor,
      basis: input.settings.default_displacement_basis,
      displacementPct:
        input.settings.default_displacement_pct === null
          ? null
          : Number(input.settings.default_displacement_pct),
      enablingKgCo2e: enablingByMovement.get(movement.id) ?? 0,
      baselineScenario: `An equivalent new ${movement.asset_type_name.toLowerCase()} manufactured`,
      alternativeScenario: `The existing ${movement.asset_type_name.toLowerCase()} ${movement.destination_name.toLowerCase()}`,
      assumptions: describeAssumptions({
        basis: input.settings.default_displacement_basis,
        pct:
          input.settings.default_displacement_pct === null
            ? null
            : Number(input.settings.default_displacement_pct),
        factor,
      }),
      // Frozen onto the claim rather than resolved at render time, so a settings
      // row that says something else next year cannot restate what was claimed.
      methodology: AVOIDED_METHODOLOGY_WARNING,
      uncertainty: factor.isEstimate
        ? 'The embodied-carbon factor behind this figure is an estimate rather than a verified product declaration.'
        : null,
    });

    outcomes.push(outcome);
    if (outcome.kind === 'GAP') {
      gaps.push(outcome.gap);
      if (outcome.gap.reason === 'DISPLACEMENT_UNKNOWN') {
        blocked.push({
          reason: 'DISPLACEMENT_UNKNOWN',
          subject: movement.asset_type_name,
          quantity: Number(movement.quantity),
        });
      }
    } else if (outcome.kind === 'QUANTIFIED') {
      rows.push({ result: outcome.result, claim: outcome.claim });
    }
  }

  return { rows, outcomes, gaps, blocked };
}

/** The sentence §27.4 requires a claim to record about what was assumed. */
function describeAssumptions(args: {
  basis: SettingsRow['default_displacement_basis'];
  pct: number | null;
  factor: ProductCarbonFactorInput;
}): string {
  const displacement =
    args.basis === 'ASSUMED_FULL'
      ? 'Full displacement is assumed: each reused item is taken to have replaced one purchase.'
      : `A displacement rate of ${args.pct ?? 0}% is assumed, stated by this organisation.`;
  const source = `Embodied carbon is taken from ${args.factor.source} (${args.factor.verificationStatus.toLowerCase().replace(/_/g, ' ')}, ${args.factor.lifecycleBoundary.replace(/_/g, '–')}).`;
  return `${displacement} ${source}`;
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * A stable fingerprint of what the engine produced.
 *
 * **This is what makes recalculation idempotent, and idempotence is what makes the
 * `calculations_superseded` event honest.** Without it, every movement write on an
 * unchanged project would supersede sixty rows, write sixty identical ones and
 * raise an event saying nothing changed by a delta of zero — which is the audit
 * trail that teaches people the trail is noise.
 */
function fingerprint(rows: readonly PreparedRow[]): string {
  return rows
    .map((r) =>
      [
        r.result.bucket,
        r.result.sourceType,
        r.result.sourceId,
        r.result.scope,
        r.result.method,
        r.result.quantity,
        r.result.unit,
        r.result.kgCo2e,
        r.result.citation.factorId,
        r.result.citation.productFactorId,
        r.claim?.displacementPct ?? '',
        r.claim?.enablingKgCo2e ?? '',
        r.result.inputs.component ?? '',
      ].join('|')
    )
    .sort()
    .join('\n');
}

interface CurrentRow {
  id: string;
  bucket: CarbonBucket;
  source_type: string;
  source_id: string | null;
  scope: string | null;
  method: string;
  quantity: string;
  unit: string;
  kg_co2e: string;
  factor_id: string | null;
  product_factor_id: string | null;
  inputs: Record<string, unknown>;
  displacement_pct: string | null;
  enabling_kg_co2e: string | null;
}

function currentFingerprint(rows: readonly CurrentRow[]): string {
  return rows
    .map((r) =>
      [
        r.bucket,
        r.source_type,
        r.source_id,
        r.scope,
        r.method,
        Number(r.quantity),
        r.unit,
        Number(r.kg_co2e),
        r.factor_id,
        r.product_factor_id,
        r.displacement_pct === null ? '' : Number(r.displacement_pct),
        r.enabling_kg_co2e === null ? '' : Number(r.enabling_kg_co2e),
        r.inputs.component ?? '',
      ].join('|')
    )
    .sort()
    .join('\n');
}

/**
 * Recalculate one project, in one transaction, under the project lock.
 *
 * Returns what changed rather than what is, because the caller's job is to raise an
 * event describing the change and §5 is emphatic about what that event must carry:
 * *"one saying 'project emissions +0.12 tCO₂e, avoided −4.30 tCO₂e, trigger
 * WEIGHT_CORRECTED' is the sentence somebody needs a year later when a client asks
 * why the number moved, and it is the only place that answer is recorded."*
 */
export async function recalculateProject(args: {
  projectId: string;
  trigger: SupersessionTrigger;
  /** The row whose write caused this, for the event's idempotency key. */
  triggeringId?: string | null;
  actorUserId?: string | null;
}): Promise<RecalculationResult> {
  const empty: RecalculationResult = {
    projectId: args.projectId,
    skipped: null,
    supersededCount: 0,
    newCount: 0,
    deltaByBucket: {},
    gaps: [],
  };

  const owner = await queryOne<{ owner_company_id: string }>(
    `select owner_company_id from projects where id = $1`,
    [args.projectId]
  );
  if (!owner) throw new AppError('NOT_FOUND', 'Project not found');

  /*
   * `carbon_engine` on the PROJECT OWNER, checked **before the lock** and through
   * `hasFeature` rather than by a query written here.
   *
   * Before the lock, because an entitlement lookup inside a held row lock widens
   * the window every other writer waits in for no benefit — the rule
   * `movementsRoutes.ts` states about its own four checks.
   *
   * Through `hasFeature`, because plan features, subscription statuses and
   * per-company overrides are three sources `resolveEntitlements` already combines,
   * and a second copy of that combination here would be a second answer to "does
   * this company have the carbon engine" — wrong in whichever direction the two
   * drifted.
   *
   * **A company without it is skipped silently rather than refused.** This function
   * is called from writes that have already succeeded — recording a movement,
   * correcting a weight — and turning one of those into a 403 because the owner does
   * not buy the carbon engine would make asset tracking unusable on the tier that
   * has it.
   */
  if (!(await hasFeature(owner.owner_company_id, 'carbon_engine'))) {
    return { ...empty, skipped: 'NO_FEATURE' };
  }

  return withTransaction(async (client) => {
    // The lock, and on the project rather than on the calculations (packet §3).
    // The set of rows to supersede is not known until the run has finished.
    const project = await queryOne<{ id: string; owner_company_id: string }>(
      `select id, owner_company_id from projects where id = $1 for update`,
      [args.projectId],
      client
    );
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');

    const settings = await ensureSettings(project.owner_company_id, client);
    const [sets, productFactors, activities, movements] = await Promise.all([
      loadFactorSetsForSelection(project.owner_company_id, client),
      loadProductFactors(project.owner_company_id, client),
      loadActivities(args.projectId, client),
      loadMovements(args.projectId, client),
    ]);

    const factorsBySet = new Map<string, EmissionFactorInput[]>();
    for (const set of sets) {
      factorsBySet.set(set.id, await loadFactors(set.id, client));
    }

    const output = run({
      settings,
      sets,
      factorsBySet,
      productFactors,
      activities,
      movements,
    });

    const current = await query<CurrentRow>(
      `select c.id, c.bucket, c.source_type, c.source_id, c.scope, c.method,
              c.quantity::text as quantity, c.unit, c.kg_co2e::text as kg_co2e,
              c.factor_id, c.product_factor_id, c.inputs,
              a.displacement_pct::text as displacement_pct,
              a.enabling_kg_co2e::text as enabling_kg_co2e
         from carbon_calculations c
         left join avoided_emissions_claims a on a.calculation_id = c.id
        where c.project_id = $1 and c.superseded_by is null`,
      [args.projectId],
      client
    );

    if (fingerprint(output.rows) === currentFingerprint(current)) {
      // Nothing moved. No supersession, no event, no audit row — the alternative is
      // a trail full of "17 superseded, delta zero" that nobody can read past.
      return { ...empty, skipped: 'UNCHANGED', gaps: output.gaps };
    }

    const before = bucketTotals(
      current.map((r) => ({ bucket: r.bucket, kgCo2e: Number(r.kg_co2e) }))
    );

    // ── Write the new rows, then stamp the old ones ─────────────────────────
    const newIds: string[] = [];
    for (const row of output.rows) {
      const inserted = await queryOne<{ id: string }>(
        `insert into carbon_calculations
           (project_id, company_id, bucket, scope, scope3_category, source_type, source_id,
            factor_set_id, factor_id, product_factor_id,
            factor_set_name, factor_set_version, factor_reporting_year,
            factor_kg_co2e_per_unit, methodology,
            quantity, unit, kg_co2e, method, inputs, is_estimate, confidence,
            calculated_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23)
         returning id`,
        [
          args.projectId,
          project.owner_company_id,
          row.result.bucket,
          row.result.scope,
          row.result.scope3Category,
          row.result.sourceType,
          row.result.sourceId,
          row.result.citation.factorSetId,
          row.result.citation.factorId,
          row.result.citation.productFactorId,
          row.result.citation.factorSetName,
          row.result.citation.factorSetVersion,
          row.result.citation.factorReportingYear,
          row.result.citation.factorKgCo2ePerUnit,
          row.result.citation.methodology,
          row.result.quantity,
          row.result.unit,
          row.result.kgCo2e,
          row.result.method,
          JSON.stringify(row.result.inputs),
          row.result.isEstimate,
          row.result.confidence,
          args.actorUserId ?? null,
        ],
        client
      );
      /* c8 ignore next */
      if (!inserted) throw new AppError('INTERNAL', 'Calculation could not be written');
      newIds.push(inserted.id);

      if (row.claim !== null) {
        await query(
          `insert into avoided_emissions_claims
             (calculation_id, asset_movement_id, baseline_scenario, alternative_scenario,
              displacement_pct, displacement_basis, baseline_kg_co2e, enabling_kg_co2e,
              net_avoided_kg_co2e, system_boundary, assumptions, uncertainty, methodology)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            inserted.id,
            row.claim.assetMovementId,
            row.claim.baselineScenario,
            row.claim.alternativeScenario,
            row.claim.displacementPct,
            row.claim.displacementBasis,
            row.claim.baselineKgCo2e,
            row.claim.enablingKgCo2e,
            row.claim.netAvoidedKgCo2e,
            row.claim.systemBoundary,
            row.claim.assumptions,
            row.claim.uncertainty,
            row.claim.methodology,
          ],
          client
        );
      }
    }

    /*
     * Every previously-current row is superseded, and `superseded_by` points at the
     * FIRST new row rather than at a per-row successor. That is honest about what
     * happened: a recalculation replaces a set of rows with a set of rows, and
     * pairing them up would invent a correspondence — a movement whose factor
     * disappeared has no successor at all, and one whose weight changed may now
     * produce two rows where it produced one.
     */
    if (current.length > 0) {
      await query(
        `update carbon_calculations set superseded_by = $2
          where id = any($1::uuid[]) and superseded_by is null`,
        [current.map((r) => r.id), newIds[0] ?? null],
        client
      );
    }

    const after = bucketTotals(
      output.rows.map((r) => ({ bucket: r.result.bucket, kgCo2e: r.result.kgCo2e }))
    );
    const deltaByBucket: Record<string, number> = {};
    for (const bucket of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const delta = (after[bucket] ?? 0) - (before[bucket] ?? 0);
      if (delta !== 0) deltaByBucket[bucket] = delta;
    }

    await recordAudit(
      {
        companyId: project.owner_company_id,
        actorUserId: args.actorUserId ?? null,
        action: 'carbon.recalculated',
        entityType: 'PROJECT',
        entityId: args.projectId,
        description: `${args.trigger.toLowerCase().replace(/_/g, ' ')} — ${current.length} superseded, ${output.rows.length} current`,
        changes: { trigger: args.trigger, deltaByBucket },
      },
      client
    );

    /*
     * ONE EVENT PER PROJECT PER TRIGGER, never one per calculation (packet §5). A
     * re-imported factor set can supersede thousands of rows across dozens of
     * projects, and one event per project is the granularity anybody can act on.
     *
     * It notifies NOBODY — this is audit-only, and that is the deliberate half of
     * §6: supersession is the most frequent event in the domain and the least
     * actionable, because it fires when somebody corrected a weight on purpose.
     */
    if (current.length > 0) {
      await enqueueOutboxEvent(
        {
          topic: 'sustainability.calculations_superseded',
          aggregateType: 'PROJECT',
          aggregateId: args.projectId,
          companyId: project.owner_company_id,
          payload: calculationsSupersededEventPayload({
            projectId: args.projectId,
            companyId: project.owner_company_id,
            trigger: args.trigger,
            triggeringId: args.triggeringId ?? null,
            supersededCount: current.length,
            newCount: output.rows.length,
            deltaByBucket,
            actorUserId: args.actorUserId ?? null,
          }),
          idempotencyKey: `sustainability.calculations_superseded:${args.projectId}:${args.trigger}:${
            args.triggeringId ?? newIds[0] ?? Date.now()
          }`,
        },
        client
      );
    }

    await raiseClaimBlocked(client, {
      projectId: args.projectId,
      companyId: project.owner_company_id,
      blocked: output.blocked,
    });

    return {
      projectId: args.projectId,
      skipped: null,
      supersededCount: current.length,
      newCount: output.rows.length,
      deltaByBucket,
      gaps: output.gaps,
    };
  });
}

function bucketTotals(
  rows: readonly { bucket: CarbonBucket; kgCo2e: number }[]
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) totals[row.bucket] = (totals[row.bucket] ?? 0) + row.kgCo2e;
  return totals;
}

/**
 * The claim that could not be made (packet §5).
 *
 * **Aggregated per project per reason per day, never per movement.** A single
 * clearance of 400 chairs with no factor would otherwise generate 400 identical
 * items; the digest names the asset type and the total quantity, which is what the
 * fix needs — one factor resolves all of them. The idempotency key is what enforces
 * it: `delivery_outbox` refuses the duplicate on its own unique index, so nothing
 * here has to remember what has already been raised and there is no weaker second
 * copy of that fact to go wrong.
 */
async function raiseClaimBlocked(
  client: PoolClient,
  args: {
    projectId: string;
    companyId: string;
    blocked: readonly { reason: ClaimBlockedReason; subject: string; quantity: number }[];
  }
): Promise<void> {
  if (args.blocked.length === 0) return;

  const today = await queryOne<{ today: string }>(
    `select to_char((now() at time zone coalesce(c.time_zone, 'UTC'))::date, 'YYYY-MM-DD') as today
       from companies c where c.id = $1`,
    [args.companyId],
    client
  );
  const onDate = today?.today ?? new Date().toISOString().slice(0, 10);

  const byReason = new Map<ClaimBlockedReason, Map<string, number>>();
  for (const item of args.blocked) {
    const subjects = byReason.get(item.reason) ?? new Map<string, number>();
    subjects.set(item.subject, (subjects.get(item.subject) ?? 0) + item.quantity);
    byReason.set(item.reason, subjects);
  }

  for (const [reason, subjects] of byReason) {
    await enqueueOutboxEvent(
      {
        topic: 'sustainability.claim_blocked',
        aggregateType: 'PROJECT',
        aggregateId: args.projectId,
        companyId: args.companyId,
        payload: claimBlockedEventPayload({
          projectId: args.projectId,
          companyId: args.companyId,
          reason,
          subjects: [...subjects].map(([subject, quantity]) => ({ subject, quantity })),
          movementCount: args.blocked.filter((b) => b.reason === reason).length,
          onDate,
        }),
        idempotencyKey: `sustainability.claim_blocked:${args.projectId}:${reason}:${onDate}`,
      },
      client
    );
  }
}

/**
 * Recalculate after a write that changed an input, **without failing that write**.
 *
 * The call sites are Phase 8's asset and movement routes plus this phase's
 * activities, and every one of them has already committed something the user asked
 * for. A recalculation that throws — an ambiguous factor set, a lock timeout —
 * must not turn a successful "12 chairs recycled" into a 409, so the failure is
 * logged and the figures stay stale until the next trigger or an explicit
 * recalculate. The staleness is visible on the section, which is the honest place
 * for it.
 *
 * **The write and the recalculation are two transactions, not one**, and that is a
 * departure from packet §3's *"synchronous with the write, inside the same
 * transaction"* worth stating. The packet's reason for one transaction is that a
 * project whose carbon is briefly stale shows two headline figures disagreeing with
 * the mass balance beside them. That is still true, and the window here is
 * milliseconds. What one transaction would also do is take the project lock inside
 * the asset lock on every movement write, and make a factor-set misconfiguration
 * refuse the movement itself — trading a millisecond of staleness for an inability
 * to record what happened on site. The section reports `stale` so the disagreement
 * is stated rather than hidden.
 */
export async function recalculateAfterWrite(args: {
  projectId: string;
  trigger: SupersessionTrigger;
  triggeringId?: string | null;
  actorUserId?: string | null;
}): Promise<void> {
  try {
    await recalculateProject(args);
  } catch (err) {
    console.error(
      `[carbon] recalculation after ${args.trigger} failed for project ${args.projectId}:`,
      err
    );
  }
}
