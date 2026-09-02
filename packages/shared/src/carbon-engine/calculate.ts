import type { WeightConfidence } from '../assets';
import { convertQuantity, kgToTonnes } from './units';
import {
  SCOPE3_WASTE_CATEGORY,
  type ActivityInput,
  type ActivitySource,
  type AvoidedInput,
  type AvoidedOutcome,
  type CarbonOutcome,
  type CarbonResult,
  type DisplacementBasis,
  type EmissionFactorInput,
  type EmissionFactorSetInput,
  type FactorCitation,
  type GhgScope,
  type MovementInput,
} from './types';

/**
 * The calculations (§27.3–§27.4).
 *
 * **Every one of these can decline to produce a number, and declining is not an
 * error.** §41.1 — *"never invent emissions factors. No factor, no number — say
 * so instead"* — is the whole design of the `CarbonOutcome` union: `QUANTIFIED`
 * carries a figure, `GAP` carries something the report must disclose, and
 * `OUT_OF_SCOPE` carries something the report must **not** disclose (packet §0
 * finding 8). A caller cannot get a number without having handled the other two.
 *
 * Nothing here rounds (§41.9).
 */

/**
 * An activity's provenance in the same vocabulary a weight uses (§25.3), so a
 * carbon figure inherits the confidence of what produced it rather than
 * inventing a second scale that means almost the same thing.
 */
const CONFIDENCE_FOR_SOURCE: Readonly<Record<ActivitySource, WeightConfidence>> = {
  MEASURED: 'VERIFIED',
  DOCUMENTED: 'DOCUMENTED',
  ESTIMATED: 'ESTIMATED',
};

function citationFor(
  set: EmissionFactorSetInput,
  factor: EmissionFactorInput
): FactorCitation {
  return {
    factorSetId: set.id,
    factorId: factor.id,
    productFactorId: null,
    factorSetName: set.name,
    factorSetVersion: set.version,
    factorReportingYear: set.reportingYear,
    factorKgCo2ePerUnit: factor.kgCo2ePerUnit,
    methodology: set.methodology,
  };
}

// ── Scope (§27.3, §27.5) ─────────────────────────────────────────────────────

/**
 * Which scope an activity belongs to.
 *
 * **The factor wins if it says.** A published set that labels its own rows is
 * stating the publisher's classification, and overriding it with ours would be
 * the invention §41.1 forbids one level up from a number.
 *
 * Where the factor is silent, §27.3's rule applies: *"Scope 1 for own vehicles,
 * Scope 3 for subcontracted"*, electricity is Scope 2, freight is Scope 3. This
 * is classification rather than invention — it changes which column a figure is
 * reported in, not how large it is.
 *
 * `OTHER` returns **null**, deliberately. An activity nobody has categorised
 * cannot be assigned a scope by this function, and a null is visible in the
 * inventory view as something to classify; a guess is not.
 */
export function resolveScope(
  activity: ActivityInput,
  factor: EmissionFactorInput
): GhgScope | null {
  if (factor.scope !== null) return factor.scope;

  switch (activity.kind) {
    case 'ELECTRICITY':
      return 'SCOPE_2';
    case 'FREIGHT':
      return 'SCOPE_3';
    case 'VEHICLE_DISTANCE':
    case 'FUEL':
    case 'PLANT':
      return activity.providerCompanyId === null ? 'SCOPE_1' : 'SCOPE_3';
    case 'OTHER':
      return null;
  }
}

// ── Operational emissions (§27.3) ────────────────────────────────────────────

/**
 * `quantity × factor`, in the factor's unit.
 *
 * §27.1 types this `(activity, factor) → CarbonResult`; it takes the **set** as
 * well, because §41.2 requires the result to name the factor's version and
 * reporting year and neither of those lives on the factor row. Returning a
 * result that cannot cite itself would defeat the purpose of returning the
 * inputs at all.
 *
 * **WTT is computed and deliberately not added in.** §27.3 asks for the
 * well-to-tank component *"where the publisher separates it"*; adding it to
 * `kgCo2e` would put a Scope 3 component inside a Scope 1 figure. It rides on the
 * result so 9.5 can persist a second row against the same activity.
 */
