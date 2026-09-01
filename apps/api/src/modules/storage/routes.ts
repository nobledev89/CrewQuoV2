import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  buildBucketKey,
  bytesToGb,
  completeUploadSchema,
  formatBytes,
  isRenderableInline,
  presignUploadSchema,
  refuseUpload,
  type PresignedUpload,
  type StoredFile,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { queryOne } from '../../db';
import { env } from '../../env';
import { withinLimit } from '../entitlements/guards';
import { referencedFileIsReadable } from './references';
import { ensureBucket, headObject, presignGet, presignPut, storageConfigured } from './client';
import {
  findByClientId,
  findDerivatives,
  findFile,
  insertPending,
  markFailed,
  markScanning,
  type StoredFileRow,
} from './repo';

export const filesRouter = Router();

/**
 * Who pays for this upload, and who may make it (owner decision, 2026-09-01).
 *
 * A file on a project is charged to the **project owner**, not the uploader, so
 * that is also the company whose limit is checked. The uploader must still be one
 * of the two companies on the project's engagement — a capability never widens
 * company scope (§37), and this route is where a forged `projectId` would try to.
 */
async function resolveUploadScope(
  ctx: { companyId: string },
  projectId: string | null
): Promise<{ billedCompanyId: string; projectId: string | null }> {
  if (!projectId) return { billedCompanyId: ctx.companyId, projectId: null };

  /*
   * A provider's link to a project is its **assignment**, not
   * `projects.engagement_id`. That column is the *client* relationship — who the
   * project is for — while a project may carry several subcontractors, each on
   * its own engagement. `providerContextForProject` in the work module already
   * resolves it this way; reading the client edge instead refused every
   * subcontractor upload with a 404, which the acceptance script caught.
   */
  const row = await queryOne<{ company_id: string; assigned: boolean }>(
    `select p.owner_company_id as company_id,
            exists (
              select 1 from project_assignments a
               where a.project_id = p.id and a.provider_company_id = $2
            ) as assigned
       from projects p
      where p.id = $1`,
    [projectId, ctx.companyId]
  );
  // A project in another tenant answers exactly as one that never existed.
  if (!row) throw new AppError('NOT_FOUND', 'Project not found');

  const permitted = row.company_id === ctx.companyId || row.assigned;
  if (!permitted) throw new AppError('NOT_FOUND', 'Project not found');

  return { billedCompanyId: row.company_id, projectId };
}

/**
 * POST /v1/files/presign — validate, reserve a row, hand back a signed PUT.
 *
 * Nothing here touches bytes. The limit is checked against the **declared** size,
 * and `presignPut` signs that length into the URL so the store enforces the
 * number the check was made against — otherwise a caller could declare a
 * megabyte and upload four gigabytes past a limit that had already said yes.
 */
