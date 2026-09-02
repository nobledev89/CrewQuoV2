-- Project activities (CREWQUO_V2_PLAN.md §27.3) — step 4 of the Phase 9 build
-- order in docs/operating-model/sustainability.md §14.
--
-- A van did 240 km collecting from site. 180 litres of diesel went into a
-- generator. The site drew 1,200 kWh. This is the table those live in, and it is
-- THE ONLY TABLE IN PHASE 9 THAT A PERSON WRITES BY HAND — everything else here
-- is either reference data imported at a desk or a figure the engine derived.
--
-- That single fact decides four things about this file: it is the one table under
-- the Phase 7 sync contract (§8), the one that needed a new capability key
-- (finding 10), the one whose `created_by_user_id` had to be corrected for the
-- closure decision (finding 3), and the one whose rows an emissions figure is
-- computed FROM rather than stored IN.
--
-- ── FOUR DEPARTURES FROM THE CANONICAL DDL ───────────────────────────────────
--
--   * `created_by_user_id` is NULLABLE with `on delete set null`, not `not null`
--     (finding 3). THE THIRD TIME: 0030 found it on project_evidence, 0034 found
--     it on project_assets, and the fix has not changed — the null IS the
--     tombstoned identity rather than a missing value. The 2026-08-20 closure
--     decision anonymises the person and preserves the record, so `not null` makes
--     "close this account" either impossible or destructive of a project's
--     activity ledger. And an activity row is an INPUT TO A PUBLISHED EMISSIONS
--     FIGURE, so destroying one silently changes a number somebody has reported.
--
--     That this is the third occurrence is itself the finding, so the packet
--     checked the class rather than the instance: of the five user references in
--     §26–§39, `carbon_calculations.calculated_by_user_id`,
--     `product_carbon_factors.created_by_user_id`,
--     `emission_factor_sets.imported_by_user_id` and
--     `sustainability_settings.updated_by_user_id` are all already nullable and
--     correct. Only this one was wrong, and it is the one table that is
--     field-captured.
--
--   * `vehicle_id uuid references vehicles(id)` is OMITTED (finding 4). `vehicles`
--     is Phase 11 (§31), and 0030's reason is unchanged: "a column nothing writes
--     and nothing reads is indistinguishable, on inspection, from one whose writer
--     is broken." It arrives with the migration that creates the table it points
--     at.
--
--     `vehicle_category`, `fuel_type` and `distance_km` ALL STAY, and the
--     distinction is Phase 8's: they have a Phase 9 consumer that needs no fleet.
--     §27.3 prices transport as distance × factor(vehicle category, fuel), and a
--     subcontractor's van is a category and a fuel without a `vehicles` row
--     anywhere. The foreign key is what waits; the semantics do not.
--
--   * The sync contract's columns are here and §27.3 has none of them (§8). This
--     is the profile the contract was designed against — a fuel fill recorded
--     one-handed on a bad connection — so it carries `revision`, `deleted_at` and
--     a client id, following `project_assets`.
--
--   * `captured_at` is a column §27.3 does not list. `activity_date` is a claim
--     about which project day the journey belongs to and `created_at` is when the
--     server accepted the row; neither is "what the device's clock said when Sam
--     pressed save", and CAPTURE_TIMESTAMPS in packages/shared/src/sync.ts is
--     explicit that collapsing the three is the naive implementation.

