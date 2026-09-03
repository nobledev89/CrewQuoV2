-- Subcontractor compliance (CREWQUO_V2_PLAN.md §33) — Phase 12.
-- Operating model: docs/operating-model/compliance-analytics.md.

create table if not exists compliance_documents (
  id uuid primary key default gen_random_uuid(),
  subject_company_id uuid not null references companies(id) on delete cascade,
  owner_company_id   uuid not null references companies(id) on delete cascade,
  engagement_id uuid references engagements(id) on delete set null,

  kind text not null check (kind in
    ('PUBLIC_LIABILITY','EMPLOYERS_LIABILITY','PROFESSIONAL_INDEMNITY','RAMS',
     'TRAINING','QUALIFICATION','LICENCE','CERTIFICATE','OTHER')),
  title text not null check (length(btrim(title)) > 0),
  reference text,
  insurer text,
  cover_amount_cents bigint check (cover_amount_cents is null or cover_amount_cents >= 0),
  file_id uuid references stored_files(id) on delete restrict,
  issued_on date,
  expires_on date,

  status text not null default 'MISSING'
    check (status in ('VALID','EXPIRING','EXPIRED','MISSING','REJECTED')),

  -- §33 only permits enforcement for a mandatory record. The canonical sketch
  -- omitted the flag, which made that sentence impossible to implement.
  mandatory boolean not null default true,
  reject_reason text,
  verified_by_user_id uuid references users(id) on delete set null,
  verified_at timestamptz,
  notes text,
  uploaded_by_user_id uuid references users(id) on delete set null,

  -- A renewal is a new evidence row, never a replacement of the bytes somebody
  -- relied on before it. Current is derived from the one live successor.
  supersedes_id uuid references compliance_documents(id) on delete restrict,
  revision int not null default 1 check (revision >= 1),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint compliance_expiry_after_issue
    check (issued_on is null or expires_on is null or expires_on >= issued_on),
  constraint compliance_rejection_reason
    check ((status = 'REJECTED') = (reject_reason is not null)),
  constraint compliance_missing_file
    check (status <> 'MISSING' or file_id is null),
  constraint compliance_not_own_predecessor
    check (supersedes_id is null or supersedes_id <> id)
);

comment on table compliance_documents is
  'Company compliance evidence (§33). Self-owned rows are reusable across direct hiring edges; one hirer''s tracked row is not disclosed to another hirer.';
comment on column compliance_documents.mandatory is
  'The word omitted by §33''s DDL but required by its enforcement rule: only missing, rejected or expired MANDATORY records can block, and only when enforce_compliance is enabled.';
comment on column compliance_documents.supersedes_id is
  'Append-only renewal chain. Replacing file_id in place would erase the evidence relied on before renewal.';

create unique index if not exists compliance_documents_one_successor_idx
  on compliance_documents (supersedes_id)
  where supersedes_id is not null and deleted_at is null;
create index if not exists compliance_documents_owner_expiry_idx
  on compliance_documents (owner_company_id, expires_on)
  where deleted_at is null;
create index if not exists compliance_documents_subject_idx
  on compliance_documents (subject_company_id, kind)
  where deleted_at is null;
create index if not exists compliance_documents_engagement_idx
  on compliance_documents (engagement_id)
  where engagement_id is not null and deleted_at is null;

drop trigger if exists compliance_documents_bump_revision on compliance_documents;
create trigger compliance_documents_bump_revision
  before update on compliance_documents
  for each row execute function bump_revision();

create table if not exists compliance_alerts (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references compliance_documents(id) on delete cascade,
  threshold_days int not null check (threshold_days in (90,60,30,14,7)),
  sent_at timestamptz not null default now(),
  unique (document_id, threshold_days)
);

comment on table compliance_alerts is
  'One durable ladder occurrence per compliance document and threshold (§33). Inserted in the same transaction as the outbox event.';

create index if not exists compliance_alerts_document_idx
  on compliance_alerts (document_id, sent_at);

insert into features (key, name, description, category) values
  ('compliance_tracking', 'Compliance tracking',
   'Track subcontractor certificates, expiry status and renewal alerts across engagements',
   'operations')
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category;

-- §43 placement: Pro and above. The seed remains authoritative on rebuild.
insert into plan_features (plan_id, feature_key)
select p.id, 'compliance_tracking' from plans p
where p.id in ('pro', 'business', 'enterprise')
on conflict do nothing;
