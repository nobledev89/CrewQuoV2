-- 0006_currency_usd_default.sql
-- Currency: USD default, user-changeable (owner decision, 2026-08-17 — plan §17).
--
-- `companies.currency` shipped defaulting to 'GBP' (0001_init.sql:21) and
-- `auth/service.ts` stamped the same literal on every company created at
-- registration. Both are now USD, and `DEFAULT_CURRENCY` in
-- packages/shared/src/me.ts is the single place the value lives in code — keep
-- this column default equal to it.

alter table companies alter column currency set default 'USD';

-- Backfill, deliberately narrow.
--
-- Currency is not decoration: it is the unit on every stored integer minor-unit
-- amount, and CrewQuo holds no exchange rate anywhere (decision #5). Rewriting it
-- does not convert anything — a 5000 rate card reads $50.00 instead of £50.00 —
-- so on a company that has already priced work, this migration would silently
-- restate real figures. That is not a thing a schema migration gets to do, even
-- pre-launch, and `PATCH /v1/companies/:id` (shipped with this migration) exists
-- precisely so a human can make that call deliberately and have it audited.
--
-- So: only companies where the label demonstrably never priced anything — no rate
-- cards, no projects, no time logs, no expenses. For those the flip is provably
-- inert, and it clears the stale default from every account that never got as far
-- as entering money. Everyone else keeps GBP until an owner or admin changes it.
update companies c
   set currency = 'USD', updated_at = now()
 where c.currency = 'GBP'
   and not exists (select 1 from rate_cards  x where x.company_id = c.id)
   and not exists (select 1 from projects    x where x.owner_company_id = c.id)
   and not exists (select 1 from time_logs   x where x.provider_company_id = c.id)
   and not exists (select 1 from expenses    x where x.provider_company_id = c.id);
