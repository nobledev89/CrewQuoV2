-- 0017_one_currency_per_company.sql
-- Owner decision, 2026-08-19: A COMPANY WORKS IN EXACTLY ONE CURRENCY, AND THE
-- CURRENCY IS A LABEL - something printed in front of an amount.
-- Operating-model packet: docs/operating-model/money-boundary.md
--
-- This reverses most of 0013. That migration built a multi-currency money
-- boundary: human-recorded exchange rates with provenance, per-row currency on
-- rates and invoices, FX citations frozen onto approved work, and a reporting
-- pipeline that withheld any figure it could not convert. It was correct for the
-- problem it was given. The owner has removed the problem.
--
-- WHAT IS KEPT, AND WHY IT IS THE ONLY THING KEPT.
-- `projects.reporting_currency` stays. It is not a second unit - it is a
-- SNAPSHOT of the company's label, taken at project creation and never re-read.
-- `companies.currency` is a live column an owner may change, and without the
-- snapshot, changing it next year would relabel every figure on a project that
-- closed last year: the stored minor units unmoved, the unit in front of them
-- different from the one anybody agreed. A label is harmless until it is
-- retroactive.
--
-- WHAT IS DROPPED. Everything that only made sense when two units could meet:
--   * `fx_rates`, its immutability trigger and its function
--   * `invoices.currency`       - derive from the project's snapshot
--   * `rate_cards.currency`     - always the hiring company's
--   * `rate_proposals.currency` - always the hiring company's
--   * the `fx` key inside `time_logs.resolved_rate`
--
-- ── THE HONEST PART ─────────────────────────────────────────────────────────
--
-- The first version of this migration REFUSED to run if any of those columns
-- disagreed with its owning company, on the principle that a drop must never
-- silently discard a distinction. It refused immediately: 58 rate cards on this
-- database are denominated in GBP for USD companies, with 57 approved time logs
-- priced off them.
--
-- That refusal was the wrong shape, for a reason worth writing down. A guard is
-- only useful if the operator can act on it, and there is NO REPAIR AVAILABLE
-- HERE: "reconcile them first" would mean converting, and conversion is the
-- capability being removed. A migration that can never run is not a safeguard,
-- it is a wall.
--
-- So the distinction is PRESERVED RATHER THAN DEFENDED. Every disagreeing row is
-- copied into `currency_model_change_log` before its column goes, and the
-- migration reports what it moved. Those figures keep their numbers and acquire
-- their company's label - which is precisely what "the currency is a label"
-- means for a row that was previously carrying a different one. Nothing is
-- estimated, nothing is converted, and the previous state stays readable.
--
-- On this database every affected row belongs to a `Meridian Crossborder <run>`
-- company - an end-to-end verification fixture built to exercise the conversion
-- paths this migration deletes. A production database has none, because
-- multi-currency shipped and was withdrawn the same day.

-- ── 1. Preserve what the drops would otherwise discard ──────────────────────
create table if not exists currency_model_change_log (
  id             bigserial primary key,
  -- What kind of row this was, and which one.
  entity_type    text not null check (entity_type in
                   ('RATE_CARD', 'INVOICE', 'RATE_PROPOSAL', 'TIME_LOG')),
  entity_id      uuid not null,
  -- The label the row carried before this migration ran.
  previous_currency text not null,
  -- The label it reads as afterwards - its company's, or its project's.
  effective_currency text not null,
  -- The whole discarded value, for a `resolved_rate` whose `fx` block held a
  -- rate, an as-of date and a source. A citation is evidence; it is archived
  -- rather than deleted even though nothing reads it any more.
  discarded      jsonb,
  recorded_at    timestamptz not null default now()
);

comment on table currency_model_change_log is
  'One row per figure whose currency label changed when multi-currency was '
  'withdrawn on 2026-08-19 (migration 0017). Insert-only, never read by the '
  'application. It exists so "why does this 2026 rate card say USD when it was '
  'entered as GBP?" has an answer.';

insert into currency_model_change_log
  (entity_type, entity_id, previous_currency, effective_currency)
select 'RATE_CARD', rc.id, rc.currency, co.currency
  from rate_cards rc
  join companies co on co.id = rc.company_id
 where rc.currency is not null and rc.currency <> co.currency;

