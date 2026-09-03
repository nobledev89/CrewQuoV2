import {
  evaluateCompliance,
  type ComplianceDocumentView,
  type ComplianceKind,
  type ComplianceProviderSummary,
  type ComplianceStatus,
  type CreateComplianceDocument,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

export interface ComplianceRow {
  id: string;
  subject_company_id: string;
  subject_company_name: string;
  owner_company_id: string;
  owner_company_name: string;
  engagement_id: string | null;
  kind: ComplianceKind;
  title: string;
  reference: string | null;
  insurer: string | null;
  cover_amount_cents: string | null;
  file_id: string | null;
  issued_on: string | null;
  expires_on: string | null;
  status: ComplianceStatus;
  mandatory: boolean;
  reject_reason: string | null;
  verified_by_user_id: string | null;
  verified_at: Date | null;
  notes: string | null;
  uploaded_by_user_id: string | null;
  supersedes_id: string | null;
  superseded: boolean;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  d.id, d.subject_company_id, sc.name as subject_company_name,
  d.owner_company_id, oc.name as owner_company_name, d.engagement_id,
  d.kind, d.title, d.reference, d.insurer, d.cover_amount_cents::text,
  d.file_id, to_char(d.issued_on, 'YYYY-MM-DD') as issued_on,
  to_char(d.expires_on, 'YYYY-MM-DD') as expires_on, d.status, d.mandatory,
  d.reject_reason, d.verified_by_user_id, d.verified_at,
  d.notes, d.uploaded_by_user_id, d.supersedes_id, d.revision,
  d.created_at, d.updated_at,
  exists (select 1 from compliance_documents n where n.supersedes_id = d.id and n.deleted_at is null) as superseded`;

export function toComplianceView(row: ComplianceRow, readerCompanyId?: string): ComplianceDocumentView {
  return {
    id: row.id,
    subjectCompanyId: row.subject_company_id,
    subjectCompanyName: row.subject_company_name,
    ownerCompanyId: row.owner_company_id,
    ownerCompanyName: row.owner_company_name,
    engagementId: row.engagement_id,
    kind: row.kind,
    title: row.title,
    reference: row.reference,
    insurer: row.insurer,
    coverAmountCents: row.cover_amount_cents === null ? null : Number(row.cover_amount_cents),
    fileId: row.file_id,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    status: row.status,
    mandatory: row.mandatory,
    rejectReason: row.reject_reason,
    verifiedByUserId: row.verified_by_user_id,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    // Notes belong to the tracking company. The subject sees the requirement and
    // decision, not one hirer's internal commentary about it.
    notes: readerCompanyId && readerCompanyId !== row.owner_company_id ? null : row.notes,
    uploadedByUserId: row.uploaded_by_user_id,
    supersedesId: row.supersedes_id,
    superseded: row.superseded,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function fromClause(): string {
  return `from compliance_documents d
    join companies sc on sc.id = d.subject_company_id
    join companies oc on oc.id = d.owner_company_id`;
}

/** Narrow visibility: own rows, rows about self, and self-filed rows over a direct edge. */
function readableWhere(param = '$2'): string {
  return `(d.owner_company_id = ${param}
       or d.subject_company_id = ${param}
       or (d.owner_company_id = d.subject_company_id and exists (
         select 1 from engagements e
          where e.client_company_id = ${param}
            and e.provider_company_id = d.subject_company_id
            and e.status in ('PENDING','ACTIVE','PAUSED')
       )))`;
}

export async function listComplianceDocuments(args: {
  companyId: string;
  subjectCompanyId?: string;
  status?: ComplianceStatus;
  expiringWithinDays?: number;
  includeHistory?: boolean;
}): Promise<ComplianceDocumentView[]> {
  const rows = await query<ComplianceRow>(
    `select ${COLUMNS} ${fromClause()}
      where d.deleted_at is null
        and ${readableWhere('$1')}
        and ($2::uuid is null or d.subject_company_id = $2)
        and ($3::text is null or d.status = $3)
        and ($4::int is null or (d.expires_on is not null and d.expires_on <= current_date + $4::int))
        and ($5::boolean or not exists (
          select 1 from compliance_documents n where n.supersedes_id = d.id and n.deleted_at is null
        ))
      order by
        case d.status when 'EXPIRED' then 1 when 'MISSING' then 2 when 'REJECTED' then 3 when 'EXPIRING' then 4 else 5 end,
        d.expires_on nulls last, sc.name, d.title`,
    [
      args.companyId,
      args.subjectCompanyId ?? null,
      args.status ?? null,
      args.expiringWithinDays ?? null,
      args.includeHistory ?? false,
    ]
  );
  return rows.map((row) => toComplianceView(row, args.companyId));
}

export async function findReadableComplianceDocument(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<ComplianceRow | null> {
  return queryOne<ComplianceRow>(
    `select ${COLUMNS} ${fromClause()}
      where d.id = $1 and d.deleted_at is null and ${readableWhere('$2')}`,
    [id, companyId],
    runner
  );
}

export function todayForCompany(companyId: string, runner?: Queryable): Promise<string | null> {
  return queryOne<{ today: string }>(
    `select to_char(now() at time zone coalesce(time_zone, 'UTC'), 'YYYY-MM-DD') as today
       from companies where id = $1`,
    [companyId],
    runner
  ).then((row) => row?.today ?? null);
}

export async function insertComplianceDocument(args: {
  ownerCompanyId: string;
  userId: string;
  input: CreateComplianceDocument;
  status: ComplianceStatus;
  runner: Queryable;
}): Promise<string> {
  const input = args.input;
  const row = await queryOne<{ id: string }>(
    `insert into compliance_documents
       (subject_company_id, owner_company_id, engagement_id, kind, title, reference,
        insurer, cover_amount_cents, file_id, issued_on, expires_on, status, mandatory,
        notes, uploaded_by_user_id, supersedes_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning id`,
    [
      input.subjectCompanyId,
      args.ownerCompanyId,
      input.engagementId ?? null,
      input.kind,
      input.title,
      input.reference ?? null,
      input.insurer ?? null,
      input.coverAmountCents ?? null,
      input.fileId ?? null,
      input.issuedOn ?? null,
      input.expiresOn ?? null,
      args.status,
      input.mandatory,
      input.notes ?? null,
      args.userId,
      input.supersedesId ?? null,
    ],
    args.runner
  );
  return row!.id;
}

export async function updateComplianceDocument(args: {
  id: string;
  ownerCompanyId: string;
  expectedRevision: number;
  fields: {
    title: string;
    reference: string | null;
    insurer: string | null;
    coverAmountCents: number | null;
    issuedOn: string | null;
    expiresOn: string | null;
    status: ComplianceStatus;
    mandatory: boolean;
    rejectReason: string | null;
    verifiedByUserId: string | null;
    notes: string | null;
  };
  runner: Queryable;
}): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update compliance_documents set
       title = $4, reference = $5, insurer = $6, cover_amount_cents = $7,
       issued_on = $8, expires_on = $9, status = $10, mandatory = $11,
       reject_reason = $12, verified_by_user_id = $13,
       verified_at = case when $13::uuid is null then null else now() end,
       notes = $14, updated_at = now()
     where id = $1 and owner_company_id = $2 and revision = $3 and deleted_at is null
     returning id`,
    [
      args.id,
      args.ownerCompanyId,
      args.expectedRevision,
      args.fields.title,
      args.fields.reference,
      args.fields.insurer,
      args.fields.coverAmountCents,
      args.fields.issuedOn,
      args.fields.expiresOn,
      args.fields.status,
      args.fields.mandatory,
      args.fields.rejectReason,
      args.fields.verifiedByUserId,
      args.fields.notes,
    ],
    args.runner
  );
  return row !== null;
}

export async function tombstoneComplianceDocument(
  id: string,
  ownerCompanyId: string,
  runner?: Queryable
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update compliance_documents set deleted_at = now(), updated_at = now()
      where id = $1 and owner_company_id = $2 and deleted_at is null returning id`,
    [id, ownerCompanyId],
    runner
  );
  return row !== null;
}

export async function listProviderSummaries(ownerCompanyId: string): Promise<ComplianceProviderSummary[]> {
  const providers = await query<{
    engagement_id: string;
    subject_company_id: string;
    subject_company_name: string;
  }>(
    `select e.id as engagement_id, e.provider_company_id as subject_company_id,
            c.name as subject_company_name
       from engagements e join companies c on c.id = e.provider_company_id
      where e.client_company_id = $1 and e.status in ('PENDING','ACTIVE','PAUSED')
      order by c.name`,
    [ownerCompanyId]
  );
  if (providers.length === 0) return [];
  const ids = providers.map((provider) => provider.subject_company_id);
  const rows = await query<ComplianceRow>(
    `select ${COLUMNS} ${fromClause()}
      where d.deleted_at is null
        and d.subject_company_id = any($2::uuid[])
        and (d.owner_company_id = $1 or d.owner_company_id = d.subject_company_id)
        and not exists (
          select 1 from compliance_documents n where n.supersedes_id = d.id and n.deleted_at is null
        )`,
    [ownerCompanyId, ids]
  );
  const bySubject = new Map<string, ComplianceDocumentView[]>();
  for (const row of rows) {
    const list = bySubject.get(row.subject_company_id) ?? [];
    list.push(toComplianceView(row, ownerCompanyId));
    bySubject.set(row.subject_company_id, list);
  }
  return providers.map((provider) => ({
    engagementId: provider.engagement_id,
    subjectCompanyId: provider.subject_company_id,
    subjectCompanyName: provider.subject_company_name,
    ...evaluateCompliance(bySubject.get(provider.subject_company_id) ?? []),
  }));
}

export async function providerCompliance(
  ownerCompanyId: string,
  subjectCompanyId: string,
  runner?: Queryable
): Promise<Pick<ComplianceProviderSummary, 'overallStatus' | 'blocking' | 'expiring' | 'documentCount'>> {
  const rows = await query<ComplianceRow>(
    `select ${COLUMNS} ${fromClause()}
      where d.deleted_at is null and d.subject_company_id = $2
        and (d.owner_company_id = $1 or d.owner_company_id = d.subject_company_id)
        and not exists (
          select 1 from compliance_documents n where n.supersedes_id = d.id and n.deleted_at is null
        )`,
    [ownerCompanyId, subjectCompanyId],
    runner
  );
  return evaluateCompliance(rows.map((row) => toComplianceView(row, ownerCompanyId)));
}

export async function complianceFileGrantsAccess(fileId: string, companyId: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select exists (
       select 1 from compliance_documents d
        where d.file_id = coalesce((select derivative_of from stored_files where id = $1), $1::uuid)
          and d.deleted_at is null
          and (
            d.owner_company_id = $2 or d.subject_company_id = $2
            or (d.owner_company_id = d.subject_company_id and exists (
              select 1 from engagements e
               where e.client_company_id = $2 and e.provider_company_id = d.subject_company_id
                 and e.status in ('PENDING','ACTIVE','PAUSED')
            ))
          )
     ) as ok`,
    [fileId, companyId]
  );
  return row?.ok ?? false;
}
