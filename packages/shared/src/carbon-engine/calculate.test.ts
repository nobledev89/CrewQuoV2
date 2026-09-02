import { describe, expect, it } from 'vitest';
import {
  calculateActivityEmissions,
  calculateAvoidedEmissions,
  calculateWasteTreatmentEmissions,
  isValidDisplacementSetting,
  resolveDisplacementPct,
  resolveScope,
} from './calculate';
import { activity, factor, factorSet, movement, productFactor } from './fixtures';
import type { AvoidedInput, DisplacementBasis } from './types';

/**
 * §44: every avoided-emissions path *"including `UNKNOWN` displacement and the
 * no-factor case"*, plus the two silences of packet §0 finding 8 and the
 * regression test finding 1 exists for.
 */

describe('calculateActivityEmissions — §27.3', () => {
  it('multiplies quantity by the factor and cites everything §41.2 requires', () => {
    const out = calculateActivityEmissions(
      activity({ quantity: 240 }),
      factor({ kgCo2ePerUnit: 0.5 }),
      factorSet()
    );
    expect(out.kind).toBe('QUANTIFIED');
    if (out.kind !== 'QUANTIFIED') return;
    expect(out.result.kgCo2e).toBe(120);
    expect(out.result.bucket).toBe('PROJECT_EMISSIONS');
    expect(out.result.method).toBe('ACTIVITY_X_FACTOR');
    // §41.2: activity data → factor → factor version → methodology, all nameable.
    expect(out.result.citation.factorId).toBe('factor-1');
    expect(out.result.citation.factorSetVersion).toBe('v1');
    expect(out.result.citation.factorReportingYear).toBe(2027);
    expect(out.result.citation.methodology).toBe('test methodology');
    expect(out.result.citation.factorKgCo2ePerUnit).toBe(0.5);
  });

  it('converts the entered unit into the factor unit and records both', () => {
    const out = calculateActivityEmissions(
      activity({ quantity: 100, unit: 'mile' }),
      factor({ unit: 'km', kgCo2ePerUnit: 1 }),
      factorSet()
    );
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a figure');
    expect(out.result.quantity).toBeCloseTo(160.9344, 10);
    expect(out.result.kgCo2e).toBeCloseTo(160.9344, 10);
    expect(out.result.inputs.enteredQuantity).toBe(100);
    expect(out.result.inputs.enteredUnit).toBe('mile');
    expect(out.result.unit).toBe('km');
  });

  it('discloses a unit it cannot convert rather than throwing or zeroing', () => {
    const out = calculateActivityEmissions(
      activity({ quantity: 50, unit: 'litre' }),
      factor({ unit: 'km' }),
      factorSet()
    );
    expect(out.kind).toBe('GAP');
    expect(out.kind === 'GAP' && out.gap.reason).toBe('UNIT_MISMATCH');
    expect(out.kind === 'GAP' && out.gap.quantity).toBe(50);
  });

  it('computes WTT separately and does not add it into the headline figure', () => {
    const out = calculateActivityEmissions(
      activity({ quantity: 100 }),
      factor({ kgCo2ePerUnit: 1, wttKgCo2ePerUnit: 0.25 }),
      factorSet()
    );
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a figure');
    expect(out.result.kgCo2e).toBe(100);
    expect(out.result.wttKgCo2e).toBe(25);
  });

  it('leaves wttKgCo2e null when the publisher does not separate it', () => {
    const out = calculateActivityEmissions(activity(), factor(), factorSet());
    expect(out.kind === 'QUANTIFIED' && out.result.wttKgCo2e).toBeNull();
  });

  it('does not round (§41.9)', () => {
    const out = calculateActivityEmissions(
      activity({ quantity: 3 }),
      factor({ kgCo2ePerUnit: 0.3333333 }),
      factorSet()
    );
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a figure');
    expect(out.result.kgCo2e).toBeCloseTo(0.9999999, 12);
    expect(out.result.kgCo2e).not.toBe(1);
  });

  it('carries the activity source through as a confidence and an estimate flag', () => {
    const measured = calculateActivityEmissions(
      activity({ source: 'MEASURED' }),
      factor(),
      factorSet()
    );
    const estimated = calculateActivityEmissions(
      activity({ source: 'ESTIMATED' }),
      factor(),
      factorSet()
    );
    expect(measured.kind === 'QUANTIFIED' && measured.result.confidence).toBe('VERIFIED');
    expect(measured.kind === 'QUANTIFIED' && measured.result.isEstimate).toBe(false);
    expect(estimated.kind === 'QUANTIFIED' && estimated.result.confidence).toBe('ESTIMATED');
    expect(estimated.kind === 'QUANTIFIED' && estimated.result.isEstimate).toBe(true);
  });
});

