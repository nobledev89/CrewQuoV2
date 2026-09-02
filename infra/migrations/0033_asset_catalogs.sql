-- Asset & destination catalogs (CREWQUO_V2_PLAN.md §25.1, §25.4) — step 1 of the
-- Phase 8 build order in docs/operating-model/assets-materials.md §14.
--
-- Reference data first, because everything after it is a foreign key to one of
-- these three tables. `project_assets` (0034) and `asset_movements` (0035) follow.
-- The packet names one migration; it became three, one per build-order step, the
-- way Phase 7's seven steps each carried their own.
--
-- §25 opens with the sentence that decides how careful this has to be: "The heart
-- of the expansion. Everything in §26–§29 is downstream of getting this record
-- right." The carbon engine multiplies these masses by factors, the report renders
-- those products, and the client sign-off attests to them — so a double-counted
-- tonne here becomes a double-counted tonne of CO₂e with a full audit trail behind
-- it.
--
-- TWO DEPARTURES FROM THE CANONICAL DDL LIVE IN THIS FILE, both from the packet's
-- §0 finding 8, and both about `destination_types`:
--
--   * §25.4 gives it a nullable `company_id` and the same shadowing intent
--     `asset_types` has — locked decision #20 is entirely about a company
--     adjusting its own counts-as flags — and then gives it NO unique index.
--     Without one a company holds two RECYCLING rows with different
--     `counts_as_diverted` flags and its diversion rate depends on a join order.
--     It gets the pair `asset_types` has.
--
--   * It is the only table in §25 without `created_at`/`updated_at`, which §0's
--     DDL convention says every table has "unless stated otherwise". Nothing
--     states otherwise.

-- ── 1. Asset types (§25.1) ───────────────────────────────────────────────────
--
-- `default_unit_weight_kg` EXISTS AND IS NULL ON EVERY SEEDED ROW, and that is
-- the most load-bearing line in this migration.
--
-- §41.1 is "never invent"; §25.1 states the consequence directly — "A shipped
-- default weight is an invented number that silently becomes a reported tonne."
-- An operator chair is anywhere between 9 kg and 24 kg depending on the base, and
-- a product that offers 16 kg gets 16 kg back from a hurried supervisor on a
-- phone, permanently, with SYSTEM_ESTIMATE provenance nobody reads.
--
-- The column is here because an org populates it from its own weighing. The
-- values are absent because we have not done that weighing. `SYSTEM_ASSET_TYPES`
-- in packages/shared/src/assets.ts has no such key at all, so the code cannot
-- supply one by accident, and `assetCatalogParity.test.ts` reads this file to
-- keep the two in step.

