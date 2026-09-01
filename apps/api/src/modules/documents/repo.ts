import type { DocumentCategory, DocumentFilter, DocumentView } from '@crewquo/shared';
import { daysUntil } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * Reads and writes for `project_documents` (0031).
 *
 * Two things are derived on read rather than stored: `superseded_by_id`, which is
 * a join to whichever live row points back here, and `today`, which is the
 * **owning company's** current date rather than the server's. Both are stated in
 * the migration; this is where they are paid for.
 */

export interface DocumentRow {
  id: string;
  project_id: string;
  company_id: string;
  file_id: string;
  category: DocumentCategory;
  title: string;
  reference: string | null;
  notes: string | null;
  version: number;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  issued_on: string | null;
  expires_on: string | null;
  /** The owning company's own current date, resolved in Postgres from its zone. */
  today: string;
  provider_company_id: string | null;
  location_id: string | null;
  client_visible: boolean;
  uploaded_by_user_id: string | null;
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
  d.id, d.project_id, d.company_id, d.file_id,
  d.category, d.title, d.reference, d.notes,
  d.version, d.supersedes_id,
  s.id as superseded_by_id,
  to_char(d.issued_on, 'YYYY-MM-DD') as issued_on,
  to_char(d.expires_on, 'YYYY-MM-DD') as expires_on,
  to_char((now() at time zone coalesce(oc.time_zone, 'UTC'))::date, 'YYYY-MM-DD') as today,
  d.provider_company_id, d.location_id, d.client_visible,
  d.uploaded_by_user_id, d.revision, d.deleted_at, d.created_at, d.updated_at,
  f.status as file_status, f.failure_reason as file_failure_reason,
  f.content_type, f.byte_size, f.original_filename`;

/**
 * The joins, and the one that decides whose day it is.
 *
 * `oc` is the **project-owning** company, not the uploader's and not the
 * reader's. A subcontractor in Manila and a hiring company in London must not
 * disagree about whether an insurance certificate expires today — the document
 * belongs to the project, so the project's owner owns its calendar, the same way
 * `projects.reporting_currency` pins the label its history is printed with.
 */
const JOINS = `
  join stored_files f on f.id = d.file_id
  join projects p on p.id = d.project_id
  join companies oc on oc.id = p.owner_company_id
  left join project_documents s
    on s.supersedes_id = d.id and s.deleted_at is null`;

const SELECT = `select ${FIELDS} from project_documents d ${JOINS}`;

/**
 * The same projection read out of a data-modifying CTE.
 *
 * The snapshot rule, again: a statement's outer read of a table cannot see rows
 * its own CTE just wrote, so a write that reported its result by re-reading
 * `project_documents` would return nothing for every success. Selecting from the
 * CTE's output is a read of the CTE, not of the table — but the *joins* still
 * read tables, which is fine here because `stored_files`, `projects`, `companies`
 * and any existing predecessor were all committed before this statement began.
 *
 * The one join that cannot work this way is `s` — a successor written by the same
 * statement would be invisible — and it does not have to: nothing supersedes a
 * row in the same statement that creates it.
 */
function selectFromCte(cte: string): string {
  return `select ${FIELDS} from ${cte} d ${JOINS}`;
}

/**
 * Who is asking, and therefore what they may be shown.
 *
 * **Documents are wider than evidence, and the asymmetry is real rather than an
 * inconsistency.** §7 classifies evidence as private to the uploading company and
 * the project owner, and document references as visible to *both hops*. The
 * reason is what the two records are for: evidence is produced by one party about
 * their own work, while a document is usually *issued to be followed* — a site
 * RAMS nobody but its author can read is a RAMS doing nothing.
 *
 * So a provider sees project-wide documents (`provider_company_id is null`), its
 * own, and anything filed against it — and nothing filed against a competitor.
 */
export type DocumentScope =
  | { kind: 'OWNER' }
  | { kind: 'PROVIDER'; companyId: string }
  | { kind: 'CLIENT' };

function scopeClause(scope: DocumentScope, params: unknown[]): string {
  switch (scope.kind) {
    case 'OWNER':
      return '';
    case 'PROVIDER':
      params.push(scope.companyId);
      return ` and (d.provider_company_id is null
                    or d.provider_company_id = $${params.length}
                    or d.company_id = $${params.length})`;
    case 'CLIENT':
      return ' and d.client_visible = true';
  }
}

export function toDocumentView(row: DocumentRow): DocumentView {
  return {
    id: row.id,
    projectId: row.project_id,
    companyId: row.company_id,
    fileId: row.file_id,
    category: row.category,
    title: row.title,
    reference: row.reference,
    notes: row.notes,
    version: row.version,
    supersedesId: row.supersedes_id,
    supersededById: row.superseded_by_id,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    // Computed from two date-only strings, so no clock and no zone can drift it.
    // Whose day it is was already decided by `today`, in Postgres, from the
    // project owner's IANA zone.
    daysUntilExpiry: row.expires_on === null ? null : daysUntil(row.expires_on, row.today),
    providerCompanyId: row.provider_company_id,
    locationId: row.location_id,
    clientVisible: row.client_visible,
    uploadedByUserId: row.uploaded_by_user_id,
    revision: row.revision,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    fileStatus: row.file_status,
    fileFailureReason: row.file_failure_reason,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    originalFilename: row.original_filename,
  };
}

export async function listDocuments(
  projectId: string,
  scope: DocumentScope,
  filter: DocumentFilter,
  runner?: Queryable
): Promise<DocumentRow[]> {
  const params: unknown[] = [projectId];
  let where = ' where d.project_id = $1 and d.deleted_at is null';
  where += scopeClause(scope, params);

  /*
   * Superseded versions are hidden by default (§24), expressed as "no live row
   * points at me" rather than as a stored flag. Asking for them is deliberate,
   * because the history is the point of the chain — it is just not the answer to
   * "what is current".
   */
  if (!filter.includeSuperseded) where += ' and s.id is null';

  if (filter.category && filter.category.length > 0) {
    params.push(filter.category);
    where += ` and d.category = any($${params.length}::text[])`;
  }
  if (filter.providerCompanyId) {
    params.push(filter.providerCompanyId);
    where += ` and d.provider_company_id = $${params.length}`;
  }
  if (filter.locationId) {
    params.push(filter.locationId);
    where += ` and d.location_id = $${params.length}`;
  }
  if (filter.clientVisible !== undefined) {
    params.push(filter.clientVisible);
    where += ` and d.client_visible = $${params.length}`;
  }
  if (filter.expiringWithinDays !== undefined) {
    /*
     * Compared against the OWNER's today, the same date the view reports, so a
     * filter for "expiring within 30 days" and the number rendered beside each row
     * can never disagree. Already-expired documents are included: they are the
     * most urgent case, and a filter that hid them would be a compliance screen
     * that goes quiet exactly when it matters.
     */
    params.push(filter.expiringWithinDays);
    where +=
      ` and d.expires_on is not null` +
      ` and d.expires_on <= (now() at time zone coalesce(oc.time_zone, 'UTC'))::date` +
      ` + ($${params.length}::int * interval '1 day')`;
  }

  params.push(filter.limit ?? 500);
  const limitParam = `$${params.length}`;
  params.push(filter.offset ?? 0);
  const offsetParam = `$${params.length}`;

  return query<DocumentRow>(
    `${SELECT}${where}
      order by d.expires_on asc nulls last, d.category asc, d.created_at desc
      limit ${limitParam} offset ${offsetParam}`,
    params,
    runner
  );
}

/** One row, tombstone included — the caller needs it to answer 410 rather than 404. */
export function findDocument(id: string, runner?: Queryable): Promise<DocumentRow | null> {
  return queryOne<DocumentRow>(`${SELECT} where d.id = $1`, [id], runner);
}

/**
 * Every version of the document `id` belongs to, tombstones included.
 *
 * A recursive walk in both directions from wherever the caller happened to point,
 * because a chain is asked about from the version somebody is holding — usually
 * the current one, sometimes an old one out of an export.
 */
export function findVersionChain(id: string, runner?: Queryable): Promise<DocumentRow[]> {
  return query<DocumentRow>(
    `with recursive back as (
       select id, supersedes_id from project_documents where id = $1
       union
       select p.id, p.supersedes_id
         from project_documents p join back b on p.id = b.supersedes_id
     ),
     forward as (
       select id from back
       union
       select n.id
         from project_documents n join forward f on n.supersedes_id = f.id
     )
     ${SELECT} where d.id in (select id from forward)
      order by d.version asc, d.created_at asc`,
    [id],
    runner
  );
}

export interface InsertDocumentArgs {
  projectId: string;
  companyId: string;
  fileId: string;
  category: DocumentCategory;
  title: string;
  reference: string | null;
  notes: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  providerCompanyId: string | null;
  locationId: string | null;
  clientVisible: boolean;
  uploadedByUserId: string;
  version: number;
  supersedesId: string | null;
}

export function insertDocument(
  args: InsertDocumentArgs,
  runner?: Queryable
): Promise<DocumentRow | null> {
  return queryOne<DocumentRow>(
    `with inserted as (
       insert into project_documents
         (project_id, company_id, file_id, category, title, reference, notes,
          issued_on, expires_on, provider_company_id, location_id, client_visible,
          uploaded_by_user_id, version, supersedes_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,$13,$14,$15)
       -- The one-successor index is the arbiter. Two concurrent re-issues of one
       -- version both pass the API check and both insert; the loser returns no
       -- row and is told a newer version already exists, rather than forking the
       -- chain and leaving "which is current" without an answer.
       on conflict (supersedes_id) where supersedes_id is not null and deleted_at is null
         do nothing
       returning *
     )
     ${selectFromCte('inserted')}`,
    [
      args.projectId,
      args.companyId,
      args.fileId,
      args.category,
      args.title,
      args.reference,
      args.notes,
      args.issuedOn,
      args.expiresOn,
      args.providerCompanyId,
      args.locationId,
      args.clientVisible,
      args.uploadedByUserId,
      args.version,
      args.supersedesId,
    ],
    runner
  );
}

/**
 * Metadata only. **`file_id` is not in this map and must never be added** — a new
 * set of bytes is a new version, which is `insertDocument` with a `supersedesId`.
 */
export interface DocumentPatch {
  category?: DocumentCategory;
  title?: string;
  reference?: string | null;
  notes?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  providerCompanyId?: string | null;
  locationId?: string | null;
  clientVisible?: boolean;
}

const PATCH_COLUMNS: Record<keyof DocumentPatch, { column: string; cast: string }> = {
  category: { column: 'category', cast: '' },
  title: { column: 'title', cast: '' },
  reference: { column: 'reference', cast: '' },
  notes: { column: 'notes', cast: '' },
  issuedOn: { column: 'issued_on', cast: '::date' },
  expiresOn: { column: 'expires_on', cast: '::date' },
  providerCompanyId: { column: 'provider_company_id', cast: '::uuid' },
  locationId: { column: 'location_id', cast: '::uuid' },
  clientVisible: { column: 'client_visible', cast: '::boolean' },
};

export async function updateDocument(
  id: string,
  patch: DocumentPatch,
  expectedRevision: number | undefined,
  runner?: Queryable
): Promise<DocumentRow | null> {
  const params: unknown[] = [id];
  const sets: string[] = [];
  for (const key of Object.keys(patch) as (keyof DocumentPatch)[]) {
    const spec = PATCH_COLUMNS[key];
    params.push(patch[key]);
    sets.push(`${spec.column} = $${params.length}${spec.cast}`);
  }
  if (sets.length === 0) return findDocument(id, runner);

  let guard = '';
  if (expectedRevision !== undefined) {
    params.push(expectedRevision);
    guard = ` and revision = $${params.length}`;
  }

  // The revision comparison is inside the `update`'s own `where`, where the row
  // lock makes it atomic — the shape the locations suite proved was necessary.
  return queryOne<DocumentRow>(
    `with updated as (
       update project_documents set ${sets.join(', ')}
        where id = $1 and deleted_at is null${guard}
        returning *
     )
     ${selectFromCte('updated')}`,
    params,
    runner
  );
}

export function tombstoneDocument(id: string, runner?: Queryable): Promise<DocumentRow | null> {
  return queryOne<DocumentRow>(
    `with deleted as (
       update project_documents set deleted_at = now()
        where id = $1 and deleted_at is null
        returning *
     )
     ${selectFromCte('deleted')}`,
    [id],
    runner
  );
}

// ── The expiry scan ──────────────────────────────────────────────────────────

export interface ExpiringDocumentRow {
  id: string;
  project_id: string;
  owner_company_id: string;
  provider_company_id: string | null;
  category: DocumentCategory;
  version: number;
  expires_on: string;
  today: string;
}

/**
 * Live, current documents with an expiry date inside the widest rung of the
 * ladder — the candidates the pass then buckets in pure code.
 *
 * **Current only.** A superseded insurance certificate expiring next week is not a
 * problem; the whole point of re-issuing it was that a newer one exists. Warning
 * about it is how a compliance screen fills with noise that is already handled.
 *
 * The window is the **project owner's** date, joined per row, which is the same
 * clock the view reports and the filter uses. One definition of "today" per
 * document, in three places that must never disagree.
 */
export function findExpiringDocuments(
  args: { widestThresholdDays: number; limit: number },
  runner?: Queryable
): Promise<ExpiringDocumentRow[]> {
  return query<ExpiringDocumentRow>(
    `select d.id, d.project_id, p.owner_company_id, d.provider_company_id,
            d.category, d.version,
            to_char(d.expires_on, 'YYYY-MM-DD') as expires_on,
            to_char((now() at time zone coalesce(oc.time_zone, 'UTC'))::date, 'YYYY-MM-DD') as today
       from project_documents d
       join projects p on p.id = d.project_id
       join companies oc on oc.id = p.owner_company_id
      where d.deleted_at is null
        and d.expires_on is not null
        and not exists (
          select 1 from project_documents s
           where s.supersedes_id = d.id and s.deleted_at is null
        )
        and d.expires_on <= (now() at time zone coalesce(oc.time_zone, 'UTC'))::date
            + ($1::int * interval '1 day')
      order by d.expires_on asc
      limit $2`,
    [args.widestThresholdDays, args.limit],
    runner
  );
}

// ── File access, contributed to the storage layer's registry ─────────────────

/**
 * Does a document grant this company access to the file behind it?
 *
 * The same shape evidence contributes, and the reason it is a pair of small
 * functions per module rather than one query in `storage/routes.ts` is the
 * argument `LOCATION_REFERENCE_TABLES` already makes: the alternative is a
 * condition every later author has to remember to extend, and the one who forgets
 * either leaks a file or hides one.
 */
export async function documentGrantsFileAccess(
  fileId: string,
  companyId: string,
  runner?: Queryable
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from project_documents d
       join projects p on p.id = d.project_id
      where (d.file_id = $1
             or exists (select 1 from stored_files x
                         where x.id = $1 and x.derivative_of = d.file_id))
        and d.deleted_at is null
        and (
          d.company_id = $2
          or d.provider_company_id = $2
          or p.owner_company_id = $2
          /*
           * A project-wide document (provider_company_id is null) is readable by
           * everybody ON THE PROJECT, and the assignment check is what makes that
           * "everybody" bounded. Written first without it, the clause read simply
           * "or d.provider_company_id is null" -- which grants the site RAMS, the
           * drawings and every purchase order to any authenticated company in the
           * product. The narrow-looking half of a disjunction is where a hole hides.
           */
          or (d.provider_company_id is null and exists (
                select 1 from project_assignments a
                 where a.project_id = p.id and a.provider_company_id = $2
              ))
        )
      limit 1`,
    [fileId, companyId],
    runner
  );
  return row !== null;
}

/** A document deliberately published to the client on the project's engagement. */
export async function documentDisclosedToClient(
  fileId: string,
  clientCompanyId: string,
  runner?: Queryable
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from project_documents d
       join projects p on p.id = d.project_id
       join engagements g on g.id = p.engagement_id
      where (d.file_id = $1
             or exists (select 1 from stored_files x
                         where x.id = $1 and x.derivative_of = d.file_id))
        and d.client_visible = true
        and d.deleted_at is null
        and g.client_company_id = $2
      limit 1`,
    [fileId, clientCompanyId],
    runner
  );
  return row !== null;
}
