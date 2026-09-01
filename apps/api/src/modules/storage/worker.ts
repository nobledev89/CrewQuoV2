import { createHash } from 'node:crypto';
import {
  DERIVATIVE_SPECS,
  buildBucketKey,
  extensionFor,
  sniffContentType,
  sniffedTypeAgrees,
  wantsDerivatives,
  type FileVariant,
} from '@crewquo/shared';
import { log } from '../../observability/log';
import { withTransaction } from '../../db';
import { enqueueOutboxEvent } from '../delivery/repo';
import { deleteObject, getObjectBytes, putObject, storageConfigured } from './client';
import {
  claimScanning,
  findExpiredPending,
  insertDerivative,
  markExpired,
  markFailed,
  markReady,
  type StoredFileRow,
} from './repo';

/**
 * The scanning and derivative pass (§22.1, and §13.5 of the packet).
 *
 * This is where `READY` is decided, and the reason is not an implementation
 * preference. §22.1 says bytes never pass through the API *and* that content type
 * is sniffed server-side on complete; both cannot be true of one request. This
 * process already has to download the original to make the `WEB` and `THUMB`
 * variants, so validation costs one existing round trip and nothing else.
 *
 * Runs from `pnpm --filter @crewquo/api work`, beside the outbox and the webhook
 * inbox, for the reason recorded under §14 step 1: a job whose caller does not
 * exist is a job that never runs, and this is the third caller that pass has
 * gained rather than a fourth scheduler.
 */

export interface StorageBatchResult {
  scanned: number;
  ready: number;
  failed: number;
  derivatives: number;
  expired: number;
}

const SCAN_BATCH = 25;
const SWEEP_BATCH = 100;
/** Enough for every signature in `sniffContentType`, and small enough to be free. */
const HEAD_BYTES = 64;

export async function runStorageBatch(): Promise<StorageBatchResult> {
  const result: StorageBatchResult = { scanned: 0, ready: 0, failed: 0, derivatives: 0, expired: 0 };
  if (!storageConfigured()) return result;

  for (const file of await claimScanning(SCAN_BATCH)) {
    result.scanned += 1;
    try {
      const outcome = await scanOne(file);
      if (outcome.ok) {
        result.ready += 1;
        result.derivatives += outcome.derivatives;
      } else {
        result.failed += 1;
      }
    } catch (err) {
      /*
       * A transient failure leaves the row in SCANNING, so the next pass retries
       * it. That is the deliberate asymmetry: a refusal is a verdict about the
       * file and is terminal, while an unreachable store is a fact about us and
       * must never be recorded as the customer's file being bad.
       */
      log('warn', 'storage_scan_error', { storedFileId: file.id });
      void err;
    }
  }

  for (const stale of await findExpiredPending(SWEEP_BATCH)) {
    /*
     * The object is deleted before the row is marked, not after. A PUT that
     * succeeded and whose `complete` never arrived leaves real bytes behind, and
     * marking the row first would lose the only pointer to them — an orphan in
     * the bucket that no query can ever find.
     */
    await deleteObject(stale.bucket_key).catch(() => undefined);
    await markExpired(stale.id);
    result.expired += 1;
  }

  return result;
}

async function scanOne(file: StoredFileRow): Promise<{ ok: boolean; derivatives: number }> {
  const bytes = await getObjectBytes(file.bucket_key);

  // 1. The size the store actually holds, again. `complete` checked this too, and
  //    checking twice is cheap next to storing a file nobody verified.
  if (bytes.byteLength !== Number(file.byte_size)) {
    await failFile(file, 'The stored file changed size after it was uploaded.', 'SIZE_MISMATCH');
    return { ok: false, derivatives: 0 };
  }

  // 2. The checksum, when the client offered one. A mismatch means the bytes that
  //    arrived are not the bytes that were sent, which is a corrupted upload
  //    rather than a malicious one — but it is still not evidence of anything.
  if (file.checksum_sha256) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== file.checksum_sha256) {
      await failFile(file, 'The uploaded file did not match its checksum.', 'CHECKSUM_MISMATCH');
      return { ok: false, derivatives: 0 };
    }
  }

  // 3. What the bytes say this is. The declared type is a claim by the client and
  //    was never evidence; this is the check the whole SCANNING state exists for.
  const sniffed = sniffContentType(bytes.subarray(0, HEAD_BYTES));
  if (!sniffedTypeAgrees(file.content_type, sniffed)) {
    await failFile(
      file,
      `This file is not the type it claims to be, so it was not stored (${file.original_filename}).`,
      'TYPE_MISMATCH'
    );
    // The bytes go too. Keeping a rejected object costs storage nobody agreed to
    // and leaves a file the store would happily serve if a key ever leaked.
    await deleteObject(file.bucket_key).catch(() => undefined);
    return { ok: false, derivatives: 0 };
  }

  const derivatives = await makeDerivatives(file, bytes);
  await markReady(file.id);
  return { ok: true, derivatives };
}