filesRouter.post(
  '/presign',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = presignUploadSchema.parse(req.body);

    if (!storageConfigured()) {
      throw new AppError('CONFLICT', 'File storage is not configured yet, so nothing was uploaded.');
    }
    await ensureBucket();

    const refusal = refuseUpload({
      kind: input.kind,
      contentType: input.contentType,
      byteSize: input.byteSize,
    });
    if (refusal) throw new AppError('VALIDATION', refusal.message, { code: refusal.code });

    const scope = await resolveUploadScope(ctx, input.projectId ?? null);

    /*
     * The replay branch, and the reason `clientId` exists at all (§8). A retry
     * from a tablet that lost signal mid-PUT must find its own row and its own
     * key. Minting a second would leave an orphaned byte-charge for an object
     * nothing references, which is the one failure here that costs a customer
     * money quietly.
     */
    if (input.clientId) {
      const existing = await findByClientId(ctx.companyId, input.clientId);
      if (existing) {
        if (existing.status !== 'PENDING') {
          throw new AppError('CONFLICT', 'That upload has already been completed.');
        }
        const replay = await presignPut({
          key: existing.bucket_key,
          contentType: existing.content_type,
          byteSize: Number(existing.byte_size),
        });
        const body: PresignedUpload = {
          fileId: existing.id,
          uploadUrl: replay.url,
          requiredHeaders: replay.requiredHeaders,
          expiresAt: replay.expiresAt.toISOString(),
          replayed: true,
        };
        res.status(200).json(body);
        return;
      }
    }

    /*
     * The limit is charged to the project owner. `projected` is a FRACTION of a
     * gigabyte, not a count — the one call site in this repository where
     * `withinLimit`'s argument does not mean "one more of the thing".
     */
    const projectedGb = bytesToGb(input.byteSize);
    if (!(await withinLimit(scope.billedCompanyId, 'storage_gb', projectedGb))) {
      throw new AppError(
        'LIMIT_EXCEEDED',
        `Storage is full — this file needs ${formatBytes(input.byteSize)} and the plan has no room for it.`,
        { limit: 'storage_gb' }
      );
    }
    if (scope.projectId && !(await withinLimit(scope.billedCompanyId, 'evidence_uploads_per_month'))) {
      throw new AppError('LIMIT_EXCEEDED', 'This month’s upload allowance is used up.', {
        limit: 'evidence_uploads_per_month',
      });
    }

    // The id is minted here because the key contains it, so the row cannot be
    // inserted before the key is known and the key cannot be built before the id.
    const fileId = randomUUID();
    const bucketKey = buildBucketKey({
      companyId: scope.billedCompanyId,
      projectId: scope.projectId,
      kind: input.kind,
      fileId,
      variant: 'ORIGINAL',
      contentType: input.contentType,
    });

    const row = await insertPending({
      id: fileId,
      companyId: ctx.companyId,
      projectId: scope.projectId,
      bucketKey,
      originalFilename: input.filename,
      contentType: input.contentType,
      byteSize: input.byteSize,
      kind: input.kind,
      clientId: input.clientId ?? null,
      uploadedByUserId: ctx.userId,
    });
    if (!row) throw new AppError('CONFLICT', 'Could not reserve that upload.');

    const signed = await presignPut({
      key: bucketKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
    });
    const body: PresignedUpload = {
      fileId,
      uploadUrl: signed.url,
      requiredHeaders: signed.requiredHeaders,
      expiresAt: signed.expiresAt.toISOString(),
      replayed: false,
    };
    res.status(201).json(body);
  })
);

/**
 * POST /v1/files/:id/complete — the client says its PUT finished.
 *
 * This does **not** set `READY`, and that is §13.5. The API never receives the
 * bytes, so it cannot sniff a content type; what it can do is ask the store what
 * is actually there and compare that with what was declared. The row moves to
 * `SCANNING` and the worker — which downloads the original to make derivatives
 * anyway — decides `READY` or `FAILED`.
 */
filesRouter.post(
  '/:id/complete',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const input = completeUploadSchema.parse(req.body ?? {});

    const file = await findFile(id);
    if (!file || file.company_id !== ctx.companyId) throw new AppError('NOT_FOUND', 'File not found');
    if (file.uploaded_by_user_id !== ctx.userId) {
      // Completing somebody else's reservation would let one member finish an
      // upload another member is still making, against a key they never chose.
      throw new AppError('NOT_FOUND', 'File not found');
    }
    if (file.status !== 'PENDING') {
      // Idempotent: a replayed complete is not an error, it is the same answer.
      res.json({ file: toView(file) });
      return;
    }

    // The store is the witness, not the caller. A client that reports 2 MB after
    // uploading 2 GB is exactly the case a declared size cannot catch.
    const head = await headObject(file.bucket_key);
    if (!head) {
      throw new AppError('CONFLICT', 'That file has not been uploaded yet.');
    }
    const declared = Number(file.byte_size);
    if (head.byteSize !== declared) {
      const failed = await markFailed(
        id,
        `The stored file is ${formatBytes(head.byteSize)}, not the ${formatBytes(declared)} that was reserved.`
      );
      throw new AppError('VALIDATION', failed?.failure_reason ?? 'The upload did not match its reservation.');
    }

    const scanning = await markScanning(id, {
      byteSize: head.byteSize,
      checksumSha256: input.checksumSha256?.toLowerCase() ?? null,
    });
    if (!scanning) throw new AppError('CONFLICT', 'That upload was already completed.');
    res.json({ file: toView(scanning) });
  })
);

