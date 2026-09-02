-- Site diary (CREWQUO_V2_PLAN.md §23) — step 6 of the Phase 7 build order in
-- docs/operating-model/project-evidence.md §14, and the last record in the phase.
--
-- The diary is the narrative backbone of the evidence pack and the first thing
-- anyone reaches for in a dispute. Everything below follows from that one
-- sentence: a day can be closed but never reopened, a closed day can be amended
-- but never quietly, and a day cannot be deleted at all.

create table if not exists site_diary_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- THE AUTHORING COMPANY, and the reason `unique` below has three columns.
  -- §23: a subcontractor keeps its own diary for the same day. Two companies on
  -- one site keep two diaries, both attributed and both true — a provider's entry
  -- is its own record, not a draft of the hiring company's.
  company_id uuid not null references companies(id),

  entry_date date not null,

  start_time time,
  finish_time time,

  -- `on delete set null` on all four person columns, for the closure decision of
  -- 2026-08-20: closing an account anonymises the person and preserves the
  -- record. §23 writes `not null` on `created_by_user_id`; a `not null` here would
  -- make closing a supervisor's account either impossible or destructive of a
  -- closed day somebody may be relying on in a dispute.
  supervisor_user_id uuid references users(id) on delete set null,

  -- ── §23's narrative fields ─────────────────────────────────────────────────
  --
  -- Thirteen of them, in the plan's order. The packet's §3 says "fourteen
  -- independent free-text fields" twice; §23 defines thirteen, and this migration
  -- follows the column list rather than the prose count — inventing a fourteenth
  -- field to make a sentence true would be the wrong correction. The number
  -- matters only because it is the argument for merging per field, and thirteen
  -- makes that argument exactly as well.
  --
  -- They are independent, which is the whole reason `mergeFieldwise` exists: they
  -- are filled in by different people through the day, and whole-row
  -- last-write-wins silently deletes a colleague's paragraph.
  work_completed      text,
  areas_completed     text,
  activities          text,
  delays              text,
  client_instructions text,
  issues              text,
  deliveries          text,
  collections         text,
  vehicle_movements   text,
  waste_movements     text,
  hs_notes            text,          -- health & safety
  weather             text,
  notes               text,

  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  closed_by_user_id uuid references users(id) on delete set null,
  closed_at timestamptz,

  created_by_user_id uuid references users(id) on delete set null,
  updated_by_user_id uuid references users(id) on delete set null,

  -- The sync contract's revision (0029, item 7.7). `deleted_at` is deliberately
  -- absent — see the note at the foot of this file.
  revision int not null default 1,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- §23 verbatim, and the constraint that makes "one entry per project per day
  -- per company" a fact rather than a convention the API remembers.
  unique (project_id, company_id, entry_date),

  -- CLOSED CARRIES ITS EVIDENCE, AND OPEN CARRIES NONE OF IT.
  -- A closed day with no `closed_at` cannot answer "who closed this and when",
  -- which is the first question asked of it; an OPEN day holding a stale
  -- `closed_at` would answer it wrongly. There is no reopen, so the pair is set
  -- once and never cleared.
  constraint site_diary_entries_closed_is_stamped check (
    (status = 'OPEN'   and closed_at is null and closed_by_user_id is null) or
    (status = 'CLOSED' and closed_at is not null)
  ),
  -- A day that finishes before it starts is a typo, not a shift. Caught here as
  -- well as in the API, because a hand-written correction is exactly where an
  -- inverted pair gets in — the same argument `project_documents` makes about
  -- issue and expiry dates.
  constraint site_diary_entries_times_ordered check (
    start_time is null or finish_time is null or finish_time >= start_time
  )
);

create index if not exists site_diary_entries_project_date_idx
  on site_diary_entries (project_id, entry_date desc);
create index if not exists site_diary_entries_company_idx
  on site_diary_entries (company_id, entry_date desc);

-- ── Structured attendance ────────────────────────────────────────────────────
--
-- §23: "so the diary agrees with the schedule and the timesheets". A free-text
-- "8 lads on site" agrees with nothing and can be reconciled against nothing,
-- which is why this is a table rather than a fourteenth narrative field.

create table if not exists site_diary_attendance (
  id uuid primary key default gen_random_uuid(),
  diary_entry_id uuid not null references site_diary_entries(id) on delete cascade,

  -- Three ways to say who, in descending order of how much the platform knows.
  user_id             uuid references users(id) on delete set null,  -- an employee
  provider_company_id uuid references companies(id),                 -- a subcontractor's crew
  name    text,                                                      -- free text when neither is known
  role_id uuid references role_catalog(id),

  headcount numeric(6,2) not null default 1,
  hours     numeric(6,2),

  -- The link that makes the diary and the timesheet one story rather than two.
  time_log_id uuid references time_logs(id) on delete set null,

  created_at timestamptz not null default now(),

  -- AN ATTENDANCE ROW THAT NAMES NOBODY IS A HEADCOUNT, NOT ATTENDANCE.
  -- Without this a client that failed to send any of the three still gets a row,
  -- and the diary's whole claim — that it can be reconciled against the schedule
  -- and the timesheets — quietly stops being true one row at a time.
  constraint site_diary_attendance_names_somebody check (
    user_id is not null or provider_company_id is not null
      or (name is not null and length(btrim(name)) > 0)
  ),
  constraint site_diary_attendance_headcount_positive check (headcount > 0),
  constraint site_diary_attendance_hours_sane check (hours is null or (hours >= 0 and hours <= 24))
);

