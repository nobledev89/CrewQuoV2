-- A provider price identifies exactly one CrewQuo plan price. Without this,
-- webhook reconciliation would have two valid tenants/plans to choose between.

create unique index if not exists plan_prices_provider_price_uidx
  on plan_prices (provider_price_id)
  where provider_price_id is not null;
