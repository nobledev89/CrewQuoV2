-- Project asset lines (CREWQUO_V2_PLAN.md §25.2, §25.3) — step 2 of the Phase 8
-- build order in docs/operating-model/assets-materials.md §14.
--
-- What came off the floor, what it weighed, and how much to trust that weight.
-- `asset_movements` (0035) says where it went; this says what "it" is.
--
-- BULK IS THE DEFAULT AND ITEM MODE IS THE EXCEPTION (§25.2). The common entry is
-- one line — "42 × Operator Chair · unit weight 16.5 kg · total 693 kg" — because
-- nobody registers 42 chairs individually. `tracking_mode = 'ITEM'` opts a line
-- into per-unit rows for ITAD and high-value items where a client needs a
-- certificate per serial number.
--
-- FOUR DEPARTURES FROM THE CANONICAL DDL, each from the packet's §0:
--
--   * `created_by_user_id` is NULLABLE with `on delete set null`, not `not null`
--     (finding 6). The closure decision of 2026-08-20 anonymises the person and
--     preserves the record; `not null` here makes "close Ekene's account" either
--     impossible or destructive of a hiring company's asset register. Same fix
--     0030 applied to `project_evidence`, and the null IS the tombstoned identity
--     rather than a missing value.
--
--   * `revision` and `deleted_at` are here, and the canonical DDL has neither
--     (finding 9's other half). 13.5 puts this record set on a phone — "Assets
--     Removed, Waste/Reuse, destination assignment on site" — and the argument
--     that put the sync contract in Phase 7 applies unchanged: cheap to design
--     into an endpoint, expensive to retrofit into a shipped one.
--
--   * The serial-number unique index carries `and deleted_at is null`. Without
--     it a tombstoned line blocks its own re-creation, which on a syncing device
--     is a permanent failure with no visible cause.
--
--   * `weighed_by_user_id` is a column §25.2 does not list and §25.3 requires.
--     "VERIFIED and DOCUMENTED require an attached document unless the source is
--     WEIGHED with a recorded weigher" — a recorded weigher needs somewhere to be
--     recorded. Without it the WEIGHED exception is unenforceable and every
--     weighed figure needs paperwork that does not exist for weighing something
--     on a scale.

create table if not exists project_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- WHO RECORDED IT, WHICH IS NOT WHOSE PLAN PAYS FOR IT. `asset_tracking` is
  -- checked against `projects.owner_company_id`; this column stays the recorder.
  -- 0030's comment transfers unchanged: "two facts, two columns, and collapsing
  -- them is how the meter starts disagreeing with the audit trail."
  company_id uuid not null references companies(id),

  asset_type_id uuid not null references asset_types(id),
  tracking_mode text not null default 'BULK' check (tracking_mode in ('BULK','ITEM')),
  description text,

  -- numeric, not integer: 42 chairs and 2.5 tonnes of timber are the same column.
  -- §0's DDL convention — physical quantities are numeric, never minor units.
  quantity numeric(12,2) not null default 1 check (quantity >= 0),

  -- ── Weight (§25.2, §25.3) ──────────────────────────────────────────────────
  --
  -- `weight_basis` records which side the user TYPED and the other is derived at
  -- write time. Editing quantity recomputes the derived side and never the
  -- entered one: 42 → 50 chairs at 16.5 kg is 825 kg, and a weighbridge that said
  -- 693 kg went out does not get heavier because four more chairs were found on
  -- the dock. The arithmetic is `deriveWeights` in packages/shared/src/assets.ts,
  -- so one rule serves the API, the importer and the phone.
  --
  -- A line with NEITHER weight is valid (§25.2). It contributes nothing to mass
  -- metrics and drags down data completeness, which is the correct incentive —
  -- and it is why these are nullable rather than defaulted to zero. Null is a
  -- gap; zero is a claim.
  weight_basis     text check (weight_basis in ('UNIT','TOTAL')),
  unit_weight_kg   numeric(14,3) check (unit_weight_kg >= 0),
  total_weight_kg  numeric(14,3) check (total_weight_kg >= 0),
  weight_source    text check (weight_source in
     ('WEIGHED','WEIGHBRIDGE','TRANSFER_NOTE','SUPPLIER_DOC','PRODUCT_SPEC',
      'USER_ESTIMATE','SYSTEM_ESTIMATE')),
  weight_confidence text check (weight_confidence in
     ('VERIFIED','DOCUMENTED','ESTIMATED','APPROXIMATE')),

  -- Derived from the confidence and denormalized for filtering (§25.3). Kept in
  -- step by the API rather than by a trigger, because `resolveWeightConfidence`
  -- already owns the derivation and two owners is how they disagree.
  weight_is_estimated boolean not null default true,

  -- The document a VERIFIED or DOCUMENTED weight rests on. It points at a
  -- document VERSION, not a chain, and that is deliberate (packet finding 5): a
  -- weight's provenance is a claim about the document that was on the table when
  -- the weight was recorded, and re-pointing it at v2 would let a re-issued
  -- ticket retroactively change what a weigher is recorded as having read. That
  -- the cited version has since been superseded is DERIVED and disclosed, by the
  -- same join `documents.ts` runs for `supersededById`.
  weight_document_id uuid references project_documents(id),

  -- §25.3's WEIGHED exception needs somewhere to record the weigher. Nullable and
  -- `on delete set null` for the same closure reason as `created_by_user_id`.
  weighed_by_user_id uuid references users(id) on delete set null,

  -- ── Identity (mostly ITEM mode / ITAD) ─────────────────────────────────────
  manufacturer text,
  model text,
  serial_number text,
  asset_tag text,
  material_composition jsonb,
  condition text check (condition in ('NEW','GOOD','FAIR','POOR','DAMAGED','SCRAP')),

  origin_location_id uuid references project_locations(id),

  -- DERIVED, NEVER TYPED (§25.4 rule 2). Stored rather than computed on read
  -- because the "what still needs a destination" screen is the daily job and its
  -- index cannot exist over an expression joining another table. Exactly one
  -- function writes it, inside the asset's own row lock; a recompute path any
  -- caller may skip is a derived column that is wrong in production.
  outcome_state text not null default 'PENDING'
                  check (outcome_state in ('PENDING','PARTIAL','IN_STORAGE','FINAL')),

  notes text,

  -- Nullable, unlike §25.2's `not null`, and the null is the tombstoned identity.
  created_by_user_id uuid references users(id) on delete set null,
  updated_by_user_id uuid references users(id) on delete set null,

  -- The client-supplied id shared by one paste-import. Sixty rows is one act by
  -- one person: it keys the single `asset.lines_recorded` event, and it is how
  -- "show me what I just pasted" is asked after a filter has moved. The same
  -- column `project_evidence.batch_client_id` is, doing the same job.
  batch_client_id uuid,

  -- The sync contract's two columns (0029, item 7.7).
  revision int not null default 1,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ITEM mode is per-unit rows, so a quantity above one is a contradiction rather
  -- than a preference (§25.2: "quantity 1, serial/asset tag required"). Stated
  -- here so no route can be written that forgets it.
  constraint project_assets_item_mode_is_one
    check (tracking_mode <> 'ITEM' or quantity = 1)
);