export function calculateActivityEmissions(
  activity: ActivityInput,
  factor: EmissionFactorInput,
  set: EmissionFactorSetInput
): CarbonOutcome<'PROJECT_EMISSIONS'> {
  const quantity = convertQuantity(activity.quantity, activity.unit, factor.unit);

  if (quantity === null) {
    return {
      kind: 'GAP',
      gap: {
        reason: 'UNIT_MISMATCH',
        sourceType: 'ACTIVITY',
        sourceId: activity.id,
        quantity: activity.quantity,
        unit: activity.unit,
        subject: factor.activity,
      },
    };
  }

  const kgCo2e = quantity * factor.kgCo2ePerUnit;
  const wttKgCo2e =
    factor.wttKgCo2ePerUnit === null ? null : quantity * factor.wttKgCo2ePerUnit;

  return {
    kind: 'QUANTIFIED',
    result: {
      bucket: 'PROJECT_EMISSIONS',
      scope: resolveScope(activity, factor),
      scope3Category: factor.scope3Category,
      sourceType: 'ACTIVITY',
      sourceId: activity.id,
      method: 'ACTIVITY_X_FACTOR',
      quantity,
      unit: factor.unit,
      kgCo2e,
      wttKgCo2e,
      isEstimate: activity.source === 'ESTIMATED',
      confidence: CONFIDENCE_FOR_SOURCE[activity.source],
      citation: citationFor(set, factor),
      inputs: {
        enteredQuantity: activity.quantity,
        enteredUnit: activity.unit,
        convertedQuantity: quantity,
        factorUnit: factor.unit,
        kgCo2ePerUnit: factor.kgCo2ePerUnit,
        wttKgCo2ePerUnit: factor.wttKgCo2ePerUnit,
        activityKind: activity.kind,
        activityDate: activity.activityDate,
        activitySource: activity.source,
        subcontracted: activity.providerCompanyId !== null,
      },
    },
  };
}

// ── Waste treatment (§27.3, Scope 3 Cat 5) ───────────────────────────────────

/**
 * `mass × treatment factor`, where the destination's `ghg_treatment_key` chose
 * the factor.
 *
 * **The two silences, which are the reason this returns three states** (packet
 * §0 finding 8):
 *
 * - A destination with **no** `ghg_treatment_key` — `RETAINED`, `RELOCATED`,
 *   `STORAGE` — was never a waste treatment. Nothing was treated, so there is
 *   nothing to compute and **nothing to disclose**. Reported as a gap, every
 *   retained chair becomes a warning about material that was handled perfectly.
 * - A destination **with** a key whose factor is missing from the selected set is
 *   in scope, unquantified, and **must** be disclosed by material and mass —
 *   §28.3's *"no waste-treatment factor exists for plasterboard… 1.2 t excluded
 *   from treatment emissions."*
 *
 * `factor` is nullable for exactly that second case: the caller passes what
 * `resolveFactor` gave it, including nothing.
 */