create table if not exists project_activities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- WHO RECORDED IT, WHICH IS NOT WHOSE PLAN PAYS FOR IT. `sustainability` is
  -- checked against `projects.owner_company_id`; this column stays the recorder.
  -- 0030's comment transfers unchanged: "two facts, two columns, and collapsing
  -- them is how the meter starts disagreeing with the audit trail."
  company_id uuid not null references companies(id),

  kind text not null check (kind in
    ('VEHICLE_DISTANCE','FUEL','ELECTRICITY','FREIGHT','PLANT','OTHER')),
  activity_date date not null,

  vehicle_category text,
  fuel_type text,

  -- §27.3's five measures. All nullable, and exactly one is required by the API
  -- for each `kind` — the pairing is enforced in `activityQuantity` rather than by
  -- a check constraint, because the constraint would have to be rewritten every
  -- time a kind is added and a wrong one is a migration to undo.
  distance_km numeric(12,3) check (distance_km >= 0),
  litres      numeric(12,3) check (litres >= 0),
  kwh         numeric(14,3) check (kwh >= 0),
  tonne_km    numeric(14,3) check (tonne_km >= 0),
  journeys    int check (journeys > 0),

  -- WHAT THE USER ACTUALLY TYPED, kept beside the derived measure above. A person
  -- who entered 150 miles and reads back 241.4 km cannot check their own entry,
  -- and §41.2's "name your activity data" means the number they typed, not the
  -- number we converted it to. `convertQuantity` does the conversion at
  -- calculation time from these two.
  entered_value numeric(14,3) check (entered_value >= 0),
  entered_unit text check (entered_unit in ('km','mile','litre','kWh','tonne','tonne.km')),

  purpose text check (purpose in
    ('COLLECTION','DELIVERY','WASTE_TRANSPORT','ASSET_TRANSPORT','CREW_TRAVEL','PLANT','OTHER')),

  -- THE COLUMN THAT MOVES AN ACTIVITY FROM SCOPE 1 TO SCOPE 3 (§27.3), which is
  -- why it is not decoration and why it is bounded in the API. A row naming
  -- another business is an assertion that business cannot see or contest — 0033's
  -- rule for `linked_company_id` and §23's for `provider_company_id`. A provider
  -- sets this to itself or leaves it null; it cannot attribute a journey to a
  -- third party.
  provider_company_id uuid references companies(id),

  -- What links an activity to the reuse it enabled. §27.4 deducts "the additional
  -- emissions required to make the reuse happen — refurbishment, cleaning,
  -- transport, storage" from the baseline, and this is how the engine knows which
  -- activities those were. Null is the ordinary case: most activities enable
  -- nothing in particular.
  asset_movement_id uuid references asset_movements(id) on delete set null,

  source text not null default 'ESTIMATED'
    check (source in ('MEASURED','DOCUMENTED','ESTIMATED')),
  document_id uuid references project_documents(id),
  notes text,

  -- Nullable, unlike §27.3's `not null`, and the null is the tombstoned identity.
  created_by_user_id uuid references users(id) on delete set null,
  updated_by_user_id uuid references users(id) on delete set null,

  -- The device's clock, which the person holding it can set. A claim, distinct
  -- from `created_at` (server truth) and from `activity_date` (which project day
  -- it counts as). All three are genuinely different for a fill recorded in a
  -- basement on Friday and delivered on Monday.
  captured_at timestamptz,

  -- The sync contract (0029, item 7.7). The client id is a SECOND guarantee
  -- beside `mutation_receipts`, not a duplicate of it: the receipt ledger answers
  -- a retry with the original response, and this index is the invariant that
  -- survives the ledger's own retention — "exactly one row exists" stays true and
  -- stays assertable directly against the table.
  client_id uuid,
  revision int not null default 1,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_activities_project_kind_date_idx
  on project_activities (project_id, kind, activity_date) where deleted_at is null;
create index if not exists project_activities_project_company_idx
  on project_activities (project_id, company_id) where deleted_at is null;
create index if not exists project_activities_movement_idx
  on project_activities (asset_movement_id)
  where asset_movement_id is not null and deleted_at is null;
create index if not exists project_activities_provider_idx
  on project_activities (provider_company_id) where provider_company_id is not null;
create index if not exists project_activities_document_idx
  on project_activities (document_id) where document_id is not null;