describe('resolveScope — §27.3, §27.5', () => {
  it("takes the factor's own scope when the publisher stated one", () => {
    expect(resolveScope(activity({ kind: 'ELECTRICITY' }), factor({ scope: 'SCOPE_3' }))).toBe(
      'SCOPE_3'
    );
  });

  it('puts an own vehicle in Scope 1 and a subcontracted one in Scope 3', () => {
    expect(resolveScope(activity({ providerCompanyId: null }), factor())).toBe('SCOPE_1');
    expect(resolveScope(activity({ providerCompanyId: 'co-2' }), factor())).toBe('SCOPE_3');
  });

  it('applies the same rule to fuel and plant', () => {
    for (const kind of ['FUEL', 'PLANT'] as const) {
      expect(resolveScope(activity({ kind, providerCompanyId: null }), factor())).toBe('SCOPE_1');
      expect(resolveScope(activity({ kind, providerCompanyId: 'co-2' }), factor())).toBe('SCOPE_3');
    }
  });

  it('puts purchased electricity in Scope 2 and freight in Scope 3', () => {
    expect(resolveScope(activity({ kind: 'ELECTRICITY' }), factor())).toBe('SCOPE_2');
    expect(resolveScope(activity({ kind: 'FREIGHT' }), factor())).toBe('SCOPE_3');
  });

  it('leaves OTHER unclassified rather than guessing', () => {
    expect(resolveScope(activity({ kind: 'OTHER' }), factor())).toBeNull();
  });
});

describe('calculateWasteTreatmentEmissions — §27.3, finding 8', () => {
  const wasteFactor = factor({ unit: 'tonne', kgCo2ePerUnit: 20, treatment: 'Landfill' });

  it('prices mass against the treatment factor in tonnes', () => {
    const out = calculateWasteTreatmentEmissions(
      movement({ massKg: 500, destination: { ghgTreatmentKey: 'LANDFILL' } }),
      wasteFactor,
      factorSet()
    );
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a figure');
    expect(out.result.quantity).toBe(0.5);
    expect(out.result.kgCo2e).toBe(10);
    expect(out.result.bucket).toBe('WASTE_TREATMENT');
    expect(out.result.method).toBe('MASS_X_TREATMENT_FACTOR');
  });

  it('reports Scope 3 category 5 by default', () => {
    const out = calculateWasteTreatmentEmissions(
      movement({ destination: { ghgTreatmentKey: 'LANDFILL' } }),
      wasteFactor,
      factorSet()
    );
    expect(out.kind === 'QUANTIFIED' && out.result.scope).toBe('SCOPE_3');
    expect(out.kind === 'QUANTIFIED' && out.result.scope3Category).toBe(5);
  });

  // ── The first silence: nothing was treated, so there is nothing to disclose.
  it('is OUT_OF_SCOPE — not a gap — for a destination with no treatment key', () => {
    for (const code of ['RETAINED', 'RELOCATED', 'STORAGE']) {
      const out = calculateWasteTreatmentEmissions(
        movement({ destination: { code, name: code, ghgTreatmentKey: null } }),
        null,
        null
      );
      expect(out.kind).toBe('OUT_OF_SCOPE');
      expect(out.kind === 'OUT_OF_SCOPE' && out.reason).toBe('NOT_A_WASTE_TREATMENT');
    }
  });

  // ── The second silence: in scope, unquantified, and it must be said out loud.
  it('is a disclosable GAP when a treatment applies but no factor exists', () => {
    const out = calculateWasteTreatmentEmissions(
      movement({
        massKg: 1200,
        materialName: 'Plasterboard',
        destination: { ghgTreatmentKey: 'LANDFILL' },
      }),
      null,
      null
    );
    expect(out.kind).toBe('GAP');
    if (out.kind !== 'GAP') return;
    expect(out.gap.reason).toBe('NO_FACTOR');
    expect(out.gap.subject).toBe('Plasterboard');
    expect(out.gap.quantity).toBe(1200);
  });

  it('an absent factor is never a zero (§41.1)', () => {
    const out = calculateWasteTreatmentEmissions(
      movement({ destination: { ghgTreatmentKey: 'LANDFILL' } }),
      null,
      null
    );
    expect(out.kind).not.toBe('QUANTIFIED');
  });

  it('is a gap when the movement has no mass', () => {
    const out = calculateWasteTreatmentEmissions(
      movement({ massKg: null, destination: { ghgTreatmentKey: 'LANDFILL' } }),
      wasteFactor,
      factorSet()
    );
    expect(out.kind === 'GAP' && out.gap.reason).toBe('NO_MASS');
  });

  it('discloses a treatment factor that is not published per tonne', () => {
    const out = calculateWasteTreatmentEmissions(
      movement({ destination: { ghgTreatmentKey: 'LANDFILL' } }),
      factor({ unit: 'km' }),
      factorSet()
    );
    expect(out.kind === 'GAP' && out.gap.reason).toBe('UNIT_MISMATCH');
  });

  it('inherits the weight confidence and marks estimated weights as estimates', () => {
    const out = calculateWasteTreatmentEmissions(
      movement({ weightConfidence: 'ESTIMATED', destination: { ghgTreatmentKey: 'LANDFILL' } }),
      wasteFactor,
      factorSet()
    );
    expect(out.kind === 'QUANTIFIED' && out.result.confidence).toBe('ESTIMATED');
    expect(out.kind === 'QUANTIFIED' && out.result.isEstimate).toBe(true);
  });
});

