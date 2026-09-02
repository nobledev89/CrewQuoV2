import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { guessColumnMapping, mapFactorRows } from '@crewquo/shared';
import { readTable } from './spreadsheet';

/**
 * The XLSX half of the importer (`sustainability.md` §10).
 *
 * The acceptance script exercises CSV end to end, which leaves this path shipped
 * and unproved — and it is the half with the interesting failure modes: a zip that
 * expands to more than it claims, a formula cell whose text is not its value, and a
 * gap in the header row that silently shifts every column after it.
 *
 * Tests rather than an e2e case because building a workbook in memory is the only
 * way to construct those states deliberately. A fixture checked into the repo would
 * be a binary nobody can read in a diff.
 */

async function workbook(
  rows: (string | number | null)[][],
  opts: { sheetName?: string; formulaAt?: [number, number, string, string | number | undefined] } = {}
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(opts.sheetName ?? 'Factors');
  rows.forEach((row) => sheet.addRow(row));
  if (opts.formulaAt) {
    const [r, c, formula, result] = opts.formulaAt;
    sheet.getRow(r).getCell(c).value = { formula, result } as ExcelJS.CellFormulaValue;
  }
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

const HEADERS = ['Category', 'Activity', 'Unit', 'kg CO2e'];

describe('readTable — XLSX', () => {
  it('reads headers and rows out of a workbook', async () => {
    const content = await workbook([HEADERS, ['Waste', 'Recycling', 'tonne', 21.28]]);
    const table = await readTable({ content, format: 'XLSX' });

    expect(table.headers).toEqual(HEADERS);
    expect(table.rows).toEqual([
      { Category: 'Waste', Activity: 'Recycling', Unit: 'tonne', 'kg CO2e': '21.28' },
    ]);
    expect(table.sheetNames).toEqual(['Factors']);
  });

  it('feeds the mapper the same shape a CSV does', async () => {
    // The property that matters: one parser downstream of two readers. If XLSX
    // produced a different shape, every mapping rule would need a second
    // implementation and the two would disagree on the first blank cell.
    const content = await workbook([HEADERS, ['Waste', 'Recycling', 'tonne', 21.28]]);
    const table = await readTable({ content, format: 'XLSX' });
    const mapped = mapFactorRows(table, guessColumnMapping(table.headers));

    expect(mapped.failures).toEqual([]);
    expect(mapped.rows[0]).toMatchObject({ unit: 'tonne', kgCo2ePerUnit: 21.28 });
  });

  it('reads a formula cell as its cached VALUE and never evaluates it', async () => {
    /*
     * §10: "Formulas are never evaluated. Cell values only. A spreadsheet parser
     * that evaluates is a code-execution surface, and the values are what the
     * publisher published anyway." The cached result is exactly what the
     * publisher's own tool computed and saved.
     */
    const content = await workbook([HEADERS, ['Waste', 'Recycling', 'tonne', null]], {
      formulaAt: [2, 4, 'B2*1000', 21.28],
    });
    const table = await readTable({ content, format: 'XLSX' });
    expect(table.rows[0]?.['kg CO2e']).toBe('21.28');
    expect(table.rows[0]?.['kg CO2e']).not.toContain('B2');
  });

  it('reads a formula with no cached result as EMPTY, not as its own text', async () => {
    // Importing `=B2*1000` as a factor would be a string where a number belongs;
    // importing it as a category would be worse. A blank is a row somebody has to
    // look at, which is the correct outcome.
    const content = await workbook([HEADERS, ['Waste', 'Recycling', 'tonne', null]], {
      formulaAt: [2, 4, 'B2*1000', undefined],
    });
    const table = await readTable({ content, format: 'XLSX' });
    expect(table.rows[0]?.['kg CO2e']).toBe('');

    const mapped = mapFactorRows(table, guessColumnMapping(table.headers));
    expect(mapped.failures[0]?.message).toBe('Emission factor is empty');
  });

  it('names an unnamed header column by position rather than compacting it', async () => {
    // A gap in the header row is a real column with no name. Dropping it would shift
    // every column after it by one — the mapping would then be silently wrong rather
    // than visibly unmapped.
    const content = await workbook([['Category', '', 'Unit'], ['Waste', 'x', 'tonne']]);
    const table = await readTable({ content, format: 'XLSX' });
    expect(table.headers).toEqual(['Category', 'Column 2', 'Unit']);
    expect(table.rows[0]).toEqual({ Category: 'Waste', 'Column 2': 'x', Unit: 'tonne' });
  });

  it('reads a named sheet, and refuses one that is not there by name', async () => {
    const content = await workbook([HEADERS, ['Waste', 'Recycling', 'tonne', 21.28]], {
      sheetName: 'GHG factors',
    });
    await expect(readTable({ content, format: 'XLSX', sheetName: 'GHG factors' })).resolves
      .toBeTruthy();
    await expect(readTable({ content, format: 'XLSX', sheetName: 'Nope' })).rejects.toThrow(
      /no sheet named/
    );
  });

  it('skips rows that are entirely empty rather than reporting them as failures', async () => {
    const content = await workbook([
      HEADERS,
      ['Waste', 'Recycling', 'tonne', 21.28],
      [null, null, null, null],
      ['Fuels', 'Diesel', 'litre', 2.5],
    ]);
    const table = await readTable({ content, format: 'XLSX' });
    expect(table.rows).toHaveLength(2);
  });

  it('refuses a file that is not a workbook at all', async () => {
    await expect(
      readTable({ content: Buffer.from('not a zip').toString('base64'), format: 'XLSX' })
    ).rejects.toThrow(/not a readable .xlsx workbook/);
  });

  it('refuses an empty payload', async () => {
    await expect(readTable({ content: '', format: 'CSV' })).rejects.toThrow();
  });
});

describe('readTable — CSV', () => {
  it('strips a UTF-8 BOM so the first column is still mappable', async () => {
    const table = await readTable({
      content: '﻿Category,Unit\nWaste,tonne',
      format: 'CSV',
    });
    expect(table.headers[0]).toBe('Category');
    expect(table.sheetNames).toEqual([]);
  });
});
