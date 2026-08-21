import JSZip from 'jszip';
import { EXPORT_NOTES, toCsv, type ExportManifest } from '@crewquo/shared';
import { pool } from '../../db';
import { EXPORT_SCOPES, selectFor, type ExportScope } from './queries';

/**
 * Build one export bundle.
 *
 * A zip holding, per table, both a `.json` and a `.csv` — the owner decision's "JSON plus
 * CSV per table" (§13.2), and never a PDF. The JSON is the faithful copy: `jsonb` stays
 * nested, a null stays null, and an integer stays an integer. The CSV is the same rows
 * flattened for a spreadsheet, which is what the person who asked will actually open.
 * Shipping both means neither has to be a compromise.
 *
 * `manifest.json` carries the spec — every table's reason, its scope in prose, its row
 * count, its columns, and the columns deliberately withheld with why. That last part is
 * the one worth defending: an unexplained absence in somebody's own data reads as either
 * a bug or evasion, and *"why is my pay rate not in here"* is the first question a careful
 * reader of a personal export will have.
 */
export interface BuiltExport {
  readonly zip: Buffer;
  readonly manifest: ExportManifest;
  readonly tableCount: number;
  readonly rowCount: number;
}

export async function buildExport(scope: ExportScope, subjectId: string): Promise<BuiltExport> {
  const { spec, queries } = EXPORT_SCOPES[scope];
  const generatedAt = new Date().toISOString();

  /*
   * One connection for the whole bundle, inside a read-only repeatable-read transaction.
   *
   * Without it, fourteen queries run at fourteen different instants and the bundle can
   * contain an invoice whose items are missing because they were written between the two
   * reads. A snapshot makes `generatedAt` a true statement about the whole file rather
   * than about its first table, which is the difference between an export somebody can
   * reconcile and one that looks corrupt.
   */
  const client = await pool.connect();
  const tables: ExportManifest['tables'][number][] = [];
  const files: { name: string; body: string }[] = [];
  let rowCount = 0;

  try {
    await client.query('begin transaction isolation level repeatable read read only');
    for (const table of spec) {
      const query = queries[table.table];
      // Unreachable while `queries.test.ts` passes; thrown rather than skipped because an
      // empty file in a bundle reads as "you have no data", not as a missing query.
      if (!query) throw new Error(`No export query for ${scope}.${table.table}`);

      const { rows } = await client.query(selectFor(table, query), [subjectId]);
      rowCount += rows.length;
      tables.push({
        table: table.table,
        because: table.because,
        scope: table.scope,
        rowCount: rows.length,
        columns: table.columns,
        ...(table.withheld ? { withheld: table.withheld } : {}),
      });
      files.push({ name: `${table.table}.json`, body: `${JSON.stringify(rows, null, 2)}\n` });
      files.push({ name: `${table.table}.csv`, body: toCsv(table.columns, rows) });
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const manifest: ExportManifest = {
    scope,
    generatedAt,
    subjectId,
    tables,
    notes: EXPORT_NOTES,
  };

  const zip = await zipOf([
    { name: 'manifest.json', body: `${JSON.stringify(manifest, null, 2)}\n` },
    ...files,
  ]);

  return { zip, manifest, tableCount: tables.length, rowCount };
}

/**
 * Files to a zip, in memory.
 *
 * In memory because the response is a single `res.send`, matching the project exports
 * beside it, and because a stream that fails halfway sends a 200 with a truncated body —
 * a corrupt file that looks like a successful download. Buffering means a failure is
 * still a 500. The ceiling is real and stated rather than discovered: this is fine for a
 * contractor's whole history and is the thing to revisit first when it is not, which is
 * why `data_exports` already records `byte_size`.
 *
 * DEFLATE at 9, not stored. A bundle of JSON and CSV compresses roughly ten to one, and
 * the whole point of the format is that somebody can mail it to their accountant.
 *
 * `jszip` rather than `archiver`, which was the first choice and was reverted: at the
 * versions current here, `archiver@8` bundles no types and `@types/archiver@8` exports
 * only classes and no callable factory, so the typed call and the runtime call are
 * different shapes. Reaching around that with a cast would have put an `as unknown as`
 * between this code and the one dependency whose job is producing the file somebody
 * downloads. `jszip` ships its own types, is in-memory by design — which is what this
 * needs anyway — and needs no cast.
 *
 * `date` is fixed rather than left to now(), because a zip entry's mtime otherwise makes
 * two exports of identical data differ byte for byte, and the manifest is where this
 * bundle says when it was made.
 */
const ZIP_EPOCH = new Date('1980-01-01T00:00:00.000Z');

async function zipOf(files: readonly { name: string; body: string }[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const file of files) zip.file(file.name, file.body, { date: ZIP_EPOCH });
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

/** The bundle's filename. Dated, so a folder of them sorts and nothing overwrites. */
export function exportFilename(scope: ExportScope, generatedAt: string): string {
  const day = generatedAt.slice(0, 10);
  return `crewquo-${scope.toLowerCase()}-export-${day}.zip`;
}