describe('resolveDisplacementPct — §27.4 and packet finding 1', () => {
  it('produces no percentage at all for UNKNOWN', () => {
    expect(resolveDisplacementPct('UNKNOWN', null)).toBeNull();
  });

  it('never falls back to 100 for UNKNOWN, even when a percentage is present', () => {
    // The one substitution the 2026-08-18 owner decision forbids.
    expect(resolveDisplacementPct('UNKNOWN', 80)).toBeNull();
  });

  it('reads ASSUMED_FULL as 100 and USER_DEFINED as what was stated', () => {
    expect(resolveDisplacementPct('ASSUMED_FULL', null)).toBe(100);
    expect(resolveDisplacementPct('USER_DEFINED', 80)).toBe(80);
    expect(resolveDisplacementPct('USER_DEFINED', 0)).toBe(0);
  });

  it('declines rather than assuming when USER_DEFINED carries no percentage', () => {
    expect(resolveDisplacementPct('USER_DEFINED', null)).toBeNull();
  });

  it('mirrors the 9.1 check constraint: a pct exists exactly when the basis is USER_DEFINED', () => {
    const cases: readonly (readonly [DisplacementBasis, number | null, boolean])[] = [
      ['UNKNOWN', null, true],
      ['UNKNOWN', 80, false],
      ['ASSUMED_FULL', null, true],
      ['ASSUMED_FULL', 100, false],
      ['USER_DEFINED', 80, true],
      ['USER_DEFINED', null, false],
    ];
    for (const [basis, pct, valid] of cases) {
      expect(isValidDisplacementSetting(basis, pct)).toBe(valid);
    }
  });
});

