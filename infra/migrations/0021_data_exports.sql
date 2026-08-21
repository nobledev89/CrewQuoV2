-- Data exports (docs/operating-model/observability-data-lifecycle.md §14 step 5,
-- owner decision §13.2: export is free for everyone, including the free `crew` plan).
--
-- This table is not the bundle. It is the record that a bundle was taken: an export is
-- the single most concentrated disclosure the platform can produce — a whole tenant's
-- commercial history, or a whole person's — and the fact that one was produced, by whom
-- and how big it was, is itself evidence somebody will need. The bundle is generated and
-- streamed under authorization on every read rather than parked behind a link, so there
-- is no artifact here to expire.
--
-- WHY NOT A STORED BUNDLE WITH AN EXPIRY CLOCK, which is what the packet's §7 assumed.
-- Its own words are the argument against it: a bundle is "protected once, at issue",
-- while "everything else in this table is protected by an authorization check on every
-- read". Generating on demand keeps the export in the second category. It also needs no
-- object storage, which does not exist until Phase 7.0 — so the alternative was either
-- megabytes of bytea in Postgres or blocking a legal obligation on a later phase. The
-- cost is honest and bounded: a very large tenant's export will one day need to become a
-- job with an artifact, and when it does, `status` and the timestamps below are already
-- the right shape for it.

create table if not exists data_exports (
  id uuid primary key default gen_random_uuid(),

  -- PERSONAL or COMPANY. Text with a check rather than an enum, matching every other
  -- status column in this schema.
  scope text not null check (scope in ('PERSONAL', 'COMPANY')),

  -- Exactly one of these. A personal export has no company: the requester may belong to
  -- five, and their own data is not any of theirs.
  subject_user_id uuid references users(id) on delete set null,
  subject_company_id uuid references companies(id) on delete set null,

  -- Who asked. Separate from the subject because a company export is requested by an
  -- owner or admin, who is a person, and because the two differ is the interesting case.
  --
  -- `on delete set null`, never cascade: the §13.1 policy is anonymise-the-person and
  -- preserve-the-record, and a disclosure record that vanishes with the account is
  -- exactly the record you would want after the account is gone.
  requested_by_user_id uuid references users(id) on delete set null,

  status text not null default 'READY' check (status in ('READY', 'FAILED')),

  -- What was in it, so a later question about a past export can be answered without
  -- re-running it. Counts only: the contents are the customer's, not the platform's.
  table_count integer,
  row_count integer,
  byte_size integer,
  error text,

  created_at timestamptz not null default now(),

  constraint data_exports_one_subject check (
    (scope = 'PERSONAL' and subject_user_id is not null and subject_company_id is null)
    or (scope = 'COMPANY' and subject_company_id is not null and subject_user_id is null)
  )
);

-- "Has this company exported recently, and who did it" — the operator and audit question.
create index if not exists data_exports_company_idx
  on data_exports (subject_company_id, created_at desc)
  where subject_company_id is not null;

create index if not exists data_exports_user_idx
  on data_exports (subject_user_id, created_at desc)
  where subject_user_id is not null;
