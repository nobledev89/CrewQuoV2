-- Project locations (CREWQUO_V2_PLAN.md §21) — step 1 of the Phase 7 build order
-- in docs/operating-model/project-evidence.md §14.
--
-- WHY THIS IS EARLY, AHEAD OF THE RECORDS THAT USE IT. Nothing in the product
-- references a location yet: evidence and documents arrive in 7.3 and 7.4, the
-- diary in 7.6, assets in Phase 8, schedule assignments in Phase 11. The tree
-- lands first because it is the spatial key all five hang off, and adding a
-- spatial key to a shipped record means backfilling a column nobody can populate
-- — the same argument decision #22 makes about the offline contract, applied to
-- a foreign key instead of a protocol.
--
-- LOCATIONS ARE OPTIONAL EVERYWHERE, and that is a product rule rather than a
-- schema convenience. A single-area job never has to create one, so every column
-- that will later point here is nullable and every screen has to render the
-- untagged case first.

create table if not exists project_locations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- Deliberately no inline `references` here: the parent constraint is composite
  -- and is added at the foot of this file, because it has to carry `project_id`
  -- as well. A second, narrower foreign key beside it would be a weaker rule
  -- sitting next to the real one.
  parent_id uuid,

  kind text not null check (kind in
    ('BUILDING','FLOOR','ROOM','DEPARTMENT','WAREHOUSE_ZONE','LOADING_BAY','SITE_AREA','OTHER')),
  name       text not null,
  reference  text,                    -- the client's own room or zone code
  notes      text,
  sort_order int not null default 0,

  -- §21's retire-not-delete. `false` keeps the row and everything recorded
  -- against it while taking it out of the pickers.
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A location cannot be its own parent. The API refuses longer cycles too, but
  -- the one-step case is cheap to make impossible rather than merely refused, and
  -- it is the one a hand-written `update` would reach for.
  constraint project_locations_not_own_parent check (parent_id is null or parent_id <> id)
);

create index if not exists project_locations_project_parent_idx
  on project_locations (project_id, parent_id);

-- The tree read orders by these two and nothing else, so the index carries them.
create index if not exists project_locations_project_order_idx
  on project_locations (project_id, sort_order, name);

-- ── The rule the database cannot state, and the one it can ────────────────────
--
-- DEPTH AND CYCLES ARE THE API'S JOB (§21). A depth cap is a property of a path
-- rather than of a row, and enforcing it here would mean a recursive trigger on
-- every insert and every re-parent — which fires per statement, cannot see the
-- rest of a transaction cheaply, and turns a bulk import into a quadratic. The
-- pure functions in `packages/shared/src/locations.ts` hold the rules with a test
-- per branch, which is where this codebase already puts arithmetic.
--
-- THE SAME-PROJECT RULE, HOWEVER, IS THE DATABASE'S. A parent in a *different
-- project* is a cross-tenant edge, and that is exactly the class of thing that
-- must not depend on a route remembering to check. A composite foreign key makes
-- it impossible: the child's `(parent_id, project_id)` must match a real parent's
-- `(id, project_id)`, so a parent from another project cannot be referenced at
-- all, whatever any handler does.
--
-- `on delete cascade` on that edge, and NOT `set null`. A location whose parent
-- is deleted must not silently become top-level — that would leave "Room 3.12"
-- beside "Building A" with nothing to say which building it was in, while every
-- photo tagged to it claims a place that no longer exists. Deleting a location
-- that still has children is refused by the API (§21), so this fires only when
-- the *project* goes, where taking the whole tree is the only right answer.
alter table project_locations
  add constraint project_locations_unique_id_project unique (id, project_id);

alter table project_locations
  add constraint project_locations_parent_same_project
  foreign key (parent_id, project_id)
  references project_locations (id, project_id)
  on delete cascade;
