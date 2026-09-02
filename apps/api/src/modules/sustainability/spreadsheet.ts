import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  MAX_XLSX_ENTRIES,
  MAX_XLSX_UNCOMPRESSED_BYTES,
  parseDelimited,
  type ImportFormat,
  type ParsedTable,
} from '@crewquo/shared';
import { AppError } from '../../http/errors';

/**
 * Reading the uploaded file (`sustainability.md` §10).
 *
 * **The importer is the largest upload surface in the product after evidence**, and
 * unlike evidence it does not merely store what it is given — it turns a
 * spreadsheet into thousands of rows a client's annual report is computed from. So
 * this file is entirely about refusing things, and the parsing it actually does is
 * two calls.
 *
 * Every cap is applied **before** the thing it protects against, which is the
 * presign precedent from Phase 7: a byte count checked after decoding is a byte
 * count that has already been paid for, and a row count checked after parsing is a
 * parse that has already run.
 */

export interface ReadResult extends ParsedTable {
  /** Every sheet in the workbook, so the mapping UI can offer a choice. */
  sheetNames: string[];
}

/**
 * Decode and size-check the payload.
 *
 * The cap is on the **decoded** bytes. Base64 is a third larger than what it
 * carries, so a limit applied to the encoded string is a limit on the wrong number
 * — generous by a third for XLSX and exactly right for nothing.
 */
function decode(content: string, format: ImportFormat): Buffer {
  const buffer =
    format === 'CSV' ? Buffer.from(content, 'utf8') : Buffer.from(content, 'base64');
  if (buffer.byteLength === 0) {
    throw new AppError('VALIDATION', 'That file is empty.');
  }
  if (buffer.byteLength > MAX_IMPORT_BYTES) {
    throw new AppError(
      'VALIDATION',
      `That file is ${Math.round(buffer.byteLength / 1024 / 1024)} MB and this importer accepts ${Math.round(
        MAX_IMPORT_BYTES / 1024 / 1024
      )} MB. Export the sheet you need on its own.`,
      { maxBytes: MAX_IMPORT_BYTES }
    );
  }
  return buffer;
}

/**
 * **XLSX is a zip**, so the archive is inspected before any sheet is read.
 *
 * Without this a 40 KB upload becomes a multi-gigabyte parse: the classic zip bomb,
 * and an authenticated one, which means it is available to anybody with a trial
 * account. Two caps, because the two attacks are different — one enormous entry,
 * and ten thousand small ones.
 *
 * `jszip` reads the central directory rather than inflating, so the check itself
 * costs nothing.
 */
async function assertSafeArchive(buffer: Buffer): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new AppError('VALIDATION', 'That file is not a readable .xlsx workbook.');
  }

  const entries = Object.values(zip.files);
  if (entries.length > MAX_XLSX_ENTRIES) {
    throw new AppError('VALIDATION', `That workbook contains ${entries.length} parts, which is more than this importer will open.`);
  }

  let total = 0;
  for (const entry of entries) {
    // `_data.uncompressedSize` is what the archive itself claims, read from the
    // directory rather than measured by inflating — which is the whole point:
    // believing the claim costs nothing and a liar's claim is still bounded by the
    // decompression exceeding it, which exceljs would then fail on.
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    total += typeof size === 'number' ? size : 0;
  }
  if (total > MAX_XLSX_UNCOMPRESSED_BYTES) {
    throw new AppError(
      'VALIDATION',
      'That workbook expands to more data than this importer will open. Export the sheet you need as CSV.'
    );
  }
}

/**
 * A cell's value, **never a formula's evaluation**.
 *
 * §10: *"Formulas are never evaluated. Cell values only. A spreadsheet parser that
 * evaluates is a code-execution surface, and the values are what the publisher
 * published anyway."* `exceljs` does not evaluate; for a formula cell it hands back
 * `{ formula, result }`, and the cached `result` is precisely what the publisher's
 * own tool computed and saved. A formula with no cached result is read as **empty**
 * rather than as its own text — importing `=B2*1000` as a category is worse than
 * reporting a blank cell somebody has to look at.
 */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) {
      const result = (value as { result?: unknown }).result;
      return result === undefined || result === null ? '' : String(result).trim();
    }
    if ('richText' in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('').trim();
    }
    if ('text' in value) return String((value as { text: unknown }).text).trim();
    if ('error' in value) return '';
  }
  return '';
}

/** Read the workbook or the CSV into headers plus rows, with every cap applied. */
export async function readTable(args: {
  content: string;
  format: ImportFormat;
  sheetName?: string;
}): Promise<ReadResult> {
  const buffer = decode(args.content, args.format);

  if (args.format === 'CSV') {
    const table = parseDelimited(buffer.toString('utf8'));
    assertRowCap(table.rows.length);
    return { ...table, sheetNames: [] };
  }

  await assertSafeArchive(buffer);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new AppError('VALIDATION', 'That file is not a readable .xlsx workbook.');
  }

  const sheetNames = workbook.worksheets.map((w) => w.name);
  const sheet =
    args.sheetName === undefined
      ? workbook.worksheets[0]
      : workbook.worksheets.find((w) => w.name === args.sheetName);
  if (!sheet) {
    throw new AppError('VALIDATION', `That workbook has no sheet named “${args.sheetName ?? ''}”.`, {
      sheetNames,
    });
  }

  // The row cap is checked against the sheet's own dimension before any row is
  // materialised, so a ten-million-row sheet is refused rather than iterated.
  assertRowCap(Math.max(sheet.rowCount - 1, 0));

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = cellText(cell.value);
  });
  for (let i = 0; i < headers.length; i += 1) {
    // A gap in the header row is a real column with no name. Naming it by position
    // keeps the row/column alignment that a compacting parser would silently break.
    if (headers[i] === undefined || headers[i] === '') headers[i] = `Column ${i + 1}`;
  }

  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      record[header] = cellText(row.getCell(idx + 1).value);
    });
    if (Object.values(record).some((v) => v !== '')) rows.push(record);
  });

  assertRowCap(rows.length);
  return { headers, rows, sheetNames };
}

function assertRowCap(count: number): void {
  if (count > MAX_IMPORT_ROWS) {
    throw new AppError(
      'VALIDATION',
      `That file has ${count} rows and this importer accepts ${MAX_IMPORT_ROWS}.`
    );
  }
}
