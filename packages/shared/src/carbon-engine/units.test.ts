import { describe, expect, it } from 'vitest';
import { FACTOR_UNITS, type FactorUnit } from './types';
import { KG_PER_TONNE, convertQuantity, dimensionOf, isConvertible, kgToTonnes } from './units';

/** §44: "every unit conversion". Six units, so all 36 ordered pairs are covered. */
describe('unit conversion', () => {
  it('is the identity within a unit', () => {
    for (const u of FACTOR_UNITS) {
      expect(convertQuantity(42.5, u, u)).toBe(42.5);
    }
  });

  it('converts miles to kilometres by the 1959 definition, exactly', () => {
    expect(convertQuantity(1, 'mile', 'km')).toBe(1.609344);
    expect(convertQuantity(100, 'mile', 'km')).toBeCloseTo(160.9344, 10);
  });

  it('converts kilometres to miles as the exact inverse', () => {
    expect(convertQuantity(1.609344, 'km', 'mile')).toBeCloseTo(1, 12);
  });

  it('round-trips a distance without drift worth reporting', () => {
    const there = convertQuantity(237.4, 'km', 'mile');
    expect(there).not.toBeNull();
    expect(convertQuantity(there as number, 'mile', 'km')).toBeCloseTo(237.4, 10);
  });

  it('refuses every cross-dimension pair rather than throwing', () => {
    const pairs: readonly (readonly [FactorUnit, FactorUnit])[] = [
      ['km', 'litre'],
      ['litre', 'kWh'],
      ['kWh', 'tonne'],
      ['tonne', 'tonne.km'],
      ['tonne.km', 'km'],
      ['mile', 'kWh'],
    ];
    for (const [from, to] of pairs) {
      expect(convertQuantity(1, from, to)).toBeNull();
      expect(convertQuantity(1, to, from)).toBeNull();
      expect(isConvertible(from, to)).toBe(false);
    }
  });

  it('covers all 36 ordered pairs: convertible exactly when the dimensions agree', () => {
    let convertible = 0;
    for (const from of FACTOR_UNITS) {
      for (const to of FACTOR_UNITS) {
        const same = dimensionOf(from) === dimensionOf(to);
        expect(isConvertible(from, to)).toBe(same);
        expect(convertQuantity(1, from, to) === null).toBe(!same);
        if (same) convertible += 1;
      }
    }
    // km/mile are the only pair sharing a dimension: 4 distance combinations
    // plus one each for litre, kWh, tonne and tonne.km.
    expect(convertible).toBe(8);
  });

  it('preserves sign and zero', () => {
    expect(convertQuantity(0, 'mile', 'km')).toBe(0);
    expect(convertQuantity(-10, 'mile', 'km')).toBeCloseTo(-16.09344, 10);
  });

  it('does not round mid-calculation (§41.9)', () => {
    // One metre in miles is a long decimal; nothing truncates it.
    const miles = convertQuantity(0.001, 'km', 'mile');
    expect(miles).not.toBeNull();
    expect(miles as number).toBeGreaterThan(0.0006213);
    expect(String(miles as number).length).toBeGreaterThan(6);
  });
});

describe('kgToTonnes', () => {
  it('divides by exactly one thousand', () => {
    expect(KG_PER_TONNE).toBe(1000);
    expect(kgToTonnes(1000)).toBe(1);
    expect(kgToTonnes(933)).toBe(0.933);
    expect(kgToTonnes(0)).toBe(0);
  });

  it('keeps full precision for a mass that does not divide evenly', () => {
    expect(kgToTonnes(1)).toBe(0.001);
    expect(kgToTonnes(12.345)).toBeCloseTo(0.012345, 12);
  });
});
