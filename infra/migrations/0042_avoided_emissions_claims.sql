-- Avoided-emissions claims (CREWQUO_V2_PLAN.md §27.4) — step 6 of the Phase 9
-- build order in docs/operating-model/sustainability.md §14.
--
-- The largest number this product publishes and the one with the least external
-- scrutiny. A wrong tonne of waste is embarrassing; a wrong avoided-emissions
-- claim is quoted in a client's annual report, aggregated by §38.2 into their
-- year, frozen into a §29.4 snapshot that is deliberately never recalculated, and
-- defended by whoever published it.
--
--   avoided = (quantity × displacement_pct × baseline_embodied_carbon)
--             − enabling_emissions
--
-- NOT negative project emissions, and never deducted from any inventory scope
-- (§27.4). The AVOIDED bucket is outside everything, which is why an AVOIDED
-- calculation row carries no scope at all.
--
-- ── NO STATE, AND THE ABSENCE IS THE DESIGN (packet §3) ──────────────────────
--
-- A claim exists or it does not. `UNKNOWN` displacement produces NO ROW — §27.4's
-- rule expressed as an absence rather than as a nullable flag — which is why the
-- data-quality gap for unknown displacement must be computed from MOVEMENTS
-- LACKING CLAIMS rather than from claim rows. There is nothing in here to count.
--
-- A claim is superseded by superseding its calculation. `on delete cascade` from
-- `carbon_calculations` is correct here and is THE ONLY CASCADE IN THIS DOMAIN,
-- because a claim without its calculation is not a record of anything — unlike a
-- calculation without its movement, which is a record of what was true when a
-- report was issued and is kept for exactly that reason (packet §7's inversion).
--
-- ── WHY `displacement_pct` IS NULLABLE HERE AND THE BASIS IS NOT ─────────────
--
-- §27.4 already had this right, and 0037 corrected `sustainability_settings` to
-- match it rather than the other way round. The basis is not derivable from the
-- number: 100 in the column could be a deliberate full-displacement assumption or
-- a user-typed coincidence, and §27.4 requires the claim to record which.
--
-- In practice no row here can carry a null pct, because a null resolved basis
-- produces no claim at all — `resolveDisplacementPct` returns null for UNKNOWN and
-- `calculateAvoidedEmissions` returns a GAP rather than a result. The column stays
-- nullable to match §27.4's shape, and the check below states the invariant the
-- code already keeps.

create table if not exists avoided_emissions_claims (
  id uuid primary key default gen_random_uuid(),

  -- The only cascade in this domain. See the header.
  calculation_id uuid not null references carbon_calculations(id) on delete cascade,

  -- Nullable and `on delete set null` is deliberately NOT used: `asset_movements`
  -- is tombstoned rather than deleted, and a tombstone supersedes the calculation,
  -- which cascades this row away. If a movement is ever hard-deleted the claim
  -- should go with it, so the FK is plain and the delete would be refused —
  -- which is the correct outcome for a row a report may cite.
  asset_movement_id uuid references asset_movements(id),

  -- §27.4: "every claim records baseline scenario, alternative scenario, factor
  -- source, system boundary, reporting period, assumptions, quantity, uncertainty
  -- and methodology — all of which surface in the report." These are not optional
  -- prose. A claim that cannot say what it is claiming against is not a claim.
  baseline_scenario    text not null,
  alternative_scenario text not null,

  displacement_pct numeric(5,2)
    check (displacement_pct >= 0 and displacement_pct <= 100),
  displacement_basis text not null check (displacement_basis in
    ('ASSUMED_FULL','USER_DEFINED','UNKNOWN')),

  baseline_kg_co2e    numeric(18,6) not null check (baseline_kg_co2e >= 0),
  enabling_kg_co2e    numeric(18,6) not null default 0 check (enabling_kg_co2e >= 0),
  -- Unconstrained in sign, like `carbon_calculations.kg_co2e` and for the same
  -- reason: a reuse whose enabling emissions exceeded its baseline saved nothing,
  -- and the product must be able to say so.
  net_avoided_kg_co2e numeric(18,6) not null,

  -- From the product factor's `lifecycle_boundary`. Copied rather than joined so
  -- the claim still states its boundary if the factor is later deactivated — the
  -- same denormalisation `carbon_calculations` applies to its citation.
  system_boundary text not null check (system_boundary in
    ('A1_A3','A1_A5','CRADLE_TO_GATE','CRADLE_TO_GRAVE','OTHER')),

  reporting_period_start date,
  reporting_period_end   date,

  assumptions text not null,
  uncertainty text,

  -- THE METHODOLOGY WARNING TRAVELS WITH EVERY AVOIDED FIGURE, and §27.4 says
  -- where: "shown wherever an avoided figure appears, in the UI and in the report,
  -- not only in an appendix." Storing it on the claim rather than resolving it
  -- from settings at render time is what makes that true a year later, when the
  -- settings row says something else.
  methodology text not null,

  created_at timestamptz not null default now(),

  -- The pairing 0037's settings row also carries. `UNKNOWN` cannot reach this
  -- table at all — it produces no claim — so this constraint is a statement of an
  -- invariant the code keeps rather than a gate the code relies on, and it is the
  -- thing that would fail loudly if some future path started writing claims
  -- without a stated assumption.
  constraint avoided_emissions_claims_basis_matches_pct check (
    (displacement_basis = 'UNKNOWN') = (displacement_pct is null)
  ),
  constraint avoided_emissions_claims_period_ordered check (
    reporting_period_start is null or reporting_period_end is null
      or reporting_period_end >= reporting_period_start
  )
);

create index if not exists avoided_emissions_claims_calculation_idx
  on avoided_emissions_claims (calculation_id);
create index if not exists avoided_emissions_claims_movement_idx
  on avoided_emissions_claims (asset_movement_id)
  where asset_movement_id is not null;

comment on table avoided_emissions_claims is
  'No state at all (packet §3): a claim exists or it does not, and UNKNOWN displacement produces no row. The data-quality gap for unknown displacement is therefore computed from movements LACKING claims, never from rows in here.';
comment on column avoided_emissions_claims.methodology is
  'Stored on the claim rather than resolved from settings at render time, because §27.4 requires the methodology warning to travel with every avoided figure — and a settings row that says something else next year must not silently restate what was claimed this year.';
comment on column avoided_emissions_claims.net_avoided_kg_co2e is
  'Not clamped at zero. Where enabling emissions exceed the baseline the claim is negative and is reported as negative — the product must be able to say that a reuse cost more than it saved.';
