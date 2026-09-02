import { z } from 'zod';
import type { WeightConfidence } from '../assets';

/**
 * Carbon engine data shapes (CREWQUO_V2_PLAN.md §26–§28). Plain data: the API
 * loads rows from Postgres and passes them in, exactly as `rate-engine/` does.
 *
 * **Nothing here is money and nothing here is rounded.** §41.9 — *"full precision
 * internally, sensible rounding for display; never round mid-calculation"* — so
 * every quantity is a plain `number` at full float precision and the only
 * rounding in this package lives in the two `format*` functions.
 */

// ── Buckets, and the firewall (locked decision #17) ──────────────────────────

export const CARBON_BUCKETS = [
  'PROJECT_EMISSIONS',
  'WASTE_TREATMENT',
  'COMPARATIVE_LIFECYCLE',
  'AVOIDED',
] as const;
export const carbonBucketSchema = z.enum(CARBON_BUCKETS);
export type CarbonBucket = z.infer<typeof carbonBucketSchema>;

/**
 * The two buckets §28.2 adds together into *"Project GHG emissions"*.
 *
 * `COMPARATIVE_LIFECYCLE` is outside the inventory (§26.4) and `AVOIDED` is
 * outside everything (§27.4), so this list is deliberately not derived from
 * `CARBON_BUCKETS` minus something — it is the definition, written out, and a new
 * bucket does not join it by default.
 */
export const INVENTORY_BUCKETS = ['PROJECT_EMISSIONS', 'WASTE_TREATMENT'] as const;
export type InventoryBucket = (typeof INVENTORY_BUCKETS)[number];

/**
 * **The firewall, as a type.**
 *
 * Locked decision #17: *"there is no query, no type and no UI component in the
 * system that adds `AVOIDED` to anything else."* §27.2 calls `bucket` the
 * firewall and states the rule; this makes the rule structural, so a sum crossing
 * buckets **does not compile** rather than failing a review.
 *
 * The mechanism: `B` appears in both parameter and return position, which makes
 * it **invariant** under `strictFunctionTypes`. Two totals with different buckets
 * therefore have no common supertype to unify on, so `addTotals(emissions,
 * avoided)` is a type error at the call site. `carbon-engine/firewall.test.ts`
 * pins this with `@ts-expect-error`, which fails the build if it ever starts
 * compiling.
 *
 * It is never assigned a value — it exists only to be measured by the checker.
 *
 * **It brands the total, not the row.** A project legitimately holds a list of
 * results from every bucket at once — that is what a project *is* — so branding
 * `CarbonResult` would make the ordinary case unrepresentable while preventing
 * nothing: summing a mixed list is not the mistake. The mistake is adding the
 * emissions total to the avoided total, and that happens on `BucketedTotal`,
 * which is where the brand lives.
 */
type BucketBrand<B extends CarbonBucket> = (bucket: B) => B;

export const GHG_SCOPES = ['SCOPE_1', 'SCOPE_2', 'SCOPE_3', 'OUT_OF_SCOPE'] as const;
export const ghgScopeSchema = z.enum(GHG_SCOPES);
export type GhgScope = z.infer<typeof ghgScopeSchema>;

/** §27.3: waste generated in operations. The only Scope 3 category this phase sets. */
export const SCOPE3_WASTE_CATEGORY = 5;

export const CALCULATION_METHODS = [
  'ACTIVITY_X_FACTOR',
  'MASS_X_TREATMENT_FACTOR',
  'DISPLACEMENT',
  'MANUAL',
] as const;
export const calculationMethodSchema = z.enum(CALCULATION_METHODS);
export type CalculationMethod = z.infer<typeof calculationMethodSchema>;

export const CALCULATION_SOURCE_TYPES = ['ACTIVITY', 'ASSET_MOVEMENT', 'MANUAL'] as const;
export type CalculationSourceType = (typeof CALCULATION_SOURCE_TYPES)[number];

// ── Units (§26.1) ────────────────────────────────────────────────────────────