create table if not exists asset_types (
  id uuid primary key default gen_random_uuid(),

  -- null = the system catalog, visible to everyone. A company row with the same
  -- `code` shadows it (§25.1), resolved by `resolveTypeCatalog` rather than by a
  -- `coalesce` written once per screen.
  company_id uuid references companies(id) on delete cascade,

  code text not null,
  name text not null,
  category text not null check (category in
    ('FURNITURE','IT','WEEE','APPLIANCE','TIMBER','METAL','PLASTIC','CARDBOARD',
     'MIXED_WASTE','TEXTILE','GLASS','OTHER')),

  default_unit_weight_kg numeric(14,3),
  default_material_composition jsonb,

  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists asset_types_company_code_idx
  on asset_types (company_id, code) where company_id is not null;
create unique index if not exists asset_types_system_code_idx
  on asset_types (code) where company_id is null;

-- §25.1's twenty-two, with no weight on any of them.
insert into asset_types (company_id, code, name, category, sort_order) values
  (null, 'OPERATOR_CHAIR', 'Operator chair',       'FURNITURE',   10),
  (null, 'MEETING_CHAIR',  'Meeting chair',        'FURNITURE',   20),
  (null, 'DESK',           'Desk',                 'FURNITURE',   30),
  (null, 'BENCH_DESK',     'Bench desk',           'FURNITURE',   40),
  (null, 'PEDESTAL',       'Pedestal',             'FURNITURE',   50),
  (null, 'CABINET',        'Cabinet',              'FURNITURE',   60),
  (null, 'LOCKER',         'Locker',               'FURNITURE',   70),
  (null, 'TABLE',          'Table',                'FURNITURE',   80),
  (null, 'SOFA',           'Sofa',                 'FURNITURE',   90),
  (null, 'MONITOR',        'Monitor',              'IT',         100),
  (null, 'COMPUTER',       'Computer',             'IT',         110),
  (null, 'PRINTER',        'Printer',              'IT',         120),
  (null, 'SERVER',         'Server',               'IT',         130),
  (null, 'NETWORKING',     'Networking equipment', 'IT',         140),
  (null, 'APPLIANCE',      'Appliance',            'APPLIANCE',  150),
  (null, 'TIMBER',         'Timber',               'TIMBER',     160),
  (null, 'METAL',          'Metal',                'METAL',      170),
  (null, 'PLASTIC',        'Plastic',              'PLASTIC',    180),
  (null, 'CARDBOARD',      'Cardboard',            'CARDBOARD',  190),
  (null, 'MIXED_WASTE',    'Mixed waste',          'MIXED_WASTE',200),
  (null, 'WEEE',           'WEEE',                 'WEEE',       210),
  (null, 'OTHER',          'Other',                'OTHER',      220)
on conflict do nothing;

comment on column asset_types.default_unit_weight_kg is
  'Deliberately null on every seeded system row (§41.1, §25.1). A shipped default weight is an invented number that becomes a reported tonne. Orgs populate their own from their own weighing, and anything derived from one is flagged SYSTEM_ESTIMATE.';

-- ── 2. Destination types (§25.4) ─────────────────────────────────────────────
--
-- The waste hierarchy AS DATA, which is locked decision #20: "waste-hierarchy and
-- destination semantics are configurable data, not code — so an org can see and
-- adjust its own assumptions." Every mass metric in §28.2 is a sum filtered by one
-- of these booleans, which is what keeps the hierarchy out of a `switch`.
--
-- The consequence, stated because it is not obvious: a company can define a
-- destination called Landfill with `counts_as_diverted` true and its diversion
-- rate will say so. Three things contain that and none is a validator — system
-- rows are immutable so the seeded semantics are always there to compare against,
-- a company row shadows by CODE so the difference reads as a diff rather than an
-- absence, and the roll-up reports which flags produced each figure so Phase 10
-- discloses a customised hierarchy like any other material assumption (§29.1 §10).

create table if not exists destination_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  code text not null,
  name text not null,

  -- 1–5, best first (§25.5). NULL for STORAGE, which is not a rung on a ladder.
  hierarchy_tier int check (hierarchy_tier between 1 and 5),

  counts_as_retained_in_use boolean not null default false,
  counts_as_reuse      boolean not null default false,
  counts_as_recycling  boolean not null default false,
  counts_as_recovery   boolean not null default false,
  counts_as_landfill   boolean not null default false,
  counts_as_diverted   boolean not null default false,
  is_final_outcome     boolean not null default true,

  -- Eligible for an avoided-emissions claim (§27.3). Written by nothing until
  -- Phase 9 — unlike a column with no reader, this one is part of the *semantics*
  -- an admin edits, so it has a reader on day one: the screen that shows what a
  -- destination means.
  displaces_replacement boolean not null default false,

  -- Maps to emission_factors.treatment for Scope 3 Cat 5 (§27.3). Phase 9 resolves
  -- it; seeded here because the mapping is part of what a destination *is*.
  ghg_treatment_key text,

  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A tier is what makes a destination rankable, and a final outcome is what makes
  -- it reportable. STORAGE is the only row that may be neither, and the check
  -- states the pairing rather than leaving it to the seed to get right.
  constraint destination_types_tier_matches_finality
    check ((hierarchy_tier is null) = (is_final_outcome = false))
);

