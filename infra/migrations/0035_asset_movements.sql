-- The movement ledger (CREWQUO_V2_PLAN.md §25.4) — step 3 of the Phase 8 build
-- order in docs/operating-model/assets-materials.md §14.
--
-- An asset line does not have "a destination". It has a chain of transfers, and
-- 42 chairs can split 30 donated / 12 recycled. This is that chain.
--
-- ── THE COLUMN THE PACKET WAS WRITTEN FOR ────────────────────────────────────
--
-- `continues_movement_id` resolves §13.1, which is the contradiction between two
-- rules of §25.4 that would each have been a migration to undo:
--
--   Rule 1: sum(movements.quantity) <= project_assets.quantity
--   Rule 3: "when the material later leaves storage a SECOND movement records
--           the real outcome"
--
-- Twelve chairs into a warehouse and twelve out is 24 against a line of 42 that
-- also donated 30, so rule 1 refuses the movement rule 3 requires. Enforced
-- literally, storage becomes a one-way door and locked decision #18 — storage is
-- not an outcome UNTIL A FINAL DESTINATION IS RECORDED — becomes unimplementable,
-- which is the opposite of what that decision exists to do.
--
-- One nullable self-reference fixes it, and rule 1 is restated over the movements
-- nothing continues:
--
--   sum(quantity) over OPEN movements <= project_assets.quantity
--
-- The storage leg stays, because a ledger records where material has been —
-- "left site 4 March, recycled 2 April" is answerable, and so is "420 kg is in a
-- warehouse and we do not yet know where it went" while it is still true. It also
-- protects Phase 9: §27.4 attaches avoided-emissions claims to asset_movements BY
-- ID, and without the chain a superseded storage leg and its real outcome are two
-- unrelated movements a claim can be attached to twice.
--
-- Raised as §13.1 rather than taken quietly, and built as recommended, because
-- the phase cannot ship a movement table that refuses the movement its own rule 3
-- describes.
--
-- ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
--
-- `vehicle_id`. §25.4 gives it a foreign key to `vehicles`, which is Phase 11
-- (§31). 0030 set the precedent and the reason: "a column nothing writes and
-- nothing reads is indistinguishable, on inspection, from one whose writer is
-- broken." It arrives with the migration that creates the table it points at.
--
-- `distance_km` STAYS, because unlike the vehicle reference it has a Phase 9
-- consumer that needs no fleet: §27.3 prices transport from tonne.km and a
-- freight factor, and a subcontractor's van is distance without a `vehicles` row.

create table if not exists asset_movements (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references project_assets(id) on delete cascade,

  -- Allocated under the asset's own row lock, so two clerks recording at once do
  -- not race for it. The unique index below stays regardless: an invariant
  -- enforced only by a lock is one a future direct-SQL fix can violate.
  sequence int not null,

  -- The packet's §13.1. Points at the non-final movement this one carries onward.
  -- A continued movement counts against nothing — not the ceiling, not allocated
  -- mass, not pending mass — and is never deleted to make room for its successor.
  continues_movement_id uuid references asset_movements(id),

  destination_type_id uuid not null references destination_types(id),
  destination_org_id  uuid references destination_organisations(id),
  destination_address text,
  from_location_id uuid references project_locations(id),

  quantity numeric(12,2) not null check (quantity > 0),

  -- ── NULL MEANS DERIVE, and that is the packet's finding 4 ──────────────────
  --
  -- §25.4 says a movement's weight is "derived from the asset unless overridden",
  -- and a derivation COPIED at write time goes stale the first time somebody
  -- corrects a weight — which §25.3 expects, since a weighbridge ticket arriving
  -- a week after an estimate is the normal case rather than the exception.
  --
  -- So nothing writes this by default. Null means `quantity × line unit weight`,
  -- computed at read time at full precision; a value is an overriding claim
  -- somebody made on purpose, which is exactly the weighbridge case where the
  -- movement knows better than the line. One nullable column does what a boolean
  -- plus a value would do, and correcting a line moves every derived movement
  -- with it while touching no overridden one.
  weight_kg numeric(14,3) check (weight_kg >= 0),

  moved_on date not null,
  distance_km numeric(12,3) check (distance_km >= 0),

  -- The WTN, weighbridge ticket, recycling certificate or donation receipt. What
  -- turns a claimed destination into a documented one (§25.4, and the four
  -- categories documents.ts already ships for exactly this).
  document_id uuid references project_documents(id),

  notes text,

  -- Nullable with `on delete set null`, like every other actor column since the
  -- closure decision of 2026-08-20. The null is the tombstoned identity.
  recorded_by_user_id uuid references users(id) on delete set null,
  updated_by_user_id  uuid references users(id) on delete set null,

  -- The sync contract's two columns (0029, item 7.7). 13.5 puts destination
  -- assignment on a phone, so this table needs them as much as the asset does.
  revision int not null default 1,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (asset_id, sequence),

  -- A movement cannot continue itself. Cheap, and the shape of a bug that would
  -- otherwise make `openMovements` return nothing for the asset — every row
  -- continued, none open, the whole line silently pending.
  constraint asset_movements_no_self_continue
    check (continues_movement_id is null or continues_movement_id <> id)
);

