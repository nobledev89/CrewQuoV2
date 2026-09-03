import { query, queryOne, withTransaction } from '../../db';
import { resolveEntitlements } from '../entitlements/resolve';
import { deleteObject } from './client';

interface Candidate {
  id: string;
  owner_company_id: string;
  retention_class: 'PROJECT' | 'TEMPORARY';
  anchor_at: Date;
}

export interface ArtifactRetentionResult {
  scanned: number;
  reclaimed: number;
  objectsDeleted: number;
  objectFailures: number;
}

export function artifactRetentionDue(anchor: Date, now: Date, days: number | null | undefined): boolean {
  if (days === null || days === undefined) return false;
  return anchor.getTime() + days * 86_400_000 <= now.getTime();
}

/**
 * Reclaim completed-project bytes without deleting the evidence rows which name
 * them. `report_file_references` and variation approval evidence are permanent
 * holds. Queueing every bucket key in the same transaction makes object deletion
 * retryable after process or store failure.
 */
export async function runArtifactRetentionBatch(limit = 200): Promise<ArtifactRetentionResult> {
  const candidates = await query<Candidate>(
    `select f.id, coalesce(p.owner_company_id, f.company_id) as owner_company_id,
            f.retention_class,
            case when f.retention_class = 'TEMPORARY' then f.created_at
                 else greatest(p.updated_at, coalesce(p.ends_on::timestamptz, p.updated_at)) end as anchor_at
       from stored_files f
       left join projects p on p.id = f.project_id
      where f.status = 'READY' and f.variant = 'ORIGINAL'
        and f.retention_class in ('PROJECT','TEMPORARY')
        and (f.retention_class = 'TEMPORARY' or p.status in ('COMPLETED','ARCHIVED'))
      order by anchor_at, f.id limit $1`,
    [limit]
  );
  const result: ArtifactRetentionResult = {
    scanned: candidates.length,
    reclaimed: 0,
    objectsDeleted: 0,
    objectFailures: 0,
  };
  const now = new Date();

  for (const candidate of candidates) {
    const days = candidate.retention_class === 'TEMPORARY'
      ? 30
      : (await resolveEntitlements(candidate.owner_company_id)).limits.artifact_retention_days;
    if (!artifactRetentionDue(candidate.anchor_at, now, days)) continue;

    const reclaimed = await withTransaction(async (client) => {
      const current = await queryOne<{ id: string }>(
        `select id from stored_files where id = $1 and status = 'READY' for update`,
        [candidate.id],
        client
      );
      if (!current) return false;
      const held = await queryOne<{ held: boolean }>(
        `select exists (
           select 1 from report_file_references r
            where r.file_id = $1 or r.file_id in
              (select id from stored_files where derivative_of = $1)
           union all
           select 1 from variations v where v.approval_evidence_file_id = $1
         ) as held`,
        [candidate.id],
        client
      );
      if (held?.held) return false;

      await client.query(
        `with reclaimed as (
           update stored_files set status = 'DELETED', updated_at = now()
            where id = $1 or derivative_of = $1
            returning id, bucket_key
         )
         insert into artifact_deletion_queue (file_id, bucket_key)
         select id, bucket_key from reclaimed on conflict (bucket_key) do nothing`,
        [candidate.id]
      );
      return true;
    });
    if (reclaimed) result.reclaimed += 1;
  }

  const queued = await query<{ id: string; bucket_key: string }>(
    `select id, bucket_key from artifact_deletion_queue
      where status = 'PENDING' order by created_at limit $1`,
    [limit * 3]
  );
  for (const item of queued) {
    try {
      await deleteObject(item.bucket_key);
      await query(
        `update artifact_deletion_queue
            set status = 'DELETED', attempts = attempts + 1, deleted_at = now(), last_error_class = null
          where id = $1`,
        [item.id]
      );
      result.objectsDeleted += 1;
    } catch (error) {
      await query(
        `update artifact_deletion_queue
            set attempts = attempts + 1, last_error_class = $2
          where id = $1`,
        [item.id, error instanceof Error ? error.name : 'UnknownError']
      );
      result.objectFailures += 1;
    }
  }
  return result;
}
