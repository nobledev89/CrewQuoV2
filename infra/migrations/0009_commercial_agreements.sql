-- 0009_commercial_agreements.sql
-- Phase 6 commercial-agreement hardening (CREWQUO_V2_PLAN.md §3.3.1, §36, §42;
-- decision #23). The operating-model packet for this domain, written before this
-- migration, is docs/operating-model/commercial-agreements.md.
--
-- Three things land here:
--   1. `record_revisions` (§36) — before/after values on commercial records. This
--      domain is the first to need it ("approved time and rates ★" on §36's list).
--   2. `rate_proposals` + `rate_proposal_lines` — the negotiation surface. Pending
--      numbers never enter `rate_cards`; that table stays the authoritative,
--      approved resolution surface.
--   3. Versioning and immutability on `rate_cards`, engagement commercial terms,
--      and acceptance state on engagements and assignments.

-- ── §36 record revisions ──────────────────────────────────────────────────────
-- Shape is §36's verbatim. `company_id` is whose record changed, which is not
-- always the actor's company: a provider submitting a proposal changes a record
-- the provider owns, while an approval changes rate cards the hiring company owns.

create table if not exists record_revisions (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  entity_type       text not null,
  entity_id         uuid not null,
  revision          integer not null,
  action            text not null check (action in ('CREATE','UPDATE','DELETE')),
  before            jsonb,
  after             jsonb,
  changed_fields    text[] not null default '{}',
  reason            text,
  changed_by_user_id uuid references users(id),
  changed_at        timestamptz not null default now(),
  unique (entity_type, entity_id, revision)
);
create index if not exists record_revisions_entity_idx
  on record_revisions (entity_type, entity_id, revision desc);
create index if not exists record_revisions_company_idx
  on record_revisions (company_id, changed_at desc);

-- ── Rate proposals (§3.3.1) ───────────────────────────────────────────────────
-- One header per atomic schedule revision for one direct engagement. The provider
-- proposes; the hiring (client) side of the edge decides. `proposed_by_company_id`
-- is stored rather than derived so a later merge that re-points the engagement
-- cannot silently change who authored a decided proposal.

create table if not exists rate_proposals (
  id                      uuid primary key default gen_random_uuid(),
  engagement_id           uuid not null references engagements(id),
  proposed_by_company_id  uuid not null references companies(id),
  currency                text not null check (currency ~ '^[A-Z]{3}$'),
  effective_from          date not null,
  status                  text not null default 'DRAFT'
                            check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED','WITHDRAWN')),
  -- The proposal this one supersedes. Rejection is terminal, so a corrected
  -- schedule is a *new* row pointing back at what it replaces (§3.3.1).
  predecessor_proposal_id uuid references rate_proposals(id),
  note                    text,
  created_by_user_id      uuid references users(id),
  submitted_by_user_id    uuid references users(id),
  submitted_at            timestamptz,
  reviewed_by_user_id     uuid references users(id),
  reviewed_at             timestamptz,
  decision_reason         text,
  -- Set only when an OWNER approved a schedule whose effective date had already
  -- passed. Non-null is the evidence that the default refusal was overridden.
  retroactive_reason      text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- A DRAFT has not been submitted; everything past DRAFT has. WITHDRAWN is
  -- reachable only from SUBMITTED — a draft the other side never saw is deleted,
  -- not withdrawn, so there is no state here with a null `submitted_at`.
  check ((status = 'DRAFT') = (submitted_at is null)),
  -- APPROVED/REJECTED carry a decision; DRAFT/SUBMITTED/WITHDRAWN do not.
  check ((status in ('APPROVED','REJECTED')) = (reviewed_at is not null)),
  -- A rejection without a reason leaves the provider nothing to correct (§3.3.1).
  check (status <> 'REJECTED' or length(btrim(coalesce(decision_reason, ''))) > 0),
  check (status = 'APPROVED' or retroactive_reason is null),
  check (id <> predecessor_proposal_id)
);

-- At most one live negotiation per edge. Two open proposals would make "what are
-- we currently arguing about" ambiguous, and whichever approved second would
-- silently win.
create unique index if not exists rate_proposals_one_open_per_engagement
  on rate_proposals (engagement_id)
  where status in ('DRAFT','SUBMITTED');
create index if not exists rate_proposals_engagement_idx
  on rate_proposals (engagement_id, created_at desc);
create index if not exists rate_proposals_status_idx on rate_proposals (status);
create unique index if not exists rate_proposals_predecessor_uq
  on rate_proposals (predecessor_proposal_id)
  where predecessor_proposal_id is not null;

-- Lines are immutable once the header leaves DRAFT — enforced by the trigger
-- below, not only by the API, because "submission freezes the payload" is the one
-- guarantee that makes the reviewer's approval mean what it says.
create table if not exists rate_proposal_lines (
  id                    uuid primary key default gen_random_uuid(),
  proposal_id           uuid not null references rate_proposals(id) on delete cascade,
  operation             text not null check (operation in ('CREATE','REPLACE','END')),
  role_id               uuid not null references role_catalog(id),
  rate_label            text not null check (rate_label in
                          ('MON_FRI_DAY','FRI_SAT_NIGHT','MON_THU_NIGHT','SUNDAY','SHIFT','DAILY')),
  rate_mode             text not null check (rate_mode in ('HOURLY','SHIFT','DAILY')),
  hourly_rate_cents     integer check (hourly_rate_cents >= 0),
  ot_hourly_rate_cents  integer check (ot_hourly_rate_cents >= 0),
  shift_rate_cents      integer check (shift_rate_cents >= 0),
  daily_rate_cents      integer check (daily_rate_cents >= 0),
  min_hours             numeric(6,2) check (min_hours >= 0),
  weekend_multiplier    numeric(6,3) check (weekend_multiplier > 0),
  night_multiplier      numeric(6,3) check (night_multiplier > 0),
  -- REPLACE/END name the approved card version they supersede; CREATE must not.
  replaces_rate_card_id uuid references rate_cards(id),
  created_at            timestamptz not null default now(),
  check ((operation in ('REPLACE','END')) = (replaces_rate_card_id is not null)),
  -- The mode dictates which amount is mandatory (§6 extractRate). An END line
  -- carries no amount at all — it closes a window rather than pricing one.
  check (
    operation = 'END'
    or (rate_mode = 'HOURLY' and hourly_rate_cents is not null)
    or (rate_mode = 'SHIFT'  and shift_rate_cents  is not null)
    or (rate_mode = 'DAILY'  and daily_rate_cents  is not null)
  ),
  -- Two lines pricing the same (role, label) in one schedule would let insertion
  -- order decide the rate. Rejected at the edge and here.
  unique (proposal_id, role_id, rate_label)
);
create index if not exists rate_proposal_lines_proposal_idx
  on rate_proposal_lines (proposal_id, created_at);

-- ── Approved rate-card versions (§3.3, §3.3.1) ────────────────────────────────
-- `currency` is nullable on purpose: existing cards inherit `companies.currency`
-- (§3.3), and only cards written by an approved agreement carry their own. The
-- money-boundary work later in Phase 6 is what makes an *unlike* currency usable;
-- until then the API refuses one, so this column records the agreement's unit
-- rather than enabling FX.

alter table rate_cards add column if not exists currency text;
alter table rate_cards add column if not exists source_proposal_id uuid references rate_proposals(id);
alter table rate_cards add column if not exists supersedes_rate_card_id uuid references rate_cards(id);
alter table rate_cards add column if not exists version integer not null default 1;
alter table rate_cards add column if not exists locked boolean not null default false;
alter table rate_cards add column if not exists created_by_user_id uuid references users(id);
alter table rate_cards add column if not exists updated_by_user_id uuid references users(id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rate_cards_currency_format') then
    alter table rate_cards add constraint rate_cards_currency_format
      check (currency is null or currency ~ '^[A-Z]{3}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rate_cards_version_positive') then
    alter table rate_cards add constraint rate_cards_version_positive check (version >= 1);
  end if;
  -- A proposal-sourced card is always locked. Direct entry is also locked
  -- (§3.3.1: it "creates the same immutable approved versions, not a mutable
  -- shortcut"), so the implication runs one way only.
  if not exists (select 1 from pg_constraint where conname = 'rate_cards_sourced_is_locked') then
    alter table rate_cards add constraint rate_cards_sourced_is_locked
      check (source_proposal_id is null or locked);
  end if;
end $$;

create index if not exists rate_cards_source_proposal_idx
  on rate_cards (source_proposal_id) where source_proposal_id is not null;
create index if not exists rate_cards_supersedes_idx
  on rate_cards (supersedes_rate_card_id) where supersedes_rate_card_id is not null;

-- Nothing is backfilled. Every existing card predates the agreement workflow, so
-- it is version 1, unlocked, currency-inheriting and sourced from no proposal —
-- which is exactly what the defaults above already say. Locking historical cards
-- would retroactively freeze rates their owners are still entitled to edit by
-- hand, which is not this migration's decision to make.

-- ── Immutability ──────────────────────────────────────────────────────────────
-- Route logic is not enough for "immutable". A locked card is an approved
-- commercial fact; the only mutation the workflow itself needs is closing the
-- effective window when a successor version supersedes it, plus deactivation.
-- Everything else — amounts, role, label, mode, kind, counterparty, currency,
-- effective_from, provenance — is refused by the database, so a later `PATCH`
-- route added in good faith cannot quietly rewrite money that has been agreed.

create or replace function rate_cards_guard_locked() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.locked then
      raise exception
        'rate card % is an approved immutable version and cannot be deleted', old.id
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if old.locked and (
       new.company_id              is distinct from old.company_id
    or new.kind                    is distinct from old.kind
    or new.counterparty_company_id is distinct from old.counterparty_company_id
    or new.role_id                 is distinct from old.role_id
    or new.rate_mode               is distinct from old.rate_mode
    or new.rate_label              is distinct from old.rate_label
    or new.hourly_rate_cents       is distinct from old.hourly_rate_cents
    or new.ot_hourly_rate_cents    is distinct from old.ot_hourly_rate_cents
    or new.shift_rate_cents        is distinct from old.shift_rate_cents
    or new.daily_rate_cents        is distinct from old.daily_rate_cents
    or new.min_hours               is distinct from old.min_hours
    or new.weekend_multiplier      is distinct from old.weekend_multiplier
    or new.night_multiplier        is distinct from old.night_multiplier
    or new.effective_from          is distinct from old.effective_from
    or new.currency                is distinct from old.currency
    or new.version                 is distinct from old.version
    or new.locked                  is distinct from old.locked
    or new.source_proposal_id      is distinct from old.source_proposal_id
    or new.supersedes_rate_card_id is distinct from old.supersedes_rate_card_id
  ) then
    raise exception
      'rate card % is an approved immutable version; only effective_to and active may change', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

drop trigger if exists rate_cards_guard_locked_trg on rate_cards;
create trigger rate_cards_guard_locked_trg
  before update or delete on rate_cards
  for each row execute function rate_cards_guard_locked();

-- Submitted proposal lines are frozen the same way, for the same reason: the
-- reviewer must be approving the numbers the provider submitted.
create or replace function rate_proposal_lines_guard_frozen() returns trigger
language plpgsql as $$
declare
  header_status text;
  target_id uuid;
begin
  if tg_op = 'DELETE' then
    target_id := old.proposal_id;
  else
    target_id := new.proposal_id;
  end if;

  select status into header_status from rate_proposals where id = target_id;
  -- A null header means the parent row is already gone inside this transaction —
  -- this is the ON DELETE CASCADE from deleting a draft, not an edit.
  if header_status is not null and header_status <> 'DRAFT' then
    raise exception
      'proposal % is % and its lines are frozen', target_id, header_status
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists rate_proposal_lines_guard_frozen_trg on rate_proposal_lines;
create trigger rate_proposal_lines_guard_frozen_trg
  before insert or update or delete on rate_proposal_lines
  for each row execute function rate_proposal_lines_guard_frozen();

-- ── Engagement commercial terms + acceptance ──────────────────────────────────
-- Payment terms and the PO reference/ceiling belong to the edge, not the project:
-- they are what the two companies agreed, and every project on that edge inherits
-- them. `purchase_order_ceiling_cents` is bigint because a ceiling is a contract
-- value, not a line amount, and integer cents runs out at ~$21m.

alter table engagements add column if not exists payment_terms_days integer;
alter table engagements add column if not exists purchase_order_reference text;
alter table engagements add column if not exists purchase_order_ceiling_cents bigint;
alter table engagements add column if not exists terms_updated_at timestamptz;
alter table engagements add column if not exists provider_accepted_at timestamptz;
alter table engagements add column if not exists provider_accepted_by_user_id uuid references users(id);
alter table engagements add column if not exists decision_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'engagements_payment_terms_range') then
    alter table engagements add constraint engagements_payment_terms_range
      check (payment_terms_days is null or payment_terms_days between 0 and 365);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'engagements_po_ceiling_positive') then
    alter table engagements add constraint engagements_po_ceiling_positive
      check (purchase_order_ceiling_cents is null or purchase_order_ceiling_cents >= 0);
  end if;
end $$;

-- Existing ACTIVE edges are treated as already accepted. They are: every one of
-- them either went through an invite accept, or was created by a hiring company
-- under the old "direct create is immediately ACTIVE" behaviour that this phase
-- replaces. Leaving them un-accepted would present live engagements as pending
-- decisions nobody asked for.
update engagements
   set provider_accepted_at = coalesce(provider_accepted_at, updated_at)
 where status = 'ACTIVE' and provider_accepted_at is null;

-- ── Assignment acceptance ─────────────────────────────────────────────────────
-- Recorded and surfaced; deliberately NOT a gate on work capture. See §9 of the
-- operating-model packet: gating it would stop a crew logging hours they had
-- already worked, hours after a decision made by a different company.

alter table project_assignments add column if not exists acceptance text;
alter table project_assignments add column if not exists accepted_at timestamptz;
alter table project_assignments add column if not exists accepted_by_user_id uuid references users(id);
alter table project_assignments add column if not exists decision_reason text;

-- Backfill before the constraint, so existing rows are valid under it. An
-- assignment that predates acceptance is ACCEPTED, not PENDING: the provider has
-- in many cases already logged and been paid for work on it, and calling that
-- "awaiting acceptance" would be a false statement about the past.
update project_assignments
   set acceptance = coalesce(acceptance, 'ACCEPTED'),
       accepted_at = coalesce(accepted_at, created_at)
 where acceptance is null;

alter table project_assignments alter column acceptance set default 'PENDING';
alter table project_assignments alter column acceptance set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_assignments_acceptance_values') then
    alter table project_assignments add constraint project_assignments_acceptance_values
      check (acceptance in ('PENDING','ACCEPTED','DECLINED'));
  end if;
  -- `accepted_at` means what it says: when the provider *accepted*. A DECLINED
  -- assignment has no accepted_at either, so the invariant keys on ACCEPTED rather
  -- than on "not PENDING". When a decline happened is carried by `updated_at` and
  -- by the audit row; inventing an `accepted_at` for it would make the column lie.
  if not exists (select 1 from pg_constraint where conname = 'project_assignments_accepted_stamp') then
    alter table project_assignments add constraint project_assignments_accepted_stamp
      check ((acceptance = 'ACCEPTED') = (accepted_at is not null));
  end if;
end $$;
