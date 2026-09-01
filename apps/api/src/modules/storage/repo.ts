import {
  METERED_STATUSES,
  PENDING_UPLOAD_TTL_HOURS,
  type FileKind,
  type FileStatus,
  type FileVariant,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

export interface StoredFileRow {
  id: string;
  company_id: string;
  project_id: string | null;
  bucket_key: string;
  original_filename: string;
  content_type: string;
  byte_size: string;
  checksum_sha256: string | null;
  kind: FileKind;
  variant: FileVariant;
  derivative_of: string | null;
  status: FileStatus;
  failure_reason: string | null;
  client_id: string | null;
  uploaded_by_user_id: string;
  created_at: Date;
}

const COLUMNS = `id, company_id, project_id, bucket_key, original_filename, content_type,
  byte_size, checksum_sha256, kind, variant, derivative_of, status, failure_reason,
  client_id, uploaded_by_user_id, created_at`;

export function findFile(id: string, runner?: Queryable): Promise<StoredFileRow | null> {
  return queryOne<StoredFileRow>(`select ${COLUMNS} from stored_files where id = $1`, [id], runner);
}

/** A replayed presign must find its own row rather than mint a second key (§8). */
export function findByClientId(
  companyId: string,
  clientId: string,
  runner?: Queryable
): Promise<StoredFileRow | null> {
  return queryOne<StoredFileRow>(
    `select ${COLUMNS} from stored_files where company_id = $1 and client_id = $2`,
    [companyId, clientId],
    runner
  );
}

export function insertPending(
  args: {
    id: string;
    companyId: string;
    projectId: string | null;
    bucketKey: string;
    originalFilename: string;
    contentType: string;
    byteSize: number;
    kind: FileKind;
    clientId: string | null;
    uploadedByUserId: string;
  },
  runner?: Queryable
): Promise<StoredFileRow | null> {
  return queryOne<StoredFileRow>(
    `insert into stored_files
       (id, company_id, project_id, bucket_key, original_filename, content_type,
        byte_size, kind, client_id, uploaded_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning ${COLUMNS}`,
    [
      args.id,
      args.companyId,
      args.projectId,
      args.bucketKey,
      args.originalFilename,
      args.contentType,
      args.byteSize,
      args.kind,
      args.clientId,
      args.uploadedByUserId,
    ],
    runner
  );
}

/**
 * PENDING → SCANNING, guarded on the current status.
 *
 * `where status = 'PENDING'` is the concurrency control: two clients calling
 * complete for one file must not both enqueue a scan, and a file already swept to
 * EXPIRED must not walk backwards into the pipeline.
 */
export function markScanning(
  id: string,
  args: { byteSize: number; checksumSha256: string | null },
  runner?: Queryable
): Promise<StoredFileRow | null> {
  return queryOne<StoredFileRow>(
    `update stored_files
        set status = 'SCANNING', byte_size = $2, checksum_sha256 = $3, updated_at = now()
      where id = $1 and status = 'PENDING'
      returning ${COLUMNS}`,
    [id, args.byteSize, args.checksumSha256],
    runner
  );
}

export function markReady(id: string, runner?: Queryable): Promise<StoredFileRow | null> {
  return queryOne<StoredFileRow>(
    `update stored_files set status = 'READY', failure_reason = null, updated_at = now()
      where id = $1 and status = 'SCANNING' returning ${COLUMNS}`,
    [id],
    runner
  );
}

export function markFailed(id: string, reason: string, runner?: Queryable): Promise<StoredFileRow | null> {
  return queryOne<StoredFileRow>(
    `update stored_files set status = 'FAILED', failure_reason = $2, updated_at = now()
      where id = $1 and status in ('PENDING','SCANNING') returning ${COLUMNS}`,
    [id, reason],
    runner
  );
}

export function claimScanning(limit: number, runner?: Queryable): Promise<StoredFileRow[]> {
  return query<StoredFileRow>(
    `select ${COLUMNS} from stored_files
      where status = 'SCANNING' and variant = 'ORIGINAL'
      order by created_at asc limit $1`,
    [limit],
    runner
  );
}

export function insertDerivative(
  args: {
    original: StoredFileRow;
    variant: Exclude<FileVariant, 'ORIGINAL'>;
    bucketKey: string;
    contentType: string;
    byteSize: number;
  },
  runner?: Queryable
): Promise<StoredFileRow | null> {
  return queryOne<StoredFileRow>(
    `insert into stored_files
       (company_id, project_id, bucket_key, original_filename, content_type, byte_size,
        kind, variant, derivative_of, status, uploaded_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'READY', $10)
     on conflict (derivative_of, variant) where derivative_of is not null do nothing
     returning ${COLUMNS}`,
    [
      args.original.company_id,
      args.original.project_id,
      args.bucketKey,
      args.original.original_filename,
      args.contentType,
      args.byteSize,
      args.original.kind,
      args.variant,
      args.original.id,
      args.original.uploaded_by_user_id,
    ],
    runner
  );
}

export function findDerivatives(originalId: string, runner?: Queryable): Promise<StoredFileRow[]> {
  return query<StoredFileRow>(
    `select ${COLUMNS} from stored_files where derivative_of = $1`,
    [originalId],
    runner
  );
}

/**
 * Unfinished uploads older than the TTL.
 *
 * Returned rather than deleted, because the object may exist even though the row
 * says PENDING — a client that PUT successfully and then lost the connection
 * before calling complete leaves exactly that. The sweep deletes the object too,
 * or the store accumulates bytes no row can find.
 */
export function findExpiredPending(limit: number, runner?: Queryable): Promise<StoredFileRow[]> {
  return query<StoredFileRow>(
    `select ${COLUMNS} from stored_files
      where status = 'PENDING' and created_at < now() - interval '${PENDING_UPLOAD_TTL_HOURS} hours'
      order by created_at asc limit $1`,
    [limit],
    runner
  );
}

export async function markExpired(id: string, runner?: Queryable): Promise<void> {
  await query(
    `update stored_files set status = 'EXPIRED', updated_at = now()
      where id = $1 and status = 'PENDING'`,
    [id],
    runner
  );
}

// ── Metering ─────────────────────────────────────────────────────────────────

/**
 * Bytes charged to a company, per the owner decision of 2026-09-01: **the
 * project-owning company, not the uploader.**
 *
 * The join is the decision, made executable. A file on a project is charged to
 * that project's company; a company-level file is charged to `company_id`. As
 * specified — `company_id` alone — a Crew-plan subcontractor's one gigabyte would
 * have paid for the hiring company's evidence pack.
 *
 * `PENDING` and `SCANNING` count as well as `READY`. Counting only completed
 * files would let a client presign a thousand uploads and PUT them all before any
 * completes, which is the limit being asked a question it cannot answer in time.
 */
export async function storageBytesForCompany(companyId: string, runner?: Queryable): Promise<number> {
  const statuses = METERED_STATUSES.map((s) => `'${s}'`).join(', ');
  const row = await queryOne<{ total: string | null }>(
    `select coalesce(sum(f.byte_size), 0)::bigint as total
       from stored_files f
       left join projects p on p.id = f.project_id
      where f.status in (${statuses})
        and coalesce(p.owner_company_id, f.company_id) = $1`,
    [companyId],
    runner
  );
  return Number(row?.total ?? 0);
}

/**
 * Files added to this company's projects inside its own current month.
 *
 * The window boundary is the company's IANA zone, not the server's. A company in
 * Manila whose month rolls over at 16:00 UTC on the last day would otherwise be
 * told it was still in the old month for eight hours, or the new one early,
 * depending on which side of the date line the server sat.
 */
export async function evidenceUploadsThisMonth(companyId: string, runner?: Queryable): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `with tz as (select coalesce(time_zone, 'UTC') as zone from companies where id = $1)
     select count(*)::int as n
       from stored_files f
       left join projects p on p.id = f.project_id
      where f.status in ('PENDING','SCANNING','READY')
        and f.variant = 'ORIGINAL'
        and f.project_id is not null
        and coalesce(p.owner_company_id, f.company_id) = $1
        and f.created_at >= (
          date_trunc('month', (now() at time zone (select zone from tz)))
        ) at time zone (select zone from tz)`,
    [companyId],
    runner
  );
  return Number(row?.n ?? 0);
}