export function calculateWasteTreatmentEmissions(
  movement: MovementInput,
  factor: EmissionFactorInput | null,
  set: EmissionFactorSetInput | null
): CarbonOutcome<'WASTE_TREATMENT'> {
  if (movement.destination.ghgTreatmentKey === null) {
    return {
      kind: 'OUT_OF_SCOPE',
      reason: 'NOT_A_WASTE_TREATMENT',
      subject: movement.destination.name,
    };
  }

  if (factor === null || set === null) {
    return {
      kind: 'GAP',
      gap: {
        reason: 'NO_FACTOR',
        sourceType: 'ASSET_MOVEMENT',
        sourceId: movement.id,
        quantity: movement.massKg,
        unit: 'kg',
        subject: movement.materialName,
      },
    };
  }

  if (movement.massKg === null) {
    return {
      kind: 'GAP',
      gap: {
        reason: 'NO_MASS',
        sourceType: 'ASSET_MOVEMENT',
        sourceId: movement.id,
        quantity: null,
        unit: null,
        subject: movement.materialName,
      },
    };
  }

  // `tonne` is the only mass unit in §26.1's six, so anything else is a factor
  // that cannot price a mass — disclosed rather than coerced.
  if (factor.unit !== 'tonne') {
    return {
      kind: 'GAP',
      gap: {
        reason: 'UNIT_MISMATCH',
        sourceType: 'ASSET_MOVEMENT',
        sourceId: movement.id,
        quantity: movement.massKg,
        unit: 'kg',
        subject: movement.materialName,
      },
    };
  }

  const tonnes = kgToTonnes(movement.massKg);
  const kgCo2e = tonnes * factor.kgCo2ePerUnit;

  return {
    kind: 'QUANTIFIED',
    result: {
      bucket: 'WASTE_TREATMENT',
      scope: factor.scope ?? 'SCOPE_3',
      scope3Category: factor.scope3Category ?? SCOPE3_WASTE_CATEGORY,
      sourceType: 'ASSET_MOVEMENT',
      sourceId: movement.id,
      method: 'MASS_X_TREATMENT_FACTOR',
      quantity: tonnes,
      unit: 'tonne',
      kgCo2e,
      wttKgCo2e:
        factor.wttKgCo2ePerUnit === null ? null : tonnes * factor.wttKgCo2ePerUnit,
      isEstimate:
        movement.weightConfidence === 'ESTIMATED' ||
        movement.weightConfidence === 'APPROXIMATE',
      confidence: movement.weightConfidence,
      citation: citationFor(set, factor),
      inputs: {
        massKg: movement.massKg,
        tonnes,
        kgCo2ePerUnit: factor.kgCo2ePerUnit,
        treatmentKey: movement.destination.ghgTreatmentKey,
        destinationCode: movement.destination.code,
        material: movement.materialName,
        weightConfidence: movement.weightConfidence,
      },
    },
  };
}

// ── Displacement (§27.4, §39) ────────────────────────────────────────────────

/**
 * The percentage a basis implies, or **null for `UNKNOWN`** — which produces no
 * claim at all (§27.4).
 *
 * This is packet §0 finding 1 as a function. §39's DDL still reads
 * `default_displacement_pct not null default 100`, which cannot express `UNKNOWN`
 * and defaults to the one value the owner decision of 2026-08-18 forbids. The
 * settings row is corrected in 9.1; this is the shape it is corrected *to*, and
 * it lives here so the engine and the column cannot drift.
 *
 * `USER_DEFINED` with no percentage returns null rather than falling back to 100.
 * The check constraint in 9.1 makes that pair unstorable, so reaching it means
 * something upstream is wrong — and the safe direction for a wrong displacement
 * is no claim, never a maximal one.
 */
export function resolveDisplacementPct(
  basis: DisplacementBasis,
  pct: number | null
): number | null {
  switch (basis) {
    case 'ASSUMED_FULL':
      return 100;
    case 'USER_DEFINED':
      return pct;
    case 'UNKNOWN':
      return null;
  }
}

/**
 * The pairing 9.1's check constraint enforces in the database, available to the
 * API so a bad pair is refused with a sentence before it is refused with a
 * constraint violation.
 */
export function isValidDisplacementSetting(
  basis: DisplacementBasis,
  pct: number | null
): boolean {
  return (basis === 'USER_DEFINED') === (pct !== null);
}

// ── Avoided emissions (§27.4) ────────────────────────────────────────────────

/**
 * `avoided = (quantity × displacement_pct × baseline_embodied_carbon) −
 * enabling_emissions` (§27.4).
 *
 * Three ways this declines to produce a number, and each is a different sentence
 * to a different person:
 *
 * - The destination **displaces nothing** (`RETAINED`, `RECYCLING`, `LANDFILL`) —
 *   out of scope, disclosed as context but never as a gap. Packet §0 finding 7:
 *   a project where the client kept everything reports high retained-in-use and
 *   zero avoided, which is correct and reads as a bug unless the report says so.
 * - The displacement basis is **`UNKNOWN`** — a gap, and an Action Centre item
 *   resolved by somebody stating an assumption. Never silently 100%.
 * - The product factor has **neither rate**, or has a per-kg rate against a
 *   movement with no mass — a gap naming the asset type.
 *
 * **The net is not clamped at zero.** Where enabling emissions exceed the
 * baseline the claim is negative, and it is reported as negative. Clamping would
 * mean the product can never report that a reuse cost more than it saved, which
 * is exactly the favourable arithmetic §41 exists to prevent.
 */
