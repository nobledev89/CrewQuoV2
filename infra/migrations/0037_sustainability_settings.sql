-- Sustainability settings (CREWQUO_V2_PLAN.md §39) — step 1 of the Phase 9 build
-- order in docs/operating-model/sustainability.md §14.
--
-- BEFORE THE FACTOR TABLES, NOT AFTER THE SCREENS, and the packet's §13.4 gives
-- the reason: three later steps read this row before they can be correct. The
-- displacement basis (9.6), the data-quality weights (9.7) and the display units
-- (9.8) are all things Phase 8 shipped as PARAMETERS with a stated promise —
-- "when it lands, the caller passes a value instead of taking the default and
-- this function does not change." Building the engine first and the settings last
-- would mean writing the engine against constants and then changing every
-- signature.
--
-- ── THE DEPARTURE THE WHOLE PACKET WAS WRITTEN FOR ───────────────────────────
--
-- §39 says:  default_displacement_pct numeric(5,2) not null default 100
--
-- §45, resolved by the owner on 2026-08-18, says: "Displacement: defaults to
-- UNKNOWN, never 100%. A claim requires an explicit, attributable assumption."
-- §27.4 states the consequence: "UNKNOWN produces no claim — it is counted as a
-- data-quality gap, not silently treated as 100%."
--
-- The column cannot express UNKNOWN at all — it is `not null` over a numeric —
-- and its default is the exact value the decision forbids. Built literally, every
-- company is created claiming maximal avoided emissions on every reuse movement,
-- with `ASSUMED_FULL` recorded as the basis of an assumption nobody made. That is
-- the largest number this product publishes and the one with the least external
-- scrutiny, and it would not have been a migration to undo. It would have been a
-- published claim to retract.
--
-- So the pair `avoided_emissions_claims` already has one table over lands here
-- too: a basis defaulting to UNKNOWN, a NULLABLE pct, and a check constraint
-- pairing them. `resolveDisplacementPct` in packages/shared/src/carbon-engine/
-- is the same shape and has had a regression test since 9.0; step 6 of the §12
-- acceptance script is the other half, so a future migration that "tidies" the
-- default back to 100 fails a suite rather than inflating a customer's report.
--
-- ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
--
-- `default_factor_set_id uuid references emission_factor_sets(id)`. That table is
-- created by 0038, one step later, and finding 4's rule applies inside a phase as
-- readily as across two: a foreign key to a table that does not exist is not a
-- forward declaration, it is an error. The column is added by 0038, which is also
-- the first migration that could hold a value for it.