-- The packet's §0 finding 8: the shadowing model `asset_types` has, with the
-- uniqueness §25.4 forgot to give it.
create unique index if not exists destination_types_company_code_idx
  on destination_types (company_id, code) where company_id is not null;
create unique index if not exists destination_types_system_code_idx
  on destination_types (code) where company_id is null;

-- §25.4's eleven, flag for flag.
--
-- ROW 7 IS THE ONE THE WHOLE DOMAIN TURNS ON. STORAGE has no tier, counts as
-- nothing, and is not a final outcome — locked decision #18 as a single row of
-- data rather than a special case in a calculator. "An asset sitting in a
-- warehouse is not a sustainability result, and CrewQuo will not report it as one
-- until someone records where it actually went."
insert into destination_types
  (company_id, code, name, hierarchy_tier,
   counts_as_retained_in_use, counts_as_reuse, counts_as_recycling,
   counts_as_recovery, counts_as_landfill, counts_as_diverted,
   is_final_outcome, displaces_replacement, ghg_treatment_key, sort_order) values
  (null, 'RETAINED',        'Retained by client',     1, true,  false, false, false, false, true,  true,  false, null,             10),
  (null, 'RELOCATED',       'Relocated / redeployed', 1, true,  false, false, false, false, true,  true,  true,  null,             20),
  (null, 'REUSE',           'Direct reuse',           2, true,  true,  false, false, false, true,  true,  true,  'REUSE',          30),
  (null, 'REFURBISHMENT',   'Refurbishment',          2, true,  true,  false, false, false, true,  true,  true,  'REUSE',          40),
  (null, 'DONATION',        'Donation',               2, true,  true,  false, false, false, true,  true,  true,  'REUSE',          50),
  (null, 'RESALE',          'Resale',                 2, true,  true,  false, false, false, true,  true,  true,  'REUSE',          60),
  (null, 'STORAGE',         'Storage',             null, false, false, false, false, false, false, false, false, null,             70),
  (null, 'RECYCLING',       'Recycling',              3, false, false, true,  false, false, true,  true,  false, 'RECYCLING',      80),
  (null, 'ENERGY_RECOVERY', 'Energy recovery',        4, false, false, false, true,  false, true,  true,  false, 'ENERGY_RECOVERY',90),
  (null, 'LANDFILL',        'Landfill',               5, false, false, false, false, true,  false, true,  false, 'LANDFILL',      100),
  (null, 'OTHER_DISPOSAL',  'Other disposal',         5, false, false, false, false, true,  false, true,  false, 'OTHER',         110)
on conflict do nothing;

comment on table destination_types is
  'The waste hierarchy as data (locked decision #20). Every §28.2 metric is a sum filtered by one of these booleans. System rows (company_id null) are immutable; a company row with the same code shadows one, so a customised hierarchy reads as a diff and is disclosed by the report that uses it.';
comment on column destination_types.is_final_outcome is
  'False only for STORAGE (locked decision #18). Material at a non-final destination counts toward no rate and is reported as pending until a continuing movement records where it actually went (assets-materials.md §13.1).';

-- ── 3. Destination organisations (§25.4) ─────────────────────────────────────
--
-- The charity, recycler, storage facility, reseller or waste contractor material
-- went to.
--
-- IT HOLDS A THIRD PARTY'S PERSONAL DATA, AND THAT THIRD PARTY IS NOT A USER. A
-- charity's contact name, email and phone belong to somebody with no CrewQuo
-- account, no consent flow and no way to ask what is held about them. So the
-- fields are optional and no screen pushes for them; deactivation anonymises the
-- contact and keeps the organisation, because the ORGANISATION is what a
-- two-year-old movement record needs to name; and the export includes them,
-- because they are the exporting company's own contacts book (packet §7).
--
-- `linked_company_id` is a claim about a third party and is bounded in the API to
-- a company this one already has an engagement edge with — the same rule §23's
-- `provider_company_id` got in Phase 7, for the same reason: "Redstone Reuse take
-- our donations" is an assertion about a named business that cannot see or contest
-- the record. A genuine off-platform charity has no companies row and is recorded
-- by `name`, which is the column that exists for that case.