/**
 * §26.1's six, and no more. A unit outside this list is an import failure
 * (`packet §9`), not something the engine quietly accepts and then multiplies.
 *
 * Product carbon factors are deliberately absent: they are per *item* or per
 * *kg* and live in their own two columns (§26.3), so they never travel through
 * `convertQuantity`.
 */
export const FACTOR_UNITS = ['km', 'mile', 'litre', 'kWh', 'tonne', 'tonne.km'] as const;
export const factorUnitSchema = z.enum(FACTOR_UNITS);
export type FactorUnit = z.infer<typeof factorUnitSchema>;

/** What a unit measures. Conversion is only ever possible within one dimension. */
export type UnitDimension = 'DISTANCE' | 'VOLUME' | 'ENERGY' | 'MASS' | 'MASS_DISTANCE';

// ── Factor sets and factors (§26.1) ──────────────────────────────────────────

/** A `emission_factor_sets` row as the engine consumes it. */
export interface EmissionFactorSetInput {
  id: string;
  /** null = the platform library. A company set shadows one (packet §0 finding 2). */
  companyId: string | null;
  name: string;
  version: string;
  reportingYear: number;
  /** ISO `YYYY-MM-DD`. */
  validFrom: string;
  /** ISO `YYYY-MM-DD`, or null for open-ended. */
  validTo: string | null;
  region: string;
  active: boolean;
  methodology: string | null;
}

/** An `emission_factors` row as the engine consumes it. */
export interface EmissionFactorInput {
  id: string;
  factorSetId: string;
  category: string;
  activity: string;
  material: string | null;
  treatment: string | null;
  vehicleType: string | null;
  fuelType: string | null;
  unit: FactorUnit;
  kgCo2ePerUnit: number;
  /** Well-to-tank, where the publisher separates it (§26.1). */
  wttKgCo2ePerUnit: number | null;
  scope: GhgScope | null;
  scope3Category: number | null;
  sourceReference: string | null;
}

/** What a caller is looking for. Every provided field must match (case-insensitively). */
export interface FactorQuery {
  category?: string;
  activity?: string;
  material?: string;
  treatment?: string;
  vehicleType?: string;
  fuelType?: string;
  unit?: FactorUnit;
}

export interface FactorSetQuery {
  /** The date the work happened, tested against the validity window. */
  date: string;
  region: string;
  /** From the project or §39. When given, only sets for that year are eligible. */
  reportingYear?: number | null;
}

/**
 * **Three outcomes, not two.** §27.1 types this `EmissionFactorSet | null`; the
 * packet's §9 requires that two sets matching one window are *refused* rather
 * than guessed between, and `null` cannot say which of those happened. A caller
 * that has to name both candidates in an error needs them returned.
 */
export type FactorSetSelection =
  | { kind: 'SELECTED'; set: EmissionFactorSetInput }
  | { kind: 'NONE' }
  | { kind: 'AMBIGUOUS'; candidates: readonly EmissionFactorSetInput[] };

/** Same three outcomes, same reason (packet §9). */
export type FactorResolution =
  | { kind: 'RESOLVED'; factor: EmissionFactorInput }
  | { kind: 'NONE' }
  | { kind: 'AMBIGUOUS'; candidates: readonly EmissionFactorInput[] };

// ── Product carbon factors (§26.3) ───────────────────────────────────────────

export const VERIFICATION_STATUSES = [
  'EPD_VERIFIED',
  'MANUFACTURER',
  'SECTOR_DATASET',
  'ORG_SPECIFIC',
  'GENERIC_ESTIMATE',
] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const LIFECYCLE_BOUNDARIES = [
  'A1_A3',
  'A1_A5',
  'CRADLE_TO_GATE',
  'CRADLE_TO_GRAVE',
  'OTHER',
] as const;
export const lifecycleBoundarySchema = z.enum(LIFECYCLE_BOUNDARIES);
export type LifecycleBoundary = z.infer<typeof lifecycleBoundarySchema>;

