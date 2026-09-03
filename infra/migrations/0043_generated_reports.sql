-- The report ledger (CREWQUO_V2_PLAN.md §29.4) — step 2 of the Phase 10 build
-- order in docs/operating-model/reporting-signoff.md §14.
--
-- THIS IS THE FIRST TABLE IN THE PRODUCT THAT STORES AN ANSWER RATHER THAN A
-- RECORD. Every figure CrewQuo has shipped so far is derived and corrected by
-- correcting its inputs — massBalance.ts says so in its own header, and
-- carbon_calculations supersedes rather than edits for the same reason. §29.4
-- deliberately breaks that: a re-render reads the snapshot and never recalculates,
-- so a 2026 report opened in 2028, after two factor sets have been imported and
-- three weights corrected, produces byte-identical numbers.
--
-- Which means every guarantee in this file is about a document that has already
-- left the building.
--
-- ── DEPARTURE 1: A FOURTH KIND (packet §0 finding 2) ─────────────────────────
--
-- §29.4 says `check (kind in ('SUSTAINABILITY','EVIDENCE_PACK','CLIENT_PERIOD'))`.
-- §29.5 says the client-facing project export "renders from a `generated_reports`
-- snapshot, never from live data — same rule as every other report here." A
-- BILL-side project statement is none of those three. Built literally, either the
-- client export gets no snapshot and recalculates — the exact behaviour the owner
-- decision of 2026-08-17 moved it out of Phase 4 to prevent — or a check
-- constraint gets quietly widened later by whoever hits it first. So the value is
-- decided here, in the migration whose subject it is.
--
-- ── DEPARTURE 2: `audience`, AND IT IS THE POINT OF THE TABLE (finding 3) ────
--
-- §29.1 section 3 lists the project's SUBCONTRACTORS among the overview fields.
-- §29.5, one subsection later, forbids "subcontractor identity" in a file that
-- leaves the building, and portal.ts gives the reason the one-hop rule exists at
-- all. The Sustainability & Completion report is the client's document — it
-- carries their logo and ends with their signature — so §29.1's section 3 hands
-- the client the supply chain, and §29.4 gives that document a `client_visible`
-- boolean that anybody holding `report.generate` can set.
--
-- §29.5 asks for the exclusion to be STRUCTURAL: "so the exclusion cannot be
-- forgotten by a later edit the way a `select` list can". One snapshot with a
-- disclosure flag is exactly the forgettable kind — the flag is applied at
-- disclosure time to a document assembled for a different reader.
--
-- Three layers, because a file cannot be un-sent:
--   1. `audience`, fixed at generation and refused by a trigger on update;
--   2. the check constraint below, so the DATABASE refuses the combination even
--      if a future route forgets;
--   3. two snapshot builders over two type families in the API, so the client's
--      document has no FIELD that can hold a PAY figure or a provider name.
--
-- ── DEPARTURE 3: `on delete restrict` (finding 5) ────────────────────────────
--
-- §29.4 has no on-delete clause and every table added since Phase 7 chose
-- `cascade`. DELETE /v1/projects/:id is a hard delete guarded by assertManager and
-- nothing else. §34 says sign-off rows are append-only and "both are retained with
-- their signatures"; decision #27 promises the evidence behind them survives. A
-- cascade contradicts both, through a route with no confirmation step.
--
-- Company closure is unaffected and this was checked rather than assumed:
-- COMPANY_STATEMENTS sets `closed_at` and deletes no company row, so no project is
-- ever cascade-deleted by the erasure path. The only thing `restrict` blocks is
-- somebody tidying away a project a client has signed off, which is the thing it
-- should block. The route refuses first with a sentence naming what stands in the
-- way — the pattern §3.3's locked rate cards already use, because a trigger
-- violation reaching the caller as a 500 is not an explanation.
--
-- ── DEPARTURE 4: A UNIQUE KEY OVER THE SEAL (finding 9) ──────────────────────
--
-- §29.4 declares no uniqueness, and a report is produced by pressing a button.
-- Double-click, or a client retrying a request that actually succeeded, and there
-- are two GENERATED rows for one project with different `generated_at` and — once
-- the renderer became deterministic in 10.1 — IDENTICAL content hashes. Which is
-- the document? Both, and neither supersedes the other.
--
-- The partial unique index below makes generation idempotent by construction, and
-- it makes "regenerate with current data" honest: a regeneration after nothing
-- changed produces the same hash, returns the same row and supersedes nothing, so
-- a SUPERSEDED row in the trail always means a figure actually moved.

