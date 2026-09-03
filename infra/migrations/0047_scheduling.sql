-- Crew scheduling (CREWQUO_V2_PLAN.md §31) — step 11.3 of the Phase 11 build order
-- in docs/operating-model/commercial-operations.md §14.
--
-- Four tables, one column on a Phase 9 table, and one feature key.
--
-- Two of the four tables are NOT IN §31's DDL AT ALL (packet finding 7). §31
-- describes them in prose — *"per-user availability windows and per-project role
-- requirements ('2 × Rigger, 1 × Supervisor, Mon–Wed') drive an
-- unfilled-requirement indicator. Requirements live on the project, not the
-- schedule"* — and the last sentence is a design instruction that only means
-- anything if there is a table for it to be true of.
--
-- One column on `schedule_assignments` is not in §31 either, and it is the phase's
-- sixth finding: an assignment carries no shift type, and every rate the engine
-- resolves is keyed on one. See its comment below.

-- ── Vehicles (§31) ───────────────────────────────────────────────────────────
--
-- The table `assets-materials.md` finding 7 and `sustainability.md` finding 3 both
-- deferred a foreign key to, twice, on `0030`'s rule that a column with no reader
-- does not ship. It has a reader on the day it exists — see the bottom of this
-- file.

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  name text not null check (length(btrim(name)) > 0),
  registration text,
  -- Free text, deliberately, and matching §31's own examples ("Van (class III)",
  -- "HGV rigid 7.5-17t"). A catalog of vehicle categories would have to be the
  -- factor library's categories, which are per-factor-set and change with the
  -- dataset; `emission_factor_activity` below is how a vehicle reaches those.
  category text,
  fuel_type text,

  -- The factor `activity` an admin mapped it to (§26). This is what makes a fleet
  -- row useful to Phase 9 rather than decorative: an activity recorded against
  -- this vehicle prefills its category and fuel, and a company that has mapped its
  -- vans to factor activities stops retyping them.
  emission_factor_activity text,
  capacity_note text,

  -- Retired, never deleted while referenced (§9's failure matrix). The same rule
  -- `asset_types` and `destination_types` follow, and DELETE refuses with a
  -- sentence naming the count and offering this instead.
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table vehicles is
  'The company fleet (§31). Company reference data like a role, so `scheduling` is checked against the ACTING company rather than a project owner — a fleet has no project to find an owner of, which is the exception `custom_factors` already is.';
comment on column vehicles.emission_factor_activity is
  'The §26 factor activity an admin mapped this vehicle to. Read by project_activities.vehicle_id''s prefill, which COPIES category and fuel rather than joining — so retiring a vehicle next year cannot restate last year''s emissions (§41.3).';

-- §31's index, with one addition: `lower(registration)`. Two rows for `LX21 ABC`
-- and `lx21 abc` are the same van, and a uniqueness rule that a keyboard can
-- defeat is not one.
create unique index if not exists vehicles_registration_idx
  on vehicles (company_id, lower(btrim(registration))) where registration is not null;
create index if not exists vehicles_company_idx on vehicles (company_id, active, name);

-- ── Assignments (§31) ────────────────────────────────────────────────────────

create table if not exists schedule_assignments (
  id uuid primary key default gen_random_uuid(),

  -- The SCHEDULING company, which is always the project owner: `schedule.manage`
  -- is owner-only (packet §4). A subcontractor reads its own rows and writes none.
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,

  resource_type text not null check (resource_type in ('USER','PROVIDER','VEHICLE')),
  user_id             uuid references users(id) on delete set null,
  provider_company_id uuid references companies(id),
  vehicle_id          uuid references vehicles(id),

  role_id uuid references role_catalog(id),
  is_supervisor boolean not null default false,
  -- §31: "for PROVIDER rows: '4 crew from Pashe'". Constrained to 1 on the other
  -- two below, because a headcount of 3 on a named person fills three requirement
  -- slots with one human — which is the arithmetic §31's indicator depends on.
  headcount int not null default 1 check (headcount >= 1),

  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  location_id uuid references project_locations(id),

  -- ── PACKET FINDING 6, and the one column §31 does not have ────────────────
  --
  -- §31 asks for *"planned labour cost [resolved] through the rate engine for
  -- §30.2's budget line"*, and gives an assignment two instants. `resolveRate`
  -- takes a `ShiftType`, and there is no function in `rate-engine/` that derives
  -- one from a clock time — deliberately: `types.ts` says *"time of day is carried
  -- by shiftType itself, because time_logs records hours worked and not clock
  -- times."*
  --
  -- An implementation reading `starts_at.getHours() >= 20 ? 'NIGHT' : 'WEEKDAY_DAY'`
  -- would put a rate rule back into code ELEVEN PHASES after the owner had the
  -- FRI_SAT_NIGHT branch deleted from `resolveRateLabel` for exactly that reason —
  -- and it would be wrong in a way nobody notices for months, because it is only
  -- consulted for a planned figure.
  --
  -- So it is stated, nullable, and a planned cost exists only when it is set.
  -- Otherwise the figure is withheld with a reason, which is what
  -- `resolveBillCentsForLog` already does for a missing BILL card.
  shift_type text check (shift_type in ('WEEKDAY_DAY','NIGHT','SUNDAY','SHIFT','DAILY')),

  status text not null default 'PLANNED' check (status in ('PLANNED','CONFIRMED','CANCELLED')),
  notes text,

  -- Priya's Monday morning is one act of eleven rows (packet §5). Keys the single
  -- outbox event and the idempotency ledger, exactly as
  -- `project_evidence.batch_client_id` does.
  batch_client_id uuid,

  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- §31's own check.
  check (ends_at > starts_at),

  -- Exactly one resource, and it is the one `resource_type` names. Without this a
  -- row with a `user_id` and `resource_type = 'VEHICLE'` is stored, conflicts
  -- against nothing, and is invisible in both views.
  constraint schedule_assignments_one_resource
    check (
      (resource_type = 'USER'     and user_id is not null and provider_company_id is null and vehicle_id is null)
   or (resource_type = 'PROVIDER' and provider_company_id is not null and user_id is null and vehicle_id is null)
   or (resource_type = 'VEHICLE'  and vehicle_id is not null and user_id is null and provider_company_id is null)
    ),

  -- A person and a van are one each.
  constraint schedule_assignments_headcount
    check (resource_type = 'PROVIDER' or headcount = 1)
);

comment on table schedule_assignments is
  'Who and what is on a project, and when (§31). NOT project_assignments, which says which COMPANY is on the job: this says which people and which van, never crosses to the client, and a subcontractor sees only rows naming it (commercial-operations.md §4).';
comment on column schedule_assignments.shift_type is
  'Stated, never derived from the clock. Every rate the engine resolves is keyed on a shift type, and deriving one from an hour would put a rate rule back in code (owner decision, 2026-08-17). A planned cost exists only when this is set.';
comment on column schedule_assignments.status is
  'CANCELLED rows are retained and never conflict (§31). Cancel is a status rather than a delete because a cancelled row is the answer to "was Femi ever booked that week?" — which is what somebody asks when nobody turned up.';
comment on column schedule_assignments.batch_client_id is
  'One planning act, many rows. Keys the single notification and the idempotent replay.';

-- §31's two indexes.
create index if not exists schedule_assignments_company_idx
  on schedule_assignments (company_id, starts_at);
create index if not exists schedule_assignments_project_idx
  on schedule_assignments (project_id, starts_at);
-- Conflict detection's own query: "what else is this resource booked on, in this
-- window?" Three partial indexes rather than one composite, because a candidate
-- names exactly one resource and a composite over three mostly-null columns would
-- be scanned rather than sought.
create index if not exists schedule_assignments_user_idx
  on schedule_assignments (user_id, starts_at) where user_id is not null and status <> 'CANCELLED';
create index if not exists schedule_assignments_vehicle_idx
  on schedule_assignments (vehicle_id, starts_at) where vehicle_id is not null and status <> 'CANCELLED';
create index if not exists schedule_assignments_provider_idx
  on schedule_assignments (provider_company_id, starts_at)
  where provider_company_id is not null and status <> 'CANCELLED';
create index if not exists schedule_assignments_batch_idx
  on schedule_assignments (batch_client_id) where batch_client_id is not null;
create index if not exists schedule_assignments_location_idx
  on schedule_assignments (location_id) where location_id is not null;

-- ── Availability (§31 in prose only — packet finding 7) ──────────────────────
--
-- §31 describes this as PER-USER. One table serves all three resource types
-- instead, because the same paragraph's other rule needs an availability for a
-- COMPANY — *"only warns when headcount exceeds a stated availability"* — and a
-- vehicle off the road for a service should not need a third table. With one table
-- the headcount warning is the same comparison as the other two rather than a
-- special case somewhere else in the code.

create table if not exists resource_availability (
  id uuid primary key default gen_random_uuid(),

  -- The company that OWNS the resource, which for a PROVIDER row is the
  -- subcontractor's own company: a stated crew count is a statement the
  -- subcontractor makes, readable by the hiring company it was stated to.
  company_id uuid not null references companies(id) on delete cascade,

  resource_type text not null check (resource_type in ('USER','PROVIDER','VEHICLE')),

  -- `on delete CASCADE` on `user_id`, and it is **the one deliberate exception to
  -- the on-delete-set-null rule every other user reference in this phase follows.**
  --
  -- Everywhere else the rule is about preserving a record whose author has closed
  -- their account. This is the opposite kind of row: it is personal data about
  -- somebody's private time — "unavailable, Thursday afternoons" — and it is not
  -- evidence of anything. A window whose person is gone should go with them, and an
  -- anonymised window pointing at nobody is data retained for no reason, which is
  -- the failure the closure promise exists to prevent rather than an instance of it.
  --
  -- It fires almost never in practice: closure anonymises users rather than deleting
  -- them (0022). Written this way so that if a hard delete ever does happen, the
  -- private half goes first.
  user_id             uuid references users(id) on delete cascade,
  provider_company_id uuid references companies(id) on delete cascade,
  vehicle_id          uuid references vehicles(id) on delete cascade,

  kind text not null default 'AVAILABLE' check (kind in ('AVAILABLE','UNAVAILABLE')),

  -- PROVIDER rows only: how many crew this subcontractor has stated it can supply
  -- in this window. Null on the other two, where the resource is one thing.
  headcount int check (headcount >= 0),

  starts_at timestamptz not null,
  ends_at   timestamptz not null,

  -- A short label, and there is deliberately **NO `reason` COLUMN** (packet §7).
  -- "Unavailable, 14-21 August" is a holiday; "unavailable Thursday afternoons" is
  -- frequently a medical appointment. A field for the reason is a field somebody
  -- writes it in, on a row that is personal data about somebody's private time.
  note text,

  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (ends_at > starts_at),

  constraint resource_availability_one_resource
    check (
      (resource_type = 'USER'     and user_id is not null and provider_company_id is null and vehicle_id is null)
   or (resource_type = 'PROVIDER' and provider_company_id is not null and user_id is null and vehicle_id is null)
   or (resource_type = 'VEHICLE'  and vehicle_id is not null and user_id is null and provider_company_id is null)
    ),
  -- Only a subcontractor states a crew count.
  constraint resource_availability_headcount
    check (resource_type = 'PROVIDER' or headcount is null)
);

comment on table resource_availability is
  'Availability windows for a person, a vehicle or a subcontractor''s stated crew count (§31, declared here because §31 names it in prose only — commercial-operations.md finding 7). A resource with NO AVAILABLE window is treated as always available: warning on every row because an optional table is empty would ship the feature broken.';
comment on column resource_availability.note is
  'A short label. There is deliberately no `reason` column: an unavailability is frequently medical, and a field for the reason is a field somebody writes it in.';

create index if not exists resource_availability_user_idx
  on resource_availability (user_id, starts_at) where user_id is not null;
create index if not exists resource_availability_vehicle_idx
  on resource_availability (vehicle_id, starts_at) where vehicle_id is not null;
create index if not exists resource_availability_provider_idx
  on resource_availability (provider_company_id, starts_at) where provider_company_id is not null;
create index if not exists resource_availability_company_idx
  on resource_availability (company_id, starts_at);

-- ── Role requirements (§31 in prose only — packet finding 7) ─────────────────
--
-- *"Requirements live on the project, not the schedule."*

create table if not exists project_role_requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,

  role_id uuid not null references role_catalog(id),
  quantity int not null check (quantity >= 1),
  is_supervisor boolean not null default false,

  -- Null means the whole project, which is the common case for a small job and is
  -- why §31's own example ("Mon-Wed") is a window rather than a requirement.
  starts_on date,
  ends_on   date,
  notes text,

  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (starts_on is null or ends_on is null or ends_on >= starts_on)
);