export function calculateAvoidedEmissions(input: AvoidedInput): AvoidedOutcome {
  const { movement, factor, basis, enablingKgCo2e } = input;

  if (!movement.destination.displacesReplacement) {
    return {
      kind: 'OUT_OF_SCOPE',
      reason: 'NO_REPLACEMENT_DISPLACED',
      subject: movement.destination.name,
    };
  }

  const pct = resolveDisplacementPct(basis, input.displacementPct);
  if (pct === null) {
    return {
      kind: 'GAP',
      gap: {
        reason: 'DISPLACEMENT_UNKNOWN',
        sourceType: 'ASSET_MOVEMENT',
        sourceId: movement.id,
        quantity: movement.quantity,
        unit: 'items',
        subject: movement.materialName,
      },
    };
  }

  const share = pct / 100;
  let baselineKgCo2e: number;
  let basisQuantity: number;
  let basisUnit: string;

  if (factor.kgCo2ePerItem !== null) {
    basisQuantity = movement.quantity;
    basisUnit = 'items';
    baselineKgCo2e = movement.quantity * share * factor.kgCo2ePerItem;
  } else if (factor.kgCo2ePerKg !== null) {
    if (movement.massKg === null) {
      return {
        kind: 'GAP',
        gap: {
          reason: 'NO_MASS',
          sourceType: 'ASSET_MOVEMENT',
          sourceId: movement.id,
          quantity: null,
          unit: null,
          subject: movement.materialName,
        },
      };
    }
    basisQuantity = movement.massKg;
    basisUnit = 'kg';
    baselineKgCo2e = movement.massKg * share * factor.kgCo2ePerKg;
  } else {
    // The DDL's `num_nonnulls(...) = 1` check makes this unreachable from the
    // database; it is handled rather than asserted because a factor imported by
    // some future path with neither rate must not become a zero.
    return {
      kind: 'GAP',
      gap: {
        reason: 'NO_PRODUCT_FACTOR',
        sourceType: 'ASSET_MOVEMENT',
        sourceId: movement.id,
        quantity: movement.quantity,
        unit: 'items',
        subject: movement.materialName,
      },
    };
  }

  const netAvoidedKgCo2e = baselineKgCo2e - enablingKgCo2e;

  return {
    kind: 'QUANTIFIED',
    result: {
      bucket: 'AVOIDED',
      // §27.4: avoided emissions are "not negative project emissions, and never
      // deducted from any inventory scope", so an AVOIDED row carries no scope.
      scope: null,
      scope3Category: null,
      sourceType: 'ASSET_MOVEMENT',
      sourceId: movement.id,
      method: 'DISPLACEMENT',
      quantity: basisQuantity,
      unit: basisUnit,
      kgCo2e: netAvoidedKgCo2e,
      wttKgCo2e: null,
      isEstimate: factor.isEstimate,
      confidence: movement.weightConfidence,
      citation: {
        factorSetId: null,
        factorId: null,
        productFactorId: factor.id,
        // A product factor belongs to no set, so §41.2's "name your source and
        // its version" is answered by the two things a product factor actually
        // has: where the number was published, and how far it has been verified.
        factorSetName: factor.source,
        factorSetVersion: factor.verificationStatus,
        factorReportingYear: null,
        factorKgCo2ePerUnit: factor.kgCo2ePerItem ?? factor.kgCo2ePerKg,
        methodology: input.methodology,
      },
      inputs: {
        quantity: movement.quantity,
        massKg: movement.massKg,
        displacementPct: pct,
        displacementBasis: basis,
        baselineKgCo2e,
        enablingKgCo2e,
        netAvoidedKgCo2e,
        lifecycleBoundary: factor.lifecycleBoundary,
        verificationStatus: factor.verificationStatus,
        isGenericFactor: factor.verificationStatus === 'GENERIC_ESTIMATE',
      },
    },
    claim: {
      assetMovementId: movement.id,
      baselineScenario: input.baselineScenario,
      alternativeScenario: input.alternativeScenario,
      displacementPct: pct,
      displacementBasis: basis,
      baselineKgCo2e,
      enablingKgCo2e,
      netAvoidedKgCo2e,
      systemBoundary: factor.lifecycleBoundary,
      assumptions: input.assumptions,
      uncertainty: input.uncertainty,
      methodology: input.methodology,
    },
  };
}
