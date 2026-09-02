import type {
  ActivityInput,
  EmissionFactorInput,
  EmissionFactorSetInput,
  MovementDestination,
  MovementInput,
  ProductCarbonFactorInput,
} from './types';

/**
 * Test builders. Sane defaults, override what a test cares about — the shape
 * `rate-engine/engine.test.ts` uses, extracted to a module because five test
 * files need the same five builders.
 *
 * **This file is not a fixture dataset and ships no factor values that mean
 * anything.** §26.2 permits *"zero fabricated rows"* in the product; a builder
 * whose default is `1` is arithmetic scaffolding, not a factor somebody could
 * mistake for a published one. Where a test needs a realistic magnitude it says
 * so at the call site.
 */

export function factorSet(
  overrides: Partial<EmissionFactorSetInput> = {}
): EmissionFactorSetInput {
  return {
    id: 'set-1',
    companyId: null,
    name: 'Test Factors',
    version: 'v1',
    reportingYear: 2027,
    validFrom: '2027-01-01',
    validTo: '2027-12-31',
    region: 'GB',
    active: true,
    methodology: 'test methodology',
    ...overrides,
  };
}

export function factor(overrides: Partial<EmissionFactorInput> = {}): EmissionFactorInput {
  return {
    id: 'factor-1',
    factorSetId: 'set-1',
    category: 'Freighting goods',
    activity: 'HGV rigid',
    material: null,
    treatment: null,
    vehicleType: null,
    fuelType: null,
    unit: 'km',
    kgCo2ePerUnit: 1,
    wttKgCo2ePerUnit: null,
    scope: null,
    scope3Category: null,
    sourceReference: null,
    ...overrides,
  };
}

export function productFactor(
  overrides: Partial<ProductCarbonFactorInput> = {}
): ProductCarbonFactorInput {
  return {
    id: 'pf-1',
    companyId: null,
    itemCategory: 'FURNITURE',
    assetTypeId: null,
    manufacturer: null,
    productModel: null,
    kgCo2ePerItem: 75,
    kgCo2ePerKg: null,
    lifecycleBoundary: 'A1_A3',
    source: 'Test source',
    verificationStatus: 'EPD_VERIFIED',
    isEstimate: false,
    active: true,
    ...overrides,
  };
}

export function activity(overrides: Partial<ActivityInput> = {}): ActivityInput {
  return {
    id: 'act-1',
    kind: 'VEHICLE_DISTANCE',
    activityDate: '2027-03-04',
    quantity: 100,
    unit: 'km',
    vehicleCategory: null,
    fuelType: null,
    source: 'DOCUMENTED',
    providerCompanyId: null,
    ...overrides,
  };
}

/** A movement to a final, reuse-shaped destination, with a mass. */
export function movement(
  overrides: Partial<Omit<MovementInput, 'destination'>> & {
    destination?: Partial<MovementDestination>;
  } = {}
): MovementInput {
  const { destination, ...rest } = overrides;
  return {
    id: 'mv-1',
    massKg: 1000,
    quantity: 30,
    weightConfidence: 'DOCUMENTED',
    materialName: 'Operator chair',
    destination: {
      code: 'DONATION',
      name: 'Donation',
      isFinalOutcome: true,
      displacesReplacement: true,
      ghgTreatmentKey: 'REUSE',
      ...destination,
    },
    ...rest,
  };
}
