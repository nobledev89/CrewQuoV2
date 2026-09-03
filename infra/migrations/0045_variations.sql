-- Variations / extra works (CREWQUO_V2_PLAN.md §30.1) — step 11.1 of the Phase 11
-- build order in docs/operating-model/commercial-operations.md §14.
--
-- Two tables, one enum value on an existing table, and one feature key. Four
-- departures from §30.1's canonical DDL, each with its reason below.
--
-- ── THE DEPARTURES, IN ONE PLACE ────────────────────────────────────────────
--
--  1. `created_by_user_id` is NULLABLE with `on delete set null`. §30.1 says
--     `not null`. This is the FOURTH time (0030, 0034, 0040): the closure promise
--     of 2026-08-20 anonymises a person and preserves the record, and a preserved
--     record must not depend on that staying true. The packet checked the class
--     rather than the instance — all five user references Phase 11 adds are like
--     this, and there is no sixth.
--
--  2. `cost_cents` / `sell_cents` carry CHECK CONSTRAINTS binding them to
--     `quantity × unit_*`. §30.1 declares the four columns and no relationship
--     between them. Packet finding 5: the header feeds computeProjectSummary and an
--     invoice line, so neither denormalisation is one this product can afford to
--     let drift, and this one can be enforced by the database against every future
--     writer including one that never read this file.
--
--  3. `approval_evidence_file_id` and `invoice_id` take `on delete restrict`
--     rather than the unstated default. A docket photograph is the one file whose
--     loss makes the record worthless — the reasoning 0044 gave a signature — and
--     a variation whose invoice vanished would read as unbilled work.
--
--  4. Two columns §30.1 does not have: `revision` and `client_id`, for the Phase 7
--     sync contract. A variation is field-captured — Femi raises one on a phone
--     with the client standing next to him — so it is the second table in the
--     product under decision #22, after project_activities.