-- Scoped to the project rather than to the company, because a device queue is per
-- project in the UI and a uuid collision across projects is not a thing worth
-- refusing. `and deleted_at is null` for the reason 0034's serial index carries
-- it: without it a tombstoned row blocks its own re-creation, which on a syncing
-- device is a permanent failure with no visible cause.
create unique index if not exists project_activities_client_id_idx
  on project_activities (project_id, client_id)
  where client_id is not null and deleted_at is null;

-- The revision trigger from 0029, reused rather than reimplemented. It already
-- refuses to fire when nothing changed, which on a syncing device is the
-- difference between a conflict prompt and a conflict.
drop trigger if exists project_activities_bump_revision on project_activities;
create trigger project_activities_bump_revision
  before update on project_activities
  for each row execute function bump_revision();

comment on table project_activities is
  'The one Phase 9 table a person writes by hand, and therefore the one under the Phase 7 sync contract (sustainability.md §8). Everything else in this phase is reference data imported at a desk or a figure the engine derived.';
comment on column project_activities.created_by_user_id is
  'Nullable, unlike §27.3''s not null — the third table to need this correction after 0030 and 0034. The null IS the tombstoned identity. An activity row is an input to a published emissions figure, so destroying one silently changes a number somebody has already reported.';
comment on column project_activities.provider_company_id is
  'Moves the activity from Scope 1 to Scope 3 (§27.3), and is an assertion about another business. Bounded in the API to the acting company itself: a provider may record its OWN transport and may not attribute a journey to a third party.';
comment on column project_activities.entered_value is
  'What the user typed, kept beside the derived measure. A person who entered 150 miles and reads back 241.4 km cannot check their own entry, and §41.2''s "name your activity data" means the number they typed.';

-- ── The one new capability key (§37, packet finding 10) ──────────────────────
--
-- §37's vocabulary shipped with 0026 and holds three sustainability keys —
-- `sustainability.read`, `sustainability.factors.manage` and
-- `sustainability.settings.manage`. All three are the sustainability lead's. NONE
-- OF THEM COVERS A PROJECT MANAGER OR A SUPERVISOR RECORDING AN ACTIVITY, which
-- is the only routine, field-captured, non-admin write this phase adds.
--
-- The two ways of avoiding a new key are both worse than adding one:
--
--   * Gating the write on `sustainability.read` fills one column of the §4 matrix
--     and leaves the rest empty, which the operating-model template calls a hole
--     in as many words — a "read" key that also permits a write is a key whose
--     name lies about what granting it does.
--
--   * Reusing `asset.write` — the nearest neighbour, already in the Supervisor
--     bundle — would mean anyone who can record a chair can also attribute a
--     journey to a subcontractor's van, which is `provider_company_id`, which is
--     an assertion about another business (§4).
--
-- It goes into the Project Manager and Supervisor bundles beside `asset.write`
-- and `diary.write`, the two keys it most resembles in who holds them and what
-- they record, and into `sustainability` because that bundle already holds every
-- other key in this domain. Not into `worker` or `finance`: a worker photographs
-- and logs their own hours, and a finance user has no reason to assert what a van
-- did.
--
-- Mirrored in SYSTEM_BUNDLE_CAPABILITIES in packages/shared/src/capabilities.ts,
-- which capabilityParity asserts against — a capability added late gets added to
-- whichever bundle the failing test names, and the bundles are what §44's
-- one-test-per-rule authorization suite asserts against.
insert into capabilities (key, name, description, category, sort_order) values
  ('sustainability.write', 'Record activities',
   'Record fuel, distance, electricity and freight against a project',
   'Sustainability', 195)
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  sort_order = excluded.sort_order;

insert into capability_bundle_items (bundle_key, capability_key) values
  ('admin',            'sustainability.write'),
  ('project_manager',  'sustainability.write'),
  ('supervisor',       'sustainability.write'),
  ('sustainability',   'sustainability.write')
on conflict do nothing;
