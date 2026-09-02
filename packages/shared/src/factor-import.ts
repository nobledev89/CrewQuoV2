import { z } from 'zod';
import { FACTOR_UNITS, factorUnitSchema, ghgScopeSchema, type FactorUnit } from './carbon-engine';

/**
 * The factor importer's pure half (CREWQUO_V2_PLAN.md §26.2) — step 2 of the
 * Phase 9 build order.
 *
 * **This is where the importer's correctness lives**, for the reason §27.1 gives
 * about the engine and `assets.ts` gives about masses: parsing a publisher's
 * workbook is the largest upload surface in the product after evidence, it turns a
 * spreadsheet into thousands of rows that a client's annual report is eventually
 * computed from, and it must be testable without a server, a database or a file.
 *
 * The API keeps only what genuinely needs a connection: reading the bytes,
 * enforcing the plan limit, and writing the rows in one transaction.
 *
 * **Zero fabricated rows** (locked decision #16). Nothing in this file invents a
 * value, fills a blank, or maps a unit it does not recognise. Every failure names
 * the row, the column and the value, because the operator's next act is to open the
 * file and look at that cell.
 */

// ── Caps, applied before parsing rather than after (packet §10) ──────────────

/**
 * The row cap. A published national factor workbook is on the order of a few
 * thousand rows; 20,000 is generous for that and still bounds the most expensive
 * authenticated operation in the product, whose cost is **per row rather than per
 * request**.
 */
export const MAX_IMPORT_ROWS = 20000;

/** Bytes of decoded file content. Checked before a parser is handed the buffer. */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/**
 * XLSX is a zip, so a 40 KB upload can become a multi-gigabyte parse. Both caps
 * apply to the archive before any sheet is read.
 */
export const MAX_XLSX_ENTRIES = 200;
export const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

/** One cell. Long enough for a methodology note, short enough not to be a payload. */
export const MAX_CELL_LENGTH = 2000;

// ── The target columns ───────────────────────────────────────────────────────

export const FACTOR_IMPORT_FIELDS = [
  'category',
  'activity',
  'material',
  'treatment',
  'vehicleType',
  'fuelType',
  'unit',
  'kgCo2ePerUnit',
  'kgCo2PerUnit',
  'kgCh4PerUnit',
  'kgN2oPerUnit',
  'wttKgCo2ePerUnit',
  'scope',
  'scope3Category',
  'sourceReference',
  'notes',
] as const;
export type FactorImportField = (typeof FACTOR_IMPORT_FIELDS)[number];

/** The four a row cannot be built without. Everything else is genuinely optional. */
export const REQUIRED_IMPORT_FIELDS: readonly FactorImportField[] = [
  'category',
  'activity',
  'unit',
  'kgCo2ePerUnit',
];

/**
 * A mapping from target field to the **column header** in the uploaded file.
 *
 * Header names rather than indices, deliberately. An index is meaningless in the
 * import report a week later, and a file whose columns move between the dry run
 * and the confirm would silently import the wrong column under an index mapping.
 */
export type ColumnMapping = Partial<Record<FactorImportField, string>>;

export const columnMappingSchema = z
  .object(
    Object.fromEntries(
      FACTOR_IMPORT_FIELDS.map((f) => [f, z.string().trim().min(1).max(200).optional()])
    ) as Record<FactorImportField, z.ZodOptional<z.ZodString>>
  )
  .strict();

/**
 * Header aliases the guesser recognises, lower-cased and stripped of everything
 * that is not a letter or a digit.
 *
 * **A guess is a suggestion the operator confirms, never a mapping applied on its
 * own.** §26.2 asks for a column-mapping UI precisely because a publisher renames
 * its columns between years, and a guesser that quietly guessed wrong would import
 * the well-to-tank column as the headline factor — which is a number roughly a
 * fifth the size, in the direction that flatters.
 */
