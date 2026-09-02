'use client';

import type { FileKind } from '@crewquo/shared';
import { api, ApiError } from '@/api/client';

/**
 * The browser half of §22.1's three-step upload: presign → PUT → complete.
 *
 * **Bytes never pass through the API**, which is the whole reason this lives in
 * the client rather than behind a `POST /upload`. The API mints a signed URL, the
 * browser PUTs straight to the object store, and a second call tells the API what
 * the store now holds. The type check happens server-side afterwards, because the
 * API never saw the bytes and a client's declared content type is precisely what
 * sniffing exists to disbelieve.
 *
 * **A partial batch must never lose the files that worked** (packet §9, and the
 * row the whole failure surface was built around). Ade is standing in a stairwell
 * with forty photographs; an "upload failed" that discards thirty-seven successes
 * is a product that trains him to stop using it. So every file is attempted
 * independently and the result carries both lists, with a reason per failure that
 * a person can act on.
 */

export interface UploadedFile {
  fileId: string;
  file: File;
  /** True when the presign replayed rather than minting a second bucket key. */
  replayed: boolean;
}

export interface UploadFailure {
  file: File;
  message: string;
  /** True when trying again is worth offering. A refused type is not. */
  retryable: boolean;
}

export interface UploadOutcome {
  uploaded: UploadedFile[];
  failed: UploadFailure[];
}

export interface UploadSession {
  accessToken: string;
  companyId: string;
}

/**
 * The SHA-256 the API records beside the bytes, computed here because here is the
 * only place that has them.
 *
 * `crypto.subtle` needs a secure context, which `https` and `localhost` both are
 * and a bare LAN IP is not. **Absent, the upload proceeds without a checksum**
 * rather than failing: `completeUploadSchema` makes it optional, the object
 * store's own size check still runs, and refusing to upload a photograph because
 * the page was opened over plain http would be a worse failure than a record with
 * one less corroborating field.
 */
async function checksumOf(file: File): Promise<string | undefined> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return undefined;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return undefined;
  }
}

function messageFor(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof ApiError) {
    // 422 is the store or the policy saying no to *this file* — a type it does not
    // accept, a size over the cap. Trying again produces the same answer, and an
    // offered retry that cannot succeed is worse than none.
    return { message: err.message, retryable: err.status !== 422 && err.status !== 403 };
  }
  return { message: 'That upload did not finish. Your file is still on this device.', retryable: true };
}

/**
 * Upload one file and return its `stored_files` id.
 *
 * `clientId` is minted here, before the network is consulted, and it is the one
 * idempotency key in the product whose absence orphans **bytes** rather than
 * merely duplicating a row: a replayed presign without it mints a second bucket
 * key, and the retry Ade's tablet makes in a stairwell leaves a charge against
 * somebody's storage allowance for an object nothing references.
 */
export async function uploadFile(
  session: UploadSession,
  file: File,
  args: { kind: FileKind; projectId?: string | null; clientId?: string }
): Promise<UploadedFile> {
  const presigned = await api.presignUpload(session.accessToken, session.companyId, {
    kind: args.kind,
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    byteSize: file.size,
    projectId: args.projectId ?? null,
    clientId: args.clientId ?? crypto.randomUUID(),
  });

  const put = await fetch(presigned.uploadUrl, {
    method: 'PUT',
    headers: presigned.requiredHeaders,
    body: file,
  });
  if (!put.ok) {
    throw new ApiError(put.status, 'UPLOAD_FAILED', 'The file could not be sent to storage.');
  }

  await api.completeUpload(session.accessToken, session.companyId, presigned.fileId, {
    byteSize: file.size,
    checksumSha256: await checksumOf(file),
  });

  return { fileId: presigned.fileId, file, replayed: presigned.replayed };
}

/**
 * Upload a selection, keeping whatever succeeds.
 *
 * Sequential rather than parallel, and that is a deliberate trade. Forty
 * concurrent PUTs from a tablet on site contend for one bad connection and fail
 * together; one at a time is slower on a good connection and is the difference
 * between "37 of 40 stored" and "nothing stored" on a poor one — which is the
 * scenario this product is for. `onProgress` exists so the screen can say which
 * one it is on rather than showing a spinner for a minute.
 */
export async function uploadFiles(
  session: UploadSession,
  files: readonly File[],
  args: {
    kind: FileKind;
    projectId?: string | null;
    onProgress?: (done: number, total: number, current: File) => void;
  }
): Promise<UploadOutcome> {
  const uploaded: UploadedFile[] = [];
  const failed: UploadFailure[] = [];

  for (const [index, file] of files.entries()) {
    args.onProgress?.(index, files.length, file);
    try {
      uploaded.push(await uploadFile(session, file, { kind: args.kind, projectId: args.projectId }));
    } catch (err) {
      const { message, retryable } = messageFor(err);
      failed.push({ file, message, retryable });
    }
  }
  args.onProgress?.(files.length, files.length, files[files.length - 1] as File);
  return { uploaded, failed };
}

/** Human bytes, for a refusal that has to name a size a person recognises. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
