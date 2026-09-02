import type { FactorUnit, UnitDimension } from './types';

/**
 * Unit conversion (§26.1, §44).
 *
 * **Conversion only ever happens within one dimension**, and a request to cross
 * dimensions returns null rather than throwing. That is not politeness: a litre
 * of diesel against a per-km factor is a data problem the report has to
 * *disclose* (§41.1), and an exception would make it a 500 instead.
 *
 * §41.9 — nothing here rounds. `1 mile` becomes `1.609344 km` and stays that
 * wide until something formats it.
 */

export const UNIT_DIMENSIONS: Readonly<Record<FactorUnit, UnitDimension>> = {
  km: 'DISTANCE',
  mile: 'DISTANCE',
  litre: 'VOLUME',
  kWh: 'ENERGY',
  tonne: 'MASS',
  'tonne.km': 'MASS_DISTANCE',
};

/**
 * Conversion to each dimension's base unit.
 *
 * `1 mile = 1.609344 km` **exactly** — the international mile has been defined
 * as 1609.344 mm since 1959, so this is a definition rather than a measurement
 * and does not belong to a factor set or a publisher.
 */
const TO_BASE: Readonly<Record<FactorUnit, number>> = {
  km: 1,
  mile: 1.609344,
  litre: 1,
  kWh: 1,
  tonne: 1,
  'tonne.km': 1,
};

/** Kilograms per tonne. Masses are stored in kg (§25.3); waste factors are per tonne. */
export const KG_PER_TONNE = 1000;

export function dimensionOf(unit: FactorUnit): UnitDimension {
  return UNIT_DIMENSIONS[unit];
}

export function isConvertible(from: FactorUnit, to: FactorUnit): boolean {
  return dimensionOf(from) === dimensionOf(to);
}

/**
 * Convert a quantity between two units of the same dimension.
 *
 * Returns **null** when the dimensions differ — the caller turns that into a
 * `UNIT_MISMATCH` gap, which is disclosed rather than raised.
 */
export function convertQuantity(
  value: number,
  from: FactorUnit,
  to: FactorUnit
): number | null {
  if (!isConvertible(from, to)) return null;
  if (from === to) return value;
  return (value * TO_BASE[from]) / TO_BASE[to];
}

/**
 * Kilograms to tonnes. Its own function rather than a `convertQuantity` call
 * because `kg` is deliberately **not** a `FactorUnit` (§26.1 lists six units and
 * kg is not one of them) — masses arrive from `asset_movements` in kg and meet a
 * factor expressed per tonne, and this is the single place that step happens.
 */
export function kgToTonnes(kg: number): number {
  return kg / KG_PER_TONNE;
}
