import type {
  GeneratedReportView,
  ReportAudience,
  ReportKind,
  ReportSectionKey,
  ReportSnapshot,
  ReportStatus,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * `generated_reports` and `report_file_references` (§29.4, decision #27).
 *
 * Two rules run through everything here:
 *
 *  - **A report is never updated in place.** The only columns that move after
 *    insert are `status`, `client_visible`, `void_reason` and the cached `file_id`;
 *    `0043`'s trigger refuses the rest whatever this file does. A correction is a
 *    new row that supersedes.
 *  - **A snapshot never leaves this module unverified.** `readSnapshot` checks the
 *    seal before returning, because a document whose stored contents no longer
 *    match its hash must be refused rather than rendered with a warning (§9).
 */

export interface ReportRow {
  id: string;
  company_id: string;
  project_id: string | null;
  project_name: string | null;
  client_company_id: string | null;
  client_company_name: string | null;
  kind: ReportKind;
  audience: ReportAudience;
  title: string;
  period_start: string | null;
  period_end: string | null;
  sections: ReportSectionKey[];
  snapshot: ReportSnapshot;
  content_hash: string;
  factor_set_ids: string[];
  disclaimer: string;
  file_id: string | null;
  status: ReportStatus;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  void_reason: string | null;
  client_visible: boolean;
  generated_by_user_id: string | null;
  generated_by_name: string | null;
  generated_at: Date;
}

/*
 * `superseded_by_id` is a correlated subquery rather than a column, and the reason
 * is the one `carbon_calculations` did NOT have. There, supersession is written by
 * one process that can set both sides atomically. Here the successor is inserted by
 * the same transaction that marks the predecessor, so a stored back-pointer would
 * be a second copy of a fact the forward pointer already carries — and the pair can
 * drift, which is how "which one is current" becomes unanswerable.
 */
const COLUMNS = `r.id, r.company_id, r.project_id, p.name as project_name,
  r.client_company_id, cc.name as client_company_name,
  r.kind, r.audience, r.title,
  to_char(r.period_start, 'YYYY-MM-DD') as period_start,
  to_char(r.period_end, 'YYYY-MM-DD') as period_end,
  r.sections, r.snapshot, r.content_hash, r.factor_set_ids, r.disclaimer, r.file_id,
  r.status, r.supersedes_id,
  (select s.id from generated_reports s where s.supersedes_id = r.id order by s.generated_at limit 1)
    as superseded_by_id,
  r.void_reason, r.client_visible, r.generated_by_user_id, u.name as generated_by_name,
  r.generated_at`;

const FROM = `from generated_reports r
  left join projects p on p.id = r.project_id
  left join companies cc on cc.id = r.client_company_id
  left join users u on u.id = r.generated_by_user_id`;

export function toReportView(row: ReportRow): GeneratedReportView {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    projectName: row.project_name,
    clientCompanyId: row.client_company_id,
    clientCompanyName: row.client_company_name,
    kind: row.kind,
    audience: row.audience,
    title: row.title,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    sections: row.sections,
    contentHash: row.content_hash,
    factorSetIds: row.factor_set_ids,
    disclaimer: row.disclaimer,
    fileId: row.file_id,
    status: row.status,
    supersedesId: row.supersedes_id,
    supersededById: row.superseded_by_id,
    voidReason: row.void_reason,
    clientVisible: row.client_visible,
    generatedByUserId: row.generated_by_user_id,
    generatedByName: row.generated_by_name,
    generatedAt: row.generated_at.toISOString(),
  };
}

export function findReport(id: string, runner?: Queryable): Promise<ReportRow | null> {
  return queryOne<ReportRow>(`select ${COLUMNS} ${FROM} where r.id = $1`, [id], runner);
}

/** The owner's list for one project. */
export function listProjectReports(
  projectId: string,
  filter: { kind?: ReportKind; includeSuperseded?: boolean },
  runner?: Queryable
): Promise<ReportRow[]> {
  return query<ReportRow>(
    `select ${COLUMNS} ${FROM}
      where r.project_id = $1
        and ($2::text is null or r.kind = $2)
        and ($3::boolean or r.status = 'GENERATED')
      order by r.generated_at desc`,
    [projectId, filter.kind ?? null, filter.includeSuperseded ?? false],
    runner
  );
}

/** Company-scoped: the client-period reports, which have no project. */
export function listCompanyPeriodReports(
  companyId: string,
  runner?: Queryable
): Promise<ReportRow[]> {
  return query<ReportRow>(
    `select ${COLUMNS} ${FROM}
      where r.company_id = $1 and r.kind = 'CLIENT_PERIOD' and r.status = 'GENERATED'
      order by r.generated_at desc`,
    [companyId],
    runner
  );
}

/**
 * A client company and every placeholder it has claimed.
 *
 * Finding 8's rule, applied to disclosure rather than to aggregation, and it comes
 * up for the same reason: `companies.claimed_by_company_id` lives on the
 * **placeholder** and names the real company. A report's `client_company_id` is
 * frozen at generation — deliberately, because the document said what it said — so
 * a client who signs up in June would otherwise lose every document issued to their
 * placeholder in March. The report was addressed to them; the row simply predates
 * their account.
 */
const CLAIMED_IDENTITIES = `select c.id from companies c
  where c.id = $1 or c.claimed_by_company_id = $1`;

/**
 * What a client may see, and **the scope is in the `where` clause**.
 *
 * Three predicates, all applied where the rows are chosen rather than where they
 * are rendered: disclosed, current, and assembled for a client. Nothing the client
 * may not see is ever serialised, which is the difference between a boundary and a
 * rendering decision — the same property `portal/routes.ts` states about evidence.
 */
export function listDisclosedReports(
  clientCompanyId: string,
  projectId: string | null,
  runner?: Queryable
): Promise<ReportRow[]> {
  return query<ReportRow>(
    `select ${COLUMNS} ${FROM}
      where r.client_company_id in (${CLAIMED_IDENTITIES})
        and r.client_visible and r.status = 'GENERATED' and r.audience = 'CLIENT'
        and ($2::uuid is null or r.project_id = $2)
      order by r.generated_at desc`,
    [clientCompanyId, projectId],
    runner
  );
}

export function findDisclosedReport(
  id: string,
  clientCompanyId: string,
  runner?: Queryable
): Promise<ReportRow | null> {
  return queryOne<ReportRow>(
    `select ${COLUMNS} ${FROM}
      where r.id = $2 and r.client_company_id in (${CLAIMED_IDENTITIES})
        and r.client_visible and r.status = 'GENERATED' and r.audience = 'CLIENT'`,
    [clientCompanyId, id],
    runner
  );
}

/**
 * The existing live document with this seal, if there is one (finding 9).
 *
 * Consulted before every insert, so a double-click or a retried request returns
 * the first caller's report instead of minting a second identical one. The unique
 * index is the guarantee; this is the courtesy that keeps the caller from seeing a
 * constraint violation.
 */
export function findLiveByHash(
  args: { projectId: string | null; companyId: string; kind: ReportKind; contentHash: string },
  runner?: Queryable
): Promise<ReportRow | null> {
  return queryOne<ReportRow>(
    `select ${COLUMNS} ${FROM}
      where coalesce(r.project_id, r.company_id) = coalesce($1::uuid, $2::uuid)
        and r.kind = $3 and r.content_hash = $4 and r.status = 'GENERATED'`,
    [args.projectId, args.companyId, args.kind, args.contentHash],
    runner
  );
}

/** The current document of a kind for a project — what a regeneration supersedes. */
export function findCurrentOfKind(
  args: { projectId: string; kind: ReportKind; audience: ReportAudience },
  runner?: Queryable
): Promise<ReportRow | null> {
  return queryOne<ReportRow>(
    `select ${COLUMNS} ${FROM}
      where r.project_id = $1 and r.kind = $2 and r.audience = $3 and r.status = 'GENERATED'
      order by r.generated_at desc limit 1`,
    [args.projectId, args.kind, args.audience],
    runner
  );
}

export interface InsertReportArgs {
  companyId: string;
  projectId: string | null;
  clientCompanyId: string | null;
  kind: ReportKind;
  audience: ReportAudience;
  title: string;
  periodStart: string | null;
  periodEnd: string | null;
  sections: ReportSectionKey[];
  snapshot: ReportSnapshot;
  contentHash: string;
  factorSetIds: string[];
  disclaimer: string;
  supersedesId: string | null;
  generatedByUserId: string | null;
  generatedAt: string;
}

export async function insertReport(
  args: InsertReportArgs,
  runner?: Queryable
): Promise<ReportRow> {
  const row = await queryOne<{ id: string }>(
    `insert into generated_reports
       (company_id, project_id, client_company_id, kind, audience, title,
        period_start, period_end, sections, snapshot, content_hash, factor_set_ids,
        disclaimer, supersedes_id, generated_by_user_id, generated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::uuid[],$13,$14,$15,$16)
     returning id`,
    [
      args.companyId,
      args.projectId,
      args.clientCompanyId,
      args.kind,
      args.audience,
      args.title,
      args.periodStart,
      args.periodEnd,
      JSON.stringify(args.sections),
      JSON.stringify(args.snapshot),
      args.contentHash,
      args.factorSetIds,
      args.disclaimer,
      args.supersedesId,
      args.generatedByUserId,
      args.generatedAt,
    ],
    runner
  );
  return (await findReport(row!.id, runner))!;
}

/**
 * Mark the predecessor superseded.
 *
 * **Guarded on `status = 'GENERATED'`**, which is the concurrency control: two
 * regenerations racing the same project must not both claim to supersede the same
 * document, and a row already superseded must not walk backwards.
 */
export function markSuperseded(id: string, runner?: Queryable): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `update generated_reports set status = 'SUPERSEDED'
      where id = $1 and status = 'GENERATED' returning id`,
    [id],
    runner
  );
}