/**
 * §26.3's preferred-source order as data. Tier 1 is best; `GENERIC_ESTIMATE`
 * sits alone in tier 4 because it is the only one gated on a setting.
 */
export const PRODUCT_FACTOR_TIER: Readonly<Record<VerificationStatus, number>> = {
  EPD_VERIFIED: 1,
  MANUFACTURER: 1,
  SECTOR_DATASET: 2,
  ORG_SPECIFIC: 3,
  GENERIC_ESTIMATE: 4,
};

/** A `product_carbon_factors` row. Exactly one of the two rates is non-null (§26.3). */
export interface ProductCarbonFactorInput {
  id: string;
  companyId: string | null;
  itemCategory: string;
  assetTypeId: string | null;
  manufacturer: string | null;
  productModel: string | null;
  kgCo2ePerItem: number | null;
  kgCo2ePerKg: number | null;
  lifecycleBoundary: LifecycleBoundary;
  source: string;
  verificationStatus: VerificationStatus;
  isEstimate: boolean;
  active: boolean;
}

export interface ProductFactorQuery {
  assetTypeId?: string | null;
  itemCategory?: string | null;
  manufacturer?: string | null;
  productModel?: string | null;
  /** §39's `allow_generic_product_factors`. */
  allowGeneric: boolean;
}

/**
 * **Four outcomes.** `GENERIC_REFUSED` is the one that earns its place: it is not
 * the same as having no factor, and the packet's §5 gives the two states
 * different `claim_blocked` reasons because they have different fixes — find a
 * better factor, versus turn generics on knowing what that means.
 */
export type ProductFactorResolution =
  | { kind: 'RESOLVED'; factor: ProductCarbonFactorInput; tier: number }
  | { kind: 'NONE' }
  | { kind: 'GENERIC_REFUSED'; factor: ProductCarbonFactorInput }
  | { kind: 'AMBIGUOUS'; candidates: readonly ProductCarbonFactorInput[] };

// ── Results (§27.2) ──────────────────────────────────────────────────────────

/**
 * The denormalised citation §27.2 stores on every calculation *"so it survives a
 * factor-set edit or delete"*, and the four things §41.2 requires a result to be
 * able to name.
 */
export interface FactorCitation {
  factorSetId: string | null;
  factorId: string | null;
  productFactorId: string | null;
  factorSetName: string;
  factorSetVersion: string;
  factorReportingYear: number | null;
  factorKgCo2ePerUnit: number | null;
  methodology: string | null;
}

/**
 * One calculated figure, carrying everything needed to persist a
 * `carbon_calculations` row and to reconstruct the arithmetic.
 *
 * §27.1: *"every function returns the inputs it used alongside the result, so the
 * caller can persist a complete trace. Nothing returns a bare number."*
 */
export interface CarbonResult<B extends CarbonBucket = CarbonBucket> {
  readonly bucket: B;
  readonly scope: GhgScope | null;
  readonly scope3Category: number | null;
  readonly sourceType: CalculationSourceType;
  readonly sourceId: string | null;
  readonly method: CalculationMethod;
  /** The quantity actually multiplied, **in `unit`** — i.e. after conversion. */
  readonly quantity: number;
  readonly unit: string;
  readonly kgCo2e: number;
  /**
   * Well-to-tank, where the publisher separates it (§27.3). **Deliberately not
   * added into `kgCo2e`**: WTT is a Scope 3 component of an activity that may be
   * Scope 1, and adding it would put two scopes in one figure. A caller that
   * wants it persists a second row.
   */
  readonly wttKgCo2e: number | null;
  readonly isEstimate: boolean;
  readonly confidence: WeightConfidence | null;
  readonly citation: FactorCitation;
  /** The exact numbers that produced the result (§27.2's `inputs jsonb`). */
  readonly inputs: Readonly<Record<string, number | string | boolean | null>>;
}