describe('calculateAvoidedEmissions — §27.4', () => {
  function avoidedInput(overrides: Partial<AvoidedInput> = {}): AvoidedInput {
    return {
      movement: movement(),
      factor: productFactor(),
      basis: 'USER_DEFINED',
      displacementPct: 80,
      enablingKgCo2e: 0,
      baselineScenario: 'equivalent new operator chair manufactured',
      alternativeScenario: 'existing chair cleaned and redeployed',
      assumptions: 'test',
      methodology: 'test methodology',
      uncertainty: null,
      ...overrides,
    };
  }

  it("reproduces §27.4's worked example", () => {
    // 100 chairs × 80% × 75 kgCO₂e = 6,000; minus 340 enabling = 5,660.
    const out = calculateAvoidedEmissions(
      avoidedInput({
        movement: movement({ quantity: 100 }),
        factor: productFactor({ kgCo2ePerItem: 75 }),
        displacementPct: 80,
        enablingKgCo2e: 340,
      })
    );
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a claim');
    expect(out.claim.baselineKgCo2e).toBe(6000);
    expect(out.claim.enablingKgCo2e).toBe(340);
    expect(out.claim.netAvoidedKgCo2e).toBe(5660);
    expect(out.result.kgCo2e).toBe(5660);
    expect(out.result.bucket).toBe('AVOIDED');
  });

  // ── Packet finding 1's regression test. If a migration ever restores
  // `default 100`, the settings row changes but this stays true, and the
  // acceptance script's step 6 is what catches the row.
  it('makes NO CLAIM when the displacement basis is UNKNOWN', () => {
    const out = calculateAvoidedEmissions(avoidedInput({ basis: 'UNKNOWN', displacementPct: null }));
    expect(out.kind).toBe('GAP');
    expect(out.kind === 'GAP' && out.gap.reason).toBe('DISPLACEMENT_UNKNOWN');
  });

  it('does not silently treat UNKNOWN as 100%', () => {
    const unknown = calculateAvoidedEmissions(
      avoidedInput({ basis: 'UNKNOWN', displacementPct: null })
    );
    const full = calculateAvoidedEmissions(avoidedInput({ basis: 'ASSUMED_FULL', displacementPct: null }));
    expect(unknown.kind).toBe('GAP');
    expect(full.kind).toBe('QUANTIFIED');
  });

  it('records the basis and percentage on the claim (§27.4)', () => {
    const out = calculateAvoidedEmissions(avoidedInput({ basis: 'ASSUMED_FULL', displacementPct: null }));
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a claim');
    expect(out.claim.displacementBasis).toBe('ASSUMED_FULL');
    expect(out.claim.displacementPct).toBe(100);
    expect(out.claim.baselineScenario).toBe('equivalent new operator chair manufactured');
    expect(out.claim.alternativeScenario).toBe('existing chair cleaned and redeployed');
    expect(out.claim.systemBoundary).toBe('A1_A3');
    expect(out.claim.methodology).toBe('test methodology');
  });

  // ── Packet finding 7: RETAINED counts as retained-in-use and displaces nothing.
  it('is OUT_OF_SCOPE for a destination that displaces no replacement', () => {
    const out = calculateAvoidedEmissions(
      avoidedInput({
        movement: movement({
          destination: { code: 'RETAINED', name: 'Retained by client', displacesReplacement: false },
        }),
      })
    );
    expect(out.kind).toBe('OUT_OF_SCOPE');
    expect(out.kind === 'OUT_OF_SCOPE' && out.reason).toBe('NO_REPLACEMENT_DISPLACED');
  });

  it('prices a per-kg factor off the movement mass', () => {
    const out = calculateAvoidedEmissions(
      avoidedInput({
        movement: movement({ massKg: 200 }),
        factor: productFactor({ kgCo2ePerItem: null, kgCo2ePerKg: 3 }),
        basis: 'ASSUMED_FULL',
        displacementPct: null,
      })
    );
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a claim');
    expect(out.claim.baselineKgCo2e).toBe(600);
    expect(out.result.unit).toBe('kg');
  });

  it('is a gap when a per-kg factor meets a movement with no mass', () => {
    const out = calculateAvoidedEmissions(
      avoidedInput({
        movement: movement({ massKg: null }),
        factor: productFactor({ kgCo2ePerItem: null, kgCo2ePerKg: 3 }),
      })
    );
    expect(out.kind === 'GAP' && out.gap.reason).toBe('NO_MASS');
  });

  it('is a gap when a factor carries neither rate', () => {
    const out = calculateAvoidedEmissions(
      avoidedInput({ factor: productFactor({ kgCo2ePerItem: null, kgCo2ePerKg: null }) })
    );
    expect(out.kind === 'GAP' && out.gap.reason).toBe('NO_PRODUCT_FACTOR');
  });

  it('reports a net-negative claim rather than clamping it at zero', () => {
    const out = calculateAvoidedEmissions(
      avoidedInput({
        movement: movement({ quantity: 1 }),
        factor: productFactor({ kgCo2ePerItem: 10 }),
        basis: 'ASSUMED_FULL',
        displacementPct: null,
        enablingKgCo2e: 40,
      })
    );
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a claim');
    expect(out.claim.netAvoidedKgCo2e).toBe(-30);
  });

  it('carries no scope, because avoided emissions are in no inventory (§27.4)', () => {
    const out = calculateAvoidedEmissions(avoidedInput());
    expect(out.kind === 'QUANTIFIED' && out.result.scope).toBeNull();
    expect(out.kind === 'QUANTIFIED' && out.result.scope3Category).toBeNull();
  });

  it('flags a generic factor on the result so the report can say so', () => {
    const out = calculateAvoidedEmissions(
      avoidedInput({ factor: productFactor({ verificationStatus: 'GENERIC_ESTIMATE', isEstimate: true }) })
    );
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a claim');
    expect(out.result.inputs.isGenericFactor).toBe(true);
    expect(out.result.isEstimate).toBe(true);
  });

  it('cites the product factor rather than a factor set', () => {
    const out = calculateAvoidedEmissions(avoidedInput());
    if (out.kind !== 'QUANTIFIED') throw new Error('expected a claim');
    expect(out.result.citation.productFactorId).toBe('pf-1');
    expect(out.result.citation.factorSetId).toBeNull();
    expect(out.result.citation.factorSetName).toBe('Test source');
    expect(out.result.citation.factorSetVersion).toBe('EPD_VERIFIED');
  });

  it('a zero percentage is a stated assumption and produces a zero claim, not a gap', () => {
    const out = calculateAvoidedEmissions(avoidedInput({ displacementPct: 0 }));
    expect(out.kind).toBe('QUANTIFIED');
    expect(out.kind === 'QUANTIFIED' && out.claim.netAvoidedKgCo2e).toBe(0);
  });
});