insert into currency_model_change_log
  (entity_type, entity_id, previous_currency, effective_currency)
select 'INVOICE', i.id, i.currency, p.reporting_currency
  from invoices i
  join projects p on p.id = i.project_id
 where i.currency is not null
   and p.reporting_currency is not null
   and i.currency <> p.reporting_currency;

insert into currency_model_change_log
  (entity_type, entity_id, previous_currency, effective_currency)
select 'RATE_PROPOSAL', rp.id, rp.currency, co.currency
  from rate_proposals rp
  join engagements e on e.id = rp.engagement_id
  join companies co on co.id = e.client_company_id
 where rp.currency is not null and rp.currency <> co.currency;

-- Time logs: the frozen FX citation is archived whole, because a citation is the
-- evidence for a number somebody was paid.
insert into currency_model_change_log
  (entity_type, entity_id, previous_currency, effective_currency, discarded)
select 'TIME_LOG',
       t.id,
       coalesce(t.resolved_rate->>'currency', p.reporting_currency),
       p.reporting_currency,
       t.resolved_rate->'fx'
  from time_logs t
  join projects p on p.id = t.project_id
 where t.resolved_rate is not null
   and (t.resolved_rate ? 'fx'
        or coalesce(t.resolved_rate->>'currency', p.reporting_currency)
             <> p.reporting_currency);

do $$
declare
  moved integer;
begin
  select count(*) into moved from currency_model_change_log;
  if moved > 0 then
    raise notice
      '0017: % figure(s) had a currency label that differed from their company''s. '
      'Their numbers are unchanged and their previous labels are preserved in '
      'currency_model_change_log.', moved;
  end if;
end $$;

-- ── 2. The exchange rates themselves ────────────────────────────────────────
--
-- Trigger first, then the table, then the function. Dropping the table would
-- take the trigger with it, but naming both keeps this readable as a reversal of
-- 0013 rather than a cascade whose effects have to be inferred.
drop trigger if exists fx_rates_no_update on fx_rates;
drop table if exists fx_rates;
drop function if exists fx_rates_are_immutable();

-- ── 3. Per-row currency columns ─────────────────────────────────────────────
alter table invoices        drop column if exists currency;
alter table rate_cards      drop column if exists currency;
alter table rate_proposals  drop column if exists currency;

-- ── 4. The frozen FX citation inside each PAY snapshot ──────────────────────
--
-- `resolved_rate` is jsonb, so this is a key removal rather than a column drop.
-- The `currency` key stays: it is the label the cost was frozen with, and from
-- here it can only ever be the paying company's one currency.
--
-- Scoped by `? 'fx'` so the update touches only rows that carry one, rather than
-- rewriting every approved log on the platform to no effect.
update time_logs
   set resolved_rate = resolved_rate - 'fx'
 where resolved_rate is not null
   and resolved_rate ? 'fx';

-- ── 5. Redefine the trigger that named the dropped column ───────────────────
--
-- THE BUG THIS SECTION EXISTS FOR, recorded because it is not obvious and it is
-- silent until something writes: `alter table ... drop column` DOES NOT rewrite a
-- PL/pgSQL function body. `rate_cards_guard_locked()` from 0009 compares
-- `new.currency` to `old.currency` as part of deciding whether an approved card
-- was illegally edited. With the column gone, that comparison raises at runtime -
-- so every UPDATE on rate_cards started failing with a 500, including the
-- legitimate `effective_to` write that supersedes a card when a new rate is
-- approved. The end-to-end script caught it on `approves the successor`; nothing
-- in the type system could.
--
-- Redefined here with the currency comparison removed and every other column
-- kept, so an approved version stays immutable in exactly the way 0009 intended.
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

-- ── 6. Keep the snapshot, and say why it survived ───────────────────────────
comment on column projects.reporting_currency is
  'The currency label every figure on this project is printed with. Snapshotted '
  'from the owner company at creation and never re-read, so changing '
  'companies.currency cannot relabel a project that is already closed. Pinned '
  'once the project holds approved work or a live invoice. There is only ever '
  'one currency in play: CrewQuo holds no exchange rate and converts nothing '
  '(owner decision, 2026-08-19).';

comment on column companies.currency is
  'The one currency this company works in. A label printed in front of amounts, '
  'not a unit anything is converted between.';