/**
 * Why a figure could not be produced **and must be disclosed** (§41.1, §28.3).
 * Every one of these becomes a sentence in the report and, for the two claim
 * reasons, an Action Centre item (packet §5).
 */
export const CARBON_GAP_REASONS = [
  'NO_FACTOR',
  'NO_PRODUCT_FACTOR',
  'GENERIC_NOT_ALLOWED',
  'DISPLACEMENT_UNKNOWN',
  'UNIT_MISMATCH',
  'AMBIGUOUS_FACTOR',
  'NO_MASS',
  'NO_FACTOR_SET',
] as const;
export type CarbonGapReason = (typeof CARBON_GAP_REASONS)[number];

export interface CarbonGap {
  readonly reason: CarbonGapReason;
  readonly sourceType: CalculationSourceType;
  readonly sourceId: string | null;
  /** What could not be quantified — the mass or distance the sentence quotes. */
  readonly quantity: number | null;
  readonly unit: string | null;
  /** The material, activity or asset type the sentence names. */
  readonly subject: string;
}

/**
 * Why a figure was **not produced and must not be disclosed** — packet §0
 * finding 8's first silence.
 *
 * A retained chair has no `ghg_treatment_key` because nothing was treated as
 * waste, which is not a hole in the data and must not appear as one. Read
 * naively the report fills with warnings about material that was handled
 * perfectly.
 */
export const OUT_OF_SCOPE_REASONS = [
  'NOT_A_WASTE_TREATMENT',
  'NO_REPLACEMENT_DISPLACED',
] as const;
export type OutOfScopeReason = (typeof OUT_OF_SCOPE_REASONS)[number];

/**
 * **Three states, and the caller cannot collapse them.**
 *
 * §41.1 makes an absent factor a legitimate state of the world rather than an
 * error, and finding 8 makes "nothing to compute" different again from "could
 * not compute". A `CarbonResult | null` return would merge the last two, which is
 * precisely the merge that fills a report with false warnings.
 */
export type CarbonOutcome<B extends CarbonBucket = CarbonBucket> =
  | { readonly kind: 'QUANTIFIED'; readonly result: CarbonResult<B> }
  | { readonly kind: 'GAP'; readonly gap: CarbonGap }
  | {
      readonly kind: 'OUT_OF_SCOPE';
      readonly reason: OutOfScopeReason;
      readonly subject: string;
    };

// ── Activities (§27.3) ───────────────────────────────────────────────────────

export const ACTIVITY_KINDS = [
  'VEHICLE_DISTANCE',
  'FUEL',
  'ELECTRICITY',
  'FREIGHT',
  'PLANT',
  'OTHER',
] as const;
export const activityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const ACTIVITY_SOURCES = ['MEASURED', 'DOCUMENTED', 'ESTIMATED'] as const;
export const activitySourceSchema = z.enum(ACTIVITY_SOURCES);
export type ActivitySource = z.infer<typeof activitySourceSchema>;

/** A `project_activities` row, reduced to what the arithmetic needs. */
export interface ActivityInput {
  id: string;
  kind: ActivityKind;
  activityDate: string;
  /** The number the user typed, in `enteredUnit`. */
  quantity: number;
  unit: FactorUnit;
  vehicleCategory: string | null;
  fuelType: string | null;
  source: ActivitySource;
  /**
   * Set when a subcontractor's vehicle did the work. **This is what moves an
   * activity from Scope 1 to Scope 3** (§27.3), so it is not decoration.
   */
  providerCompanyId: string | null;
}

// ── Movements, for waste treatment and avoided (§27.3, §27.4) ────────────────

/** The destination semantics the two movement calculations read (§25.4). */
export interface MovementDestination {
  code: string;
  name: string;
  isFinalOutcome: boolean;
  displacesReplacement: boolean;
  /** Null means *not a waste treatment*, which is not a gap (finding 8). */
  ghgTreatmentKey: string | null;
}

