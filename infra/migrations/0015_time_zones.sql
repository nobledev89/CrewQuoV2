-- 0015_time_zones.sql
-- Company and project IANA time zones (CREWQUO_V2_PLAN.md 42).
-- Operating-model packet: docs/operating-model/time.md
--
-- An instant is a point in time; a date is a human's answer to "which day was
-- that". CrewQuo already stores both correctly - `timestamptz` for instants,
-- `date` for days, with `work_date` asserted by the person who did the work
-- rather than derived from when they pressed the button. What it never had was
-- an answer to WHOSE DAY IT IS when the server has to decide for itself.
--
-- The bug this migration exists for: `todayIso()` returned the server's UTC
-- date, and retroactive rate approval keyed off it. In Manila (UTC+8) before
-- 08:00 local the server is still on yesterday, so a back-dated schedule passed
-- as current - the safeguard silently off for a third of every day. In Los
-- Angeles (UTC-8) after 16:00 local the server is already on tomorrow, so a rate
-- starting TODAY was judged retroactive and refused.
--
-- THE INVARIANT: changing a zone changes presentation and future bucketing, and
-- never moves a stored instant or a stored date. There is deliberately no
-- backfill below for exactly that reason - every existing company keeps behaving
-- as it does today until somebody chooses otherwise.

alter table companies add column if not exists time_zone text not null default 'UTC';

-- Nullable on purpose: null means "inherit the company", which is a real answer
-- and not a missing one. A project that copied the company's zone at creation
-- would silently stop tracking it, and the far more common intent is "wherever
-- the business is" rather than "wherever it was when I made this project".
alter table projects add column if not exists time_zone text;

-- Validated against the server's own IANA database rather than a regex: a regex
-- would happily accept `Not/AZone`, which then fails at `AT TIME ZONE` inside a
-- business transaction. `pg_timezone_names` is the same list Postgres itself
-- resolves against, so anything that passes here is guaranteed usable later.
--
-- NOT VALID is deliberate. Some deployments carry rows this predates, and a
-- table rewrite on `companies` during a deploy is a worse outcome than a
-- constraint that governs every future write and can be validated separately
-- once the data is known clean.
create or replace function is_iana_time_zone(candidate text) returns boolean as $$
  select candidate is null
      or exists (select 1 from pg_timezone_names where name = candidate);
$$ language sql stable;

alter table companies drop constraint if exists companies_time_zone_valid;
alter table companies add constraint companies_time_zone_valid
  check (is_iana_time_zone(time_zone)) not valid;

alter table projects drop constraint if exists projects_time_zone_valid;
alter table projects add constraint projects_time_zone_valid
  check (is_iana_time_zone(time_zone)) not valid;

comment on column companies.time_zone is
  'IANA zone deciding what "today" means for this business. Changing it never moves a stored instant or date.';
comment on column projects.time_zone is
  'IANA zone for work that happens somewhere other than the office. Null inherits companies.time_zone.';
