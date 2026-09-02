import type { EvidenceCategory, EvidenceFilter, EvidenceView } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * Reads and writes for `project_evidence` (0030).
 *
 * The joins here are the interesting part. Derivatives are found through
 * `stored_files.derivative_of` rather than from columns on this table, so a
 * preview that failed once and succeeds on the next worker pass simply appears —
 * no back-fill, and no column that is null in production because a job did not
 * run.
 */

export interface EvidenceRow {
  id: string;
  project_id: string;
  company_id: string;
  file_id: string;
  web_file_id: string | null;
  thumb_file_id: string | null;
  category: EvidenceCategory;
  caption: string | null;
  notes: string | null;
  evidence_date: string | null;
  captured_at: Date | null;
  location_id: string | null;
  diary_entry_id: string | null;
  gps_lat: string | null;
  gps_lng: string | null;
  gps_accuracy_m: string | null;
  client_visible: boolean;
  first_published_at: Date | null;
  sort_order: number;
  uploaded_by_user_id: string | null;
  batch_client_id: string | null;
  revision: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  file_status: string;
  file_failure_reason: string | null;
  content_type: string;
  byte_size: string;
  original_filename: string;
}

const FIELDS = `
  e.id, e.project_id, e.company_id, e.file_id,
  e.category, e.caption, e.notes,
  to_char(e.evidence_date, 'YYYY-MM-DD') as evidence_date,
  e.captured_at, e.location_id, e.diary_entry_id,
  e.gps_lat, e.gps_lng, e.gps_accuracy_m,
  e.client_visible, e.first_published_at, e.sort_order,
  e.uploaded_by_user_id, e.batch_client_id,
  e.revision, e.deleted_at, e.created_at, e.updated_at,
  f.status as file_status, f.failure_reason as file_failure_reason,
  f.content_type, f.byte_size, f.original_filename,
  w.id as web_file_id, t.id as thumb_file_id`;

const JOINS = `
  join stored_files f on f.id = e.file_id
  left join stored_files w on w.derivative_of = e.file_id and w.variant = 'WEB'
  left join stored_files t on t.derivative_of = e.file_id and t.variant = 'THUMB'`;

const SELECT = `select ${FIELDS} from project_evidence e ${JOINS}`;

/**
 * The same projection, read out of a data-modifying CTE rather than out of the
 * table.
 *
 * **This distinction is not a style choice and it is silent when it is wrong.** A
 * statement shaped `with written as (insert ... returning id) select ... from
 * project_evidence where id in (select id from written)` returns *nothing*: every
 * part of a statement sees the same snapshot, taken before the statement ran, so
 * the outer read of the table cannot see the row the CTE just wrote. Selecting
 * from the CTE's own output works, because that output is not a table read. The
 * write path would have returned null for every successful insert, which reads
 * exactly like a conflict — the failure would have looked like the duplicate rule
 * working.
 */
function selectFromCte(cte: string): string {
  return `select ${FIELDS} from ${cte} e ${JOINS}`;
}

/**
 * Who is asking, and therefore what they may be shown.
 *
 * §7 classifies evidence as *private to the uploading company and the project
 * owner*, so a second subcontractor on the same project sees none of the first
 * one's photographs. The client sees exactly what was published to them. Written
 * as a discriminated union rather than a pair of booleans because the three cases
 * are genuinely different rules, and a boolean pair has a fourth state that means
 * nothing.
 */
export type EvidenceScope =
  | { kind: 'OWNER' }
  | { kind: 'PROVIDER'; companyId: string }
  | { kind: 'CLIENT' };

function scopeClause(scope: EvidenceScope, params: unknown[]): string {
  switch (scope.kind) {
    case 'OWNER':
      return '';
    case 'PROVIDER':
      params.push(scope.companyId);
      return ` and e.company_id = $${params.length}`;
    case 'CLIENT':
      return ' and e.client_visible = true';
  }
}

