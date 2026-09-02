import { describe, expect, it } from 'vitest';
import {
  addTotals,
  computeDataQuality,
  describeCarbonGaps,
  describeUnclaimedRetainedMass,
  formatCarbonKg,
  formatCompleteness,
  rollUpProjectCarbon,
  sumBucket,
  type AnyCarbonOutcome,
} from './rollup';
import {
  DEFAULT_DATA_QUALITY_WEIGHTS,
  dataQualityWeightsSchema,
  type CarbonBucket,
  type CarbonGap,
  type CarbonResult,
  type DataQualityInputs,
  type GhgScope,
} from './types';

function result(
  bucket: CarbonBucket,
  kgCo2e: number,
  scope: GhgScope | null = null
): CarbonResult {
  return {
    bucket,
    scope,
    scope3Category: null,
    sourceType: 'ACTIVITY',
    sourceId: 'x',
    method: 'ACTIVITY_X_FACTOR',
    quantity: 1,
    unit: 'km',
    kgCo2e,
    wttKgCo2e: null,
    isEstimate: false,
    confidence: null,
    citation: {
      factorSetId: null,
      factorId: null,
      productFactorId: null,
      factorSetName: 'n',
      factorSetVersion: 'v',
      factorReportingYear: null,
      factorKgCo2ePerUnit: null,
      methodology: null,
    },
    inputs: {},
  };
}

const quantified = (r: CarbonResult): AnyCarbonOutcome => ({ kind: 'QUANTIFIED', result: r });

const gap = (reason: CarbonGap['reason'], subject = 'Plasterboard'): AnyCarbonOutcome => ({
  kind: 'GAP',
  gap: { reason, sourceType: 'ASSET_MOVEMENT', sourceId: 'm', quantity: 1200, unit: 'kg', subject },
});

describe('sumBucket and addTotals — the firewall (locked decision #17)', () => {
  it('sums only the requested bucket out of a mixed list', () => {
    const rows = [
      result('PROJECT_EMISSIONS', 100),
      result('AVOIDED', 5000),
      result('PROJECT_EMISSIONS', 50),
    ];
    expect(sumBucket(rows, 'PROJECT_EMISSIONS')).toEqual({
      bucket: 'PROJECT_EMISSIONS',
      kgCo2e: 150,
      rowCount: 2,
    });
    expect(sumBucket(rows, 'AVOIDED').kgCo2e).toBe(5000);
  });

  it('returns a zero total with a zero row count for an absent bucket', () => {
    expect(sumBucket([], 'COMPARATIVE_LIFECYCLE')).toEqual({
      bucket: 'COMPARATIVE_LIFECYCLE',
      kgCo2e: 0,
      rowCount: 0,
    });
  });

  it('adds two totals from the same bucket', () => {
    const a = sumBucket([result('PROJECT_EMISSIONS', 10)], 'PROJECT_EMISSIONS');
    const b = sumBucket([result('PROJECT_EMISSIONS', 5)], 'PROJECT_EMISSIONS');
    expect(addTotals(a, b).kgCo2e).toBe(15);
  });
});