export function setClientVisible(
  id: string,
  clientVisible: boolean,
  runner?: Queryable
): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `update generated_reports set client_visible = $2
      where id = $1 and status = 'GENERATED' returning id`,
    [id, clientVisible],
    runner
  );
}

/** Void, un-disclosing in the same statement — 0043's trigger refuses otherwise. */
export function voidReport(
  id: string,
  reason: string,
  runner?: Queryable
): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `update generated_reports
        set status = 'VOID', void_reason = $2, client_visible = false
      where id = $1 and status = 'GENERATED' returning id`,
    [id, reason],
    runner
  );
}

export function setReportFile(
  id: string,
  fileId: string,
  runner?: Queryable
): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `update generated_reports set file_id = $2 where id = $1 returning id`,
    [id, fileId],
    runner
  );
}

// ── The hold (decision #27) ───────────────────────────────────────────────────

export type FileReferenceRole = 'EVIDENCE' | 'DOCUMENT' | 'SIGNATURE' | 'LOGO' | 'RENDERED';

/**
 * Record what a frozen document points at.
 *
 * **Written in the same transaction as the snapshot.** A hold recorded afterwards
 * is a hold that a crash between the two writes silently omits, on the one table
 * whose whole purpose is that nothing gets omitted.
 */
export async function addFileReferences(
  owner: { reportId: string } | { signoffId: string },
  files: readonly { fileId: string; role: FileReferenceRole }[],
  runner?: Queryable
): Promise<void> {
  if (files.length === 0) return;
  const reportId = 'reportId' in owner ? owner.reportId : null;
  const signoffId = 'signoffId' in owner ? owner.signoffId : null;
  // Deduplicated here as well as by the partial unique indexes: one photograph
  // legitimately appears in two sections of the same document.
  const unique = new Map(files.map((f) => [f.fileId, f.role]));
  for (const [fileId, role] of unique) {
    await query(
      `insert into report_file_references (report_id, signoff_id, file_id, role)
       values ($1, $2, $3, $4)
       on conflict do nothing`,
      [reportId, signoffId, fileId, role],
      runner
    );
  }
}

