-- The storage layer (CREWQUO_V2_PLAN.md §22.1) — step 3 of the Phase 7 build
-- order in docs/operating-model/project-evidence.md §14, unblocked by the four
-- owner decisions of 2026-09-01.
--
-- WHERE THE BYTES ARE. An S3-compatible object store, which locally is the MinIO
-- service in infra/docker-compose.yml and in production is Cloudflare R2. That is
-- §13.1: the 2026-08-31 data decision applies to files exactly as it applies to
-- rows, and provisioning an R2 bucket *is* the act of handing a third party
-- customer files while /privacy still calls its subprocessor list a preview. One
-- S3 client serves both, so the first real R2 request is not the first exercise
-- of the code path.
--
-- WHAT THIS TABLE IS NOT. It is not a file browser's index. There is no route
-- that lists files, and there should never be one: a file is reachable only
-- through the evidence, document, signature or export row that points at it, and
-- the download authorization runs against *that* record. A second way to reach
-- the same bytes would be a second authorization surface, and the weaker of the
-- two would decide.

-- ── 1. stored_files ───────────────────────────────────────────────────────────
--
-- §22.1's shape, with two statuses it does not list. Both are recorded in the
-- packet's §3 and §13.5 and both close a real hole:
--
-- `SCANNING`, because the API cannot sniff a content type it never receives.
-- §22.1 says bytes never pass through the API *and* that the type is sniffed
-- server-side on complete — and trusting the client's declared type is the exact
-- hole sniffing exists to close. The derivative worker downloads the original
-- anyway, so validation lives there and `READY` is the worker's to set. `complete`
-- checks only what it can see: the size and the checksum the client reports.
--
-- `EXPIRED`, because a presign that is never completed is otherwise a row
-- claiming bytes that do not exist, counted by the storage meter for ever. That
-- is a slow leak which reads to a customer as using more than they are, and to us
-- as demand that is not there.

create table if not exists stored_files (
  id uuid primary key default gen_random_uuid(),

  -- WHO UPLOADED IT. Deliberately NOT the billing key — see the meter below.
  -- §13.3 charges storage to the project owner, and these are two different facts
  -- about one row. Collapsing them into one column is how the meter starts
  -- disagreeing with the audit trail.
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,   -- null = company-level

  -- Derived server-side from the row's own id and never accepted from the caller.
  -- A caller who chooses a key chooses a prefix, and a prefix is a tenant.
  bucket_key text not null unique,

  original_filename text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  checksum_sha256 text,

  kind text not null check (kind in ('IMAGE','DOCUMENT','SIGNATURE','EXPORT')),
  variant text not null default 'ORIGINAL' check (variant in ('ORIGINAL','WEB','THUMB')),
  derivative_of uuid references stored_files(id) on delete cascade,

  status text not null default 'PENDING'
    check (status in ('PENDING','SCANNING','READY','FAILED','EXPIRED','DELETED')),
  -- Why it failed, in words a person can act on. Never the provider's own error
  -- text, which carries bucket names and credentials-adjacent configuration.
  failure_reason text,

  -- The offline contract's idempotency key (§8). Without it a replayed presign
  -- mints a second bucket key, so the retry Ade's tablet makes in a stairwell
  -- leaves an orphaned byte-charge for an object nothing references.
  client_id uuid,

  uploaded_by_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A derivative is not an original and an original is not derived from itself.
  constraint stored_files_variant_derivation
    check ((variant = 'ORIGINAL' and derivative_of is null)
        or (variant <> 'ORIGINAL' and derivative_of is not null)),
  constraint stored_files_not_own_derivative check (derivative_of is null or derivative_of <> id)
);

create index if not exists stored_files_company_created_idx
  on stored_files (company_id, created_at desc);
create index if not exists stored_files_project_idx
  on stored_files (project_id) where project_id is not null;
create index if not exists stored_files_derivative_idx
  on stored_files (derivative_of) where derivative_of is not null;

-- One WEB and one THUMB per original. §22.1 declares the columns and no
-- constraint, so nothing stopped a re-run of the derivative job producing a
-- second WEB — two rows, two objects, two charges, and a caller with no way to
-- say which is current.
create unique index if not exists stored_files_one_derivative_per_variant
  on stored_files (derivative_of, variant) where derivative_of is not null;

