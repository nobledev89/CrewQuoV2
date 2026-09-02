-- Product carbon factors (CREWQUO_V2_PLAN.md §26.3) — step 3 of the Phase 9 build
-- order in docs/operating-model/sustainability.md §14.
--
-- The embodied carbon of the item that did NOT have to be manufactured. A
-- different kind of number from an activity factor — it is per item or per kg
-- rather than per unit of activity, it has a lifecycle boundary rather than a
-- scope, and it is the only input to an avoided-emissions claim — so §26.3 gives
-- it its own admin-managed library rather than a category inside a factor set.
--
-- ── THE DEPARTURE: UNIQUENESS, WHICH §26.3 GIVES IT NONE OF ──────────────────
--
-- `emission_factor_sets` at least had a unique constraint that did the wrong
-- thing; this table has none at all, over the same nullable `company_id` whose
-- null means "platform library". Finding 2 states why that is worse here: the
-- resolver walks a five-tier preference order (§26.3), so a duplicate does not
-- merely duplicate — IT CAN OUTRANK ITSELF, and an ORG_SPECIFIC factor entered
-- twice is indistinguishable from an organisation that genuinely holds two.
--
-- The two partial indexes below are `asset_types`' pair again. What is in the key
-- deserves its own sentence, because getting it wrong in either direction breaks
-- something real:
--
--   * `verification_status` IS PART OF THE KEY. An organisation legitimately holds
--     an EPD-verified factor AND a generic estimate for the same chair — that is
--     precisely what the tier walk exists to choose between, and a key without it
--     would make §26.3's preferred-source order unimplementable by permitting only
--     one factor per item.
--
--   * The nullable discriminators are `coalesce`d into the key rather than left
--     raw. Nulls are distinct in a Postgres unique index, which is the entire
--     mistake this file is correcting; leaving `manufacturer` and `product_model`
--     raw would let two identical category-level factors coexist, which is the
--     duplicate finding 2 names.
--
--   * `where active`, so deactivating a factor does not block re-adding one —
--     the rule `destination_organisations_company_name_idx` already applies for
--     the same reason.

create table if not exists product_carbon_factors (
  id uuid primary key default gen_random_uuid(),

  -- null = the platform library. Read-only to every customer; writable only from
  -- the platform admin console, audited, and the one write in this domain with
  -- cross-tenant reach (packet §10).
  company_id uuid references companies(id) on delete cascade,

  item_category text not null,
  asset_type_id uuid references asset_types(id),
  manufacturer text,
  product_model text,

  kg_co2e_per_item numeric(18,6) check (kg_co2e_per_item >= 0),
  kg_co2e_per_kg   numeric(18,6) check (kg_co2e_per_kg >= 0),

  -- What the number covers, and it travels onto the claim as its system boundary
  -- (§27.4). A cradle-to-gate figure and a cradle-to-grave one are not the same
  -- claim, and a claim that cannot say which it used is not defensible.
  lifecycle_boundary text not null check (lifecycle_boundary in
    ('A1_A3','A1_A5','CRADLE_TO_GATE','CRADLE_TO_GRAVE','OTHER')),

  source text not null,
  source_url text,
  publication_year int check (publication_year between 1990 and 2200),
  region text,

  -- §26.3's preferred-source order as a column. Tier 1 is EPD_VERIFIED and
  -- MANUFACTURER; GENERIC_ESTIMATE sits alone in tier 4 because it is the only
  -- one gated on a setting (`allow_generic_product_factors`).
  verification_status text not null check (verification_status in
    ('EPD_VERIFIED','MANUFACTURER','SECTOR_DATASET','ORG_SPECIFIC','GENERIC_ESTIMATE')),

  -- Defaults TRUE, which is the conservative direction: a factor nobody has
  -- characterised is an estimate, and the report says so. The API derives it from
  -- `verification_status` on write so the two cannot disagree.
  is_estimate boolean not null default true,

  notes text,
  active boolean not null default true,

  -- Nullable with `on delete set null`, like every actor column since the closure
  -- decision of 2026-08-20. §26.3 already had this right — finding 3 checked all
  -- five user references in §26–§39 and only `project_activities` was wrong.
  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- §26.3's own check. Exactly one rate: a factor that carries both is two claims
  -- about the same chair and the engine would have to pick, which is the silent
  -- substitution §41.1 exists to prevent. `calculateAvoidedEmissions` handles the
  -- neither-rate case anyway rather than asserting, because a factor imported by
  -- some future path with neither must not become a zero.
  constraint product_carbon_factors_exactly_one_rate
    check (num_nonnulls(kg_co2e_per_item, kg_co2e_per_kg) = 1)
);

create unique index if not exists product_carbon_factors_company_identity_idx
  on product_carbon_factors (
    company_id,
    lower(item_category),
    coalesce(asset_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(coalesce(manufacturer, '')),
    lower(coalesce(product_model, '')),
    verification_status
  )
  where company_id is not null and active;

create unique index if not exists product_carbon_factors_platform_identity_idx
  on product_carbon_factors (
    lower(item_category),
    coalesce(asset_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(coalesce(manufacturer, '')),
    lower(coalesce(product_model, '')),
    verification_status
  )
  where company_id is null and active;

create index if not exists product_carbon_factors_company_idx
  on product_carbon_factors (company_id, lower(item_category)) where active;
create index if not exists product_carbon_factors_asset_type_idx
  on product_carbon_factors (asset_type_id) where asset_type_id is not null and active;

comment on table product_carbon_factors is
  'The embodied carbon of the item that did not have to be manufactured (§26.3). Two partial unique indexes rather than §26.3''s none: the five-tier resolver means a duplicate can outrank itself, and an ORG_SPECIFIC factor entered twice is indistinguishable from an organisation that holds two (sustainability.md §0 finding 2).';
comment on column product_carbon_factors.verification_status is
  'Part of the unique key on purpose. An org legitimately holds an EPD-verified factor AND a generic estimate for the same chair — that is what §26.3''s tier walk exists to choose between — so a key without it would make the preferred-source order unimplementable.';
comment on column product_carbon_factors.lifecycle_boundary is
  'Travels onto avoided_emissions_claims.system_boundary (§27.4). A cradle-to-gate figure and a cradle-to-grave one are not the same claim, and a claim that cannot say which it used is not defensible.';
