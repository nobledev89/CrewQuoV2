-- The offline/sync contract (item 7.7, locked decision #22) — step 2 of the
-- Phase 7 build order in docs/operating-model/project-evidence.md §14.
--
-- WHY NOW, WHEN THE PHONE IS PHASE 13. Client ids, expected versions and
-- tombstones are cheap to design into an endpoint and expensive to retrofit into
-- a shipped one. The mobile deferral of 2026-08-20 moved the *device* half out
-- and left this half exactly where it was, because the evidence, document and
-- diary APIs are the ones that must not harden without it. This migration lands
-- the storage the contract needs and applies it to `project_locations`, which is
-- currently its only mutable consumer; 7.3 to 7.6 adopt the same three columns.

-- ── 1. The idempotency ledger ────────────────────────────────────────────────
--
-- "Have I already done this?" — for a retry that could not tell whether its first
-- attempt landed, which on an intermittent connection is most of them.
--
-- IT STORES THE RESPONSE, NOT JUST THE FACT. A ledger that only recorded "seen"
-- would let the replay be refused as a duplicate, and a refusal is not what the
-- caller needs: it needs the answer it missed. So a replayed mutation returns
-- byte-for-byte what the first one returned, and the client cannot tell which
-- attempt it was — which is the entire definition of idempotent.
--
-- SCOPED PER COMPANY. Two tenants choosing the same uuid is vanishingly unlikely
-- and the consequence of being wrong is one tenant receiving another's response
-- body, so the key carries the boundary rather than trusting the entropy.

create table if not exists mutation_receipts (
  company_id uuid not null references companies(id) on delete cascade,
  client_id  uuid not null,

  -- The route template, never the populated path — the same rule the request log
  -- follows (`observability/log.ts`), for the same reason: a populated path is a
  -- record of which resources a person touched.
  route text not null,

  -- What the first attempt was asked to do. A replay whose body differs is not a
  -- retry, it is a client reusing an id for a second act, and returning the first
  -- answer would silently discard the second. Hashed rather than stored: the body
  -- is customer data and this table has no business holding a diary entry.
  request_fingerprint text not null,

  status_code int not null,
  response    jsonb not null,

  created_at timestamptz not null default now(),

  primary key (company_id, client_id)
);

-- The prune runs with the auth-retention pass rather than on a schedule of its
-- own, for the reason §14 step 1 records: a table whose purpose is bookkeeping,
-- pruned by a job that can itself stop, is one more thing somebody has to notice
-- had stopped.
create index if not exists mutation_receipts_created_idx on mutation_receipts (created_at);

-- ── 2. Revisions and tombstones on project_locations ─────────────────────────
--
-- `revision` answers "is what I am changing still what I read?" and `deleted_at`
-- answers "is it gone, or am I not allowed?" — two questions a 404 cannot tell
-- apart, and on a bad connection a third (a timeout) looks like both.

alter table project_locations
  add column if not exists revision int not null default 1,
  add column if not exists deleted_at timestamptz;

-- A live location is one without a tombstone. Every read filters on this, so it
-- carries the project too.
create index if not exists project_locations_live_idx
  on project_locations (project_id) where deleted_at is null;

-- THE INCREMENT IS THE DATABASE'S, NOT THE ROUTE'S.
--
-- A revision maintained by application code is a revision that is correct until
-- somebody adds the second write path — and the second write path is always
-- added by whoever has not read this file. A trigger cannot be forgotten, cannot
-- be skipped by a hand-written `update`, and is the only version of this that is
-- still true after Phase 8 adds its own handler.
--
-- It deliberately does not fire when nothing changed: a no-op `update` that bumped
-- the revision would invalidate every client's expected version for no reason,
-- which on a syncing device means a conflict prompt about a change nobody made.
create or replace function bump_revision() returns trigger as $$
begin
  if to_jsonb(new) - 'revision' - 'updated_at' is distinct from to_jsonb(old) - 'revision' - 'updated_at' then
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists project_locations_bump_revision on project_locations;
create trigger project_locations_bump_revision
  before update on project_locations
  for each row execute function bump_revision();

-- ── 3. Deleting a location becomes a tombstone ───────────────────────────────
--
-- §21's rules do not change: a location with children or references is still
-- refused, and retirement (`active = false`) is still the path for one that has
-- been used. What changes is what a *permitted* delete leaves behind — a row that
-- can say "this is gone" rather than an absence that says nothing.
--
-- The composite parent key stays `on delete cascade` for the project-deleted
-- case, and a tombstoned parent is simply never returned as a live row.
comment on column project_locations.deleted_at is
  'Tombstone (0029). Set instead of deleting the row, so a stale client can be told the record is gone rather than inferring it from a 404 — which is indistinguishable from a permission failure. Only ever disclosed to a caller who could have read the live row.';