/** GET /v1/files/:id — the record, including why it failed if it did. */
filesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const file = await readableFile(uuidParam(req, 'id'), ctx.companyId);
    res.json({ file: toView(file), derivatives: (await findDerivatives(file.id)).map(toView) });
  })
);

/**
 * GET /v1/files/:id/download — a short-lived signed URL, minted per request.
 *
 * Never a list. A gallery asks for one of these per visible tile, because a
 * presigned URL is a bearer capability with a URL for a body: anybody holding it
 * has the bytes and it cannot be recalled inside its lifetime. Handing back a
 * hundred at once turns one authorized read into a hundred uncontrolled ones.
 */
filesRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const file = await readableFile(uuidParam(req, 'id'), ctx.companyId);
    if (file.status !== 'READY') {
      throw new AppError('CONFLICT', 'That file is not ready to download yet.');
    }
    const url = await presignGet({
      key: file.bucket_key,
      filename: file.original_filename,
      contentType: file.content_type,
      // Anything a browser could execute against the origin serving it is forced
      // to download rather than render, whatever the store would otherwise do.
      inline: isRenderableInline(file.content_type),
    });
    res.json({ url, expiresInMinutes: env.STORAGE_URL_TTL_MINUTES });
  })
);

/**
 * The one authorization rule for reading a file, in one place.
 *
 * A file is readable by the company that uploaded it, by the company that owns
 * its project, and by whoever a **record referencing it** has deliberately
 * disclosed it to. The first two are the floor; the third is the packet's §4 rule
 * that a download is governed by *"whichever hop the referencing record allows"*.
 *
 * **This corrects the note that stood here from 7.0**, which said record rules
 * would only ever narrow the floor and never widen it. Publishing evidence to a
 * client is exactly a widening, and it is the entire point of the flag: the
 * client is on neither side of the file's own two companies, and a disclosure the
 * project owner deliberately made must reach them or `client_visible` means
 * nothing. The floor is still a floor — nothing here is reachable *without* a
 * record that names the caller — and the widening is per record, per file, and
 * revocable going forward.
 *
 * A derivative is reachable through its original's record, so a thumbnail is
 * never a way around a rule its full-size photograph obeys.
 */
async function readableFile(id: string, companyId: string): Promise<StoredFileRow> {
  const file = await findFile(id);
  if (!file) throw new AppError('NOT_FOUND', 'File not found');
  if (file.company_id === companyId) return file;

  if (file.project_id) {
    const owner = await queryOne<{ company_id: string }>(
      `select owner_company_id as company_id from projects where id = $1`,
      [file.project_id]
    );
    if (owner?.company_id === companyId) return file;
  }

  /*
   * The record-granted hops, as a registry (`references.ts`) rather than a list of
   * `if`s that each later phase has to remember to extend. Evidence and documents
   * are in it today; 7.5's diary attachments and Phase 8's weight documents join
   * it there rather than here.
   */
  if (await referencedFileIsReadable(id, companyId)) return file;

  // Not 403 — a forged id must not confirm that somebody else's file exists.
  throw new AppError('NOT_FOUND', 'File not found');
}

function toView(row: StoredFileRow): StoredFile {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    checksumSha256: row.checksum_sha256,
    kind: row.kind,
    variant: row.variant,
    status: row.status,
    failureReason: row.failure_reason,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}