describe('rollUpProjectCarbon — §28.2', () => {
  it('adds the two inventory buckets into project emissions and leaves avoided alone', () => {
    const out = rollUpProjectCarbon([
      quantified(result('PROJECT_EMISSIONS', 3000, 'SCOPE_1')),
      quantified(result('WASTE_TREATMENT', 840, 'SCOPE_3')),
      quantified(result('AVOIDED', 27420)),
    ]);
    expect(out.projectEmissionsKgCo2e).toBe(3840);
    expect(out.avoidedKgCo2e).toBe(27420);
  });

  it('exposes no netted total anywhere in the shape (§27.5)', () => {
    const out = rollUpProjectCarbon([
      quantified(result('PROJECT_EMISSIONS', 3840, 'SCOPE_1')),
      quantified(result('AVOIDED', 27420)),
    ]);
    const netted = out.projectEmissionsKgCo2e - out.avoidedKgCo2e;
    expect(Object.values(out)).not.toContain(netted);
    expect(Object.keys(out)).not.toContain('net');
    expect(Object.keys(out)).not.toContain('netKgCo2e');
  });

  it('keeps comparative lifecycle out of the inventory (§26.4)', () => {
    const out = rollUpProjectCarbon([
      quantified(result('PROJECT_EMISSIONS', 100, 'SCOPE_1')),
      quantified(result('COMPARATIVE_LIFECYCLE', 900, 'SCOPE_3')),
    ]);
    expect(out.projectEmissionsKgCo2e).toBe(100);
    expect(out.comparativeLifecycleKgCo2e).toBe(900);
  });

  it('groups by scope over the inventory buckets only', () => {
    const out = rollUpProjectCarbon([
      quantified(result('PROJECT_EMISSIONS', 100, 'SCOPE_1')),
      quantified(result('PROJECT_EMISSIONS', 40, 'SCOPE_2')),
      quantified(result('WASTE_TREATMENT', 60, 'SCOPE_3')),
      // A comparative-lifecycle row carrying a scope must not reach the inventory.
      quantified(result('COMPARATIVE_LIFECYCLE', 999, 'SCOPE_3')),
    ]);
    expect(out.byScope.SCOPE_1).toBe(100);
    expect(out.byScope.SCOPE_2).toBe(40);
    expect(out.byScope.SCOPE_3).toBe(60);
    expect(out.byScope.OUT_OF_SCOPE).toBe(0);
  });

  it('never lets an avoided row reach a scope total', () => {
    const out = rollUpProjectCarbon([quantified(result('AVOIDED', 27420))]);
    for (const scope of Object.values(out.byScope)) expect(scope).toBe(0);
  });

  it('reports every bucket, including the empty ones', () => {
    const out = rollUpProjectCarbon([]);
    expect(Object.keys(out.byBucket).sort()).toEqual([
      'AVOIDED',
      'COMPARATIVE_LIFECYCLE',
      'PROJECT_EMISSIONS',
      'WASTE_TREATMENT',
    ]);
    expect(out.projectEmissionsKgCo2e).toBe(0);
  });

  it('counts gaps and says the totals are a floor', () => {
    const out = rollUpProjectCarbon([
      quantified(result('PROJECT_EMISSIONS', 100, 'SCOPE_1')),
      gap('NO_FACTOR'),
      gap('DISPLACEMENT_UNKNOWN'),
    ]);
    expect(out.gapCount).toBe(2);
    expect(out.hasGaps).toBe(true);
  });

  it('does not count OUT_OF_SCOPE outcomes as gaps (finding 8)', () => {
    const out = rollUpProjectCarbon([
      { kind: 'OUT_OF_SCOPE', reason: 'NOT_A_WASTE_TREATMENT', subject: 'Retained by client' },
      { kind: 'OUT_OF_SCOPE', reason: 'NO_REPLACEMENT_DISPLACED', subject: 'Retained by client' },
    ]);
    expect(out.gapCount).toBe(0);
    expect(out.hasGaps).toBe(false);
  });
});

