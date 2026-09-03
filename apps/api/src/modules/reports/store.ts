import { createHash, randomUUID } from 'node:crypto';
import { buildBucketKey } from '@crewquo/shared';
import { putObject, storageConfigured } from '../storage/client';
import { findByClientId, insertPending, markReady, markScanning } from '../storage/repo';
import type { ReportRow } from './repo';

/**
 * Putting a rendered report into object storage.
 *
 * **The file is a cache and the snapshot is the record** (packet §13.7). §29.4's
 * own DDL makes `file_id` nullable, and 10.1's deterministic renderer is what makes
 * that safe: a document rendered from the snapshot a year later is byte-identical to
 * the one that was stored. So an environment with no object store — a developer's
 * laptop without MinIO — produces exactly the same documents, just without keeping
 * a copy.
 *
 * It is written **server-side rather than through the presign flow**, which is the
 * one place in the product bytes do not arrive from a client. The presign path
 * exists so uploads never traverse the API; these bytes were made *by* the API, and
 * routing them out to a signed URL and back would be ceremony around a `PUT`.
 *
 * The row goes straight to `READY`: the scanning worker exists to sniff a content
 * type the API never saw, and this is the one file whose type the API chose.
 */
export async function storeRenderedPdf(args: {
  report: ReportRow;
  bytes: Buffer;
  uploadedByUserId: string;
}): Promise<string | null> {
  if (!storageConfigured()) return null;

  /*
   * The report id is the idempotency key, so re-storing after a failed first
   * attempt finds its own row rather than minting a second bucket key and a second
   * byte charge — the same rule `stored_files.client_id` was added for in 0029.
   */
  const existing = await findByClientId(args.report.company_id, args.report.id);
  if (existing) return existing.id;

  const id = randomUUID();
  const bucketKey = buildBucketKey({
    companyId: args.report.company_id,
    projectId: args.report.project_id,
    kind: 'EXPORT',
    fileId: id,
    variant: 'ORIGINAL',
    contentType: 'application/pdf',
  });

  await putObject({ key: bucketKey, body: args.bytes, contentType: 'application/pdf' });

  const row = await insertPending({
    id,
    companyId: args.report.company_id,
    projectId: args.report.project_id,
    bucketKey,
    originalFilename: 'report.pdf',
    contentType: 'application/pdf',
    byteSize: args.bytes.byteLength,
    kind: 'EXPORT',
    clientId: args.report.id,
    uploadedByUserId: args.uploadedByUserId,
  });
  if (!row) return null;

  /*
   * PENDING -> SCANNING -> READY, through the two guarded transitions rather than
   * straight to READY. Not ceremony: both updates carry a `where status = …`, so a
   * concurrent sweep that has already expired the row cannot be walked backwards
   * into the pipeline by this path — which is exactly the guarantee 0027 added
   * those predicates for.
   *
   * The checksum is recorded because it is free here and it is the one thing an
   * operator comparing bytes on disk to a report's seal would otherwise have to
   * compute by hand.
   */
  await markScanning(id, { byteSize: args.bytes.byteLength, checksumSha256: sha256Of(args.bytes) });
  await markReady(id);
  return id;
}

/** The checksum recorded alongside, for an operator comparing bytes to a seal. */
export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