create table if not exists sustainability_settings (
  company_id uuid primary key references companies(id) on delete cascade,

  -- What `selectFactorSet` matches against `emission_factor_sets.region`. §39
  -- calls it a country and the factor table calls it a region; they are the same
  -- string, and this comment is cheaper than a rename that would desynchronise
  -- the plan from the schema.
  default_country text not null default 'GB',

  -- Null = "use the year the work happened in". A pinned year is what a client
  -- reporting a 2027 period against 2027 factors needs; the null is what a
  -- multi-year org needs, and it is the safer default because it selects by date
  -- rather than by an assumption somebody set once and forgot.
  reporting_year int check (reporting_year between 1990 and 2200),

  -- ── Display units (§39) ────────────────────────────────────────────────────
  --
  -- The three parameters Phase 8 shipped as function arguments. `formatMassKg`
  -- has taken a MassUnit since 8.0 and defaults to AUTO; this is the row it now
  -- reads from, and the function did not change — which is what
  -- assets-materials.md §13.4 promised.
  weight_unit   text not null default 'AUTO' check (weight_unit in ('KG','TONNE','AUTO')),
  distance_unit text not null default 'KM'   check (distance_unit in ('KM','MILE')),
  carbon_display_unit text not null default 'AUTO'
    check (carbon_display_unit in ('KGCO2E','TCO2E','AUTO')),

  -- ── Displacement (§27.4, §45, packet finding 1) ────────────────────────────
  default_displacement_basis text not null default 'UNKNOWN'
    check (default_displacement_basis in ('ASSUMED_FULL','USER_DEFINED','UNKNOWN')),
  default_displacement_pct numeric(5,2)
    check (default_displacement_pct >= 0 and default_displacement_pct <= 100),

  -- §26.3 tier 4. On by default because §26.3 makes a generic estimate a
  -- legitimate last resort that is "always surfaced as an estimate in the
  -- report", and the fifth data-quality component measures exactly how much of a
  -- claim rests on one — so the honesty is in the disclosure rather than in the
  -- refusal.
  allow_generic_product_factors boolean not null default true,

  -- Phase 8's §25.3 rule, made configurable where §39 says it belongs. Nothing in
  -- Phase 9 reads it: `resolveWeightConfidence` already implements the `true`
  -- behaviour, and turning it off is a Phase 12 conversation about what a company
  -- is willing to call documented.
  require_document_for_verified_weight boolean not null default true,

  -- THE PHASE 7 QUESTION, CLOSED BY ITS OWN RECOMMENDATION (project-evidence.md
  -- §13.7). The recommendation was to capture nothing; false is that
  -- recommendation, and Phase 9 builds nothing that reads this column. The camera
  -- that would honour it is 13.3. The column exists here so that turning GPS on
  -- one day is a setting rather than a migration — the same reasoning 0030
  -- applied when it created the evidence GPS columns and wrote to none of them.
  capture_gps_on_evidence boolean not null default false,

  -- ── Data quality (§28.3, packet finding 5) ─────────────────────────────────
  --
  -- THE DEFAULT IS DUPLICATED HERE ON PURPOSE, AND A TEST KEEPS THE COPIES IN
  -- STEP. §39 gives this column `not null` with no default, which makes the table
  -- uninsertable by hand; the packet requires the authority to be
  -- DEFAULT_DATA_QUALITY_WEIGHTS in packages/shared/src/carbon-engine/types.ts,
  -- because "a default that lives only in a migration cannot be read by the
  -- engine; one that lives only in the engine means an edited settings row and
  -- the code disagree about what 100% means."
  --
  -- Both, therefore, with sustainabilityParity.test.ts reading this file and
  -- asserting the two agree — the mechanism catalogParity.test.ts already uses
  -- for the 0033 catalogs. `ensureSettings` writes the shared constant
  -- explicitly, so the row a company actually gets comes from the engine's copy.
  data_quality_weights jsonb not null default
    '{"LINES_WITH_WEIGHT":0.25,"MASS_WITH_FINAL_DESTINATION":0.25,"MASS_DOCUMENTED_OR_VERIFIED":0.2,"LINES_WITH_SUPPORT":0.15,"AVOIDED_MASS_ON_SPECIFIC_FACTOR":0.15}'::jsonb,

  -- §38.1: "any figure whose data completeness is below a configurable threshold
  -- is shown with its completeness percentage attached rather than presented as
  -- fact." This is that threshold.
  data_quality_warn_below int not null default 80
    check (data_quality_warn_below between 0 and 100),

  -- ── The report (§29.3) ─────────────────────────────────────────────────────
  --
  -- SHIPPED HERE AND RENDERED BY NOBODY IN THIS PHASE. §39 makes it `not null`
  -- with no default, which would hand Phase 10 a table it cannot insert into —
  -- so §29.3's text lands as the DDL default now, under the same parity test as
  -- the weights above.
  --
  -- The sentence about avoided emissions being reported separately is not
  -- decoration: it is §27.5's prohibition on a net headline, stated to the reader
  -- of the report rather than only enforced in the type system. The electricity
  -- sentence is the open decision in sustainability.md §13.1, built as
  -- recommended — location-based only, and said out loud rather than assumed.
  report_disclaimer text not null default
    'Greenhouse gas emissions are calculated using activity data recorded for this project and the emission factors identified in this report. Electricity is reported on a location-based basis using published grid average factors. Avoided emissions are comparative estimates and are reported separately from Scope 1, Scope 2 and Scope 3 inventory emissions. Results may include estimates where measured activity, asset weight or product-specific lifecycle data was unavailable. Assumptions and data sources are disclosed within this report.',
  report_logo_file_id uuid references stored_files(id),
  report_accent_hex text check (report_accent_hex ~ '^#[0-9a-fA-F]{6}$'),

  -- §33's switch, defaulted off, and Phase 12 owns the ladder that reads it. It
  -- is here because §39 puts it here, and because a company that finds the switch
  -- missing builds a worse one in a spreadsheet.
  enforce_compliance boolean not null default false,

  updated_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ── The load-bearing half of finding 1 ─────────────────────────────────────
  --
  -- Without this the two columns drift into a state that READS as an assumption —
  -- a basis of UNKNOWN sitting beside a stored 80 — and the resolver has to guess
  -- which one the operator meant. A pct without a basis is a number nobody
  -- claimed.
  --
  -- `=` between the two predicates rather than an implication is deliberate. It
  -- refuses ASSUMED_FULL carrying a stray 80 just as firmly as it refuses
  -- USER_DEFINED carrying nothing, because 100% is what ASSUMED_FULL *means* and
  -- a second copy of it is a second answer. `isValidDisplacementSetting` in the
  -- carbon engine is this predicate in TypeScript, so the API refuses the pair
  -- with a sentence before the database refuses it with a constraint violation.
  constraint sustainability_settings_displacement_basis_matches_pct check (
    (default_displacement_basis = 'USER_DEFINED') = (default_displacement_pct is not null)
  )
);

comment on table sustainability_settings is
  'The assumptions every carbon figure is computed under (§39). One row per company, created from shared defaults. Its displacement pair departs from §39''s canonical DDL because §39 predates the owner decision of 2026-08-18 (sustainability.md §0 finding 1).';
comment on column sustainability_settings.default_displacement_basis is
  'UNKNOWN by default, which produces NO avoided-emissions claim (§27.4). §39''s "not null default 100" contradicted the owner decision of 2026-08-18 and failed in the direction that inflates the headline. Do not restore it.';
comment on column sustainability_settings.capture_gps_on_evidence is
  'False, and Phase 9 builds nothing that reads it. Closes the Phase 7 §13.7 question the way its own recommendation proposed — capture nothing. The camera that would honour it is 13.3.';
comment on column sustainability_settings.data_quality_weights is
  'Duplicated from DEFAULT_DATA_QUALITY_WEIGHTS in packages/shared/src/carbon-engine/types.ts, which is the authority. sustainabilityParity.test.ts reads this file and asserts the two agree.';

-- One row per company that already exists. Cheap, and it makes the table
-- meaningful the moment it lands rather than on whatever future read happens to
-- create a row. `ensureSettings` still upserts on read, because a company created
-- after this migration needs one too and a read path that assumes a row exists is
-- a 500 waiting for the first new customer.
insert into sustainability_settings (company_id)
select id from companies
on conflict (company_id) do nothing;