/**
 * Does a frozen document this company owns cite this file?
 *
 * Registered in `FILE_ACCESS_GRANTS`. Resolves derivatives through their original,
 * so a thumbnail is never a way around a rule its full-size file obeys — the
 * property `references.ts` requires of every entry.
 */
export async function reportGrantsFileAccess(
  fileId: string,
  companyId: string
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from stored_files f
       join report_file_references x on x.file_id = coalesce(f.derivative_of, f.id)
       left join generated_reports r on r.id = x.report_id
       left join client_signoffs s on s.id = x.signoff_id
      where f.id = $1
        and (r.company_id = $2 or s.company_id = $2)
      limit 1`,
    [fileId, companyId]
  );
  return row !== null;
}

/**
 * Is this file cited by a document that was **given to this client**?
 *
 * Registered in `FILE_CLIENT_DISCLOSURES`, and it is the live caller that made the
 * hold worth building now rather than in Phase 12. Without it, a photograph inside
 * a signed completion report that was never individually published to the client
 * returns 403 to the very client holding the signed document.
 *
 * Narrower than publishing the photograph: the grant is *"a document you were given
 * cites this"*, so it covers exactly the images in that document and nothing else
 * on the project.
 */
export async function reportFileDisclosedToClient(
  fileId: string,
  companyId: string
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from stored_files f
       join report_file_references x on x.file_id = coalesce(f.derivative_of, f.id)
       left join generated_reports r
         on r.id = x.report_id and r.client_visible and r.status = 'GENERATED'
        and r.audience = 'CLIENT' and r.client_company_id = $2
       left join client_signoffs s on s.id = x.signoff_id
       left join projects sp on sp.id = s.project_id and sp.client_company_id = $2
      where f.id = $1 and (r.id is not null or sp.id is not null)
      limit 1`,
    [fileId, companyId]
  );
  return row !== null;
}

