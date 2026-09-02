import { z } from 'zod';
import { MASS_UNITS, weightConfidenceSchema, type MassUnit } from './assets';
import {
  CARBON_DISPLAY_UNITS,
  DEFAULT_DATA_QUALITY_WEIGHTS,
  activityKindSchema,
  activitySourceSchema,
  calculationMethodSchema,
  carbonBucketSchema,
  carbonDisplayUnitSchema,
  dataQualityWeightsSchema,
  displacementBasisSchema,
  factorUnitSchema,
  ghgScopeSchema,
  lifecycleBoundarySchema,
  verificationStatusSchema,
  type CarbonDisplayUnit,
  type DataQualityComponentResult,
  type DataQualityWeights,
  type DisplacementBasis,
} from './carbon-engine';

/**
 * The Phase 9 wire contracts (CREWQUO_V2_PLAN.md §26–§28, §38.1, §39).
 *
 * `carbon-engine/` owns the arithmetic and knows nothing about HTTP; this module
 * owns the shapes that cross the wire and knows nothing about Postgres. The split
 * is the one `assets.ts` and `massBalance.ts` already draw, and it is what makes
 * the numbers testable without a server and the payloads testable without a
 * database.
 *
 * **Nothing here rounds.** §41.9 — *"full precision internally, sensible rounding
 * for display"* — so every figure crosses the wire as a full-precision number and
 * `formatCarbonKg` / `formatMassKg` are the only places a decimal place is chosen.
 */

// ── Settings (§39) ───────────────────────────────────────────────────────────

/**
 * §29.3's default methodology statement, and **the authority for the DDL default
 * in `0037`** — the parity test reads both and asserts they agree.
 *
 * The electricity sentence is `sustainability.md` §13.1 built as recommended:
 * location-based only, **labelled wherever it appears**. The GHG Protocol requires
 * dual reporting where a company holds contractual instruments, and CrewQuo holds
 * none and can verify none — so it says which basis it used rather than leaving a
 * reader to assume the favourable one.
 *
 * The avoided-emissions sentence is §27.5's prohibition on a net headline, stated
 * to the reader rather than only enforced in the type system.
 */
export const DEFAULT_REPORT_DISCLAIMER =
  'Greenhouse gas emissions are calculated using activity data recorded for this project and the emission factors identified in this report. ' +
  'Electricity is reported on a location-based basis using published grid average factors. ' +
  'Avoided emissions are comparative estimates and are reported separately from Scope 1, Scope 2 and Scope 3 inventory emissions. ' +
  'Results may include estimates where measured activity, asset weight or product-specific lifecycle data was unavailable. ' +
  'Assumptions and data sources are disclosed within this report.';

/**
 * The warning §27.4 requires to travel with **every** avoided figure — *"in the UI
 * and in the report, not only in an appendix"*.
 *
 * Frozen onto each claim at the moment it is made rather than resolved at render
 * time, because a settings row that says something else next year must not
 * silently restate what was claimed this year.
 */
export const AVOIDED_METHODOLOGY_WARNING =
  'Avoided emissions are a comparative estimate of what would have been emitted had replacement items been manufactured instead. ' +
  'They are not a reduction in this project’s Scope 1, 2 or 3 emissions and are never deducted from them. ' +
  'The figure depends on a stated displacement assumption and on the embodied-carbon factor cited beside it.';

export const DISTANCE_UNITS = ['KM', 'MILE'] as const;
export const distanceUnitSchema = z.enum(DISTANCE_UNITS);
export type DistanceUnit = z.infer<typeof distanceUnitSchema>;

export const massUnitSchema = z.enum(MASS_UNITS);

export interface SustainabilitySettingsView {
  companyId: string;
  defaultCountry: string;
  defaultFactorSetId: string | null;
  reportingYear: number | null;
  weightUnit: MassUnit;
  distanceUnit: DistanceUnit;
  carbonDisplayUnit: CarbonDisplayUnit;
  defaultDisplacementBasis: DisplacementBasis;
  defaultDisplacementPct: number | null;
  allowGenericProductFactors: boolean;
  requireDocumentForVerifiedWeight: boolean;
  captureGpsOnEvidence: boolean;
  dataQualityWeights: DataQualityWeights;
  dataQualityWarnBelow: number;
  reportDisclaimer: string;
  reportLogoFileId: string | null;
  reportAccentHex: string | null;
  enforceCompliance: boolean;
  updatedAt: string;
}