/**
 * Mark a file refused, and tell the person who uploaded it — in one transaction.
 *
 * **The event is the point, and it is why this is not a bare `markFailed`.** The
 * scan runs in a worker minutes after the upload, long after the screen that
 * started it has moved on. Without a notification, a refused photograph is
 * something Ade discovers weeks later when a report is one picture short. The
 * packet's §6 promises him the message; this is where it is owed.
 *
 * `reasonClass` and not the reason itself travels in the payload. The prose
 * carries `original_filename`, which is customer data — `scrubEvent` already made
 * that argument for error events, and an outbox payload read by a notification
 * body is the same surface with the same rule.
 */
async function failFile(
  file: StoredFileRow,
  reason: string,
  reasonClass: 'TYPE_MISMATCH' | 'SIZE_MISMATCH' | 'CHECKSUM_MISMATCH'
): Promise<void> {
  await withTransaction(async (client) => {
    const failed = await markFailed(file.id, reason, client);
    // Nothing moved — another pass got there first. Enqueueing anyway would be a
    // second notification for one refusal.
    if (!failed) return;
    await enqueueOutboxEvent(
      {
        topic: 'file.scan_failed',
        aggregateType: 'STORED_FILE',
        aggregateId: file.id,
        companyId: file.company_id,
        payload: {
          fileId: file.id,
          companyId: file.company_id,
          projectId: file.project_id,
          uploadedByUserId: file.uploaded_by_user_id,
          reasonClass,
        },
        idempotencyKey: `file.scan_failed:${file.id}`,
      },
      client
    );
  });
}

/**
 * `WEB` and `THUMB`, and the failure rule that matters more than either.
 *
 * **A derivative failure never fails the original.** A missing thumbnail is
 * cosmetic; a missing original is the evidence gone. So this returns a count and
 * swallows its own errors — the gallery shows the photo without a preview rather
 * than not at all, which is what the packet's §9 commits to.
 *
 * `sharp` is imported dynamically for the same reason. It is a native module, and
 * a platform without a working binary must degrade to "no thumbnails" rather than
 * refusing to boot the process that also drains notifications.
 */
async function makeDerivatives(file: StoredFileRow, bytes: Buffer): Promise<number> {
  if (!wantsDerivatives(file.kind, file.content_type)) return 0;

  let sharp: (input: Buffer) => import('sharp').Sharp;
  try {
    const mod = (await import('sharp')) as unknown as {
      default?: (input: Buffer) => import('sharp').Sharp;
    };
    // The package is CJS with an ESM interop shim, so under `tsx` the callable is
    // `default` and under some bundlers it is the namespace itself. Reaching for
    // one and assuming is how this fails only in production.
    const callable = mod.default ?? (mod as unknown as (input: Buffer) => import('sharp').Sharp);
    if (typeof callable !== 'function') throw new Error('sharp is not callable');
    sharp = callable;
  } catch {
    log('warn', 'storage_derivatives_unavailable', { storedFileId: file.id });
    return 0;
  }

  let made = 0;
  for (const variant of ['WEB', 'THUMB'] as const) {
    try {
      const spec = DERIVATIVE_SPECS[variant];
      const output = await sharp(bytes)
        // `withoutEnlargement` so a small original is never upscaled into a
        // larger "derivative" than the thing it derives from.
        .resize({ width: spec.longEdge, height: spec.longEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: spec.quality })
        .toBuffer();

      const key = derivativeKey(file, variant);
      await putObject({ key, body: output, contentType: 'image/webp' });
      const row = await insertDerivative({
        original: file,
        variant,
        bucketKey: key,
        contentType: 'image/webp',
        byteSize: output.byteLength,
      });
      /*
       * `insertDerivative` does nothing on conflict, which happens when a pass
       * was interrupted after writing the object but before committing the row.
       * The object is overwritten at the same key, so there is exactly one of it
       * and no second charge — the unique index is what makes that true rather
       * than hoped for.
       */
      if (row) made += 1;
    } catch {
      log('warn', 'storage_derivative_failed', { storedFileId: file.id });
    }
  }
  return made;
}

function derivativeKey(file: StoredFileRow, variant: Exclude<FileVariant, 'ORIGINAL'>): string {
  // The derivative sits under the ORIGINAL's own prefix, so a per-tenant or
  // per-project prefix delete takes the whole family with it.
  return buildBucketKey({
    companyId: keyCompanyOf(file),
    projectId: file.project_id,
    kind: file.kind,
    fileId: file.id,
    variant,
    contentType: `image/${extensionFor('image/webp')}`,
  });
}

/**
 * The company segment of the key, which must match the ORIGINAL's.
 *
 * The original's key was built from the *billed* company — the project owner —
 * not from `company_id`, which is the uploader. Rebuilding it from the row's own
 * `company_id` would put a subcontractor's derivative under a different prefix
 * from the photograph it derives from, and a prefix delete would then take one
 * and leave the other.
 */
function keyCompanyOf(file: StoredFileRow): string {
  const segments = file.bucket_key.split('/');
  return segments[1] ?? file.company_id;
}
