-- 0013_money_boundary.sql
-- Money boundary (CREWQUO_V2_PLAN.md 3.3 decision #5, 3.4, 3.5, 6, 41.9).
-- Operating-model packet: docs/operating-model/money-boundary.md
--
-- An amount is a number AND a unit. Until now only the number was stored, which
-- is safe exactly as long as every figure in a company shares one unit. Phase 6
-- broke that in two places (0008 invoices, 0009 rate proposals) and both shipped
-- with an outright refusal of anything unlike, because CrewQuo holds no exchange
-- rate and 41 forbids adding unlike units.
--
-- Three things land here, replacing that refusal with a mechanism that still
-- never invents a rate:
--   1. `projects.reporting_currency` - the one unit a project's summary and
--      margin are expressed in, snapshotted from the owner company at creation
--      rather than referenced live, so changing a company currency next year
--      cannot silently restate a project that closed last year.
--   2. `fx_rates` - human-entered, provenance-required, never edited. No rate
--      means no converted figure; the figure is withheld and named.
--   3. Frozen FX snapshots on the records where money commits, so a rate
--      recorded tomorrow cannot move a cost agreed today.

-- 1. Project reporting currency -----------------------------------------------
-- Nullable-then-backfill-then-NOT NULL: every existing project must land on the
-- unit its figures were already being reported in, which is its owner company's
-- currency (apps/api/src/modules/projects/routes.ts read it live).

alter table projects add column if not exists reporting_currency text;

update projects p
   set reporting_currency = c.currency
  from companies c
 where c.id = p.owner_company_id
   and p.reporting_currency is null;

-- A project whose owner row somehow has no currency falls back to the documented
-- platform default rather than blocking the migration.
update projects set reporting_currency = 'USD' where reporting_currency is null;

alter table projects alter column reporting_currency set not null;

alter table projects drop constraint if exists projects_reporting_currency_format;
alter table projects add constraint projects_reporting_currency_format
  check (reporting_currency ~ '^[A-Z]{3}$');

comment on column projects.reporting_currency is
  'The single unit this project''s cost/bill/margin are reported in. Snapshotted from the owner company at creation; immutable once the project holds committed money.';

-- 2. FX rates ------------------------------------------------------------------
-- Company-scoped because a rate is a finance judgement, not a market fact: two
-- companies may legitimately book the same pair differently, and a platform-wide
-- table would make one tenant's arithmetic depend on another's.
--
-- Semantics, stated once and relied on everywhere: ONE UNIT OF `base_currency`
-- IS WORTH `rate` UNITS OF `quote_currency`.
--
-- The rate is used only in its stored direction. Deriving the inverse as 1/rate
-- would look like algebra but is a different number from the market's inverse
-- (spread), and 41.1's rule - never invent a factor - is what makes the strict
-- direction worth the extra row.

create table if not exists fx_rates (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  base_currency   text not null check (base_currency ~ '^[A-Z]{3}$'),
  quote_currency  text not null check (quote_currency ~ '^[A-Z]{3}$'),
  rate            numeric(20,10) not null check (rate > 0),
  as_of           date not null,
  source          text not null check (length(btrim(source)) > 0),
  note            text,
  created_by_user_id uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  check (base_currency <> quote_currency)
);

-- The unique key IS the concurrency control: two people recording the same rate
-- race to the same row rather than creating two competing truths.
create unique index if not exists fx_rates_pair_asof_uq
  on fx_rates (company_id, base_currency, quote_currency, as_of);

-- The lookup every conversion runs: latest as_of on or before the money's date.
create index if not exists fx_rates_lookup_idx
  on fx_rates (company_id, base_currency, quote_currency, as_of desc);

comment on table fx_rates is
  'Human-entered exchange rates with required provenance. One unit of base_currency is worth `rate` units of quote_currency. Never edited - supersede with a later as_of.';

-- There is no UPDATE path in the API, but a later PATCH added in good faith must
-- not be able to restate history behind a frozen snapshot's back. Same argument
-- as the locked rate-card trigger in 0009: the route refuses first with an
-- explanation, and the database refuses regardless.
create or replace function fx_rates_are_immutable() returns trigger as $$
begin
  raise exception 'fx_rates rows are immutable; record a corrected rate at a later as_of'
    using errcode = 'check_violation';
end;
$$ language plpgsql;

drop trigger if exists fx_rates_no_update on fx_rates;
create trigger fx_rates_no_update
  before update on fx_rates
  for each row execute function fx_rates_are_immutable();

-- 3. Frozen FX snapshots -------------------------------------------------------
-- PAY freezes inside `time_logs.resolved_rate` (jsonb, already the frozen §6
-- snapshot) rather than in new columns, so there is no ordering in which a log
-- has a PAY snapshot and no FX snapshot - they are the same write. No DDL is
-- needed for that; the shape is enforced by `resolvedRateSnapshotSchema`.
--
-- Invoices deliberately get NO fx columns. An invoice is denominated in its
-- project's reporting currency and a BILL card declaring a different unit is
-- refused at derivation rather than converted: the BILL rate IS what the client
-- is charged, so converting it would bill them a number nobody agreed. Columns
-- for a conversion that never happens would be an invented shape (§0 rule 3).