create index if not exists site_diary_attendance_entry_idx
  on site_diary_attendance (diary_entry_id);

-- PREFILL APPLIED TWICE MUST NOT DOUBLE THE CREW.
--
-- §23's prefill exists so the supervisor *confirms* rather than retypes, and the
-- confirm button is the one a person on a tablet presses twice. Without this the
-- second press produces a day with sixteen people on it and four of them
-- imaginary, and nothing in the record says which four. The unique index makes
-- the second application a no-op instead of a fabrication.
create unique index if not exists site_diary_attendance_one_per_time_log_idx
  on site_diary_attendance (diary_entry_id, time_log_id) where time_log_id is not null;

-- ── The two joins ────────────────────────────────────────────────────────────

create table if not exists site_diary_locations (
  diary_entry_id uuid not null references site_diary_entries(id) on delete cascade,
  location_id    uuid not null references project_locations(id) on delete cascade,
  primary key (diary_entry_id, location_id)
);
create index if not exists site_diary_locations_location_idx
  on site_diary_locations (location_id);

-- §23's `site_diary_documents`. A day's site instruction, delivery note or
-- weighbridge ticket is filed once as a document and *referenced* here, rather
-- than uploaded a second time against the day — one set of bytes, one expiry, one
-- version chain, cited from wherever it is relevant.
create table if not exists site_diary_documents (
  diary_entry_id uuid not null references site_diary_entries(id) on delete cascade,
  document_id    uuid not null references project_documents(id) on delete cascade,
  primary key (diary_entry_id, document_id)
);
create index if not exists site_diary_documents_document_idx
  on site_diary_documents (document_id);

-- ── The back-reference 0030 promised ─────────────────────────────────────────
--
-- `project_evidence.diary_entry_id` is the first of the five foreign keys 0030
-- deliberately left out, and it arrives under exactly the condition that
-- migration set: with the table it points at, a real foreign key, and a real
-- consumer on the same day. Evidence is tagged to a day on capture or after it,
-- the diary reads its own photographs back, and Close Day counts them.
alter table project_evidence
  add column if not exists diary_entry_id uuid references site_diary_entries(id) on delete set null;

create index if not exists project_evidence_diary_idx
  on project_evidence (diary_entry_id) where diary_entry_id is not null;

-- The revision trigger from 0029, reused rather than reimplemented.
drop trigger if exists site_diary_entries_bump_revision on site_diary_entries;
create trigger site_diary_entries_bump_revision
  before update on site_diary_entries
  for each row execute function bump_revision();

-- ── What is deliberately NOT here ────────────────────────────────────────────
--
-- NO `deleted_at`, AND THEREFORE NO DELETE ROUTE. Every other record in this
-- phase is tombstoned, and this one is the exception on purpose. The diary is
-- what somebody reads in a dispute; a day that can be removed is a day somebody
-- can make not have happened, and a tombstone is still a row that stops being
-- rendered. The wrong-date entry the column would exist for is an OPEN entry with
-- nothing in it, which is already indistinguishable from a day nobody has written
-- yet. Adding the column without a writer would be worse than either: this
-- repository has twice recorded that a column nothing writes is indistinguishable,
-- on inspection, from one whose writer is broken.
--
-- NO `workers_present_count` / `subcontractors_present_count`. §23 has both,
-- "denormalized from attendance for quick display", and they are the same shape
-- as the `superseded` boolean 0031 refused: two answers to one question, which
-- disagree the first time an attendance row is corrected on a closed day. They
-- are a `sum(headcount)` over rows this table already holds, computed in the read
-- projection where nothing can back-fill it wrongly.
--
-- NO amendment counter either. The count is `max(revision)` over
-- `record_revisions` for this entry, which is where the amendments themselves
-- live. A counter column beside a revision table is two answers to one question
-- in the one place the product promises the answer is exact.
comment on column site_diary_entries.company_id is
  'The AUTHORING company. A subcontractor keeps its own diary for the same project day (§23); the unique key is (project_id, company_id, entry_date) and the owner sees both, each attributed.';
comment on column site_diary_entries.status is
  'OPEN or CLOSED. There is no reopen: a post-close change is an amendment with a required reason in record_revisions, which is a different and more honest object than a day that was closed becoming open again (project-evidence.md §3).';