-- ── One successor per movement ───────────────────────────────────────────────
--
-- A fork double-counts on the very next sum: two movements both continuing one
-- storage leg would each be open, and 12 chairs would leave the warehouse twice.
-- The same partial-index shape `project_documents.supersedes_id` uses, and for
-- the same reason — filtered on `deleted_at is null`, so retracting a wrong
-- continuation frees the slot rather than blocking the correct one for ever.
create unique index if not exists asset_movements_one_continuation_idx
  on asset_movements (continues_movement_id)
  where continues_movement_id is not null and deleted_at is null;

create index if not exists asset_movements_asset_idx
  on asset_movements (asset_id) where deleted_at is null;
create index if not exists asset_movements_destination_idx
  on asset_movements (destination_type_id) where deleted_at is null;
create index if not exists asset_movements_org_idx
  on asset_movements (destination_org_id)
  where destination_org_id is not null and deleted_at is null;
create index if not exists asset_movements_moved_on_idx
  on asset_movements (moved_on) where deleted_at is null;
create index if not exists asset_movements_document_idx
  on asset_movements (document_id) where document_id is not null and deleted_at is null;

drop trigger if exists asset_movements_bump_revision on asset_movements;
create trigger asset_movements_bump_revision
  before update on asset_movements
  for each row execute function bump_revision();

comment on column asset_movements.continues_movement_id is
  'The non-final movement this one carries onward — storage, then the real outcome (assets-materials.md §13.1). A continued movement counts against no ceiling and no metric, and stays because a ledger records where material has been. Exactly one successor per movement, enforced by asset_movements_one_continuation_idx.';
comment on column asset_movements.weight_kg is
  'NULL means derive from the asset line at read time. A value is an overriding claim — the weighbridge weighed this load. Nothing writes it by default, so correcting a line''s weight moves every derived movement with it and touches no overridden one (assets-materials.md §0 finding 4).';

-- ── The back-references 0030 deferred ────────────────────────────────────────
--
-- 0030 omitted five foreign keys from `project_evidence` and said why: "Each of
-- the five arrives with the migration that creates the table it points at, where
-- it can carry a real foreign key and a real consumer on the same day." Two of
-- the five are these, and today is that day — §22.2's own DDL, with the index it
-- specifies.
--
-- `on delete set null` rather than cascade: a photograph of 42 chairs is evidence
-- of the day's work whether or not the asset line it was tagged to survives, and
-- deleting a mis-typed line should not delete the picture.
alter table project_evidence
  add column if not exists asset_id uuid references project_assets(id) on delete set null,
  add column if not exists asset_movement_id uuid references asset_movements(id) on delete set null;

create index if not exists project_evidence_asset_idx
  on project_evidence (asset_id) where asset_id is not null and deleted_at is null;
create index if not exists project_evidence_asset_movement_idx
  on project_evidence (asset_movement_id)
  where asset_movement_id is not null and deleted_at is null;
