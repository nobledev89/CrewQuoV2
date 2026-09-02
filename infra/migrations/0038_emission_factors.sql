-- Emission factor sets and their factors (CREWQUO_V2_PLAN.md §26.1) — step 2 of
-- the Phase 9 build order in docs/operating-model/sustainability.md §14.
--
-- The versioned reference-data layer, built the way the rate engine was built and
-- for the same reason (locked decision #15): the numbers belong to the customer
-- and to a point in time, not to a release of our code.
--
-- LOCKED DECISION #16 IS WHY THIS FILE SEEDS NOTHING. "No emission factor is ever
-- hard-coded. Factors arrive by import into `emission_factor_sets`; the seed ships
-- the importer and the schema, never invented numbers." §45's licensing gate on
-- the UK Government GHG Conversion Factors is unanswered and this migration does
-- not wait for it: the importer plus org-owned factors is the whole of what Phase
-- 9 ships regardless. The suites need factor data and get an obviously synthetic
-- fixture named as such ("CrewQuo Test Factors 2027", source organisation
-- "CrewQuo — synthetic test data"), created by the suite rather than by the seed,
-- because a fixture that looked real would be the fabricated row §26.2 forbids
-- wearing a test label.
--
-- ── THE DEPARTURE: TWO PARTIAL UNIQUE INDEXES, NOT ONE CONSTRAINT ────────────
--
-- §26.1 gives the table `unique (company_id, name, version)` over a NULLABLE
-- company_id whose null means "platform-wide set". In Postgres nulls are distinct
-- in a unique index, so that constraint binds company rows and does NOTHING
-- WHATSOEVER to platform rows. Two platform sets named "UK Government GHG
-- Conversion Factors 2027" at "v1.1" coexist happily, each holding a full copy of
-- the factors.
--
-- This is the third table in the product to make the mistake — `asset_types` had
-- the pair, `destination_types` was corrected to it by 0033 — and the consequence
-- here is worse than a duplicate row. `resolveFactor` picks from what the join
-- returns, so with two identical sets WHICH FACTOR ID A CALCULATION CITES DEPENDS
-- ON JOIN ORDER. §41.2 requires every result to name its activity data, factor,
-- factor version and methodology; it still can. They are just not stably the same
-- four, which is the failure §41.3's reproducibility promise cannot survive.
--
-- So: one partial unique index for company rows, one for the platform library.

create table if not exists emission_factor_sets (
  id uuid primary key default gen_random_uuid(),

  -- null = the platform library, readable by every company and writable only by
  -- the platform admin console (0010). The tenant boundary in this domain is a
  -- READ widening and never a write one, so the worst outcome of a bug in it is a
  -- customer seeing a published government factor.
  company_id uuid references companies(id) on delete cascade,

  name text not null,
  source_organisation text not null,
  source_document text,
  source_url text,
  reporting_year int not null check (reporting_year between 1990 and 2200),
  version text not null,
  published_on date,

  valid_from date not null,
  valid_to   date,

  methodology text,
  region text not null default 'GB',

  -- ── Two booleans, not a lifecycle (packet §3) ──────────────────────────────
  --
  -- There is no DRAFT → PUBLISHED → RETIRED, because a factor set is not authored
  -- here; it is transcribed from a publisher who already did the publishing.
  -- Deactivation stops FUTURE selection and changes no existing calculation, which
  -- is why it is reversible: it is an operational act, not a judgement.
  active boolean not null default true,

  imported_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint emission_factor_sets_validity_window
    check (valid_to is null or valid_to >= valid_from)
);

-- Finding 2, as the pair `asset_types` has had since §25.1.
create unique index if not exists emission_factor_sets_company_name_version_idx
  on emission_factor_sets (company_id, lower(name), lower(version))
  where company_id is not null;
create unique index if not exists emission_factor_sets_platform_name_version_idx
  on emission_factor_sets (lower(name), lower(version))
  where company_id is null;

create index if not exists emission_factor_sets_company_idx
  on emission_factor_sets (company_id, reporting_year) where active;
create index if not exists emission_factor_sets_platform_idx
  on emission_factor_sets (reporting_year) where company_id is null and active;

comment on table emission_factor_sets is
  'Published third-party reference data, transcribed rather than authored (§26.1). Nobody reviews a set and nobody edits a factor row: §41.3''s "new factor sets never change old reports" is only true if a factor is immutable once cited, and the cheapest way to guarantee that is to have no code path that updates one.';
comment on column emission_factor_sets.active is
  'Deactivation stops future selection and changes NO existing calculation (packet §3). A set cited by a calculation can never be removed — the citation is denormalised onto carbon_calculations and the FK is a plain reference, so a delete is refused rather than cascading through a year of reports.';

-- ── Factors ──────────────────────────────────────────────────────────────────
--
-- NOBODY EDITS A FACTOR ROW, and that is a design commitment rather than a
-- permission gap (packet §2). A publisher's correction is a NEW SET AT A NEW
-- VERSION, which is what the publisher itself does. There is deliberately no
-- `updated_at` and no update path in the API: a row that can be edited is a row a
-- report cited before somebody edited it.

create table if not exists emission_factors (
  id uuid primary key default gen_random_uuid(),
  factor_set_id uuid not null references emission_factor_sets(id) on delete cascade,

  category  text not null,
  activity  text not null,
  material  text,
  treatment text,
  vehicle_type text,
  fuel_type text,

  -- §26.1's six, and no more. A unit outside this list is an import failure
  -- (packet §9), not something the engine quietly accepts and then multiplies.
  -- The check is here as well as in `factorUnitSchema` because the importer is a
  -- bulk path and a bulk path is exactly where a per-row validation gets skipped.
  unit text not null check (unit in ('km','mile','litre','kWh','tonne','tonne.km')),

  -- ZERO IS A LEGITIMATE FACTOR AND IS ACCEPTED; NEGATIVE IS NOT (packet §9). A
  -- published set can legitimately carry a zero — a biogenic combustion line, an
  -- out-of-scope row kept for completeness — and refusing it would make the
  -- importer reject a real workbook. A negative kg_co2e_per_unit is either a
  -- transcription error or an avoided-emissions figure smuggled into the
  -- inventory, and both must be refused at the door.
  kg_co2e_per_unit numeric(18,9) not null check (kg_co2e_per_unit >= 0),
  kg_co2_per_unit  numeric(18,9) check (kg_co2_per_unit >= 0),
  kg_ch4_per_unit  numeric(18,9) check (kg_ch4_per_unit >= 0),
  kg_n2o_per_unit  numeric(18,9) check (kg_n2o_per_unit >= 0),

  -- Well-to-tank, where the publisher separates it. Computed by the engine and
  -- DELIBERATELY NOT ADDED into kg_co2e: WTT is a Scope 3 component of an
  -- activity that may be Scope 1, and adding it would put two scopes in one
  -- figure. 9.5 persists it as a second row instead.
  wtt_kg_co2e_per_unit numeric(18,9) check (wtt_kg_co2e_per_unit >= 0),

  scope text check (scope in ('SCOPE_1','SCOPE_2','SCOPE_3','OUT_OF_SCOPE')),
  scope3_category int check (scope3_category between 1 and 15),
  source_reference text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists emission_factors_set_category_activity_idx
  on emission_factors (factor_set_id, category, activity);
create index if not exists emission_factors_set_material_treatment_idx
  on emission_factors (factor_set_id, material, treatment);
create index if not exists emission_factors_set_treatment_idx
  on emission_factors (factor_set_id, treatment) where treatment is not null;

comment on table emission_factors is
  'Immutable once written (packet §2). A publisher''s correction is a new set at a new version. There is no update path in the API and no updated_at column, because a factor a report has cited must still say what it said.';
comment on column emission_factors.kg_co2e_per_unit is
  'Zero is accepted and negative is refused (packet §9). A published set legitimately carries zeros; a negative factor is either a transcription error or an avoided figure smuggled into the inventory.';

-- ── The column 0037 could not create ─────────────────────────────────────────
--
-- §39 puts `default_factor_set_id` on the settings row and 0037 omitted it,
-- because a foreign key to a table that does not exist is an error rather than a
-- forward declaration (finding 4's rule, applied inside the phase). This is the
-- first migration where it can exist, so it lands here.
--
-- `on delete set null` rather than restrict: a company that deletes an unused set
-- it imported by mistake should not be refused because it happened to be the
-- default, and falling back to date-based selection is a safe place to land.
alter table sustainability_settings
  add column if not exists default_factor_set_id uuid
    references emission_factor_sets(id) on delete set null;

comment on column sustainability_settings.default_factor_set_id is
  'Optional pin. Null means selection is by date, region and reporting year through selectFactorSet, which is the normal case; a pin is what an org uses when it holds two sets whose validity windows would otherwise be ambiguous.';

-- ── Entitlements (§43, packet finding 9) ─────────────────────────────────────
--
-- Three features and one limit, none of which existed. The two halves of the
-- packaging question are NOT the same rule, and that is the whole of finding 9:
--
--   * `sustainability` and `carbon_engine` are read over a PROJECT, so the
--     2026-09-01 rule governs them unchanged — "capture is free, the record is the
--     project owner's entitlement". The project owner is who publishes the figure
--     and who answers for it.
--
--   * `custom_factors` and the `factor_sets` limit are NOT PROJECT-SCOPED AT ALL.
--     A factor set is company reference data, imported once and used across every
--     project that company owns, so it is checked against the IMPORTING COMPANY'S
--     OWN PLAN and against nothing else. Transferring the project-owner rule here
--     would mean a subcontractor importing its own factors consumed the project
--     owner's allowance for data the project owner cannot even see.
--
-- Written down rather than assumed precisely because the last three phases have
-- all transferred that rule by analogy, and this is the first noun it does not fit.
insert into features (key, name, description, category) values
  ('sustainability', 'Sustainability',
   'Mass balance, carbon figures, data completeness and the organisation dashboard',
   'sustainability'),
  ('carbon_engine', 'Carbon engine',
   'Calculate project emissions and avoided emissions from factors and activity data',
   'sustainability'),
  ('custom_factors', 'Custom emission factors',
   'Import your own emission factor sets and maintain a product carbon factor library',
   'sustainability')
on conflict (key) do nothing;

-- §43's proposed placement. Sustainability and the carbon engine at Pro and above;
-- custom factors at Business and above, on the same row §43 puts client reporting.
--
-- THIS INSERT IS NOT THE AUTHORITY, and 0033's comment transfers unchanged:
-- infra/seed does `delete from plan_features where plan_id = $1` and rebuilds the
-- set to match itself, so a placement granted only here is silently revoked by the
-- next seed run. The seed lists the same three keys on the same plans and
-- sustainabilityParity.test.ts asserts the two agree. What this insert is for is
-- an ALREADY-MIGRATED deployment, which gets the features without waiting.
insert into plan_features (plan_id, feature_key)
select p.id, k.key
from plans p
cross join (values ('sustainability'), ('carbon_engine')) as k(key)
where p.id in ('pro', 'business', 'enterprise')
on conflict do nothing;

insert into plan_features (plan_id, feature_key)
select p.id, 'custom_factors'
from plans p
where p.id in ('business', 'enterprise')
on conflict do nothing;

-- The limit row must exist whether or not any plan sets a value, for the reason
-- 0027's two limits did: `company_entitlement_overrides.limit_key` and
-- `plan_limits.limit_key` both carry a foreign key to this table, so without the
-- row an operator cannot grant one company a ceiling even by hand.
--
-- NO PLAN SETS A VALUE, AND AN UNSET LIMIT IS SILENTLY UNLIMITED. That is the same
-- stated gap `storage_gb` carries and it is deliberate here for a weaker reason:
-- §43 proposes figures for storage and proposes none for factor sets, so inventing
-- one would be a pricing judgement made by a migration. The enforcement is built
-- and checked against the importing company (§4); turning it on is one number per
-- plan in infra/seed/index.ts and no code change anywhere.
insert into limits (key, name, unit) values
  ('factor_sets', 'Imported emission factor sets', 'count')
on conflict (key) do nothing;