export function toEvidenceView(row: EvidenceRow): EvidenceView {
  return {
    id: row.id,
    projectId: row.project_id,
    companyId: row.company_id,
    fileId: row.file_id,
    webFileId: row.web_file_id,
    thumbFileId: row.thumb_file_id,
    category: row.category,
    caption: row.caption,
    notes: row.notes,
    evidenceDate: row.evidence_date,
    capturedAt: row.captured_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    locationId: row.location_id,
    diaryEntryId: row.diary_entry_id,
    // `numeric` arrives as a string so precision survives the wire; it becomes a
    // number exactly once, here, rather than in each caller that forgets.
    gpsLat: row.gps_lat === null ? null : Number(row.gps_lat),
    gpsLng: row.gps_lng === null ? null : Number(row.gps_lng),
    gpsAccuracyM: row.gps_accuracy_m === null ? null : Number(row.gps_accuracy_m),
    clientVisible: row.client_visible,
    firstPublishedAt: row.first_published_at?.toISOString() ?? null,
    sortOrder: row.sort_order,
    uploadedByUserId: row.uploaded_by_user_id,
    batchClientId: row.batch_client_id,
    revision: row.revision,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    fileStatus: row.file_status,
    fileFailureReason: row.file_failure_reason,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    originalFilename: row.original_filename,
  };
}

/** §22.4's filters, as one parameterised statement rather than string assembly. */
export async function listEvidence(
  projectId: string,
  scope: EvidenceScope,
  filter: EvidenceFilter,
  runner?: Queryable
): Promise<EvidenceRow[]> {
  const params: unknown[] = [projectId];
  let where = ' where e.project_id = $1 and e.deleted_at is null';
  where += scopeClause(scope, params);

  if (filter.category && filter.category.length > 0) {
    params.push(filter.category);
    where += ` and e.category = any($${params.length}::text[])`;
  }
  if (filter.from) {
    params.push(filter.from);
    where += ` and e.evidence_date >= $${params.length}::date`;
  }
  if (filter.to) {
    params.push(filter.to);
    where += ` and e.evidence_date <= $${params.length}::date`;
  }
  if (filter.uploadedByUserId) {
    params.push(filter.uploadedByUserId);
    where += ` and e.uploaded_by_user_id = $${params.length}`;
  }
  if (filter.locationId) {
    params.push(filter.locationId);
    where += ` and e.location_id = $${params.length}`;
  }
  if (filter.diaryEntryId) {
    params.push(filter.diaryEntryId);
    where += ` and e.diary_entry_id = $${params.length}`;
  }
  if (filter.clientVisible !== undefined) {
    params.push(filter.clientVisible);
    where += ` and e.client_visible = $${params.length}`;
  }
  if (filter.batchClientId) {
    params.push(filter.batchClientId);
    where += ` and e.batch_client_id = $${params.length}`;
  }

  /*
   * Ordered in SQL as well as in `compareEvidence`, and that is not a duplicate
   * rule: the ordering has to be right *before* the limit, or a page is a
   * different set of rows rather than a different view of the same ones. The pure
   * comparator then holds for anything assembled client-side from several pages.
   *
   * `nulls last` on the date is the undated group sorting to the end — it is real
   * evidence and must be visible, but it has made no claim about which day it
   * belongs to.
   */
  params.push(filter.limit ?? 500);
  const limitParam = `$${params.length}`;
  params.push(filter.offset ?? 0);
  const offsetParam = `$${params.length}`;

  return query<EvidenceRow>(
    `${SELECT}${where}
      order by e.evidence_date desc nulls last, e.sort_order asc, e.created_at desc
      limit ${limitParam} offset ${offsetParam}`,
    params,
    runner
  );
}

/** Category counts over the whole scoped set, ignoring paging. */
export async function countEvidenceByCategory(
  projectId: string,
  scope: EvidenceScope,
  runner?: Queryable
): Promise<Partial<Record<EvidenceCategory, number>>> {
  const params: unknown[] = [projectId];
  const where = ` where e.project_id = $1 and e.deleted_at is null${scopeClause(scope, params)}`;
  const rows = await query<{ category: EvidenceCategory; n: string }>(
    `select e.category, count(*)::int as n from project_evidence e${where} group by e.category`,
    params,
    runner
  );
  const counts: Partial<Record<EvidenceCategory, number>> = {};
  for (const row of rows) counts[row.category] = Number(row.n);
  return counts;
}

/**
 * One record, tombstone included.
 *
 * Deliberately does not filter `deleted_at`: the caller has to see a tombstone in
 * order to answer 410 rather than 404, and the disclosure rule — only to somebody
 * who could have read the live row — is enforced in the route, after
 * authorization, where it belongs.
 */
export function findEvidence(id: string, runner?: Queryable): Promise<EvidenceRow | null> {
  return queryOne<EvidenceRow>(`${SELECT} where e.id = $1`, [id], runner);
}