export interface MovementInput {
  id: string;
  /** Null when the asset line has no weight — a gap, not a zero. */
  massKg: number | null;
  quantity: number;
  destination: MovementDestination;
  /** Carried through to the result so a figure inherits its input's confidence. */
  weightConfidence: WeightConfidence | null;
  /** For the disclosure sentence: "…for plasterboard". */
  materialName: string;
}

// ── Displacement (§27.4, §39) ────────────────────────────────────────────────

/**
 * §27.4's three, and the shape §39's settings row is being corrected to match
 * (packet §0 finding 1). `UNKNOWN` is the default and produces **no claim**.
 */
export const DISPLACEMENT_BASES = ['ASSUMED_FULL', 'USER_DEFINED', 'UNKNOWN'] as const;
export const displacementBasisSchema = z.enum(DISPLACEMENT_BASES);
export type DisplacementBasis = z.infer<typeof displacementBasisSchema>;

export interface AvoidedInput {
  movement: MovementInput;
  factor: ProductCarbonFactorInput;
  basis: DisplacementBasis;
  /** Required iff basis is `USER_DEFINED`; ignored otherwise. */
  displacementPct: number | null;
  /**
   * Emissions incurred to make the reuse happen — refurbishment, cleaning,
   * transport, storage — already calculated from activities linked to this same
   * movement (§27.4). The caller sums them; the engine deducts them.
   */
  enablingKgCo2e: number;
  baselineScenario: string;
  alternativeScenario: string;
  assumptions: string;
  methodology: string;
  uncertainty: string | null;
}

/** Everything an `avoided_emissions_claims` row needs (§27.4). */
export interface AvoidedClaim {
  readonly assetMovementId: string;
  readonly baselineScenario: string;
  readonly alternativeScenario: string;
  readonly displacementPct: number;
  readonly displacementBasis: DisplacementBasis;
  readonly baselineKgCo2e: number;
  readonly enablingKgCo2e: number;
  readonly netAvoidedKgCo2e: number;
  readonly systemBoundary: LifecycleBoundary;
  readonly assumptions: string;
  readonly uncertainty: string | null;
  readonly methodology: string;
}

export type AvoidedOutcome =
  | {
      readonly kind: 'QUANTIFIED';
      readonly result: CarbonResult<'AVOIDED'>;
      readonly claim: AvoidedClaim;
    }
  | { readonly kind: 'GAP'; readonly gap: CarbonGap }
  | {
      readonly kind: 'OUT_OF_SCOPE';
      readonly reason: OutOfScopeReason;
      readonly subject: string;
    };

// ── Roll-up (§28.2) ──────────────────────────────────────────────────────────

/**
 * A total that remembers which bucket it came from, and refuses to be added to
 * one that came from another. See `BucketBrand`.
 */
export interface BucketedTotal<B extends CarbonBucket = CarbonBucket> {
  readonly bucket: B;
  readonly kgCo2e: number;
  readonly rowCount: number;
  readonly __bucketBrand?: BucketBrand<B>;
}

/**
 * §28.4's two headlines, and **there is deliberately no third field.**
 *
 * §27.5 forbids *"a single 'net' headline that combines emissions and avoided
 * emissions"*. The way that headline gets built is somebody adding a convenience
 * field here, so the shape simply does not have one — `projectEmissions` and
 * `avoided` are separate `BucketedTotal`s with different brands, and adding them
 * is a compile error.
 */
export interface ProjectCarbonRollUp {
  /** §28.2: `PROJECT_EMISSIONS` + `WASTE_TREATMENT`, current rows only. */
  readonly projectEmissionsKgCo2e: number;
  /** §27.4: outside every inventory scope, never netted. */
  readonly avoidedKgCo2e: number;
  /** §26.4: outside the inventory, reported under its own label. */
  readonly comparativeLifecycleKgCo2e: number;
  readonly byBucket: Readonly<Record<CarbonBucket, BucketedTotal>>;
  readonly byScope: Readonly<Record<GhgScope, number>>;
  /** True when at least one input could not be quantified — every total is a floor. */
  readonly hasGaps: boolean;
  readonly gapCount: number;
}