create table if not exists generated_reports (
  id uuid primary key default gen_random_uuid(),

  -- The company that generated it. For a project report this is always the
  -- project's owner; for CLIENT_PERIOD there is no single project, which is why
  -- the column is not derived from one.
  company_id uuid not null references companies(id) on delete cascade,

  -- Null for a client-period report (§29.4). `restrict` for the reason above.
  project_id uuid references projects(id) on delete restrict,

  -- Whose report it is about. For CLIENT_PERIOD this is the subject; for a
  -- project report it is a copy of the project's client at generation time,
  -- frozen because a project's client can be re-pointed by the placeholder merge
  -- and the document said what it said.
  client_company_id uuid references companies(id),

  kind text not null check (kind in
    ('SUSTAINABILITY','EVIDENCE_PACK','CLIENT_EXPORT','CLIENT_PERIOD')),

  -- Who it was ASSEMBLED FOR. Never updatable — see the trigger below.
  audience text not null check (audience in ('INTERNAL','CLIENT')),

  title text not null,
  period_start date,
  period_end date,

  -- Which sections were included, in order (§29.2). Stored so a regeneration
  -- reproduces the same document, and so a report generated before Phase 11 keeps
  -- its own set once PACK_VARIATIONS becomes available.
  sections jsonb not null default '[]'::jsonb,

  -- Every number, every factor-set id and version, every source record id, and
  -- the revision each cited record was at (packet finding 10). This IS the report;
  -- the PDF is a rendering of it.
  snapshot jsonb not null,

  -- sha256 of `canonicalJson(snapshot)` — packages/shared/src/reporting.ts.
  --
  -- NOT of `snapshot::text`, and the difference is the whole of finding 4: jsonb
  -- reorders keys on write, a numeric written as 1.500 parses back as 1.5, and key
  -- insertion order is a property of whichever code built the object. Hash the
  -- stored text and the seal fails on every row, which is the same as no seal.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),

  -- Denormalised from the snapshot so §38.2's "a period spanning two factor sets
  -- says so" is answerable without opening every document. The same argument
  -- carbon_calculations' citation columns make one table down.
  factor_set_ids uuid[] not null default '{}',

  -- §29.3's text as it stood, frozen. NEVER re-read from sustainability_settings
  -- at render: a company that edits its methodology statement next year must not
  -- restate what a client was already given.
  disclaimer text not null,

  -- The rendered PDF, and it is a CACHE rather than the record (packet §13.7).
  -- Nullable in §29.4's own DDL and nullable here: 10.1 made the renderer
  -- deterministic, so a document rendered from the snapshot a year later is
  -- byte-identical to the one that was stored. That is what lets the whole phase
  -- work in an environment with no object store.
  file_id uuid references stored_files(id) on delete set null,

  status text not null default 'GENERATED'
    check (status in ('GENERATED','SUPERSEDED','VOID')),
  supersedes_id uuid references generated_reports(id) on delete set null,
  -- Why it was voided. Required by the route; nullable here because a GENERATED
  -- row has no reason to carry one.
  void_reason text,

  client_visible boolean not null default false,

  -- Nullable, unlike §29.4's `not null`, and for the reason 0030, 0034 and 0040
  -- each made the same column nullable: the closure promise of 2026-08-20
  -- anonymises a person and preserves the record. Anonymisation keeps the row,
  -- so `not null` would in fact survive — but `on delete set null` costs nothing
  -- and removes the question, and a report generated by a scheduled regeneration
  -- has no person behind it at all.
  generated_by_user_id uuid references users(id) on delete set null,
  generated_at timestamptz not null default now(),

  -- ── The disclosure constraint (finding 3, layer 2) ─────────────────────────
  --
  -- A snapshot assembled for the owner cannot be disclosed AT ALL, by anybody,
  -- ever, including by a future route that forgets to check. This is the line
  -- that makes the exclusion structural rather than procedural.
  constraint generated_reports_disclosure
    check (not client_visible or audience = 'CLIENT'),

  -- §29.5 has no internal form: the owner's own project export is Phase 4's live
  -- one, which shows PAY and margin. An INTERNAL client-export would be a second
  -- owner-side document with the owner's own figures deliberately removed.
  constraint generated_reports_client_export_audience
    check (kind <> 'CLIENT_EXPORT' or audience = 'CLIENT'),

  -- A project report needs a project; a period report needs a period. Stated as
  -- constraints because both are assumed by every query below them.
  constraint generated_reports_project_or_period
    check ((kind = 'CLIENT_PERIOD') = (project_id is null)),
  constraint generated_reports_period_bounds
    check (period_start is null or period_end is null or period_start <= period_end),
  constraint generated_reports_period_required
    check (kind <> 'CLIENT_PERIOD' or (period_start is not null and period_end is not null)),

  -- A void has a reason and a live report does not carry one.
  constraint generated_reports_void_reason
    check ((status = 'VOID') = (void_reason is not null)),

  constraint generated_reports_not_own_predecessor
    check (supersedes_id is null or supersedes_id <> id)
);