export interface InsertEvidenceArgs {
  projectId: string;
  companyId: string;
  fileId: string;
  category: EvidenceCategory;
  caption: string | null;
  notes: string | null;
  evidenceDate: string | null;
  capturedAt: string | null;
  locationId: string | null;
  diaryEntryId: string | null;
  sortOrder: number;
  uploadedByUserId: string;
  batchClientId: string | null;
}

export function insertEvidence(
  args: InsertEvidenceArgs,
  runner?: Queryable
): Promise<EvidenceRow | null> {
  return queryOne<EvidenceRow>(
    `with inserted as (
       insert into project_evidence
         (project_id, company_id, file_id, category, caption, notes, evidence_date,
          captured_at, location_id, diary_entry_id, sort_order, uploaded_by_user_id,
          batch_client_id)
       values ($1,$2,$3,$4,$5,$6,$7::date,$8::timestamptz,$9,$10,$11,$12,$13)
       -- The partial unique index on a live file is the arbiter, not a prior
       -- select: two simultaneous retries of one batch both find no row and both
       -- insert, which is the check-then-act the sync contract already caught
       -- once in this phase. DO NOTHING makes the loser return no row, and the
       -- caller reports the file as already attached rather than duplicating it.
       on conflict (file_id) where deleted_at is null do nothing
       returning *
     )
     ${selectFromCte('inserted')}`,
    [
      args.projectId,
      args.companyId,
      args.fileId,
      args.category,
      args.caption,
      args.notes,
      args.evidenceDate,
      args.capturedAt,
      args.locationId,
      args.diaryEntryId,
      args.sortOrder,
      args.uploadedByUserId,
      args.batchClientId,
    ],
    runner
  );
}

export interface EvidencePatch {
  category?: EvidenceCategory;
  caption?: string | null;
  notes?: string | null;
  evidenceDate?: string | null;
  capturedAt?: string | null;
  locationId?: string | null;
  diaryEntryId?: string | null;
  sortOrder?: number;
}

const PATCH_COLUMNS: Record<keyof EvidencePatch, { column: string; cast: string }> = {
  category: { column: 'category', cast: '' },
  caption: { column: 'caption', cast: '' },
  notes: { column: 'notes', cast: '' },
  evidenceDate: { column: 'evidence_date', cast: '::date' },
  capturedAt: { column: 'captured_at', cast: '::timestamptz' },
  locationId: { column: 'location_id', cast: '::uuid' },
  diaryEntryId: { column: 'diary_entry_id', cast: '::uuid' },
  sortOrder: { column: 'sort_order', cast: '::int' },
};

function assignments(patch: EvidencePatch, params: unknown[]): string[] {
  const sets: string[] = [];
  for (const key of Object.keys(patch) as (keyof EvidencePatch)[]) {
    const spec = PATCH_COLUMNS[key];
    params.push(patch[key]);
    sets.push(`${spec.column} = $${params.length}${spec.cast}`);
  }
  return sets;
}

/**
 * One record's metadata, with the optimistic-concurrency check **inside the
 * statement**.
 *
 * The comparison lives in the `where` rather than in the handler for the reason
 * the live suite proved on locations: two tabs composing against revision 4 both
 * pass a check done beforehand and both write, so the second silently overwrites
 * the first and nobody is told. Here the row lock makes it atomic.
 */
export async function updateEvidence(
  id: string,
  patch: EvidencePatch,
  expectedRevision: number | undefined,
  runner?: Queryable
): Promise<EvidenceRow | null> {
  const params: unknown[] = [id];
  const sets = assignments(patch, params);
  if (sets.length === 0) return findEvidence(id, runner);

  let guard = '';
  if (expectedRevision !== undefined) {
    params.push(expectedRevision);
    guard = ` and revision = $${params.length}`;
  }

  return queryOne<EvidenceRow>(
    `with updated as (
       update project_evidence
          set ${sets.join(', ')}
        where id = $1 and deleted_at is null${guard}
        returning *
     )
     ${selectFromCte('updated')}`,
    params,
    runner
  );
}

/**
 * The same patch across a selection, scoped to the project and to what the caller
 * may edit.
 *
 * `editableCompanyId` is null for the project owner, who may re-tag anything on
 * their own project, and set for a provider, who may only edit its own rows (§4).
 * Scoping in the statement rather than by pre-filtering ids means a forged id in
 * the list changes nothing instead of changing something.
 */
