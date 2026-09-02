-- The calculation ledger (CREWQUO_V2_PLAN.md §27.2) — step 5 of the Phase 9 build
-- order in docs/operating-model/sustainability.md §14.
--
-- Every figure this product publishes is a row in here, and every row names the
-- factor that produced it. §41.2 requires a result to be able to name its activity
-- data, its factor, that factor's version and the methodology; §41.3 promises the
-- client's ESG analyst that a report generated in March still reconstructs in
-- November. This table is where both of those are kept or lost.
--
-- ── `bucket` IS THE FIREWALL, AND IT IS ALSO A TYPE ──────────────────────────
--
-- Locked decision #17: "there is no query, no type and no UI component in the
-- system that adds AVOIDED to anything else." The database half is this column and
-- the discipline that sums are always taken within one bucket. The TypeScript half
-- shipped with 9.0 — `BucketedTotal<B>` carries a phantom `(bucket: B) => B`, which
-- is invariant under `strictFunctionTypes`, so `addTotals(emissions, avoided)` does
-- not compile and `firewall.test.ts` pins six such refusals with `@ts-expect-error`.
-- Neither half is sufficient alone: a type cannot stop a `sum(kg_co2e)` with no
-- bucket predicate, and a column cannot stop somebody adding two numbers in
-- JavaScript.
--
-- ── NOBODY CORRECTS A CALCULATION ────────────────────────────────────────────
--
-- This is the assets packet's "nobody corrects the roll-up; you correct its
-- inputs" one layer up, and it is why this table has `superseded_by` instead of
-- `updated_at`. A calculation is a record of what the engine produced from stated
-- inputs at a stated time; editing it produces a row that claims to be a
-- derivation and is not one.
--
-- A SUPERSEDED ROW IS NEVER DELETED AND NEVER HIDDEN FROM A CITATION. It is
-- excluded from every sum by the partial index below and included in every trace,
-- which is the distinction §41.2 draws between what a figure IS and what it WAS.
--
-- ── THE FINDING THAT NEEDS CODE, NOT SCHEMA (packet §0 finding 6) ────────────
--
-- `project_assets` and `asset_movements` both carry `deleted_at`, and Phase 8's
-- roll-up excludes tombstoned rows on both sides. Supersession is written by
-- recalculation. Delete a movement and its calculation row is UNTOUCHED,
-- `superseded_by` still null, still counted — so the mass balance and the carbon
-- roll-up, rendered side by side in the same §28 section, disagree about whether
-- the material exists.
--
-- There is no schema fix. The fix is the rule: ANY WRITE THAT CHANGES WHAT
-- massBalance.ts WOULD RETURN MUST SUPERSEDE THE CALCULATIONS DERIVED FROM IT, and
-- the writes that qualify are correcting a weight, tombstoning a line or movement,
-- and recording a continuation. It is a §0 finding rather than an implementation
-- note because it is invisible in testing: the calculation is created, the movement
-- is deleted, and every query still returns a plausible number. Step 12 of the §12
-- acceptance script is the one that catches it.

