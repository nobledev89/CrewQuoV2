import { getObjectBytes, storageConfigured } from '../storage/client';
import { query } from '../../db';

/**
 * Getting the pictures into the page.
 *
 * ── WHY THE ORIGINALS, AND WHY sharp ────────────────────────────────────────
 *
 * Phase 7's derivative worker writes **WebP**, which jsPDF cannot embed. So the
 * only bytes available to a PDF are the originals, and an original from a phone is
 * several megabytes — twenty-four of them would be a seventy-megabyte report
 * nobody can email, which is the one thing a completion pack has to be able to do.
 *
 * So they are re-encoded here, once, at a pinned size and quality.
 *
 * ── THE LIMIT ON "BYTE-IDENTICAL", STATED RATHER THAN GLOSSED ───────────────
 *
 * Every option below is fixed, so the same source bytes produce the same JPEG on
 * the same libvips build — which is what makes `renderReportPdf` a pure function of
 * its input, and what `determinism.test.ts` asserts. A *libvips upgrade* could in
 * principle change an encoder's output, and that is the one input to a rendering
 * this phase does not control.
 *
 * It does not weaken §29.4, and the reason is the design rather than luck: the
 * **rendered PDF is stored** (`generated_reports.file_id`), so the document a
 * client was given is served back to them as the bytes they were given. Re-rendering
 * from the snapshot is the fallback for a report whose file was never stored, and
 * its numbers — which is what §29.4 actually promises — come from the snapshot and
 * cannot move at all.
 *
 * ── AND A MISSING IMAGE IS NAMED, NEVER SILENT ──────────────────────────────
 *
 * A file id in the snapshot with no bytes behind it returns nothing from here, and
 * the renderer prints *"1 photograph referenced by this report could not be
 * retrieved"*. A blank frame would read as a bug; the sentence reads as a fact
 * about the document, which is what it is.
 */

export type ImageFormat = 'PNG' | 'JPEG';
export type ImageMap = Map<string, { bytes: Buffer; format: ImageFormat }>;

/** Long edge in points-worth of pixels: 1100 covers a full-width plate at 150dpi. */
const MAX_EDGE = 1100;
const JPEG_QUALITY = 72;

interface FileRow {
  id: string;
  bucket_key: string;
  content_type: string;
  status: string;
}

/**
 * Fetch and normalise every image the snapshot named.
 *
 * Missing, unreadable and non-image files are simply absent from the returned map;
 * every caller treats absence as "name it on the page".
 */
export async function loadImages(fileIds: readonly string[]): Promise<ImageMap> {
  const images: ImageMap = new Map();
  if (fileIds.length === 0 || !storageConfigured()) return images;

  const rows = await query<FileRow>(
    `select id, bucket_key, content_type, status
       from stored_files
      where id = any($1::uuid[]) and status in ('READY','SCANNING')`,
    [fileIds]
  );

  const encoder = await loadSharp();

  for (const row of rows) {
    try {
      const bytes = await getObjectBytes(row.bucket_key);
      if (!encoder) {
        // No sharp: embed what can be embedded as-is rather than dropping every
        // photograph. A large report is better than a report with no evidence in it.
        const format = passthroughFormat(row.content_type);
        if (format) images.set(row.id, { bytes, format });
        continue;
      }
      const jpeg = await encoder(bytes)
        .rotate() // honour EXIF orientation, or half the site photographs are sideways
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        // Flattened onto white: a PNG signature with a transparent background
        // becomes a black rectangle in a JPEG, which is the one image in the
        // document nobody would think to check.
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0', mozjpeg: false })
        .toBuffer();
      images.set(row.id, { bytes: jpeg, format: 'JPEG' });
    } catch {
      // Deliberately silent here and loud on the page. A storage hiccup must not
      // fail a whole document that is correct in every other respect (§9).
      continue;
    }
  }
  return images;
}

function passthroughFormat(contentType: string): ImageFormat | null {
  if (contentType === 'image/png') return 'PNG';
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') return 'JPEG';
  return null;
}

/**
 * The same defensive import `storage/worker.ts` uses, and for the same reason: the
 * package is CJS with an ESM interop shim, so the callable is `default` under `tsx`
 * and the namespace itself under some bundlers.
 */
async function loadSharp(): Promise<((input: Buffer) => import('sharp').Sharp) | null> {
  try {
    const mod = (await import('sharp')) as unknown as {
      default?: (input: Buffer) => import('sharp').Sharp;
    };
    const callable = mod.default ?? (mod as unknown as (input: Buffer) => import('sharp').Sharp);
    return typeof callable === 'function' ? callable : null;
  } catch {
    return null;
  }
}