const HEADER_ALIASES: Readonly<Record<FactorImportField, readonly string[]>> = {
  category: ['category', 'scopecategory', 'level1', 'activitycategory', 'group'],
  activity: ['activity', 'level2', 'activityname', 'description', 'lookup'],
  material: ['material', 'level3', 'wastematerial', 'substance'],
  treatment: ['treatment', 'level4', 'wastetreatment', 'disposalmethod', 'endoflife'],
  vehicleType: ['vehicletype', 'vehicle', 'vehiclecategory', 'type'],
  fuelType: ['fueltype', 'fuel'],
  unit: ['unit', 'uom', 'units', 'unitofmeasure'],
  kgCo2ePerUnit: ['kgco2e', 'kgco2eperunit', 'ghgconversionfactor', 'factor', 'co2e', 'value'],
  kgCo2PerUnit: ['kgco2', 'kgco2perunit', 'co2'],
  kgCh4PerUnit: ['kgch4', 'kgch4perunit', 'ch4'],
  kgN2oPerUnit: ['kgn2o', 'kgn2operunit', 'n2o'],
  wttKgCo2ePerUnit: ['wtt', 'wttkgco2e', 'welltotank', 'wttkgco2eperunit'],
  scope: ['scope', 'ghgscope'],
  scope3Category: ['scope3category', 'scope3cat', 'category3'],
  sourceReference: ['sourcereference', 'source', 'sheet', 'reference', 'ref'],
  notes: ['notes', 'note', 'comment', 'comments'],
};

function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A best guess at the mapping, for the operator to confirm or correct.
 *
 * An exact alias match only — no fuzzy distance, no prefix matching. A guesser
 * that reaches produces a mapping somebody accepts without reading, and the whole
 * reason §26.2 asks for the mapping step is that the file is not trustworthy on
 * its own.
 */
export function guessColumnMapping(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();
  for (const field of FACTOR_IMPORT_FIELDS) {
    const aliases = HEADER_ALIASES[field];
    const found = headers.find(
      (h) => !taken.has(h) && aliases.includes(normaliseHeader(h))
    );
    if (found !== undefined) {
      mapping[field] = found;
      taken.add(found);
    }
  }
  return mapping;
}

// ── Delimited parsing ────────────────────────────────────────────────────────

export interface ParsedTable {
  headers: string[];
  /** One entry per data row, keyed by header. Row 1 is the header, so these start at 2. */
  rows: Record<string, string>[];
}

export type ParseFailure = { row: number; column: string | null; value: string | null; message: string };

/**
 * RFC 4180 CSV, including quoted fields containing commas and escaped quotes.
 *
 * Hand-written rather than a dependency, and small enough to be obviously correct:
 * the alternative is a parser with its own options, its own coercions and its own
 * opinion about what an empty field means, and "what does an empty cell mean" is
 * exactly the question this importer must not have two answers to.
 *
 * **A blank cell is an empty string, and an empty string is later read as null.**
 * It is never zero. A missing waste-treatment factor is a disclosed gap (§41.1);
 * a zero is a claim that treating that material emits nothing.
 */
export function parseDelimited(text: string, delimiter = ','): ParsedTable {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  // A UTF-8 BOM in front of the first header would make it match no alias, which
  // presents as "the file has no category column" against a file that plainly does.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      rows.push(record);
      record = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    rows.push(record);
  }

  const headerRow = rows.shift() ?? [];
  const headers = headerRow.map((h) => h.trim());
  return {
    headers,
    rows: rows
      // A trailing newline produces one empty record, and so does a blank line in
      // the middle of a publisher's workbook. Neither is a row, and reporting them
      // as failures would bury the real ones.
      .filter((r) => r.some((cell) => cell.trim() !== ''))
      .map((r) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, idx) => {
          obj[h] = (r[idx] ?? '').trim();
        });
        return obj;
      }),
  };
}

/**
 * Prefix a cell that a spreadsheet would treat as a formula.
 *
 * §10: *"CSV cells beginning `=`, `+`, `-` or `@` are stored as text and prefixed
 * on export, because the export is opened in Excel by the auditor this data exists
 * for. Storing a formula is harmless; handing one back is CSV injection."*
 *
 * The leading apostrophe is what Excel and LibreOffice both read as "this is
 * text". A negative number is deliberately **not** exempted — `-2+3` is a formula
 * and `-2` is not, and telling them apart is exactly the kind of cleverness that
 * ships a hole.
 */