create table if not exists carbon_calculations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- The project-owning company. Unlike every other table in this phase there is no
  -- "recorder" to distinguish it from: THE ENGINE CREATES THESE ROWS, NEVER A
  -- PERSON (packet §2), so there is no second party whose act this was.
  company_id uuid not null references companies(id),

  bucket text not null check (bucket in
    ('PROJECT_EMISSIONS','WASTE_TREATMENT','COMPARATIVE_LIFECYCLE','AVOIDED')),
  scope text check (scope in ('SCOPE_1','SCOPE_2','SCOPE_3','OUT_OF_SCOPE')),
  scope3_category int check (scope3_category between 1 and 15),

  source_type text not null check (source_type in ('ACTIVITY','ASSET_MOVEMENT','MANUAL')),
  source_id uuid,

  -- ── The citation (§41.2) ───────────────────────────────────────────────────
  --
  -- Plain `references`, NO `on delete cascade`, on all three. A factor set that has
  -- been cited can never be silently removed: the delete is refused rather than
  -- taking a year of reports with it, and deactivation is the operation that
  -- exists for wanting a set to stop being used.
  factor_set_id     uuid references emission_factor_sets(id),
  factor_id         uuid references emission_factors(id),
  product_factor_id uuid references product_carbon_factors(id),

  -- DENORMALISED SO THE CITATION SURVIVES EVEN A HARD DELETE. §26.1 makes a factor
  -- immutable and this makes it unnecessary to trust that: the four things §41.2
  -- requires are stored as values on the row that used them, so an auditor reading
  -- this table a year later needs nothing else joined to it. It is also what makes
  -- the export complete without shipping a publisher's workbook inside a
  -- customer's bundle, which would be the redistribution §45's licensing gate is
  -- about.
  factor_set_name    text not null,
  factor_set_version text not null,
  factor_reporting_year int,
  factor_kg_co2e_per_unit numeric(18,9),
  methodology text,

  quantity numeric(18,6) not null,
  unit     text not null,

  -- NOT constrained to be non-negative, and that is deliberate on exactly one
  -- bucket. Where enabling emissions exceed the baseline an AVOIDED row is
  -- negative and is reported as negative: clamping would mean the product can
  -- never report that a reuse cost more than it saved, which is the favourable
  -- arithmetic §41 exists to prevent.
  kg_co2e  numeric(18,6) not null,

  method text not null check (method in
    ('ACTIVITY_X_FACTOR','MASS_X_TREATMENT_FACTOR','DISPLACEMENT','MANUAL')),

  -- §27.1: "every function returns the inputs it used alongside the result, so the
  -- caller can persist a complete trace. Nothing returns a bare number." This is
  -- where that trace lands — the exact numbers, in the units they were multiplied
  -- in, including the conversion that happened on the way.
  inputs jsonb not null,

  is_estimate boolean not null default false,
  confidence text check (confidence in ('VERIFIED','DOCUMENTED','ESTIMATED','APPROXIMATE')),

  calculated_at timestamptz not null default now(),
  calculated_by_user_id uuid references users(id) on delete set null,

  -- The only transition there is, written by the engine in the same transaction as
  -- the row that replaces it. There is no RECALCULATING state and no queue
  -- (packet §3): a project whose carbon is briefly stale is a project whose two
  -- headline figures disagree with the mass balance rendered beside them, and the
  -- window in which that is true is a window in which somebody screenshots it.
  superseded_by uuid references carbon_calculations(id),

  created_at timestamptz not null default now(),

  -- A row cannot supersede itself. Cheap, and the shape of a bug that would make
  -- the partial index below exclude a row from every sum forever.
  constraint carbon_calculations_no_self_supersession
    check (superseded_by is null or superseded_by <> id)
);

-- §27.2's index, and the mechanism that makes "current rows only" in §28.2's
-- metric definitions a predicate rather than a convention.
create index if not exists carbon_calculations_project_bucket_idx
  on carbon_calculations (project_id, bucket) where superseded_by is null;

create index if not exists carbon_calculations_source_idx
  on carbon_calculations (source_type, source_id) where superseded_by is null;
create index if not exists carbon_calculations_company_idx
  on carbon_calculations (company_id, bucket) where superseded_by is null;
create index if not exists carbon_calculations_factor_set_idx
  on carbon_calculations (factor_set_id) where factor_set_id is not null;
create index if not exists carbon_calculations_superseded_idx
  on carbon_calculations (superseded_by) where superseded_by is not null;

comment on table carbon_calculations is
  'Created by the engine, never by a person (§27.2). Nobody corrects a calculation — you correct its input and it supersedes. A superseded row is never deleted and never hidden from a citation: excluded from every sum by the partial index, included in every trace.';
comment on column carbon_calculations.bucket is
  'The firewall (locked decision #17). Sums are always taken within one bucket. The TypeScript half is BucketedTotal<B> in packages/shared/src/carbon-engine/types.ts, whose phantom brand makes addTotals(emissions, avoided) a compile error.';
comment on column carbon_calculations.factor_set_name is
  'Denormalised so §41.2''s citation survives a factor-set edit or delete. An auditor reading this row a year later needs nothing joined to it, and the export ships the citation rather than a copy of the publisher''s workbook.';
comment on column carbon_calculations.kg_co2e is
  'Deliberately not constrained non-negative. An AVOIDED row whose enabling emissions exceed its baseline is negative and is reported as negative; clamping would mean the product can never report that a reuse cost more than it saved.';
comment on column carbon_calculations.superseded_by is
  'The only transition in this domain, written by the engine inside the transaction that replaces the row. Triggers: WEIGHT_CORRECTED, MOVEMENT_TOMBSTONED, CONTINUATION_RECORDED, MOVEMENT_RECORDED, ACTIVITY_CHANGED and an explicit FACTOR_SET_REIMPORTED — recorded on the sustainability.calculations_superseded event, not on this row, because the row says what the figure WAS and only the event says what changed it and by how much.';