comment on table generated_reports is
  'Frozen report snapshots (§29.4). A re-render reads the snapshot and never recalculates. `audience` is immutable and gates `client_visible`, because §29.5 requires the money boundary in a disclosed document to be structural rather than filtered (reporting-signoff.md §0 finding 3).';
comment on column generated_reports.audience is
  'Who the snapshot was ASSEMBLED FOR. Immutable — the trigger below refuses an update. A CLIENT snapshot is built from PortalProjectView/PortalLineItem and ClientWorkforceSummary, which have no field for a PAY figure or a provider name.';
comment on column generated_reports.content_hash is
  'sha256 of canonicalJson(snapshot), never of snapshot::text — jsonb reorders keys and normalises numerics, so a hash over the stored text fails on every row.';
comment on column generated_reports.file_id is
  'A cache, not the record. The renderer is deterministic (10.1), so the snapshot alone reproduces the same bytes.';
comment on column generated_reports.project_id is
  'on delete RESTRICT: §34 makes a sign-off append-only and decision #27 keeps a report addressable, and DELETE /v1/projects/:id would otherwise erase both. Company closure sets closed_at and deletes no company, so nothing legitimate is blocked.';

-- One live document per (project, kind, content). Finding 9: without this, a
-- double-click produces two GENERATED rows with identical seals and no way to say
-- which one the client has.
--
-- `coalesce(project_id, company_id)` so a CLIENT_PERIOD report — which has no
-- project — is still deduplicated, per company, on exactly the same rule.
create unique index if not exists generated_reports_live_content_idx
  on generated_reports (coalesce(project_id, company_id), kind, content_hash)
  where status = 'GENERATED';

create index if not exists generated_reports_project_idx
  on generated_reports (project_id, generated_at desc) where project_id is not null;
create index if not exists generated_reports_company_idx
  on generated_reports (company_id, generated_at desc);
-- The client's portal list: their disclosed, current documents, newest first.
create index if not exists generated_reports_disclosed_idx
  on generated_reports (client_company_id, generated_at desc)
  where client_visible and status = 'GENERATED';
create index if not exists generated_reports_supersedes_idx
  on generated_reports (supersedes_id) where supersedes_id is not null;
-- §38.2's mixed-factor-year disclosure, over a period, without opening snapshots.
create index if not exists generated_reports_factor_sets_idx
  on generated_reports using gin (factor_set_ids);