export function escapeForSpreadsheet(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// ── Mapping rows onto factors ────────────────────────────────────────────────

export interface MappedFactorRow {
  /** 1-based row number **in the file**, header included, so it matches what Excel shows. */
  rowNumber: number;
  category: string;
  activity: string;
  material: string | null;
  treatment: string | null;
  vehicleType: string | null;
  fuelType: string | null;
  unit: FactorUnit;
  kgCo2ePerUnit: number;
  kgCo2PerUnit: number | null;
  kgCh4PerUnit: number | null;
  kgN2oPerUnit: number | null;
  wttKgCo2ePerUnit: number | null;
  scope: z.infer<typeof ghgScopeSchema> | null;
  scope3Category: number | null;
  sourceReference: string | null;
  notes: string | null;
}

export interface MappedImport {
  rows: MappedFactorRow[];
  failures: ParseFailure[];
  countsByCategory: Record<string, number>;
  /** Distinct units seen, for the report. */
  units: string[];
}

/**
 * Unit spellings a publisher actually uses, mapped onto §26.1's six.
 *
 * **This table is exhaustive and closed.** An unrecognised unit is a terminal
 * import failure that names the value and lists what is accepted (packet §9) — it
 * is never coerced to the nearest thing, because the nearest thing to "tonnes" is
 * "tonne" and the nearest thing to "t.km" is either of two answers with a
 * thousand-fold difference between them.
 */
const UNIT_ALIASES: Readonly<Record<string, FactorUnit>> = {
  km: 'km',
  kms: 'km',
  kilometre: 'km',
  kilometres: 'km',
  kilometer: 'km',
  kilometers: 'km',
  mile: 'mile',
  miles: 'mile',
  litre: 'litre',
  litres: 'litre',
  liter: 'litre',
  liters: 'litre',
  l: 'litre',
  kwh: 'kWh',
  kilowatthour: 'kWh',
  kilowatthours: 'kWh',
  tonne: 'tonne',
  tonnes: 'tonne',
  ton: 'tonne',
  tons: 'tonne',
  t: 'tonne',
  tonnekm: 'tonne.km',
  tonnekms: 'tonne.km',
  tkm: 'tonne.km',
  tonnekilometre: 'tonne.km',
  tonnekilometres: 'tonne.km',
};

export function normaliseUnit(raw: string): FactorUnit | null {
  const direct = factorUnitSchema.safeParse(raw.trim());
  if (direct.success) return direct.data;
  return UNIT_ALIASES[raw.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? null;
}

function optionalText(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A numeric cell.
 *
 * Thousands separators are stripped because publishers use them; everything else
 * that is not a number is a failure rather than a `NaN` that becomes a null that
 * becomes a silently missing factor. **A blank optional number is null, never
 * zero** — the same distinction the whole domain turns on.
 */
function numeric(value: string | undefined): number | null | 'INVALID' {
  const raw = (value ?? '').trim().replace(/,/g, '');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 'INVALID';
}

/**
 * Turn parsed cells into factor rows under a confirmed mapping.
 *
 * **Every failure is collected rather than thrown**, and the caller decides what to
 * do with a file that has some. The API refuses the whole import if there is even
 * one — imports are all-or-nothing (packet §9), because a partially imported set is
 * worse than none: the resolver finds some factors and reports gaps for the rest,
 * so the operator sees a plausible half-result and the missing half is disclosed to
 * a client as a data gap that does not exist.
 *
 * Collecting rather than stopping at the first is what makes one round trip fix a
 * file with eleven bad rows in it.
 */
export function mapFactorRows(table: ParsedTable, mapping: ColumnMapping): MappedImport {
  const failures: ParseFailure[] = [];
  const rows: MappedFactorRow[] = [];
  const countsByCategory: Record<string, number> = {};
  const units = new Set<string>();

  for (const field of REQUIRED_IMPORT_FIELDS) {
    const header = mapping[field];
    if (header === undefined) {
      failures.push({ row: 1, column: field, value: null, message: `No column is mapped to ${field}` });
    } else if (!table.headers.includes(header)) {
      failures.push({
        row: 1,
        column: field,
        value: header,
        message: `The file has no column named “${header}”`,
      });
    }
  }
  if (failures.length > 0) return { rows, failures, countsByCategory, units: [] };

  const cell = (r: Record<string, string>, field: FactorImportField): string | undefined => {
    const header = mapping[field];
    return header === undefined ? undefined : r[header];
  };

  table.rows.forEach((r, idx) => {
    // +2: the header is row 1 and this index is 0-based, so a failure names the row
    // the operator sees in Excel rather than the one the parser sees.
    const rowNumber = idx + 2;
    const before = failures.length;

    const oversized = Object.entries(r).find(([, v]) => v.length > MAX_CELL_LENGTH);
    if (oversized) {
      failures.push({
        row: rowNumber,
        column: oversized[0],
        value: `${oversized[1].slice(0, 40)}…`,
        message: `A cell is longer than ${MAX_CELL_LENGTH} characters`,
      });
      return;
    }

    const category = optionalText(cell(r, 'category'));
    const activity = optionalText(cell(r, 'activity'));
    if (category === null) {
      failures.push({ row: rowNumber, column: mapping.category ?? 'category', value: null, message: 'Category is empty' });
    }
    if (activity === null) {
      failures.push({ row: rowNumber, column: mapping.activity ?? 'activity', value: null, message: 'Activity is empty' });
    }

    const rawUnit = optionalText(cell(r, 'unit'));
    const unit = rawUnit === null ? null : normaliseUnit(rawUnit);
    if (unit === null) {
      failures.push({
        row: rowNumber,
        column: mapping.unit ?? 'unit',
        value: rawUnit,
        message: `Unit is not recognised. Accepted units: ${FACTOR_UNITS.join(', ')}`,
      });
    }

    const headline = numeric(cell(r, 'kgCo2ePerUnit'));
    if (headline === 'INVALID' || headline === null) {
      failures.push({
        row: rowNumber,
        column: mapping.kgCo2ePerUnit ?? 'kgCo2ePerUnit',
        value: optionalText(cell(r, 'kgCo2ePerUnit')),
        message: headline === null ? 'Emission factor is empty' : 'Emission factor is not a number',
      });
    } else if (headline < 0) {
      // Zero is a legitimate factor and is accepted; negative is not (packet §9).
      failures.push({
        row: rowNumber,
        column: mapping.kgCo2ePerUnit ?? 'kgCo2ePerUnit',
        value: String(headline),
        message: 'Emission factor is negative',
      });
    }

    const optionalNumbers: [FactorImportField, number | null][] = [];
    for (const field of ['kgCo2PerUnit', 'kgCh4PerUnit', 'kgN2oPerUnit', 'wttKgCo2ePerUnit'] as const) {
      const parsed = numeric(cell(r, field));
      if (parsed === 'INVALID') {
        failures.push({
          row: rowNumber,
          column: mapping[field] ?? field,
          value: optionalText(cell(r, field)),
          message: 'Not a number',
        });
      } else if (parsed !== null && parsed < 0) {
        failures.push({ row: rowNumber, column: mapping[field] ?? field, value: String(parsed), message: 'Negative' });
      } else {
        optionalNumbers.push([field, parsed]);
      }
    }

    const rawScope = optionalText(cell(r, 'scope'));
    let scope: z.infer<typeof ghgScopeSchema> | null = null;
    if (rawScope !== null) {
      const normalised = rawScope.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const parsed = ghgScopeSchema.safeParse(normalised);
      if (!parsed.success) {
        failures.push({
          row: rowNumber,
          column: mapping.scope ?? 'scope',
          value: rawScope,
          message: 'Scope must be SCOPE_1, SCOPE_2, SCOPE_3 or OUT_OF_SCOPE',
        });
      } else {
        scope = parsed.data;
      }
    }

    const rawCat = numeric(cell(r, 'scope3Category'));
    let scope3Category: number | null = null;
    if (rawCat === 'INVALID' || (rawCat !== null && (!Number.isInteger(rawCat) || rawCat < 1 || rawCat > 15))) {
      failures.push({
        row: rowNumber,
        column: mapping.scope3Category ?? 'scope3Category',
        value: optionalText(cell(r, 'scope3Category')),
        message: 'Scope 3 category must be a whole number from 1 to 15',
      });
    } else {
      scope3Category = rawCat;
    }

    if (failures.length !== before) return;

    const byField = new Map(optionalNumbers);
    rows.push({
      rowNumber,
      category: category as string,
      activity: activity as string,
      material: optionalText(cell(r, 'material')),
      treatment: optionalText(cell(r, 'treatment')),
      vehicleType: optionalText(cell(r, 'vehicleType')),
      fuelType: optionalText(cell(r, 'fuelType')),
      unit: unit as FactorUnit,
      kgCo2ePerUnit: headline as number,
      kgCo2PerUnit: byField.get('kgCo2PerUnit') ?? null,
      kgCh4PerUnit: byField.get('kgCh4PerUnit') ?? null,
      kgN2oPerUnit: byField.get('kgN2oPerUnit') ?? null,
      wttKgCo2ePerUnit: byField.get('wttKgCo2ePerUnit') ?? null,
      scope,
      scope3Category,
      sourceReference: optionalText(cell(r, 'sourceReference')),
      notes: optionalText(cell(r, 'notes')),
    });
    countsByCategory[category as string] = (countsByCategory[category as string] ?? 0) + 1;
    units.add(unit as string);
  });

  return { rows, failures, countsByCategory, units: [...units].sort() };
}

// ── The dry-run diff (§26.2) ─────────────────────────────────────────────────

/**
 * What a confirm would do, computed **before** it does it.
 *
 * §26.2 asks for a dry-run diff and packet §2 explains why it is the whole of the
 * review this domain gets: *"Nobody reviews a factor set. There is no approval
 * state, and adding one would be theatre — the reviewer would be the same person
 * who imported it, and the thing being reviewed is a published government
 * workbook. What replaces review is the importer's dry-run diff: you see what will
 * change before it changes, which is a better guarantee than a second click by the
 * same hand."*
 */
export interface ImportDiff {
  /** Rows that would be added, by category, and the total. */
  toAdd: number;
  countsByCategory: Record<string, number>;
  units: string[];
  /**
   * Rows in the file that duplicate **each other** on the identity `resolveFactor`
   * matches — the same category, activity, material, treatment, vehicle and fuel.
   *
   * Reported rather than deduplicated, because two rows claiming the same identity
   * with different values is a file the operator has to look at: `resolveFactor`
   * would return `AMBIGUOUS` for that query forever after, which produces a
   * disclosed gap on a factor that is right there in the set.
   */
  duplicateRows: { rowNumber: number; duplicateOfRow: number; identity: string }[];
  failures: ParseFailure[];
  /** True when the set (name + version) already exists for this company. */
  setExists: boolean;
}

/** The tuple `resolveFactor` discriminates on, as a comparable string. */
export function factorIdentity(row: {
  category: string;
  activity: string;
  material: string | null;
  treatment: string | null;
  vehicleType: string | null;
  fuelType: string | null;
  unit: string;
}): string {
  return [row.category, row.activity, row.material, row.treatment, row.vehicleType, row.fuelType, row.unit]
    .map((v) => (v ?? '').toLowerCase().trim())
    .join(' ');
}

export function buildImportDiff(mapped: MappedImport, opts: { setExists: boolean }): ImportDiff {
  const seen = new Map<string, number>();
  const duplicateRows: ImportDiff['duplicateRows'] = [];
  for (const row of mapped.rows) {
    const identity = factorIdentity(row);
    const first = seen.get(identity);
    if (first === undefined) {
      seen.set(identity, row.rowNumber);
    } else {
      duplicateRows.push({
        rowNumber: row.rowNumber,
        duplicateOfRow: first,
        identity: [row.category, row.activity, row.material, row.treatment]
          .filter((v) => v !== null && v !== '')
          .join(' · '),
      });
    }
  }
  return {
    toAdd: mapped.rows.length,
    countsByCategory: mapped.countsByCategory,
    units: mapped.units,
    duplicateRows,
    failures: mapped.failures,
    setExists: opts.setExists,
  };
}

/** The import is refusable for exactly three reasons, and each has a different fix. */
export function importRefusal(diff: ImportDiff): { code: string; message: string } | null {
  if (diff.setExists) {
    return {
      code: 'SET_ALREADY_EXISTS',
      message:
        'A factor set with this name and version already exists. Import it as a new version, or deactivate the existing one.',
    };
  }
  const firstFailure = diff.failures[0];
  if (firstFailure !== undefined) {
    const first = firstFailure;
    return {
      code: 'INVALID_ROWS',
      message: `Row ${first.row}${first.column ? `, column “${first.column}”` : ''}: ${first.message}${
        first.value === null ? '' : ` (value: ${first.value})`
      }. ${diff.failures.length - 1} other problem${diff.failures.length === 2 ? '' : 's'} in this file.`,
    };
  }
  const firstDuplicate = diff.duplicateRows[0];
  if (firstDuplicate !== undefined) {
    const first = firstDuplicate;
    return {
      code: 'DUPLICATE_ROWS',
      message: `Row ${first.rowNumber} repeats the same factor as row ${first.duplicateOfRow} (${first.identity}). Two rows claiming one identity make that factor unresolvable.`,
    };
  }
  if (diff.toAdd === 0) {
    return { code: 'NO_ROWS', message: 'This file has no factor rows in it.' };
  }
  if (diff.toAdd > MAX_IMPORT_ROWS) {
    return {
      code: 'TOO_MANY_ROWS',
      message: `This file has ${diff.toAdd} rows and the limit is ${MAX_IMPORT_ROWS}.`,
    };
  }
  return null;
}

// ── The request shapes ───────────────────────────────────────────────────────

export const IMPORT_FORMATS = ['CSV', 'XLSX'] as const;
export const importFormatSchema = z.enum(IMPORT_FORMATS);
export type ImportFormat = z.infer<typeof importFormatSchema>;

/**
 * The upload.
 *
 * Inline rather than through the presigned-file path, and the reason is the packet's
 * §10 rather than convenience: *"the `factor_sets` limit checked **before** a byte is
 * parsed — the presign precedent from Phase 7"*. A file that reaches object storage
 * has already been accepted; the caps that matter here are on content the API has
 * not yet looked at, and the simplest place to refuse an oversize workbook is
 * before it is stored anywhere.
 *
 * `content` is the file's text for CSV and base64 for XLSX. The size cap is applied
 * to the **decoded** bytes, because base64 is a third larger than what it carries
 * and a limit on the encoded form is a limit on the wrong number.
 */
export const factorImportSchema = z.object({
  format: importFormatSchema,
  content: z.string().min(1),
  /** Which sheet, for XLSX. The first is used when absent. */
  sheetName: z.string().trim().max(200).optional(),
  mapping: columnMappingSchema,
  set: z.object({
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
  }),
  /**
   * **True is the default, and the default is the safe one.** A dry run reports what
   * would happen and writes nothing; a caller has to ask for the write. §26.2's
   * mapping UI runs the dry run on every mapping change, so the expensive direction
   * is the one that has to be requested.
   */
  dryRun: z.boolean().default(true),
});
export type FactorImportRequest = z.infer<typeof factorImportSchema>;

/** The mapping-preview request: headers and a guess, without committing to anything. */
export const factorImportPreviewSchema = z.object({
  format: importFormatSchema,
  content: z.string().min(1),
  sheetName: z.string().trim().max(200).optional(),
});
export type FactorImportPreview = z.infer<typeof factorImportPreviewSchema>;

export interface FactorImportPreviewResult {
  headers: string[];
  rowCount: number;
  sheetNames: string[];
  suggestedMapping: ColumnMapping;
  /** The first few rows, for the operator to see what they are mapping. */
  sample: Record<string, string>[];
}