create index if not exists project_assets_project_idx
  on project_assets (project_id) where deleted_at is null;
create index if not exists project_assets_project_outcome_idx
  on project_assets (project_id, outcome_state) where deleted_at is null;
create index if not exists project_assets_company_idx
  on project_assets (project_id, company_id) where deleted_at is null;
create index if not exists project_assets_location_idx
  on project_assets (origin_location_id)
  where origin_location_id is not null and deleted_at is null;
create index if not exists project_assets_batch_idx
  on project_assets (batch_client_id) where batch_client_id is not null;
create index if not exists project_assets_weight_document_idx
  on project_assets (weight_document_id) where weight_document_id is not null;

-- ── The serial number, and what it identifies ────────────────────────────────
--
-- COMPANY-WIDE, NOT PER-PROJECT, and it is the packet's §13.2 — open, built as
-- recommended.
--
-- The same server, relocated off project A and recycled from project B a year
-- later, is one physical machine and two rows in one company; this index refuses
-- the second. Loosening it to (company_id, project_id, serial_number) would
-- permit the same machine to be recycled twice and reported as two tonnes and two
-- ITAD certificates — the exact double-count §41 exists to prevent, and a
-- double-count that passes every constraint is the worst kind.
--
-- So it fails LOUDLY: the API names the project the serial already lives on, so
-- the refusal is a route to the right record rather than a wall. If ITAD
-- customers turn out to re-handle serials across projects routinely, that message
-- is what makes the demand for a cross-project asset registry measurable.
create unique index if not exists project_assets_item_serial_idx
  on project_assets (company_id, serial_number)
  where serial_number is not null and tracking_mode = 'ITEM' and deleted_at is null;

-- The revision trigger from 0029, reused rather than reimplemented. It already
-- refuses to fire when nothing changed, which on a syncing device is the
-- difference between a conflict prompt and a conflict.
drop trigger if exists project_assets_bump_revision on project_assets;
create trigger project_assets_bump_revision
  before update on project_assets
  for each row execute function bump_revision();

comment on column project_assets.outcome_state is
  'Derived from the open movements, never typed (§25.4 rule 2). PENDING with none; FINAL when open final-outcome movements account for the whole line; IN_STORAGE when every open movement is non-final and together they account for it; PARTIAL otherwise. Recomputed inside the asset row lock by one function (assets-materials.md §3).';
comment on column project_assets.weight_document_id is
  'A document VERSION, not a chain. A weight''s provenance is a claim about the document that was on the table when it was recorded; that the version has since been superseded is derived and disclosed, never repaired by re-pointing (assets-materials.md §0 finding 5).';
comment on column project_assets.weighed_by_user_id is
  'Required by §25.3 for a WEIGHED weight to reach VERIFIED without an attached document — the person IS the provenance, so the claim has an author who can be asked. A column §25.2 omits and §25.3 needs.';