/**
 * A report logo, readable across the engagement (decision #30).
 *
 * The client company supplies the default and the contractor renders it, so the
 * asset has to cross one hop by design. Scoped to the two endpoints of a project
 * that actually references it: the owner may read the client's logo, and the client
 * may read the override the owner set for them.
 */
export async function brandingGrantsFileAccess(
  fileId: string,
  companyId: string
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    /*
     * Two `exists` clauses rather than a `union all` with a `limit` on each arm —
     * which is a syntax error in Postgres, and the kind that fails loudly at the
     * worst moment: this function is one entry in a registry every signed-URL
     * request walks, so a throw here took the *whole* download authorization down
     * with it, including grants that had nothing to do with branding.
     */
    `select true as ok
      where exists (
        select 1 from projects p
        left join sustainability_settings cs on cs.company_id = p.client_company_id
        where (p.owner_company_id = $2 or p.client_company_id = $2)
          and $1 in (p.client_logo_file_id, cs.report_logo_file_id)
      ) or exists (
        select 1 from sustainability_settings s
        where s.company_id = $2 and s.report_logo_file_id = $1
      )`,
    [fileId, companyId]
  );
  return row !== null;
}

/**
 * Follow a client identity **forward** through the placeholder tombstone.
 *
 * The mirror of `CLAIMED_IDENTITIES`, and it exists because the read path and the
 * notification path need the relation in opposite directions. A report's
 * `client_company_id` is frozen at generation; if the client has since signed up,
 * the placeholder it names has no members, so a notice addressed to it reaches
 * nobody at all — silently, because a dispatch with an empty recipient list writes
 * no rows and raises nothing.
 */
export async function currentClientCompanyId(clientCompanyId: string): Promise<string> {
  const row = await queryOne<{ claimed_by_company_id: string | null }>(
    `select claimed_by_company_id from companies where id = $1`,
    [clientCompanyId]
  );
  return row?.claimed_by_company_id ?? clientCompanyId;
}

/** Which projects block a delete, and why — the sentence the route refuses with. */
export async function frozenDocumentsOnProject(
  projectId: string
): Promise<{ reports: number; signoffs: number }> {
  const row = await queryOne<{ reports: string; signoffs: string }>(
    `select (select count(*) from generated_reports where project_id = $1)::text as reports,
            (select count(*) from client_signoffs where project_id = $1)::text as signoffs`,
    [projectId]
  );
  return { reports: Number(row?.reports ?? 0), signoffs: Number(row?.signoffs ?? 0) };
}