export async function bulkUpdateEvidence(
  args: {
    projectId: string;
    ids: readonly string[];
    patch: EvidencePatch;
    editableCompanyId: string | null;
  },
  runner?: Queryable
): Promise<EvidenceRow[]> {
  const params: unknown[] = [args.projectId, args.ids];
  const sets = assignments(args.patch, params);
  let scope = '';
  if (args.editableCompanyId !== null) {
    params.push(args.editableCompanyId);
    scope = ` and company_id = $${params.length}`;
  }
  return query<EvidenceRow>(
    `with updated as (
       update project_evidence
          set ${sets.join(', ')}
        where project_id = $1 and id = any($2::uuid[]) and deleted_at is null${scope}
        returning *
     )
     ${selectFromCte('updated')}`,
    params,
    runner
  );
}

/**
 * Publish or hide a selection.
 *
 * `first_published_at` is set with `coalesce`, so it records the **first**
 * disclosure and every later publish leaves it alone. It is never cleared on the
 * way back down: hiding removes the record from the client's view from now on and
 * withdraws nothing they have already seen.
 */
export function setClientVisible(
  args: { projectId: string; ids: readonly string[]; clientVisible: boolean },
  runner?: Queryable
): Promise<EvidenceRow[]> {
  return query<EvidenceRow>(
    `with updated as (
       update project_evidence
          set client_visible = $3,
              first_published_at = case
                when $3 then coalesce(first_published_at, now())
                else first_published_at
              end
        where project_id = $1 and id = any($2::uuid[]) and deleted_at is null
        returning *
     )
     ${selectFromCte('updated')}`,
    [args.projectId, args.ids, args.clientVisible],
    runner
  );
}

/** A delete is a tombstone (0029), so a stale client is told rather than left to infer. */
export function tombstoneEvidence(id: string, runner?: Queryable): Promise<EvidenceRow | null> {
  return queryOne<EvidenceRow>(
    `with deleted as (
       update project_evidence set deleted_at = now()
        where id = $1 and deleted_at is null
        returning *
     )
     ${selectFromCte('deleted')}`,
    [id],
    runner
  );
}

/**
 * The files a batch wants to attach, with everything the refusal rules need.
 *
 * One query for the whole selection rather than one per file: a forty-photograph
 * batch would otherwise be forty round trips before any work started, and the
 * batch endpoint's whole reason for existing is that forty is the normal case.
 */
export interface AttachCandidate {
  id: string;
  company_id: string;
  project_id: string | null;
  status: string;
  attached: boolean;
}

export function findAttachCandidates(
  args: { fileIds: readonly string[]; uploaderCompanyId: string },
  runner?: Queryable
): Promise<AttachCandidate[]> {
  return query<AttachCandidate>(
    `select f.id, f.company_id, f.project_id, f.status,
            exists (
              select 1 from project_evidence e
               where e.file_id = f.id and e.deleted_at is null
            ) as attached
       from stored_files f
      where f.id = any($1::uuid[])
        and f.company_id = $2
        and f.variant = 'ORIGINAL'`,
    [args.fileIds, args.uploaderCompanyId],
    runner
  );
}

/**
 * Does a client company have a published piece of evidence pointing at this file?
 *
 * This is the one hop the storage layer's floor does not grant, and it is granted
 * by a record rather than by a relationship — which is exactly what publishing
 * *is*. Kept here, beside the records that decide it, rather than in the storage
 * module, so the file layer stays ignorant of what references it.
 */
export async function fileDisclosedToClient(
  fileId: string,
  clientCompanyId: string,
  runner?: Queryable
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from project_evidence e
       join projects p on p.id = e.project_id
       join engagements g on g.id = p.engagement_id
      where (e.file_id = $1
             or exists (select 1 from stored_files d
                         where d.id = $1 and d.derivative_of = e.file_id))
        and e.client_visible = true
        and e.deleted_at is null
        and g.client_company_id = $2
      limit 1`,
    [fileId, clientCompanyId],
    runner
  );
  return row !== null;
}

/**
 * Is this file readable by this company through a record that references it?
 *
 * Only evidence today; documents join it in 7.4 and the diary's attachments in
 * 7.5. A registry the way `LOCATION_REFERENCE_TABLES` is one, for the same
 * reason: the alternative is a condition each of those authors has to remember to
 * extend, and the one who forgets either leaks a file or hides one.
 */
export async function evidenceGrantsFileAccess(
  fileId: string,
  companyId: string,
  runner?: Queryable
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from project_evidence e
      where (e.file_id = $1
             or exists (select 1 from stored_files d
                         where d.id = $1 and d.derivative_of = e.file_id))
        and e.deleted_at is null
        and e.company_id = $2
      limit 1`,
    [fileId, companyId],
    runner
  );
  return row !== null;
}