comment on table project_role_requirements is
  '"2 x Rigger, 1 x Supervisor, Mon-Wed" (§31). Drives the unfilled-requirement indicator, where a PROVIDER assignment counts its headcount and a USER row counts one — which is what §31 gave provider rows a headcount for.';

-- One requirement per role per window. Without it, editing "2 x Rigger" by adding
-- a second row rather than changing the first silently doubles the requirement,
-- and the indicator reports a shortfall nobody can clear.
create unique index if not exists project_role_requirements_unique_idx
  on project_role_requirements (project_id, role_id, coalesce(starts_on, 'epoch'::date),
                                coalesce(ends_on, 'infinity'::date));
create index if not exists project_role_requirements_project_idx
  on project_role_requirements (project_id, role_id);

-- ── The deferred column, now that it has a reader (packet finding 8) ─────────
--
-- `assets-materials.md` finding 7 and `sustainability.md` finding 3 both recorded
-- a foreign key to `vehicles` being omitted because the table was Phase 11 and
-- `0030`'s rule refuses a column with no reader. This is the third time it has
-- been named and the first time the table exists.
--
-- Two properties are kept deliberately:
--
--   * `vehicle_category` and `fuel_type` STAY on project_activities. A
--     subcontractor's van is a category and a fuel with no fleet row, which is why
--     those columns exist rather than a join, and 0040's reasoning is unchanged.
--   * The prefill COPIES rather than joins. Retiring a vehicle or correcting its
--     category next year must not restate last year's emissions, which is §41.3
--     enforced by the shape of the write rather than by remembering.
--
-- `on delete set null` for that same reason: losing the fleet reference degrades a
-- future prefill and falsifies nothing, because the category and fuel that
-- produced every existing calculation are on the activity row itself.
alter table project_activities add column if not exists vehicle_id uuid
  references vehicles(id) on delete set null;

comment on column project_activities.vehicle_id is
  'The fleet vehicle this journey was made in (§31, Phase 11). Prefills vehicle_category and fuel_type by COPYING them at write time — never by joining — so retiring a vehicle cannot restate a published figure (§41.3).';

create index if not exists project_activities_vehicle_idx
  on project_activities (vehicle_id) where vehicle_id is not null;

-- ── Entitlements (§43) ───────────────────────────────────────────────────────

insert into features (key, name, description, category) values
  ('scheduling', 'Crew scheduling',
   'Plan people, subcontractor crews and vehicles across projects by day, week or month, with conflicts and unfilled requirements surfaced',
   'operations')
on conflict (key) do nothing;

-- §43's placement, taken exactly: Starter and up. See 0045's note on why this
-- insert is not the authority (infra/seed rebuilds plan_features) and why it is a
-- `select … from plans` rather than a literal VALUES list (0027's defect: on a
-- fresh database `plans` is empty until db:seed, and a literal insert violates the
-- foreign key and stops the whole migration run).
insert into plan_features (plan_id, feature_key)
select p.id, 'scheduling' from plans p
where p.id in ('starter', 'pro', 'business', 'enterprise')
on conflict do nothing;
