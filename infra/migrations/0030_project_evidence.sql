-- Project evidence (CREWQUO_V2_PLAN.md §22.2) — step 4 of the Phase 7 build
-- order in docs/operating-model/project-evidence.md §14.
--
-- The record that makes a photograph evidence rather than a file. `stored_files`
-- (0027) holds the bytes and their lifecycle; this holds the claim about what
-- they show, which project day they belong to, where on the site they were taken
-- and whether the client has been shown them.

create table if not exists project_evidence (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- WHO UPLOADED IT, WHICH IS NOT WHO PAYS FOR IT. The byte meter joins through
  -- `projects.owner_company_id` (owner decision, 2026-09-01, and the join lives
  -- in `storage/repo.ts`). This column stays the uploader — two facts, two
  -- columns, and collapsing them is how the meter starts disagreeing with the
  -- audit trail.
  company_id uuid not null references companies(id),

  -- The ORIGINAL. Derivatives are found through `stored_files.derivative_of`
  -- rather than pinned here: a WEB variant that failed to generate and later
  -- succeeds must appear without an update to this row, and a column that has to
  -- be back-filled by a worker is a column that is null in production.
  file_id uuid not null references stored_files(id),

  category text not null check (category in
    ('BEFORE','DURING','AFTER','COLLECTION','DELIVERY','INSTALLATION','REUSE','DONATION',
     'RECYCLING','WASTE','DAMAGE','INCIDENT','ASSET','OTHER')),
  caption text,
  notes   text,

  -- ── The three timestamps, and they are three columns on purpose ────────────
  --
  -- `created_at` is when the server accepted it — the only one the platform
  -- attests to. `captured_at` is what the device's clock said, which the person
  -- holding it can set. `evidence_date` is a human's claim about which project
  -- day it belongs to: a supervisor uploading Friday's photos on Monday sets
  -- Friday. Reports order by `evidence_date`; disputes rely on the other two.
  --
  -- An offline queue is what makes the difference bite. A photograph taken on
  -- Friday in a basement, queued, and delivered on Monday has all three genuinely
  -- different, and the naive implementation stamps `created_at` and treats the
  -- other two as decoration.
  evidence_date date,
  captured_at   timestamptz,

  location_id uuid references project_locations(id),

  -- ── GPS: columns now, capture never (yet) ─────────────────────────────────
  --
  -- §13.7 is still open and its recommendation is to capture nothing, which needs
  -- no decision to proceed. The columns land here because the *shape* of the
  -- record is decided in this migration, and the governing setting
  -- (`capture_gps_on_evidence`, §39) arrives with a Phase 9 table — so the
  -- alternative is a migration on a table that by then holds a year of evidence.
  -- They are written by nothing until that setting exists.
  gps_lat numeric(9,6),
  gps_lng numeric(9,6),
  gps_accuracy_m numeric(8,2),

  -- ── Disclosure ────────────────────────────────────────────────────────────
  --
  -- `client_visible` is the only flag in this table that carries weight, and it
  -- is a disclosure rather than a state: flipping it back does not un-send what
  -- the client already downloaded.
  --
  -- `first_published_at` is therefore set on the first publish and NEVER cleared.
  -- Without it a screen offering "hide from client" implies a retraction the
  -- product cannot perform, and the person who believes it is the person who
  -- published the wrong photograph and thinks they have fixed it.
  client_visible boolean not null default false,
  first_published_at timestamptz,

  sort_order int not null default 0,

  -- Nullable, unlike §22.2's `not null`, and the reason is the closure decision
  -- of 2026-08-20: deletion anonymises the person and preserves the record. A
  -- `not null` here would make "close Ade's account" either impossible or
  -- destructive of the hiring company's evidence, which is precisely the outcome
  -- §7 promises against. `on delete set null` is the tombstoned identity.
  uploaded_by_user_id uuid references users(id) on delete set null,

  -- The client-supplied id shared by one selection (§8). Forty photographs is one
  -- act by one person: it keys the single `evidence.batch_uploaded` event, and it
  -- is how "show me what I just uploaded" is asked after a filter has moved.
  batch_client_id uuid,

  -- The sync contract's two columns (0029, item 7.7).
  revision int not null default 1,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── The identity of a piece of evidence is its file ──────────────────────────
--
-- One live record per stored file. This is what makes a replayed batch safe at
-- the row level rather than only at the ledger: a retry that re-posts the same
-- forty file ids cannot create eighty records, whatever happened to the client id
-- in between.
--
-- It deliberately does NOT deduplicate by checksum. Two identical photographs of
-- one wall taken an hour apart are two pieces of evidence, and they are two
-- different `stored_files` rows with two different bucket keys (§3).
create unique index if not exists project_evidence_one_per_file_idx
  on project_evidence (file_id) where deleted_at is null;

-- §22.2's two indexes, plus the tombstone filter every read carries.
create index if not exists project_evidence_project_date_idx
  on project_evidence (project_id, evidence_date desc, created_at desc)
  where deleted_at is null;
create index if not exists project_evidence_project_category_idx
  on project_evidence (project_id, category) where deleted_at is null;
create index if not exists project_evidence_location_idx
  on project_evidence (location_id) where location_id is not null and deleted_at is null;
create index if not exists project_evidence_batch_idx
  on project_evidence (batch_client_id) where batch_client_id is not null;

-- The revision trigger from 0029, reused rather than reimplemented. It already
-- refuses to fire when nothing changed, which on a syncing device is the
-- difference between a conflict prompt and a conflict.
drop trigger if exists project_evidence_bump_revision on project_evidence;
create trigger project_evidence_bump_revision
  before update on project_evidence
  for each row execute function bump_revision();

-- ── What is deliberately NOT here ────────────────────────────────────────────
--
-- §22.2 lists five more foreign keys: `asset_id`, `diary_entry_id`,
-- `variation_id`, `incident_id` and `asset_movement_id`. None of those tables
-- exists yet — the diary is 7.5, assets and movements are Phase 8, variations and
-- incidents are Phase 11 — and the plan's own ordering note says the migration
-- adds back-references with `alter table` at the end.
--
-- They are omitted rather than added as bare uuids, and this repository has
-- already recorded why twice under the names "a column with no reader" and "a
-- pruner with no caller": a column nothing writes and nothing reads is
-- indistinguishable, on inspection, from one whose writer is broken. Each of the
-- five arrives with the migration that creates the table it points at, where it
-- can carry a real foreign key and a real consumer on the same day.
comment on column project_evidence.first_published_at is
  'Set the first time this was made client-visible and never cleared. Un-publishing hides the record from the client going forward; it does not withdraw a disclosure already made (project-evidence.md §3).';
