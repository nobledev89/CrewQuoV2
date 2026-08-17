-- 0007_rate_label_rules.sql
-- Rate label rules become per-company data (owner decision, 2026-08-17 — plan
-- §17: "nothing about rates may be hardcoded").
--
-- `resolveRateLabel` carried a branch that promoted a NIGHT shift on a Friday or
-- Saturday to the FRI_SAT_NIGHT label. Which days map to which label is a company
-- setting, so the branch is gone and the rule now lives in
-- `rate_card_templates.timeframe_definitions` as
--   {"type":"label_rule","shiftType":"NIGHT","daysOfWeek":[5,6],"label":"FRI_SAT_NIGHT"}
-- alongside the existing {"type":"holiday",...} definitions.
--
-- A company can hold several templates, so one of them has to be the one the
-- engine reads: `is_default`. Steps 2–4 below make sure every company that was
-- relying on the old branch keeps resolving exactly as it did — nothing already
-- priced moves. New companies start with no label rules at all, which is the
-- point: the product no longer assumes anyone's weekend.

-- 1) The default flag.
alter table rate_card_templates
  add column if not exists is_default boolean not null default false;

-- 2) A company that was using FRI_SAT_NIGHT cards but has no template at all
--    needs somewhere to keep the rule.
insert into rate_card_templates (company_id, name, timeframe_definitions, is_default)
select distinct rc.company_id, 'Default', '[]'::jsonb, false
  from rate_cards rc
 where rc.rate_label = 'FRI_SAT_NIGHT'
   and not exists (
     select 1 from rate_card_templates t where t.company_id = rc.company_id
   );

-- 3) Elect one default per company: the earliest-created template, deterministic
--    on re-run. Companies with a single template simply get that one.
update rate_card_templates t
   set is_default = true, updated_at = now()
 where t.id = (
   select x.id from rate_card_templates x
    where x.company_id = t.company_id
    order by x.created_at asc, x.id asc
    limit 1
 )
   and not exists (
     select 1 from rate_card_templates d
      where d.company_id = t.company_id and d.is_default
   );

-- 4) Preserve the old behaviour as data, for companies that had a FRI_SAT_NIGHT
--    card and don't already carry a NIGHT label rule.
update rate_card_templates t
   set timeframe_definitions = t.timeframe_definitions
         || '[{"type":"label_rule","shiftType":"NIGHT","daysOfWeek":[5,6],"label":"FRI_SAT_NIGHT"}]'::jsonb,
       updated_at = now()
 where t.is_default
   and exists (
     select 1 from rate_cards rc
      where rc.company_id = t.company_id and rc.rate_label = 'FRI_SAT_NIGHT'
   )
   and not exists (
     select 1 from jsonb_array_elements(t.timeframe_definitions) d
      where d->>'type' = 'label_rule' and d->>'shiftType' = 'NIGHT'
   );

-- 5) One default per company, enforced.
create unique index if not exists rate_card_templates_one_default_idx
  on rate_card_templates (company_id) where is_default;