/**
 * A settings edit.
 *
 * **The displacement pair is validated together or not at all**, which is the
 * `superRefine` below and the reason it exists. `0037`'s check constraint refuses
 * a mismatched pair at the database; this refuses it with a sentence first, so an
 * operator reads *"a user-defined displacement needs a percentage"* rather than a
 * constraint name.
 *
 * The subtlety a `.refine` on each field separately would miss: **a patch that
 * changes only one half is still a change to the pair.** Sending
 * `{ defaultDisplacementBasis: 'USER_DEFINED' }` alone would leave a null pct and
 * violate the constraint, so the API resolves both against the stored row before
 * validating — see `resolveDisplacementUpdate`.
 */
export const updateSustainabilitySettingsSchema = z
  .object({
    defaultCountry: z.string().trim().min(1).max(10),
    defaultFactorSetId: z.string().uuid().nullable(),
    reportingYear: z.number().int().min(1990).max(2200).nullable(),
    weightUnit: massUnitSchema,
    distanceUnit: distanceUnitSchema,
    carbonDisplayUnit: carbonDisplayUnitSchema,
    defaultDisplacementBasis: displacementBasisSchema,
    defaultDisplacementPct: z.number().min(0).max(100).nullable(),
    allowGenericProductFactors: z.boolean(),
    requireDocumentForVerifiedWeight: z.boolean(),
    captureGpsOnEvidence: z.boolean(),
    dataQualityWeights: dataQualityWeightsSchema,
    dataQualityWarnBelow: z.number().int().min(0).max(100),
    reportDisclaimer: z.string().trim().min(1).max(4000),
    reportLogoFileId: z.string().uuid().nullable(),
    reportAccentHex: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour, e.g. #1f2933')
      .nullable(),
    enforceCompliance: z.boolean(),
    /** Last-write-wins with an expected version, and the refusal is visible (§8). */
    expectedRevision: z.number().int().min(1),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateSustainabilitySettings = z.infer<typeof updateSustainabilitySettingsSchema>;

/**
 * The pair, resolved against what is already stored, then checked.
 *
 * Exported and pure because the API, the screen and the acceptance script all need
 * the same answer, and a second copy of *"is 80% with basis UNKNOWN allowed"* is a
 * second answer to the question `0037`'s constraint exists to have one of.
 *
 * **`ASSUMED_FULL` carrying a stray percentage is refused as firmly as
 * `USER_DEFINED` carrying none**, because 100% is what `ASSUMED_FULL` *means* and
 * a second copy of it is a second answer.
 */
export function resolveDisplacementUpdate(args: {
  current: { basis: DisplacementBasis; pct: number | null };
  patch: { basis?: DisplacementBasis; pct?: number | null };
}): { basis: DisplacementBasis; pct: number | null; error: string | null } {
  const basis = args.patch.basis ?? args.current.basis;
  // A basis change with no accompanying percentage clears the old one rather than
  // carrying it forward: leaving 80 behind an `ASSUMED_FULL` is exactly the
  // drifted pair the constraint exists to refuse.
  const pct =
    args.patch.pct !== undefined
      ? args.patch.pct
      : args.patch.basis !== undefined && args.patch.basis !== args.current.basis
        ? null
        : args.current.pct;

  if (basis === 'USER_DEFINED' && pct === null) {
    return {
      basis,
      pct,
      error: 'A user-defined displacement assumption needs a percentage.',
    };
  }
  if (basis !== 'USER_DEFINED' && pct !== null) {
    return {
      basis,
      pct,
      error:
        basis === 'ASSUMED_FULL'
          ? 'Full displacement already means 100%. Choose “user defined” to state a different percentage.'
          : 'An unknown displacement assumption cannot carry a percentage — that is a claim nobody made.',
    };
  }
  return { basis, pct, error: null };
}

// ── Factor sets and factors (§26.1) ──────────────────────────────────────────

export interface FactorSetView {
  id: string;
  companyId: string | null;
  /** True for the platform library, which is read-only to every customer (§4). */
  isPlatform: boolean;
  name: string;
  sourceOrganisation: string;
  sourceDocument: string | null;
  sourceUrl: string | null;
  reportingYear: number;
  version: string;
  publishedOn: string | null;
  validFrom: string;
  validTo: string | null;
  methodology: string | null;
  region: string;
  active: boolean;
  factorCount: number;
  /**
   * How many **current** calculations cite this set. It is what makes
   * deactivation an informed act rather than a switch — packet §5 puts the same
   * number on the `factor_set_deactivated` event for the same reason.
   */
  citedByCalculations: number;
  importedByUserId: string | null;
  createdAt: string;
}

export interface EmissionFactorView {
  id: string;
  factorSetId: string;
  category: string;
  activity: string;
  material: string | null;
  treatment: string | null;
  vehicleType: string | null;
  fuelType: string | null;
  unit: z.infer<typeof factorUnitSchema>;
  kgCo2ePerUnit: number;
  wttKgCo2ePerUnit: number | null;
  scope: z.infer<typeof ghgScopeSchema> | null;
  scope3Category: number | null;
  sourceReference: string | null;
}

export const createFactorSetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sourceOrganisation: z.string().trim().min(1).max(200),
  sourceDocument: z.string().trim().max(400).nullish(),
  sourceUrl: z.string().trim().url().max(2000).nullish(),
  reportingYear: z.number().int().min(1990).max(2200),
  version: z.string().trim().min(1).max(60),
  publishedOn: z.string().date().nullish(),
  validFrom: z.string().date(),
  validTo: z.string().date().nullish(),
  methodology: z.string().trim().max(4000).nullish(),
  region: z.string().trim().min(1).max(10).default('GB'),
});
export type CreateFactorSet = z.infer<typeof createFactorSetSchema>;