create table if not exists variations (
  id uuid primary key default gen_random_uuid(),

  -- `restrict` rather than §30.1's `cascade`, and for the same reason 0043 and
  -- 0044 chose it: this row can be cited by an invoice_items row on a document a
  -- client has received, and DELETE /v1/projects/:id would otherwise erase the
  -- agreement behind a line on it. The route refuses first with a sentence naming
  -- what stands in the way (see projects/routes.ts).
  project_id uuid not null references projects(id) on delete restrict,

  -- WHOSE ROW IT IS, which on a subcontractor's job is not the project owner.
  -- §30.1 gives no `on delete` and neither does this: a company is closed rather
  -- than deleted (0022), so there is nothing for a cascade to do.
  company_id uuid not null references companies(id),
  engagement_id uuid references engagements(id),

  reference text,
  description text not null check (length(btrim(description)) > 0),
  reason text,

  -- The client-side person who ASKED. Text and not a foreign key, for the reason
  -- client_signoffs.signer_name is text: Dana is standing next to a supervisor,
  -- has no membership and frequently no login, and this is EVIDENCE ABOUT HER
  -- rather than identity for her (packet finding 11).
  requested_by text,
  requested_on date not null,

  status text not null default 'DRAFT' check (status in
    ('DRAFT','SUBMITTED','APPROVED','REJECTED','COMPLETED','INVOICED')),

  -- The header totals. Recomputed inside every transaction that touches a line —
  -- the way recalculateInvoiceTotals already does — and NEVER accepted from a
  -- caller: `updateVariationSchema` has no field for them, so a client sending
  -- `sellTotalCents` has it ignored rather than honoured.
  --
  -- A CHECK cannot aggregate, so unlike the line identity below this one cannot be
  -- pushed into the database; the acceptance script asserts the two agree, because
  -- a drift here is money on an invoice.
  sell_total_cents int not null default 0 check (sell_total_cents >= 0),
  cost_total_cents int not null default 0 check (cost_total_cents >= 0),

  -- ── The client's agreement, and why it is not required ────────────────────
  --
  -- Packet §3. Approval WITHOUT these is permitted, because requiring them would
  -- refuse the commonest real sequence — the client says yes on the phone on
  -- Tuesday and sends the paperwork on Friday, and the crew works on Wednesday.
  -- It is never silent: every response carries `clientApprovalRecorded`, which is
  -- `client_approved_by is not null`, and the panel badges it.
  client_approved_by text,
  client_approved_at timestamptz,

  -- The photograph of the signed docket. `restrict` for the reason a signature
  -- takes it. Joins FILE_ACCESS_GRANTS so the parties to the variation can read
  -- it, and FILE_CLIENT_DISCLOSURES only once the variation is APPROVED — the
  -- client may see the docket they signed, which is narrower than publishing the
  -- photograph to them generally.
  approval_evidence_file_id uuid references stored_files(id) on delete restrict,

  reviewed_by_user_id uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  reject_reason text,

  -- Set ONLY by the transaction that creates the invoice line. There is no route
  -- to it and no actor a caller could name — see VARIATION_TRANSITIONS, where the
  -- two transitions into INVOICED carry actor 'SYSTEM'.
  invoice_id uuid references invoices(id) on delete restrict,

  -- Departure 4: the sync contract (0029, decision #22).
  revision int not null default 1 check (revision > 0),
  client_id uuid,

  created_by_user_id uuid references users(id) on delete set null,
  updated_by_user_id uuid references users(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A rejection with no reason is a message nobody can act on (§3.4's rule for a
  -- timesheet, and it matters more here: the person who must re-price is on a
  -- different site, possibly in a different company).
  constraint variations_reject_reason
    check (status <> 'REJECTED' or (reject_reason is not null and length(btrim(reject_reason)) > 0)),

  -- An invoice id and the INVOICED state are one fact. Either both or neither —
  -- otherwise "is this billed?" has two answers, which is the defect the whole
  -- money boundary was written against.
  constraint variations_invoiced_pairing
    check ((status = 'INVOICED') = (invoice_id is not null)),

  -- The client's agreement is a pair. A date with no name is unattributable and a
  -- name with no date cannot be placed in the sequence of events.
  constraint variations_client_approval_pairing
    check ((client_approved_by is null) = (client_approved_at is null))
);

comment on table variations is
  'Variations / extra works (§30.1). The status machine mirrors §3.4 deliberately; lines and prices are editable in DRAFT and REJECTED only, because from APPROVED onward the totals are what a named person outside the tenancy agreed (commercial-operations.md finding 4).';
comment on column variations.company_id is
  'Whose row it is — the company that RAISED the variation, which on a subcontractor''s job is not the project owner.';
comment on column variations.requested_by is
  'The client-side person who asked. Text rather than a foreign key: this is evidence about somebody outside the tenancy, not identity for them.';
comment on column variations.sell_total_cents is
  'Recomputed from the lines inside every writing transaction and never accepted from a caller. A CHECK cannot aggregate, so the acceptance script asserts header = sum(lines).';
comment on column variations.invoice_id is
  'Set only by the transaction that creates the invoice line. There is no route to it.';

create index if not exists variations_project_idx
  on variations (project_id, requested_on desc) where deleted_at is null;
create index if not exists variations_company_idx
  on variations (company_id, status) where deleted_at is null;
-- The approver's queue: SUBMITTED rows across a company's projects.
create index if not exists variations_status_idx
  on variations (status, created_at desc) where deleted_at is null and status = 'SUBMITTED';
create index if not exists variations_invoice_idx
  on variations (invoice_id) where invoice_id is not null;
create index if not exists variations_file_idx
  on variations (approval_evidence_file_id) where approval_evidence_file_id is not null;
-- A replayed capture must find its own row rather than mint a second variation.
-- Carries `deleted_at is null` like every Phase 7 index learned to: a tombstoned
-- draft must not permanently reserve its client id.
create unique index if not exists variations_client_id_idx
  on variations (project_id, client_id) where client_id is not null and deleted_at is null;

-- ── Lines ────────────────────────────────────────────────────────────────────

create table if not exists variation_lines (
  id uuid primary key default gen_random_uuid(),
  variation_id uuid not null references variations(id) on delete cascade,

  kind text not null check (kind in
    ('LABOUR','VEHICLE','MATERIAL','WASTE','SUBCONTRACTOR','OTHER')),
  description text not null check (length(btrim(description)) > 0),

  quantity numeric(12,2) not null default 1 check (quantity >= 0),
  unit_cost_cents int not null default 0 check (unit_cost_cents >= 0),
  unit_sell_cents int not null default 0 check (unit_sell_cents >= 0),
  cost_cents int not null default 0,
  sell_cents int not null default 0,

  -- LABOUR lines price off the rate engine (§30.1). `role_id` is what a card is
  -- resolved against, and `shift_type` is what a LABEL is resolved against —
  -- without the second there is no rate to resolve, which is the same finding
  -- schedule_assignments records (packet finding 6). Kept on the line so a reader
  -- a year later can see which card the price came from.
  role_id uuid references role_catalog(id),
  shift_type text check (shift_type in ('WEEKDAY_DAY','NIGHT','SUNDAY','SHIFT','DAILY')),
  -- Where the prices came from, so the panel does not have to re-resolve a rate to
  -- find out whether one was ever resolved.
  priced_from text not null default 'STATED'
    check (priced_from in ('RATE_ENGINE','STATED','PARTIAL')),

  asset_id uuid references project_assets(id) on delete set null,
  created_at timestamptz not null default now(),

  -- ── PACKET FINDING 5, ENFORCED BY THE DATABASE ────────────────────────────
  --
  -- `cost_cents` and `sell_cents` are derivable from `quantity` and the unit
  -- prices, and §30.1 declares all four with no relationship between them. A
  -- denormalisation the product cannot afford to let drift and CAN express as a
  -- constraint gets one: `round()` on numeric is immutable, so this is a legal
  -- CHECK, it is exact, and it holds against a writer that never read this file.
  --
  -- The API's `lineTotalCents` does this arithmetic in integer hundredths for
  -- exactly this reason — see its header. `Math.round(quantity * unitCents)`
  -- disagrees with Postgres at the half-cent boundary (0.29 × 50 is 14.50, which
  -- IEEE 754 computes as 14.499999999999998), and the disagreement surfaces here
  -- as a 23514 refusing a write on a line somebody typed perfectly.
  constraint variation_lines_cost_identity
    check (cost_cents = round(quantity * unit_cost_cents)),
  constraint variation_lines_sell_identity
    check (sell_cents = round(quantity * unit_sell_cents))
);

comment on table variation_lines is
  'One priced line of a variation (§30.1). The two total columns are bound to quantity × unit by CHECK constraints — see commercial-operations.md finding 5.';
comment on column variation_lines.shift_type is
  'Required to resolve a rate LABEL for a LABOUR line. Without it there is no rate, and deriving one from a clock would put a rate rule back in code (owner decision, 2026-08-17).';
comment on column variation_lines.priced_from is
  'RATE_ENGINE when the unit prices were resolved from PAY/BILL cards, STATED when somebody typed them, PARTIAL when only one side resolved.';

create index if not exists variation_lines_variation_idx
  on variation_lines (variation_id, created_at);
create index if not exists variation_lines_role_idx
  on variation_lines (role_id) where role_id is not null;
create index if not exists variation_lines_asset_idx
  on variation_lines (asset_id) where asset_id is not null;

-- ── The Phase 6 hook, now that the domain exists ─────────────────────────────
--
-- PROGRESS, 2026-08-17, under the invoice foundation: "Phase 11 hook: approved
-- variation lines join this same source builder when the variations domain exists;
-- no variation table or calculation exists yet to duplicate here."
--
-- This is that hook. `invoice_items.source_type` gains VARIATION, and the paired
-- constraint that made TIME_LOG and EXPENSE require a source id is widened rather
-- than rewritten — a variation line without its variation is a manual line
-- wearing a label.
--
-- Postgres has no `alter constraint`, so both are dropped and recreated.
--
-- ── AND THE NAMES ARE THE TRAP, WHICH IS WHY THEY ARE VERIFIED HERE ────────
--
-- 0008 declared its two table-level checks ANONYMOUSLY, so Postgres generated the
-- names: `invoice_items_check` is the AMOUNT IDENTITY (`amount_cents = round(...)`)
-- and `invoice_items_check1` is the source pairing. The obvious guess is the other
-- way round, and the first draft of this migration dropped
-- `invoice_items_source_type_check` and `invoice_items_check` — which would have
-- silently removed the guard that keeps an invoice line's total equal to its
-- quantity times its unit price, on a table whose rows are sent to clients.
--
-- Nothing would have failed. No test asserts that constraint by name, the
-- migration would have applied cleanly, and the loss would have surfaced years
-- later as one invoice that did not add up.
--
-- So the pairing is dropped by its real generated name, and the amount identity is
-- RE-DECLARED WITH A NAME OF ITS OWN rather than left to the next person to guess
-- at. `if exists` on both drops keeps this idempotent and keeps it correct on a
-- database where an earlier run already renamed them.
alter table invoice_items drop constraint if exists invoice_items_source_type_check;
alter table invoice_items add constraint invoice_items_source_type_check
  check (source_type in ('TIME_LOG','EXPENSE','MANUAL','VARIATION'));

alter table invoice_items drop constraint if exists invoice_items_check1;
alter table invoice_items drop constraint if exists invoice_items_source_pairing;
alter table invoice_items add constraint invoice_items_source_pairing
  check ((source_type in ('TIME_LOG','EXPENSE','VARIATION') and source_id is not null)
      or (source_type = 'MANUAL' and source_id is null));

-- The amount identity, given the name it should have had in 0008. Dropped and
-- re-added rather than left alone so that `invoice_items_check` stops being a name
-- anybody has to look up — the constraint itself is byte-for-byte what 0008
-- declared.
alter table invoice_items drop constraint if exists invoice_items_check;
alter table invoice_items drop constraint if exists invoice_items_amount_identity;
alter table invoice_items add constraint invoice_items_amount_identity
  check (amount_cents = round(quantity * unit_amount_cents));

comment on column invoice_items.source_type is
  'TIME_LOG and EXPENSE derive from approved work; VARIATION from an approved variation (Phase 11, §30.1); MANUAL is typed and carries no source id.';

-- ── Entitlements (§43) ───────────────────────────────────────────────────────

insert into features (key, name, description, category) values
  ('variations', 'Variations & extra works',
   'Price, submit and approve extra works, and feed approved variations into project revenue and invoices',
   'commercial')
on conflict (key) do nothing;

-- §43's proposed placement, taken EXACTLY this time — Starter and up. The fourth
-- time this entry has appeared and the first with no departure: client_signoff was
-- moved a tier down with a stated reason and the storage figures were kept as a
-- pricing judgement, and neither applies here. Variations are an operating feature
-- rather than a publishing one, they cost nothing marginal to serve, and Starter is
-- described as "run your own subcontractors" — which is exactly who has extra
-- works.
--
-- AND 0033's NOTE TRANSFERS UNCHANGED: THIS INSERT IS NOT THE AUTHORITY.
-- infra/seed deletes and rebuilds plan_features to match itself, so a placement
-- granted only here is silently revoked by the next seed run. What this is for is
-- an already-migrated deployment.
--
-- The `select … from plans` shape rather than a literal VALUES list is the fix
-- recorded in PROGRESS for 0027: on a genuinely fresh database `plans` is empty
-- until `db:seed`, and a literal insert violates the foreign key and stops the
-- whole migration run. This yields no rows instead.
insert into plan_features (plan_id, feature_key)
select p.id, 'variations' from plans p
where p.id in ('starter', 'pro', 'business', 'enterprise')
on conflict do nothing;