create table if not exists destination_organisations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  linked_company_id uuid references companies(id),
  name text not null,
  kind text not null check (kind in
    ('CHARITY','REUSE_ORG','RECYCLER','STORAGE','RESELLER','WASTE_CONTRACTOR',
     'CLIENT_SITE','MANUFACTURER','OTHER')),
  address text,
  contact_name text,
  contact_email text,
  contact_phone text,

  -- A waste carrier licence or permit number, and its expiry. Recorded and shown;
  -- NOT alerted on and NOT blocking. §33's compliance ladder is Phase 12 and its
  -- governing rule is "never auto-blocks unless enforce_compliance" — building a
  -- second, harder ladder here would pre-empt a decision that phase owns.
  licence_number text,
  licence_expires_on date,

  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists destination_organisations_company_idx
  on destination_organisations (company_id) where active;
create index if not exists destination_organisations_linked_idx
  on destination_organisations (linked_company_id) where linked_company_id is not null;

-- Two organisations with the same name in one company is a duplicate somebody
-- will pick the wrong one of, and picking the wrong one silently attributes a
-- tonne to the wrong charity. Case-insensitive, and only over live rows so a
-- deactivated organisation does not block re-adding it.
create unique index if not exists destination_organisations_company_name_idx
  on destination_organisations (company_id, lower(name)) where active;

comment on column destination_organisations.contact_email is
  'A third party''s personal data, held about somebody with no CrewQuo account. Optional by design, anonymised on deactivation, never in a notification payload (assets-materials.md §7).';

-- ── 4. The entitlement key (§43) ─────────────────────────────────────────────
--
-- Checked against the PROJECT OWNER at every write, never against the recorder.
-- Not a new decision: the owner answered the packaging rule on 2026-09-01 —
-- "capture is free, the record is the project owner's entitlement" — and this is
-- the same rule with a different noun (packet §13.3). A subcontractor who cannot
-- record what it removed cannot do a clearance job.
--
-- The row lands here rather than only in the seed for the reason 0027's limits
-- did: `plan_features.feature_key` carries a foreign key to this table, so
-- without the row an operator cannot grant one company the feature by hand.
insert into features (key, name, description, category) values
  ('asset_tracking', 'Asset & material tracking',
   'Record assets removed, their weights and where they went',
   'sustainability')
on conflict (key) do nothing;

-- §43's proposed placement, and unlike storage_gb there is no reserved figure —
-- a feature placement is a boolean and §43's table is the plan's own proposal for
-- it. Crew is deliberately absent: a Crew company running its OWN project cannot
-- record assets, which is the intended shape of the free tier and consistent with
-- what shipped for evidence, documents and the diary.
--
-- THIS INSERT IS NOT THE AUTHORITY, AND THE DISTINCTION MATTERS. infra/seed does
-- `delete from plan_features where plan_id = $1` and rebuilds the set to match
-- itself exactly, so a placement granted only here is silently revoked by the
-- next seed run — the feature works in production until somebody re-seeds, which
-- is the worst possible time to find out. The seed lists `asset_tracking` on the
-- same four plans, and `assetCatalogParity.test.ts` asserts these two agree. What
-- this insert is for is an ALREADY-MIGRATED deployment: it grants the feature
-- without waiting for a seed run.
insert into plan_features (plan_id, feature_key)
select p.id, 'asset_tracking'
from plans p
where p.id in ('starter', 'pro', 'business', 'enterprise')
on conflict do nothing;