-- ── Immutability, where it actually bites ────────────────────────────────────
--
-- A report's numbers are its snapshot and its seal; its audience is who it was
-- built for. None of the four may ever change, because every one of them is a
-- claim the document has already made to somebody.
--
-- What MAY change is exactly three things: the status (as the state machine
-- allows), the disclosure flag, and the cached `file_id`. Everything else is
-- refused here as well as in the route, for the reason 0009 and 0013 both give: a
-- PATCH added later in good faith must not be able to restate history behind a
-- frozen snapshot's back.
create or replace function generated_reports_guard_frozen() returns trigger as $$
begin
  if new.snapshot is distinct from old.snapshot
     or new.content_hash is distinct from old.content_hash
     or new.audience is distinct from old.audience
     or new.kind is distinct from old.kind
     or new.disclaimer is distinct from old.disclaimer
     or new.sections is distinct from old.sections
     or new.project_id is distinct from old.project_id
     or new.company_id is distinct from old.company_id
     or new.generated_at is distinct from old.generated_at then
    raise exception 'a generated report is frozen; generate a new one, which supersedes this'
      using errcode = 'check_violation';
  end if;

  -- Terminal states are terminal (§3). A superseded document stays superseded and
  -- a void one stays void; both remain retrievable, which is the point.
  if old.status <> 'GENERATED' and new.status <> old.status then
    raise exception 'report status % is terminal', old.status
      using errcode = 'check_violation';
  end if;

  -- Voiding un-discloses in the same statement, because the reason to void is
  -- frequently that it was disclosed by mistake. Enforced rather than left to the
  -- route: a voided document that is still listed in a client's portal is the one
  -- failure this transition exists to prevent.
  if new.status = 'VOID' and new.client_visible then
    raise exception 'a voided report cannot remain shared with the client'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists generated_reports_guard_frozen_trg on generated_reports;
create trigger generated_reports_guard_frozen_trg
  before update on generated_reports
  for each row execute function generated_reports_guard_frozen();

-- ── §43's four new feature keys ──────────────────────────────────────────────
--
-- `client_reporting` ships now even though §38.2's UI is Phase 12, because the
-- aggregation query and the CLIENT_PERIOD kind ship now and an ungated route is
-- not a smaller decision for being invisible.
insert into features (key, name, description, category) values
  ('sustainability_reports', 'Sustainability reports',
   'Generate the Sustainability & Completion report from project data, with reproducible snapshots',
   'reporting'),
  ('evidence_pack', 'Evidence & completion pack',
   'Generate the operational handover pack with selectable sections',
   'reporting'),
  ('client_signoff', 'Client sign-off',
   'Capture a client signature against a project or phase, with an immutable evidence snapshot',
   'reporting'),
  ('client_reporting', 'Client-level reporting',
   'Aggregate a client''s projects over a period into one sustainability report',
   'reporting')
on conflict (key) do nothing;

-- §43's proposed placement, and 0033's note transfers unchanged: THIS INSERT IS
-- NOT THE AUTHORITY. infra/seed deletes and rebuilds plan_features to match
-- itself, so a placement granted only here is silently revoked by the next seed
-- run; the seed lists the same keys on the same plans and reportingParity.test.ts
-- asserts the two agree. What this is for is an already-migrated deployment.
--
-- `client_signoff` FROM STARTER RATHER THAN PRO, and it is a stated departure
-- from §43's table (packet §13.6). A sign-off is how a small contractor proves a
-- job is finished; it costs nothing to serve; and putting the proof of completion
-- two tiers above the work would stop the free-to-Starter path one step short of
-- the thing the customer is actually selling.
insert into plan_features (plan_id, feature_key)
select p.id, 'client_signoff' from plans p
where p.id in ('starter', 'pro', 'business', 'enterprise')
on conflict do nothing;

insert into plan_features (plan_id, feature_key)
select p.id, k.key
from plans p
cross join (values ('sustainability_reports'), ('evidence_pack')) as k(key)
where p.id in ('pro', 'business', 'enterprise')
on conflict do nothing;

insert into plan_features (plan_id, feature_key)
select p.id, 'client_reporting' from plans p
where p.id in ('business', 'enterprise')
on conflict do nothing;