describe('computeDataQuality — §28.3', () => {
  function inputs(overrides: Partial<DataQualityInputs> = {}): DataQualityInputs {
    return {
      lineCount: 10,
      linesWithWeight: 10,
      linesWithSupport: 10,
      allocatedKg: 1000,
      handledKg: 1000,
      documentedMassKg: 1000,
      avoidedMassKg: 1000,
      avoidedMassOnSpecificFactorKg: 1000,
      ...overrides,
    };
  }

  it('ships §28.3s default weights, and they sum to 1', () => {
    expect(DEFAULT_DATA_QUALITY_WEIGHTS).toEqual({
      LINES_WITH_WEIGHT: 0.25,
      MASS_WITH_FINAL_DESTINATION: 0.25,
      MASS_DOCUMENTED_OR_VERIFIED: 0.2,
      LINES_WITH_SUPPORT: 0.15,
      AVOIDED_MASS_ON_SPECIFIC_FACTOR: 0.15,
    });
    expect(dataQualityWeightsSchema.safeParse(DEFAULT_DATA_QUALITY_WEIGHTS).success).toBe(true);
  });

  it('refuses a weight set that does not sum to 1', () => {
    const bad = { ...DEFAULT_DATA_QUALITY_WEIGHTS, LINES_WITH_WEIGHT: 0.5 };
    expect(dataQualityWeightsSchema.safeParse(bad).success).toBe(false);
  });

  it('scores a complete project at 100', () => {
    const out = computeDataQuality(inputs(), DEFAULT_DATA_QUALITY_WEIGHTS);
    expect(out.pct).toBe(100);
    expect(out.warnings).toEqual([]);
  });

  it('returns null — not zero — for an empty project (§44)', () => {
    const out = computeDataQuality(
      inputs({
        lineCount: 0,
        linesWithWeight: 0,
        linesWithSupport: 0,
        allocatedKg: 0,
        handledKg: 0,
        documentedMassKg: 0,
        avoidedMassKg: 0,
        avoidedMassOnSpecificFactorKg: 0,
      }),
      DEFAULT_DATA_QUALITY_WEIGHTS
    );
    expect(out.pct).toBeNull();
    for (const c of out.components) expect(c.value).toBeNull();
  });

  it('gives all five components, each with its weight and measurement', () => {
    const out = computeDataQuality(inputs(), DEFAULT_DATA_QUALITY_WEIGHTS);
    expect(out.components).toHaveLength(5);
    expect(out.components.map((c) => c.component)).toEqual([
      'LINES_WITH_WEIGHT',
      'MASS_WITH_FINAL_DESTINATION',
      'MASS_DOCUMENTED_OR_VERIFIED',
      'LINES_WITH_SUPPORT',
      'AVOIDED_MASS_ON_SPECIFIC_FACTOR',
    ]);
    expect(out.components[0]?.weight).toBe(0.25);
  });

  it('renormalises over the components that apply, so no avoided mass is not a penalty', () => {
    // Everything else perfect; the fifth component simply does not apply.
    const out = computeDataQuality(
      inputs({ avoidedMassKg: 0, avoidedMassOnSpecificFactorKg: 0 }),
      DEFAULT_DATA_QUALITY_WEIGHTS
    );
    expect(out.pct).toBe(100);
    expect(out.components[4]?.value).toBeNull();
  });

  it('weights a shortfall by its component weight', () => {
    // Only the 0.25-weighted first component is half met; the rest are complete.
    const out = computeDataQuality(
      inputs({ linesWithWeight: 5 }),
      DEFAULT_DATA_QUALITY_WEIGHTS
    );
    expect(out.pct).toBeCloseTo(87.5, 6);
  });

  it('honours weights the company changed', () => {
    const weights = {
      LINES_WITH_WEIGHT: 1,
      MASS_WITH_FINAL_DESTINATION: 0,
      MASS_DOCUMENTED_OR_VERIFIED: 0,
      LINES_WITH_SUPPORT: 0,
      AVOIDED_MASS_ON_SPECIFIC_FACTOR: 0,
    };
    const out = computeDataQuality(inputs({ linesWithWeight: 4 }), weights);
    expect(out.pct).toBe(40);
  });

  it('returns null when every applicable weight is zero rather than dividing by it', () => {
    const weights = {
      LINES_WITH_WEIGHT: 0,
      MASS_WITH_FINAL_DESTINATION: 0,
      MASS_DOCUMENTED_OR_VERIFIED: 0,
      LINES_WITH_SUPPORT: 0,
      AVOIDED_MASS_ON_SPECIFIC_FACTOR: 0,
    };
    expect(computeDataQuality(inputs(), weights).pct).toBeNull();
  });

  it('adds only the fifth sentence — Phase 8 already owns the other four', () => {
    const out = computeDataQuality(
      inputs({
        linesWithWeight: 9,
        allocatedKg: 580,
        documentedMassKg: 820,
        linesWithSupport: 7,
        avoidedMassOnSpecificFactorKg: 760,
      }),
      DEFAULT_DATA_QUALITY_WEIGHTS
    );
    // Four components are short, and four of Phase 8's `describeGaps` sentences
    // already say so. Repeating them here would print each gap twice in a
    // client's report, in two different wordings.
    expect(out.warnings).toEqual([
      'Carbon benefit for 240.0 kg uses a generic product factor.',
    ]);
  });

  it('does not restate any of the sentences describeGaps already produces', () => {
    const out = computeDataQuality(
      inputs({ linesWithWeight: 9, documentedMassKg: 820, linesWithSupport: 7, allocatedKg: 580 }),
      DEFAULT_DATA_QUALITY_WEIGHTS
    );
    const phase8Fragments = [
      'no weight recorded',
      'of project weight is estimated',
      'photograph or document',
      'not yet allocated',
      'Final destination for',
    ];
    for (const fragment of phase8Fragments) {
      expect(out.warnings.some((w) => w.includes(fragment))).toBe(false);
    }
  });

  it('still weights all five components even though it narrates one', () => {
    const out = computeDataQuality(inputs({ linesWithWeight: 5 }), DEFAULT_DATA_QUALITY_WEIGHTS);
    expect(out.components).toHaveLength(5);
    expect(out.pct).toBeCloseTo(87.5, 6);
    expect(out.warnings).toEqual([]);
  });

  it('says nothing about a component that is complete or does not apply', () => {
    const out = computeDataQuality(
      inputs({ avoidedMassKg: 0, avoidedMassOnSpecificFactorKg: 0 }),
      DEFAULT_DATA_QUALITY_WEIGHTS
    );
    expect(out.warnings).toEqual([]);
  });
});

