-- 0011_company_creation_safeguard.sql
-- Company ownership & creation safeguard (CREWQUO_V2_PLAN.md §3.1.1, §41 decision 31).
-- Operating-model packet: docs/operating-model/company-creation.md
--
-- Multiple *memberships* stay unlimited; creating a *tenant* does not. Four
-- things land here:
--   1. `companies.country` / `.registration_id` — the legal identity a duplicate
--      check can be answered against years later.
--   2. `company_creation_allowances` — one permanently ledgered automatic first
--      company per user. Presence of the row means "consumed"; it is never removed.
--   3. `company_creation_requests` — the additional-company state machine
--      (PENDING_CHECKOUT | PENDING_REVIEW | APPROVED | REJECTED | EXPIRED | CONSUMED).
--   4. `trial_grants` — trial eligibility ledgered against the owning identity
--      rather than the tenant, so a new company is not a new trial.
--
-- The backfill at the bottom fails *safe*: every existing owner of a real company
-- is recorded as having consumed the allowance, so no live customer silently gains
-- a free second tenant and none loses a company they already have.

-- ── 1. Legal identity on companies (§3.1.1(6)) ────────────────────────────────
-- Nullable because every company that exists today has neither, and because not
-- every jurisdiction/entity has a registration identifier at all. The normalised
-- column is generated so the value compared can never drift from the value shown.

alter table companies add column if not exists country text;
alter table companies add column if not exists registration_id text;

alter table companies
  add column if not exists registration_id_normalized text
  generated always as (
    nullif(upper(regexp_replace(coalesce(registration_id, ''), '[^A-Za-z0-9]', '', 'g')), '')
  ) stored;

alter table companies drop constraint if exists companies_country_alpha2;
alter table companies add constraint companies_country_alpha2
  check (country is null or country ~ '^[A-Z]{2}$');

-- Deliberately NOT unique. §3.1.1(6) routes a duplicate to invitation, ownership
-- recovery or support; a unique index would make legitimate recovery impossible
-- and would turn a support case into a database error.
create index if not exists companies_registration_identity_idx
  on companies (country, registration_id_normalized)
  where registration_id_normalized is not null and not is_placeholder;

-- ── 2. The automatic first-company allowance ──────────────────────────────────
-- `user_id` is the primary key on purpose: the insert itself is the concurrency
-- control, so two simultaneous first-company creates cannot both succeed without
-- a lock, a transaction level or a read-then-write.

