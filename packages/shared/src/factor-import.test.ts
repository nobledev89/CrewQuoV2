import { describe, expect, it } from 'vitest';
import {
  MAX_CELL_LENGTH,
  buildImportDiff,
  escapeForSpreadsheet,
  factorIdentity,
  factorImportSchema,
  guessColumnMapping,
  importRefusal,
  mapFactorRows,
  normaliseUnit,
  parseDelimited,
  type ColumnMapping,
} from './factor-import';

/**
 * The importer's pure half (§26.2, `sustainability.md` §9).
 *
 * The bar here is the one §44 sets for the engine and for the same reason: this
 * code turns a publisher's spreadsheet into thousands of rows that a client's
 * annual report is eventually computed from, and every one of its failure modes
 * is silent. A mis-mapped column produces a plausible number; a coerced unit
 * produces one that is out by a factor of a thousand; a partially imported set
 * produces gaps a client is told about that do not exist.
 */

const HEADERS = 'Category,Activity,Material,Treatment,Unit,kg CO2e,WTT\n';

function csv(...rows: string[]): string {
  return HEADERS + rows.join('\n');
}

const MAPPING: ColumnMapping = {
  category: 'Category',
  activity: 'Activity',
  material: 'Material',
  treatment: 'Treatment',
  unit: 'Unit',
  kgCo2ePerUnit: 'kg CO2e',
  wttKgCo2ePerUnit: 'WTT',
};