describe('describeCarbonGaps — §28.3, §41.1', () => {
  it("writes §28.3's own example sentence", () => {
    const [sentence] = describeCarbonGaps(
      [
        {
          reason: 'NO_FACTOR',
          sourceType: 'ASSET_MOVEMENT',
          sourceId: 'm',
          quantity: 1200,
          unit: 'kg',
          subject: 'plasterboard',
        },
      ],
      { factorSetName: '2027' }
    );
    expect(sentence).toBe(
      'No waste-treatment factor exists for plasterboard in the 2027 factor set — 1.20 t excluded from treatment emissions.'
    );
  });

  it('covers every gap reason with a sentence naming its subject', () => {
    const reasons: readonly CarbonGap['reason'][] = [
      'NO_FACTOR',
      'NO_FACTOR_SET',
      'NO_PRODUCT_FACTOR',
      'GENERIC_NOT_ALLOWED',
      'DISPLACEMENT_UNKNOWN',
      'UNIT_MISMATCH',
      'AMBIGUOUS_FACTOR',
      'NO_MASS',
    ];
    const gaps: CarbonGap[] = reasons.map((reason) => ({
      reason,
      sourceType: 'ASSET_MOVEMENT',
      sourceId: 'm',
      quantity: 30,
      unit: 'items',
      subject: 'Operator chair',
    }));
    const sentences = describeCarbonGaps(gaps);
    expect(sentences).toHaveLength(reasons.length);
    for (const s of sentences) {
      expect(s).toContain('Operator chair');
      expect(s.endsWith('.')).toBe(true);
    }
  });

  it('handles a gap with no recorded quantity', () => {
    const [s] = describeCarbonGaps([
      {
        reason: 'NO_PRODUCT_FACTOR',
        sourceType: 'ASSET_MOVEMENT',
        sourceId: 'm',
        quantity: null,
        unit: null,
        subject: 'Desk',
      },
    ]);
    expect(s).toContain('an unrecorded quantity');
  });

  it('says nothing for an empty list', () => {
    expect(describeCarbonGaps([])).toEqual([]);
  });
});

describe('describeUnclaimedRetainedMass — packet finding 7', () => {
  it('explains retained-in-use mass that displaced nothing', () => {
    expect(describeUnclaimedRetainedMass(8200)).toBe(
      '8.20 t was retained in use by the client; no replacement was displaced, so no avoided-emissions claim is made for it.'
    );
  });

  it('says nothing when there is no such mass', () => {
    expect(describeUnclaimedRetainedMass(0)).toBeNull();
    expect(describeUnclaimedRetainedMass(-1)).toBeNull();
  });
});

describe('display (§28.4, §39, §41.9)', () => {
  it("renders the milestone's headline figures", () => {
    expect(formatCarbonKg(3840)).toBe('3.84 tCO₂e');
    expect(formatCarbonKg(27420)).toBe('27.42 tCO₂e');
  });

  it('switches to kilograms below a tonne, matching formatMassKg', () => {
    expect(formatCarbonKg(840)).toBe('840.0 kgCO₂e');
    expect(formatCarbonKg(999.9)).toBe('999.9 kgCO₂e');
    expect(formatCarbonKg(1000)).toBe('1.00 tCO₂e');
  });

  it('honours a pinned §39 display unit in both directions', () => {
    expect(formatCarbonKg(3840, 'KGCO2E')).toBe('3840.0 kgCO₂e');
    expect(formatCarbonKg(840, 'TCO2E')).toBe('0.84 tCO₂e');
  });

  it('renders a negative figure without losing its sign', () => {
    expect(formatCarbonKg(-1500)).toBe('-1.50 tCO₂e');
  });

  it('renders the completeness score, or an em dash when there was nothing to measure', () => {
    expect(formatCompleteness(92)).toBe('92%');
    expect(formatCompleteness(87.5)).toBe('88%');
    expect(formatCompleteness(null)).toBe('—');
  });
});