// ── Data quality (§28.3) ─────────────────────────────────────────────────────

export const DATA_QUALITY_COMPONENTS = [
  'LINES_WITH_WEIGHT',
  'MASS_WITH_FINAL_DESTINATION',
  'MASS_DOCUMENTED_OR_VERIFIED',
  'LINES_WITH_SUPPORT',
  'AVOIDED_MASS_ON_SPECIFIC_FACTOR',
] as const;
export type DataQualityComponent = (typeof DATA_QUALITY_COMPONENTS)[number];

export type DataQualityWeights = Readonly<Record<DataQualityComponent, number>>;

/**
 * §28.3's defaults, and **this is where they live** (packet §0 finding 5).
 *
 * §39 holds `data_quality_weights jsonb not null` with no DDL default, so a
 * settings row has to be created from something. A default that lives only in a
 * migration cannot be read by this engine; one that lives only here means an
 * edited settings row and the code disagree about what 100% means. So: defined
 * beside the components they weight, seeded into the row at company creation,
 * and passed back in as a parameter on every call.
 */
export const DEFAULT_DATA_QUALITY_WEIGHTS: DataQualityWeights = {
  LINES_WITH_WEIGHT: 0.25,
  MASS_WITH_FINAL_DESTINATION: 0.25,
  MASS_DOCUMENTED_OR_VERIFIED: 0.2,
  LINES_WITH_SUPPORT: 0.15,
  AVOIDED_MASS_ON_SPECIFIC_FACTOR: 0.15,
};

/**
 * Validates the §39 jsonb column. Weights must be non-negative and sum to 1 —
 * a set that sums to anything else silently rescales the published percentage.
 */
export const dataQualityWeightsSchema = z
  .object({
    LINES_WITH_WEIGHT: z.number().min(0).max(1),
    MASS_WITH_FINAL_DESTINATION: z.number().min(0).max(1),
    MASS_DOCUMENTED_OR_VERIFIED: z.number().min(0).max(1),
    LINES_WITH_SUPPORT: z.number().min(0).max(1),
    AVOIDED_MASS_ON_SPECIFIC_FACTOR: z.number().min(0).max(1),
  })
  .refine(
    (w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9,
    { message: 'data quality weights must sum to 1' }
  );

/** The five measurements §28.3 takes, each a numerator over a denominator. */
export interface DataQualityInputs {
  lineCount: number;
  linesWithWeight: number;
  linesWithSupport: number;
  /** Mass with a final outcome recorded (§28.2's allocated mass). */
  allocatedKg: number;
  handledKg: number;
  documentedMassKg: number;
  /** Mass carrying an avoided claim at all. */
  avoidedMassKg: number;
  /** …of which, on a non-generic product factor. */
  avoidedMassOnSpecificFactorKg: number;
}

export interface DataQualityComponentResult {
  readonly component: DataQualityComponent;
  readonly weight: number;
  /** 0…1, or **null when the denominator is zero** — a rate over nothing is not 0%. */
  readonly value: number | null;
  readonly measured: number;
  readonly total: number;
  readonly unit: 'LINES' | 'KG';
}

export interface DataQualityResult {
  /**
   * 0…100, or **null when no component applies** — §44: *"empty project returns
   * nulls not zeros"*. Weights are renormalised over the components that do
   * apply, so a project with no avoided mass is not marked down for it.
   */
  readonly pct: number | null;
  readonly components: readonly DataQualityComponentResult[];
  readonly warnings: readonly string[];
}

// ── Display (§39) ────────────────────────────────────────────────────────────

export const CARBON_DISPLAY_UNITS = ['KGCO2E', 'TCO2E', 'AUTO'] as const;
export const carbonDisplayUnitSchema = z.enum(CARBON_DISPLAY_UNITS);
export type CarbonDisplayUnit = z.infer<typeof carbonDisplayUnitSchema>;