describe('parseDelimited', () => {
  it('reads headers and rows', () => {
    const t = parseDelimited(csv('Waste,Recycling,Wood,Closed-loop,tonne,21.28,'));
    expect(t.headers).toEqual(['Category', 'Activity', 'Material', 'Treatment', 'Unit', 'kg CO2e', 'WTT']);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]?.['kg CO2e']).toBe('21.28');
  });

  it('handles quoted fields containing the delimiter', () => {
    const t = parseDelimited('a,b\n"one, two",three');
    expect(t.rows[0]).toEqual({ a: 'one, two', b: 'three' });
  });

  it('handles escaped quotes inside a quoted field', () => {
    const t = parseDelimited('a\n"say ""hi"""');
    expect(t.rows[0]?.a).toBe('say "hi"');
  });

  it('strips a UTF-8 BOM, which would otherwise make the first column unmappable', () => {
    const t = parseDelimited('﻿Category,Unit\nWaste,tonne');
    expect(t.headers[0]).toBe('Category');
    expect(guessColumnMapping(t.headers).category).toBe('Category');
  });

  it('drops blank lines rather than reporting them as failed rows', () => {
    const t = parseDelimited('a,b\n1,2\n\n3,4\n');
    expect(t.rows).toHaveLength(2);
  });

  it('reads CRLF the way Excel writes it', () => {
    const t = parseDelimited('a,b\r\n1,2\r\n');
    expect(t.rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('leaves a short row short rather than shifting later columns into it', () => {
    // The failure this prevents: a row missing its trailing WTT column silently
    // taking the next row's first cell, which parses as a number and imports.
    const t = parseDelimited('a,b,c\n1,2');
    expect(t.rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });
});

describe('guessColumnMapping', () => {
  it('matches on an exact alias, ignoring case and punctuation', () => {
    const m = guessColumnMapping(['GHG Conversion Factor', 'UOM', 'Level 1', 'Level 2']);
    expect(m.kgCo2ePerUnit).toBe('GHG Conversion Factor');
    expect(m.unit).toBe('UOM');
    expect(m.category).toBe('Level 1');
    expect(m.activity).toBe('Level 2');
  });

  it('guesses nothing it is not sure of, rather than reaching', () => {
    // "Emissions coefficient" is obviously the factor to a human and matches no
    // alias. A fuzzy matcher would map it; the mapping UI exists because that
    // guess is the one that silently imports the wrong column.
    expect(guessColumnMapping(['Emissions coefficient']).kgCo2ePerUnit).toBeUndefined();
  });

  it('never assigns one column to two fields', () => {
    // 'Source' is an alias of sourceReference only. If both matched, the earlier
    // field would win and the later one would silently be unmapped.
    const m = guessColumnMapping(['Source']);
    const used = Object.values(m);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('normaliseUnit', () => {
  it('accepts the six exactly', () => {
    expect(normaliseUnit('kWh')).toBe('kWh');
    expect(normaliseUnit('tonne.km')).toBe('tonne.km');
  });

  it('accepts the spellings publishers actually use', () => {
    expect(normaliseUnit('litres')).toBe('litre');
    expect(normaliseUnit('Kilometres')).toBe('km');
    expect(normaliseUnit('t.km')).toBe('tonne.km');
    expect(normaliseUnit('tonnes')).toBe('tonne');
  });

  it('refuses anything else rather than picking the nearest', () => {
    // 'kg' is a mass and 'tonne' is a mass, and coercing one to the other is a
    // thousand-fold error in a published figure.
    expect(normaliseUnit('kg')).toBeNull();
    expect(normaliseUnit('m3')).toBeNull();
    expect(normaliseUnit('')).toBeNull();
  });
});

describe('mapFactorRows', () => {
  it('maps a clean file', () => {
    const mapped = mapFactorRows(
      parseDelimited(csv('Waste,Recycling,Wood,Closed-loop,tonne,21.28,0.5')),
      MAPPING
    );
    expect(mapped.failures).toEqual([]);
    expect(mapped.rows).toHaveLength(1);
    expect(mapped.rows[0]).toMatchObject({
      rowNumber: 2,
      category: 'Waste',
      activity: 'Recycling',
      material: 'Wood',
      treatment: 'Closed-loop',
      unit: 'tonne',
      kgCo2ePerUnit: 21.28,
      wttKgCo2ePerUnit: 0.5,
    });
    expect(mapped.countsByCategory).toEqual({ Waste: 1 });
    expect(mapped.units).toEqual(['tonne']);
  });

  it('numbers rows the way Excel does, so a failure names the row somebody can open', () => {
    const mapped = mapFactorRows(
      parseDelimited(csv('Waste,Recycling,Wood,Closed-loop,tonne,21.28,', 'Waste,,Wood,,tonne,3,')),
      MAPPING
    );
    // Header is row 1, first data row is row 2, so the bad second data row is 3.
    expect(mapped.failures[0]?.row).toBe(3);
  });

  it('accepts a zero factor and refuses a negative one', () => {
    const zero = mapFactorRows(parseDelimited(csv('Waste,Reuse,Wood,Re-use,tonne,0,')), MAPPING);
    expect(zero.failures).toEqual([]);
    expect(zero.rows[0]?.kgCo2ePerUnit).toBe(0);

    const negative = mapFactorRows(parseDelimited(csv('Waste,Reuse,Wood,Re-use,tonne,-3,')), MAPPING);
    expect(negative.failures[0]?.message).toContain('negative');
  });

  it('treats a blank optional number as null, never as zero', () => {
    const mapped = mapFactorRows(parseDelimited(csv('Waste,Recycling,Wood,Closed-loop,tonne,21.28,')), MAPPING);
    // A zero here would claim the publisher separated WTT and found it to be nil.
    expect(mapped.rows[0]?.wttKgCo2ePerUnit).toBeNull();
  });

  it('strips thousands separators, because publishers use them', () => {
    const mapped = mapFactorRows(parseDelimited(csv('Fuels,Diesel,,,litre,"2,689",')), MAPPING);
    expect(mapped.rows[0]?.kgCo2ePerUnit).toBe(2689);
  });

  it('collects every failure rather than stopping at the first', () => {
    const mapped = mapFactorRows(
      parseDelimited(
        csv('Waste,,Wood,,tonne,3,', 'Waste,Recycling,Wood,,gallons,3,', 'Waste,Recycling,Wood,,tonne,abc,')
      ),
      MAPPING
    );
    // One round trip fixes a file with three bad rows in it.
    expect(mapped.failures).toHaveLength(3);
    expect(mapped.rows).toHaveLength(0);
  });

  it('names the accepted units when one is not recognised', () => {
    const mapped = mapFactorRows(parseDelimited(csv('Waste,Recycling,Wood,,gallons,3,')), MAPPING);
    expect(mapped.failures[0]?.value).toBe('gallons');
    expect(mapped.failures[0]?.message).toContain('tonne.km');
  });

  it('fails the whole file when a required column is unmapped, and says which', () => {
    const mapped = mapFactorRows(parseDelimited(csv('Waste,Recycling,Wood,,tonne,3,')), {
      ...MAPPING,
      unit: undefined,
    });
    expect(mapped.failures).toEqual([
      { row: 1, column: 'unit', value: null, message: 'No column is mapped to unit' },
    ]);
  });

  it('fails when a mapped column is not in the file at all', () => {
    const mapped = mapFactorRows(parseDelimited(csv('Waste,Recycling,Wood,,tonne,3,')), {
      ...MAPPING,
      unit: 'Units of measure',
    });
    expect(mapped.failures[0]?.message).toContain('Units of measure');
  });

  it('refuses an oversized cell before it becomes a row', () => {
    const mapped = mapFactorRows(
      parseDelimited(csv(`Waste,Recycling,${'x'.repeat(MAX_CELL_LENGTH + 1)},,tonne,3,`)),
      MAPPING
    );
    expect(mapped.failures[0]?.message).toContain('longer than');
  });

  it('normalises a scope spelled the way a workbook spells it', () => {
    const table = parseDelimited('Category,Activity,Unit,kg CO2e,Scope\nFuels,Diesel,litre,2.5,Scope 1');
    const mapped = mapFactorRows(table, {
      category: 'Category', activity: 'Activity', unit: 'Unit', kgCo2ePerUnit: 'kg CO2e', scope: 'Scope',
    });
    expect(mapped.rows[0]?.scope).toBe('SCOPE_1');
  });

  it('refuses a scope it cannot recognise rather than dropping it', () => {
    const table = parseDelimited('Category,Activity,Unit,kg CO2e,Scope\nFuels,Diesel,litre,2.5,upstream');
    const mapped = mapFactorRows(table, {
      category: 'Category', activity: 'Activity', unit: 'Unit', kgCo2ePerUnit: 'kg CO2e', scope: 'Scope',
    });
    // Dropping it would file an upstream factor as unclassified, which reads as
    // "the publisher did not say" when the publisher did.
    expect(mapped.failures[0]?.value).toBe('upstream');
  });
});

describe('the dry-run diff (§26.2)', () => {
  it('reports what would be added, by category', () => {
    const mapped = mapFactorRows(
      parseDelimited(
        csv('Waste,Recycling,Wood,Closed-loop,tonne,21.28,', 'Fuels,Diesel,,,litre,2.51,0.6')
      ),
      MAPPING
    );
    const diff = buildImportDiff(mapped, { setExists: false });
    expect(diff.toAdd).toBe(2);
    expect(diff.countsByCategory).toEqual({ Waste: 1, Fuels: 1 });
    expect(diff.units).toEqual(['litre', 'tonne']);
    expect(importRefusal(diff)).toBeNull();
  });

  it('finds rows that duplicate each other on the identity resolveFactor matches', () => {
    const mapped = mapFactorRows(
      parseDelimited(
        csv('Waste,Recycling,Wood,Closed-loop,tonne,21.28,', 'Waste,Recycling,Wood,Closed-loop,tonne,19.90,')
      ),
      MAPPING
    );
    const diff = buildImportDiff(mapped, { setExists: false });
    expect(diff.duplicateRows).toEqual([
      { rowNumber: 3, duplicateOfRow: 2, identity: 'Waste · Recycling · Wood · Closed-loop' },
    ]);
    // Not deduplicated: resolveFactor would answer AMBIGUOUS for that query
    // forever after, producing a disclosed gap on a factor that is in the set.
    expect(importRefusal(diff)?.code).toBe('DUPLICATE_ROWS');
  });

  it('does not call two rows duplicates when a discriminator differs', () => {
    const mapped = mapFactorRows(
      parseDelimited(
        csv('Waste,Recycling,Wood,Closed-loop,tonne,21.28,', 'Waste,Recycling,Plasterboard,Closed-loop,tonne,71.6,')
      ),
      MAPPING
    );
    expect(buildImportDiff(mapped, { setExists: false }).duplicateRows).toEqual([]);
  });

  it('refuses a duplicate set by name and version before it looks at rows', () => {
    const mapped = mapFactorRows(parseDelimited(csv('Waste,Recycling,Wood,,tonne,21.28,')), MAPPING);
    expect(importRefusal(buildImportDiff(mapped, { setExists: true }))?.code).toBe('SET_ALREADY_EXISTS');
  });

  it('refuses a file with no rows in it', () => {
    const mapped = mapFactorRows(parseDelimited(HEADERS), MAPPING);
    expect(importRefusal(buildImportDiff(mapped, { setExists: false }))?.code).toBe('NO_ROWS');
  });

  it('quotes the first failure with its row, column and value', () => {
    const mapped = mapFactorRows(
      parseDelimited(csv('Waste,Recycling,Wood,,gallons,3,', 'Waste,,Wood,,tonne,3,')),
      MAPPING
    );
    const refusal = importRefusal(buildImportDiff(mapped, { setExists: false }));
    expect(refusal?.code).toBe('INVALID_ROWS');
    expect(refusal?.message).toContain('Row 2');
    expect(refusal?.message).toContain('gallons');
    expect(refusal?.message).toContain('1 other problem');
  });
});

describe('factorIdentity', () => {
  it('ignores case and surrounding space, because a workbook does not', () => {
    const a = { category: 'Waste', activity: 'Recycling', material: 'Wood', treatment: null, vehicleType: null, fuelType: null, unit: 'tonne' };
    const b = { ...a, category: ' waste ', activity: 'RECYCLING' };
    expect(factorIdentity(a)).toBe(factorIdentity(b));
  });

  it('separates a null discriminator from an empty one only where it should', () => {
    const withMaterial = { category: 'W', activity: 'R', material: 'Wood', treatment: null, vehicleType: null, fuelType: null, unit: 'tonne' };
    const without = { ...withMaterial, material: null };
    expect(factorIdentity(withMaterial)).not.toBe(factorIdentity(without));
  });
});

describe('escapeForSpreadsheet (§10)', () => {
  it('prefixes the four leading characters Excel treats as a formula', () => {
    expect(escapeForSpreadsheet('=1+1')).toBe("'=1+1");
    expect(escapeForSpreadsheet('+cmd')).toBe("'+cmd");
    expect(escapeForSpreadsheet('-2+3')).toBe("'-2+3");
    expect(escapeForSpreadsheet('@SUM')).toBe("'@SUM");
  });

  it('prefixes a leading negative number too, and that is deliberate', () => {
    // Telling '-2' apart from '-2+3' is exactly the cleverness that ships a hole.
    // An auditor reading '-2 in a cell has lost nothing.
    expect(escapeForSpreadsheet('-2')).toBe("'-2");
  });

  it('leaves ordinary text alone', () => {
    expect(escapeForSpreadsheet('Recycling')).toBe('Recycling');
    expect(escapeForSpreadsheet('21.28')).toBe('21.28');
  });
});

describe('factorImportSchema', () => {
  const base = {
    format: 'CSV' as const,
    content: 'a\n1',
    mapping: MAPPING,
    set: {
      name: 'CrewQuo Test Factors 2027',
      sourceOrganisation: 'CrewQuo — synthetic test data',
      reportingYear: 2027,
      version: 'v1.0',
      validFrom: '2027-01-01',
      region: 'GB',
    },
  };

  it('defaults to a dry run, because the write is the direction that has to be asked for', () => {
    expect(factorImportSchema.parse(base).dryRun).toBe(true);
  });

  it('refuses a mapping naming a field that does not exist', () => {
    const result = factorImportSchema.safeParse({
      ...base,
      mapping: { ...MAPPING, nonsense: 'X' },
    });
    expect(result.success).toBe(false);
  });

  it('refuses a reporting year outside the range a factor set can have', () => {
    expect(factorImportSchema.safeParse({ ...base, set: { ...base.set, reportingYear: 27 } }).success).toBe(false);
  });
});