create table if not exists company_creation_allowances (
  user_id         uuid primary key references users(id) on delete cascade,
  company_id      uuid references companies(id) on delete set null,
  source          text not null check (source in ('REGISTRATION', 'SELF_SERVE', 'BACKFILL')),
  idempotency_key text,
  consumed_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- `on delete set null` above, not `cascade`: deleting the company must not delete
-- the ledger row, or deletion would restore the allowance — the precise loophole
-- §3.1.1(1) closes.
create index if not exists company_creation_allowances_company_idx
  on company_creation_allowances (company_id);

-- ── 3. Additional-company requests ────────────────────────────────────────────

create table if not exists company_creation_requests (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(id) on delete cascade,
  status                  text not null check (status in
                            ('PENDING_CHECKOUT', 'PENDING_REVIEW', 'APPROVED',
                             'REJECTED', 'EXPIRED', 'CONSUMED')),

  -- the declared business (§3.1.1(2))
  legal_name              text not null,
  display_name            text not null,
  country                 text not null,
  registration_id         text,
  registration_id_normalized text generated always as (
    nullif(upper(regexp_replace(coalesce(registration_id, ''), '[^A-Za-z0-9]', '', 'g')), '')
  ) stored,
  intended_plan_id        text references plans(id),
  requested_currency      text not null,
  attestation_text        text not null,
  attested_at             timestamptz not null,

  -- routing and decision
  approval_route          text not null check (approval_route in ('CHECKOUT', 'ADMIN')),
  checkout_reference      text,
  decided_by_user_id      uuid references users(id) on delete set null,
  decided_at              timestamptz,
  decision_reason         text,
  expires_at              timestamptz not null,

  -- consumption
  company_id              uuid references companies(id) on delete set null,
  consumed_at             timestamptz,
  idempotency_key         text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint company_creation_requests_country_alpha2
    check (country ~ '^[A-Z]{2}$'),
  -- A rejection with no reason is indistinguishable from a mistake later. Same
  -- rule the rate-proposal reviewer works under (§3.3.1).
  constraint company_creation_requests_rejection_reason
    check (status <> 'REJECTED' or (decision_reason is not null and length(trim(decision_reason)) > 0)),
  -- CONSUMED means a company exists. Nothing else may claim one.
  constraint company_creation_requests_consumption
    check ((status = 'CONSUMED') = (consumed_at is not null)
       and (status = 'CONSUMED') = (company_id is not null)),
  constraint company_creation_requests_decision
    check (status not in ('APPROVED', 'REJECTED') or decided_at is not null)
);

-- One live claim per user. Two open requests would make "what am I waiting on"
-- and "what may I create" ambiguous, and an approved-but-unconsumed second one
-- would be a spare tenant sitting in a drawer.
create unique index if not exists company_creation_requests_one_open_per_user
  on company_creation_requests (user_id)
  where status in ('PENDING_CHECKOUT', 'PENDING_REVIEW', 'APPROVED');

create index if not exists company_creation_requests_user_idx
  on company_creation_requests (user_id, created_at desc);
create index if not exists company_creation_requests_queue_idx
  on company_creation_requests (status, created_at)
  where status in ('PENDING_CHECKOUT', 'PENDING_REVIEW');
create index if not exists company_creation_requests_identity_idx
  on company_creation_requests (country, registration_id_normalized)
  where registration_id_normalized is not null;
create index if not exists company_creation_requests_idempotency_idx
  on company_creation_requests (user_id, idempotency_key)
  where idempotency_key is not null;

-- ── 4. Trial eligibility ledger (§3.1.1(5)) ───────────────────────────────────
-- Keyed to the *owning identity*, not the tenant, so archiving a company and
-- making another cannot produce a second automatic trial. Deliberately not
-- unique: a repeat grant is a legitimate, audited support decision, and refusing
-- it in the database would leave support with no lever but an entitlement
-- override, which is not the same record.

create table if not exists trial_grants (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete cascade,
  company_id           uuid not null references companies(id) on delete cascade,
  plan_id              text not null references plans(id),
  days                 integer not null check (days > 0),
  source               text not null check (source in ('ADMIN_COMP', 'CHECKOUT', 'SIGNUP', 'BACKFILL')),
  is_repeat            boolean not null default false,
  reason               text,
  granted_by_user_id   uuid references users(id) on delete set null,
  -- The stable merchant-of-record customer identity §3.1.1(5) names. Null until
  -- Gumroad lands; reserved now so that arriving is a write, not a migration.
  provider_customer_id text,
  granted_at           timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

create index if not exists trial_grants_user_idx on trial_grants (user_id, granted_at desc);
create index if not exists trial_grants_company_idx on trial_grants (company_id);
create index if not exists trial_grants_provider_customer_idx
  on trial_grants (provider_customer_id) where provider_customer_id is not null;

-- ── 5. Platform settings for this policy ──────────────────────────────────────
-- `requireVerifiedEmail` gates the *automatic* first company on a verified
-- address. It ships **false**: verification links are only logged until Resend
-- arrives (its own Phase 6 bullet), so turning it on today would lock every new
-- signup out of its own company. The additional-company request requires
-- verification unconditionally and does not read this flag — that user has had
-- time. Flipping this to true is the single change needed once mail is delivered.
--
-- `checkoutEnabled` is what routes a paid-plan request to PENDING_CHECKOUT
-- instead of PENDING_REVIEW. False until Gumroad exists.

insert into system_settings (key, value)
values ('platform.company_creation',
        '{"requireVerifiedEmail":false,"checkoutEnabled":false}'::jsonb)
on conflict (key) do nothing;

-- ── 6. Backfill: existing owners have consumed their allowance ────────────────
-- Every user who currently owns a real (non-placeholder, unmerged) company is
-- ledgered against the *earliest* such company. Two deliberate consequences:
--
--   · A user who already owns several companies keeps all of them — this policy
--     is never applied retroactively to something already built — but their
--     allowance is spent, so the *next* one needs an approval.
--   · Where creator identity is ambiguous (a company with several OWNERs, or a
--     company whose original creator has since left), the restrictive answer is
--     taken: each present owner is recorded as having consumed the allowance.
--     §3.1.1 asks this to "fail safely", and safe here means nobody is handed a
--     free tenant by an ambiguity.
--
-- `on conflict do nothing` makes the migration re-runnable and makes a user who
-- somehow already has a row keep the row they have.

insert into company_creation_allowances (user_id, company_id, source, consumed_at)
select distinct on (m.user_id)
       m.user_id,
       c.id,
       'BACKFILL',
       c.created_at
  from memberships m
  join companies c on c.id = m.company_id
 where m.role = 'OWNER'
   and m.status <> 'INVITED'
   and not c.is_placeholder
   and c.claimed_by_company_id is null
 order by m.user_id, c.created_at asc, c.id asc
on conflict (user_id) do nothing;

-- Trials already running are ledgered too, or the first comp after this migration
-- would look like a customer's first trial when it is their second.
insert into trial_grants (user_id, company_id, plan_id, days, source, granted_at)
select m.user_id,
       s.company_id,
       s.plan_id,
       greatest(1, ceil(extract(epoch from (s.trial_end - s.created_at)) / 86400)::int),
       'BACKFILL',
       s.created_at
  from company_subscriptions s
  join memberships m on m.company_id = s.company_id and m.role = 'OWNER' and m.status <> 'INVITED'
 where s.status = 'TRIALING'
   and s.trial_end is not null
   and not exists (select 1 from trial_grants g where g.company_id = s.company_id);