/**
 * What may be changed on a set after it exists, and the list is short on purpose.
 *
 * **Not `reportingYear`, `version`, `region` or `validFrom`.** Those are what
 * `selectFactorSet` matches on, so editing one silently changes which projects a
 * set applies to — including projects already calculated against it, which §41.3
 * forbids. A publisher's correction is a new set at a new version (packet §2), and
 * so is ours.
 */
export const updateFactorSetSchema = z
  .object({
    sourceDocument: z.string().trim().max(400).nullable(),
    sourceUrl: z.string().trim().url().max(2000).nullable(),
    methodology: z.string().trim().max(4000).nullable(),
    validTo: z.string().date().nullable(),
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateFactorSet = z.infer<typeof updateFactorSetSchema>;

// ── Product carbon factors (§26.3) ───────────────────────────────────────────

export interface ProductFactorView {
  id: string;
  companyId: string | null;
  isPlatform: boolean;
  itemCategory: string;
  assetTypeId: string | null;
  assetTypeName: string | null;
  manufacturer: string | null;
  productModel: string | null;
  kgCo2ePerItem: number | null;
  kgCo2ePerKg: number | null;
  lifecycleBoundary: z.infer<typeof lifecycleBoundarySchema>;
  source: string;
  sourceUrl: string | null;
  publicationYear: number | null;
  region: string | null;
  verificationStatus: z.infer<typeof verificationStatusSchema>;
  isEstimate: boolean;
  notes: string | null;
  active: boolean;
  createdAt: string;
}

const productFactorFields = z.object({
  itemCategory: z.string().trim().min(1).max(120),
  assetTypeId: z.string().uuid().nullish(),
  manufacturer: z.string().trim().max(200).nullish(),
  productModel: z.string().trim().max(200).nullish(),
  kgCo2ePerItem: z.number().min(0).max(1e9).nullish(),
  kgCo2ePerKg: z.number().min(0).max(1e9).nullish(),
  lifecycleBoundary: lifecycleBoundarySchema,
  source: z.string().trim().min(1).max(400),
  sourceUrl: z.string().trim().url().max(2000).nullish(),
  publicationYear: z.number().int().min(1990).max(2200).nullish(),
  region: z.string().trim().max(10).nullish(),
  verificationStatus: verificationStatusSchema,
  notes: z.string().trim().max(2000).nullish(),
});

/**
 * `is_estimate` is **derived, never accepted**, which is why it is absent here.
 *
 * §26.3 makes a generic estimate "always surfaced as an estimate in the report",
 * and a client-supplied boolean beside a `verification_status` is two answers to
 * one question. `deriveIsEstimate` owns it, so an EPD cannot be filed as an
 * estimate and a generic cannot be filed as anything else.
 */
export const createProductFactorSchema = productFactorFields.refine(
  (v) => (v.kgCo2ePerItem == null) !== (v.kgCo2ePerKg == null),
  { message: 'Give exactly one of a per-item or a per-kilogram rate' }
);
export type CreateProductFactor = z.infer<typeof createProductFactorSchema>;

export const updateProductFactorSchema = productFactorFields
  .extend({ active: z.boolean() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .refine((v) => !(v.kgCo2ePerItem != null && v.kgCo2ePerKg != null), {
    message: 'A factor carries exactly one rate — clear the other to change which',
  });
export type UpdateProductFactor = z.infer<typeof updateProductFactorSchema>;

/**
 * The one derivation `is_estimate` gets, in one place.
 *
 * Only a verified EPD or the manufacturer's own published figure is not an
 * estimate. A sector dataset is a class average, an organisation-specific factor
 * is somebody's internal assumption, and a generic is a generic — all three are
 * estimates and the report says so.
 */
export function deriveIsEstimate(status: z.infer<typeof verificationStatusSchema>): boolean {
  return status !== 'EPD_VERIFIED' && status !== 'MANUFACTURER';
}

// ── Project activities (§27.3) ───────────────────────────────────────────────

export const ACTIVITY_PURPOSES = [
  'COLLECTION',
  'DELIVERY',
  'WASTE_TRANSPORT',
  'ASSET_TRANSPORT',
  'CREW_TRAVEL',
  'PLANT',
  'OTHER',
] as const;
export const activityPurposeSchema = z.enum(ACTIVITY_PURPOSES);
export type ActivityPurpose = z.infer<typeof activityPurposeSchema>;

export interface ProjectActivityView {
  id: string;
  projectId: string;
  companyId: string;
  kind: z.infer<typeof activityKindSchema>;
  activityDate: string;
  vehicleCategory: string | null;
  fuelType: string | null;
  distanceKm: number | null;
  litres: number | null;
  kwh: number | null;
  tonneKm: number | null;
  journeys: number | null;
  /** What the person typed, which is not always what was stored (§41.2). */
  enteredValue: number | null;
  enteredUnit: z.infer<typeof factorUnitSchema> | null;
  purpose: ActivityPurpose | null;
  providerCompanyId: string | null;
  providerCompanyName: string | null;
  assetMovementId: string | null;
  source: z.infer<typeof activitySourceSchema>;
  documentId: string | null;
  notes: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  capturedAt: string | null;
  revision: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * **Which measure each kind requires**, as data rather than as a check constraint.
 *
 * A constraint would have to be rewritten every time a kind is added, and a wrong
 * one is a migration to undo — 0040's comment says so. Here it is one table the
 * API, the form and the tests all read.
 *
 * `OTHER` requires nothing, deliberately: it is the escape hatch for an activity
 * somebody wants recorded before anybody has decided how to price it, and forcing
 * a measure onto it would make people file it as something it is not.
 */
export const REQUIRED_MEASURE_FOR_KIND: Readonly<
  Record<z.infer<typeof activityKindSchema>, 'distanceKm' | 'litres' | 'kwh' | 'tonneKm' | null>
> = {
  VEHICLE_DISTANCE: 'distanceKm',
  FUEL: 'litres',
  ELECTRICITY: 'kwh',
  FREIGHT: 'tonneKm',
  PLANT: 'litres',
  OTHER: null,
};

/** The factor unit each measure is expressed in, so the engine never has to guess. */
export const UNIT_FOR_MEASURE: Readonly<
  Record<'distanceKm' | 'litres' | 'kwh' | 'tonneKm', z.infer<typeof factorUnitSchema>>
> = {
  distanceKm: 'km',
  litres: 'litre',
  kwh: 'kWh',
  tonneKm: 'tonne.km',
};

const activityFields = z.object({
  kind: activityKindSchema,
  activityDate: z.string().date(),
  vehicleCategory: z.string().trim().max(120).nullish(),
  fuelType: z.string().trim().max(60).nullish(),
  distanceKm: z.number().min(0).max(1e7).nullish(),
  litres: z.number().min(0).max(1e7).nullish(),
  kwh: z.number().min(0).max(1e9).nullish(),
  tonneKm: z.number().min(0).max(1e9).nullish(),
  journeys: z.number().int().min(1).max(100000).nullish(),
  enteredValue: z.number().min(0).max(1e9).nullish(),
  enteredUnit: factorUnitSchema.nullish(),
  purpose: activityPurposeSchema.nullish(),
  /**
   * A provider may name **itself** and nothing else; the API enforces that against
   * the acting company, because a schema cannot know who is asking. §4: a row
   * naming another business is an assertion that business cannot see or contest.
   */
  providerCompanyId: z.string().uuid().nullish(),
  assetMovementId: z.string().uuid().nullish(),
  source: activitySourceSchema.default('ESTIMATED'),
  documentId: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).nullish(),
  /** The device's clock. A claim, and labelled as one wherever it is shown. */
  capturedAt: z.string().datetime().nullish(),
});

/**
 * The measure a kind needs must be present and positive.
 *
 * **Zero is refused rather than accepted**, which is the one judgement in this
 * schema. A zero-litre fuel activity is not a fact about the world; it is a form
 * somebody abandoned, and it would produce a `0.0 kgCO₂e` calculation row that
 * looks exactly like a computed result.
 */
function requireMeasure(v: z.infer<typeof activityFields>, ctx: z.RefinementCtx): void {
  const required = REQUIRED_MEASURE_FOR_KIND[v.kind];
  if (required === null) return;
  const value = v[required];
  if (value == null || value <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [required],
      message: `A ${v.kind.toLowerCase().replace(/_/g, ' ')} activity needs a ${required} above zero`,
    });
  }
}

export const createActivitySchema = activityFields
  .extend({ clientId: z.string().uuid().optional() })
  .superRefine((v, ctx) => {
    requireMeasure(v, ctx);
  });
export type CreateActivity = z.infer<typeof createActivitySchema>;

export const updateActivitySchema = activityFields
  .extend({ expectedRevision: z.number().int().min(1) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateActivity = z.infer<typeof updateActivitySchema>;

// ── Calculations and claims (§27.2, §27.4) ───────────────────────────────────

export interface CarbonCalculationView {
  id: string;
  bucket: z.infer<typeof carbonBucketSchema>;
  scope: z.infer<typeof ghgScopeSchema> | null;
  scope3Category: number | null;
  sourceType: 'ACTIVITY' | 'ASSET_MOVEMENT' | 'MANUAL';
  sourceId: string | null;
  method: z.infer<typeof calculationMethodSchema>;
  quantity: number;
  unit: string;
  kgCo2e: number;
  isEstimate: boolean;
  confidence: z.infer<typeof weightConfidenceSchema> | null;
  /** §41.2's four, denormalised so a trace needs nothing joined to it. */
  citation: {
    factorSetId: string | null;
    factorId: string | null;
    productFactorId: string | null;
    factorSetName: string;
    factorSetVersion: string;
    factorReportingYear: number | null;
    factorKgCo2ePerUnit: number | null;
    methodology: string | null;
  };
  inputs: Record<string, unknown>;
  calculatedAt: string;
  /** Set on a row that has been replaced. Excluded from every sum, in every trace. */
  supersededBy: string | null;
}

export interface AvoidedClaimView {
  id: string;
  calculationId: string;
  assetMovementId: string | null;
  baselineScenario: string;
  alternativeScenario: string;
  displacementPct: number | null;
  displacementBasis: DisplacementBasis;
  baselineKgCo2e: number;
  enablingKgCo2e: number;
  netAvoidedKgCo2e: number;
  systemBoundary: z.infer<typeof lifecycleBoundarySchema>;
  assumptions: string;
  uncertainty: string | null;
  /** Travels with the figure, never in an appendix (§27.4). */
  methodology: string;
  createdAt: string;
}

/**
 * The four things that supersede a calculation (packet §3 and §0 finding 6).
 *
 * Written out rather than derived, because the list **is** the rule: any write
 * that changes what `massBalance.ts` would return must supersede the calculations
 * derived from it. A fifth trigger is a deliberate edit here plus a call site,
 * which is the point — the failure mode this guards is a new write path that
 * quietly does not recalculate.
 */
export const SUPERSESSION_TRIGGERS = [
  /** §0 finding 6's three, which are the writes that change an EXISTING figure. */
  'WEIGHT_CORRECTED',
  'MOVEMENT_TOMBSTONED',
  'CONTINUATION_RECORDED',
  /** An explicit recalculation — the only way a newer factor set reaches a project. */
  'FACTOR_SET_REIMPORTED',
  /**
   * Two additive writes the packet's list does not name, and naming them here is
   * the deliberate edit its "a fifth trigger is a deliberate edit plus a call site"
   * rule asks for.
   *
   * Finding 6 lists the writes that change what `massBalance.ts` returns **for
   * material already accounted for**, because those are the ones whose failure is
   * silent — a figure that stays standing after its input is retracted. Recording a
   * new movement or a new activity has the opposite failure: nothing appears, which
   * is visible immediately. They still have to recalculate, or the section would
   * show a movement in the mass balance and no emission beside it.
   */
  'MOVEMENT_RECORDED',
  'ACTIVITY_CHANGED',
  /** Reserved: a settings change does not recalculate anything today (§41.3). */
  'SETTINGS_CHANGED',
] as const;
export const supersessionTriggerSchema = z.enum(SUPERSESSION_TRIGGERS);
export type SupersessionTrigger = z.infer<typeof supersessionTriggerSchema>;

// ── The project section (§28) ────────────────────────────────────────────────

export interface DataQualityComponentView extends DataQualityComponentResult {
  /** The sentence a screen puts beside the bar. Generated, never hand-written. */
  label: string;
}

/**
 * §28.3's five components, named for a human.
 *
 * The score ships **itemised rather than as a bare percentage** (packet finding
 * 5), because a customer who has been reading named gaps for a phase now sees a
 * number for the first time and will report it as a regression unless they can
 * see what it is made of.
 */
export const DATA_QUALITY_COMPONENT_LABELS: Readonly<
  Record<DataQualityComponentResult['component'], string>
> = {
  LINES_WITH_WEIGHT: 'Asset lines with a weight',
  MASS_WITH_FINAL_DESTINATION: 'Mass with a known final destination',
  MASS_DOCUMENTED_OR_VERIFIED: 'Mass whose weight is verified or documented',
  LINES_WITH_SUPPORT: 'Asset lines with a photo or document',
  AVOIDED_MASS_ON_SPECIFIC_FACTOR: 'Avoided mass on a product-specific factor',
};

/**
 * What a reader **without** `sustainability.read` gets — and it is a view with no
 * carbon in it at all rather than a view with nulls where carbon would be.
 *
 * §4's rule, stated as a type: *"the §28 project section renders masses for a
 * Supervisor and omits — rather than nulls — the carbon headlines, the completeness
 * score and the gaps. An omitted key cannot be rendered as 0.00 tCO₂e."*
 */
export interface ProjectCarbonDeniedView {
  view: 'MASS_ONLY';
  /** Why the rest is absent, so the screen can say so rather than showing nothing. */
  reason: 'CAPABILITY';
}

export interface FactorSetCitation {
  id: string;
  name: string;
  version: string;
  reportingYear: number;
  region: string;
}

export interface ProjectCarbonView {
  view: 'FULL';
  projectId: string;
  /**
   * The dominant set every figure below was computed against, or null when none
   * applies — in which case both headlines are **absent**, not zero (§41.1).
   */
  factorSet: FactorSetCitation | null;
  /**
   * Every set the current calculations cite, which is usually one.
   *
   * A project spanning a year boundary legitimately cites two, and §38.2 requires
   * that to be **disclosed** — *"a period spanning two factor sets says so"*. It is
   * carried here rather than left to Phase 12 because this is the first screen that
   * can span them, and a single-set field would have made the second one invisible
   * exactly where somebody would first assume there was only ever one.
   */
  factorSets: FactorSetCitation[];
  /**
   * `null` means *"nothing has been calculated"*, which is not the same as zero and
   * must never be rendered as one. A project with no factor set, or no activity and
   * no movement, has not emitted nothing — nobody has measured it.
   */
  projectEmissionsKgCo2e: number | null;
  avoidedKgCo2e: number | null;
  comparativeLifecycleKgCo2e: number | null;
  byBucket: { bucket: z.infer<typeof carbonBucketSchema>; kgCo2e: number; rowCount: number }[];
  byScope: { scope: z.infer<typeof ghgScopeSchema>; kgCo2e: number }[];
  /** Every total above is a floor while this is true. */
  hasGaps: boolean;
  /** §28.3's generated sentences: the carbon gaps, plus Phase 8's mass gaps. */
  gaps: string[];
  completeness: {
    pct: number | null;
    warnBelow: number;
    components: DataQualityComponentView[];
  };
  /** The claims behind the avoided figure, each carrying its own methodology. */
  claims: AvoidedClaimView[];
  /** §27.4's warning, so a screen cannot render the figure without it. */
  methodologyWarning: string;
  /** Display preferences from §39, resolved once so every figure agrees. */
  display: { carbonUnit: CarbonDisplayUnit; massUnit: MassUnit };
  /** When the engine last ran for this project. Null if it never has. */
  calculatedAt: string | null;
}

export type ProjectCarbonResponse = ProjectCarbonView | ProjectCarbonDeniedView;

// ── The organisation dashboard (§38.1) ───────────────────────────────────────

/**
 * One project's row on the org dashboard.
 *
 * **Every figure clicks through to its records** (§38.1's "no vanity metrics"), so
 * each row carries the project id it came from rather than only its contribution
 * to a total. The completeness percentage rides on the row for the same reason:
 * §38.1 requires any figure below the threshold to be *shown with its completeness
 * attached rather than presented as fact*, and a total cannot carry that — only
 * the rows it is made of can.
 */
export interface OrgProjectCarbonRow {
  projectId: string;
  projectName: string;
  clientCompanyName: string | null;
  handledKg: number;
  allocatedKg: number;
  pendingKg: number;
  reuseKg: number;
  recyclingKg: number;
  recoveryKg: number;
  landfillKg: number;
  divertedKg: number;
  retainedInUseKg: number;
  projectEmissionsKgCo2e: number | null;
  avoidedKgCo2e: number | null;
  completenessPct: number | null;
  /** True when this project's figures rest on a set the company no longer selects. */
  factorSetNames: string[];
}

export interface OrgSustainabilityView {
  /**
   * Scoped to projects the company **owns or is assigned to** (§4). A provider
   * reading the project section learns a mass times a factor; the dashboard
   * aggregates across projects and would otherwise leak the shape of a portfolio.
   */
  projects: OrgProjectCarbonRow[];
  totals: {
    projectCount: number;
    handledKg: number;
    allocatedKg: number;
    pendingKg: number;
    reuseKg: number;
    recyclingKg: number;
    recoveryKg: number;
    landfillKg: number;
    divertedKg: number;
    retainedInUseKg: number;
    /** Never netted against each other, and there is deliberately no third field. */
    projectEmissionsKgCo2e: number;
    avoidedKgCo2e: number;
  };
  rates: {
    reuse: number | null;
    recycling: number | null;
    recovery: number | null;
    landfill: number | null;
    diverted: number | null;
    retainedInUse: number | null;
  };
  /**
   * The projects whose completeness is below `warnBelow`, named. §38.1 asks for the
   * percentage to be attached to the figure; naming the projects is what makes the
   * attachment actionable rather than decorative.
   */
  belowThreshold: { projectId: string; projectName: string; pct: number }[];
  warnBelow: number;
  /**
   * §38.2's disclosure, one phase early and free: a period spanning two factor sets
   * says so. Computed here because the dashboard is the first screen that can span
   * them.
   */
  factorSetNames: string[];
  display: { carbonUnit: CarbonDisplayUnit; massUnit: MassUnit };
  methodologyWarning: string;
}

// ── Events (packet §5) ───────────────────────────────────────────────────────

/**
 * `sustainability.factor_set_imported`.
 *
 * Row counts **by category**, because "1,842 rows imported" is unreadable and
 * "freight 210 · fuels 96 · waste 148" is what an operator checks a workbook
 * against. No factor values travel: §11 excludes them, and a factor value is
 * commercially sensitive third-party data even when the set is a government one.
 */
export function factorSetImportedEventPayload(args: {
  companyId: string;
  factorSetId: string;
  name: string;
  version: string;
  reportingYear: number;
  rowCount: number;
  countsByCategory: Readonly<Record<string, number>>;
  actorUserId: string;
}): Record<string, unknown> {
  return {
    companyId: args.companyId,
    factorSetId: args.factorSetId,
    name: args.name,
    version: args.version,
    reportingYear: args.reportingYear,
    rowCount: args.rowCount,
    countsByCategory: args.countsByCategory,
    actorUserId: args.actorUserId,
  };
}

/**
 * `sustainability.calculations_superseded`.
 *
 * **The per-bucket delta is the whole payload.** An audit row saying "17
 * calculations superseded" is unreadable; one saying *"project emissions +0.12
 * tCO₂e, avoided −4.30 tCO₂e, trigger WEIGHT_CORRECTED"* is the sentence somebody
 * needs a year later when a client asks why the number moved — and it is the only
 * place that answer is recorded. The superseded rows say what the figures were;
 * only this says what changed them and by how much.
 *
 * **No event fires per calculation.** A re-imported factor set can supersede
 * thousands of rows across dozens of projects; one event per project per trigger is
 * the granularity anybody can act on.
 */
export function calculationsSupersededEventPayload(args: {
  projectId: string;
  companyId: string;
  trigger: SupersessionTrigger;
  triggeringId: string | null;
  supersededCount: number;
  newCount: number;
  deltaByBucket: Readonly<Record<string, number>>;
  actorUserId: string | null;
}): Record<string, unknown> {
  return {
    projectId: args.projectId,
    companyId: args.companyId,
    trigger: args.trigger,
    triggeringId: args.triggeringId,
    supersededCount: args.supersededCount,
    newCount: args.newCount,
    deltaByBucket: args.deltaByBucket,
    actorUserId: args.actorUserId,
  };
}

export const CLAIM_BLOCKED_REASONS = [
  'NO_PRODUCT_FACTOR',
  'DISPLACEMENT_UNKNOWN',
  'GENERIC_NOT_ALLOWED',
] as const;
export type ClaimBlockedReason = (typeof CLAIM_BLOCKED_REASONS)[number];

/**
 * `sustainability.claim_blocked` — **the one event here that earns its place.**
 *
 * Every other event in this domain reports something that happened; this reports
 * something that *didn't* — an avoided-emissions claim that could not be made,
 * with the reason and the quantity. §41.1's *"no factor, no number — say so
 * instead"* is a rule about the report, and a rule about the report alone means the
 * first time anybody learns the claim is missing is when the report is generated,
 * which is after the client meeting is booked.
 *
 * **Digested per project per day, never per movement.** A single clearance of 400
 * chairs with no factor would otherwise generate 400 identical items; the digest
 * names the asset type and the total quantity, which is what the fix needs — one
 * factor resolves all of them. The idempotency key is what enforces that, and it is
 * built by the caller from project + reason + date.
 */
export function claimBlockedEventPayload(args: {
  projectId: string;
  companyId: string;
  reason: ClaimBlockedReason;
  /** Asset type codes and quantities, aggregated. Never a serial or a description. */
  subjects: readonly { subject: string; quantity: number }[];
  movementCount: number;
  onDate: string;
}): Record<string, unknown> {
  return {
    projectId: args.projectId,
    companyId: args.companyId,
    reason: args.reason,
    subjects: args.subjects.map((s) => ({ subject: s.subject, quantity: s.quantity })),
    movementCount: args.movementCount,
    onDate: args.onDate,
  };
}

/** The DDL default in `0037` must equal this. `sustainabilityParity.test.ts` asserts it. */
export const SETTINGS_DEFAULTS = {
  defaultCountry: 'GB',
  weightUnit: 'AUTO',
  distanceUnit: 'KM',
  carbonDisplayUnit: 'AUTO',
  defaultDisplacementBasis: 'UNKNOWN',
  allowGenericProductFactors: true,
  requireDocumentForVerifiedWeight: true,
  captureGpsOnEvidence: false,
  dataQualityWeights: DEFAULT_DATA_QUALITY_WEIGHTS,
  dataQualityWarnBelow: 80,
  reportDisclaimer: DEFAULT_REPORT_DISCLAIMER,
  enforceCompliance: false,
} as const;

/** Re-exported so a caller can render a unit picker without reaching into the engine. */
export { CARBON_DISPLAY_UNITS };