-- The sweep that makes EXPIRED possible finds rows by age within a status; the
-- meter sums bytes by status. Both want the same partial index.
create index if not exists stored_files_pending_created_idx
  on stored_files (created_at) where status = 'PENDING';

-- A replayed presign must find its own row, and two companies may legitimately
-- use the same client id. Partial, because most rows have none.
create unique index if not exists stored_files_client_id_idx
  on stored_files (company_id, client_id) where client_id is not null;

-- ── 2. The two new limits (§43) ───────────────────────────────────────────────
--
-- `storage_gb` is the one genuinely metered new axis. Its unit is **gigabytes**,
-- which is why `unit` is not 'count': every other limit in this table counts
-- objects, and `withinLimit`'s `projected` argument means "one more of the thing"
-- at every existing call site. A caller taking that default while charging
-- storage would charge a full gigabyte per upload.
--
-- `evidence_uploads_per_month` is the product's first windowed meter. A month has
-- a start; the start is the company's own IANA zone, not the server's.

insert into limits (key, name, description, unit, unlimited_allowed) values
  ('storage_gb', 'File storage', 'Total stored evidence, documents and exports', 'gigabytes', true),
  ('evidence_uploads_per_month', 'Evidence uploads per month',
   'Files added to projects within the company''s current month', 'count', true)
on conflict (key) do update set
  name = excluded.name, description = excluded.description, unit = excluded.unit;

-- §43's suggested placement. The *rule* was decided on 2026-09-01 — capture is
-- free and the record is the project owner's entitlement — while these figures
-- remain a pricing judgement rather than a product one, which is why they are
-- ordinary seed rows an operator can edit rather than constants in code.
--
-- Crew gets 1 GB and 50 uploads a month. Not zero, deliberately: §5B's Crew plan
-- exists so a subcontractor can work for nothing, and since the *hiring* company's
-- allowance pays for work on its projects, Crew's own figure only ever bounds a
-- free company's own projects.
-- Joined against `plans` rather than naming ids in a values list. NO MIGRATION
-- INSERTS `plans` — only infra/seed/index.ts does — so on a genuinely fresh
-- database the literal form violates plan_limits_plan_id_fkey and stops the whole
-- run here, leaving every later migration unapplied. This yields no rows on an
-- empty `plans`, which is the shape 0033, 0038 and 0043 already use for
-- plan_features, and the seed is the authority for placement either way.
--
-- Forward-only-safe: schema_migrations records filenames, so an already-migrated
-- database re-runs nothing and this edit changes behaviour only where it is
-- currently broken.
insert into plan_limits (plan_id, limit_key, value)
select p.id, k.key, k.value
from plans p
join (values
  ('crew',       'storage_gb', 1),
  ('starter',    'storage_gb', 25),
  ('pro',        'storage_gb', 200),
  ('business',   'storage_gb', 1000),
  ('enterprise', 'storage_gb', null::int),
  ('crew',       'evidence_uploads_per_month', 50),
  ('starter',    'evidence_uploads_per_month', 1000),
  ('pro',        'evidence_uploads_per_month', 10000),
  ('business',   'evidence_uploads_per_month', null::int),
  ('enterprise', 'evidence_uploads_per_month', null::int)
) as k(id, key, value) on k.id = p.id
on conflict (plan_id, limit_key) do nothing;

-- ── 3. The Phase 3 receipt upload, retro-fitted ───────────────────────────────
--
-- `expenses.receipt_url` has held null since 0004 with the comment "R2 object
-- (upload deferred)". It is the smallest real consumer of the storage service and
-- therefore its best first proof: one record, one file, one authorization rule
-- that already exists.
--
-- A new column rather than a repurposed one. `receipt_url` was a free-text URL
-- and this is a foreign key to a row that knows its own status, size and owner;
-- reusing the name would leave a column whose meaning depends on which release
-- wrote it. The old column is left in place and unread — nothing ever populated
-- it, so there is nothing to migrate and nothing to lose.
alter table expenses
  add column if not exists receipt_file_id uuid references stored_files(id) on delete set null;

comment on column expenses.receipt_url is
  'Superseded by receipt_file_id (0027). Never populated; retained only so a forward-only migration does not drop a column mid-flight.';
