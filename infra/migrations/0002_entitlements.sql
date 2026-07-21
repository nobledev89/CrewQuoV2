-- 0002_entitlements.sql
-- Plans & entitlements — super-admin configurable (CREWQUO_V2_PLAN.md §5B).
-- Plans are data, not code: one resolver enforces feature gates + limits.

create table if not exists features (
  key         text primary key,
  name        text not null,
  description text,
  category    text
);

create table if not exists limits (
  key               text primary key,
  name              text not null,
  description       text,
  unit              text not null default 'count',
  unlimited_allowed boolean not null default true
);

create table if not exists plans (
  id                  text primary key,               -- slug, e.g. 'pro'
  name                text not null,
  description         text,
  status              text not null default 'DRAFT'
                        check (status in ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  is_public           boolean not null default true,
  operates_downstream boolean not null default false, -- can add own subcontractors?
  sort_order          int not null default 0,
  trial_days          int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists plan_prices (
  id                uuid primary key default gen_random_uuid(),
  plan_id           text not null references plans(id) on delete cascade,
  currency          text not null,
  interval          text not null check (interval in ('MONTH', 'YEAR')),
  amount_cents      int not null,
  provider_price_id text,                             -- MoR product/price id
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (plan_id, currency, interval)
);

create table if not exists plan_features (
  plan_id     text not null references plans(id) on delete cascade,
  feature_key text not null references features(key),
  primary key (plan_id, feature_key)
);

create table if not exists plan_limits (
  plan_id   text not null references plans(id) on delete cascade,
  limit_key text not null references limits(key),
  value     int,                                      -- null = unlimited
  primary key (plan_id, limit_key)
);

create table if not exists company_subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references companies(id) on delete cascade,
  plan_id                  text not null references plans(id),
  status                   text not null
                             check (status in ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED')),
  currency                 text,
  interval                 text check (interval in ('MONTH', 'YEAR')),
  current_period_end       timestamptz,
  trial_end                timestamptz,
  provider_subscription_id text,                      -- MoR subscription id
  entitlements_snapshot    jsonb,                     -- grandfathering (§5B)
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (company_id)
);
create index if not exists company_subscriptions_plan_id_idx on company_subscriptions (plan_id);

create table if not exists company_entitlement_overrides (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  feature_key     text references features(key),
  feature_enabled boolean,
  limit_key       text references limits(key),
  limit_value     int,                                -- null value = unlimited
  note            text,
  expires_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists company_entitlement_overrides_company_id_idx
  on company_entitlement_overrides (company_id);
