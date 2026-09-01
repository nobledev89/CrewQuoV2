-- Paddle billing: checkout attempts and replay-safe provider reconciliation.

alter table company_subscriptions
  add column if not exists provider text,
  add column if not exists provider_customer_id text,
  add column if not exists provider_price_id text,
  add column if not exists provider_status text,
  add column if not exists provider_updated_at timestamptz,
  add column if not exists provider_event_id text,
  add column if not exists cancel_at_period_end boolean not null default false;

create unique index if not exists company_subscriptions_provider_subscription_uidx
  on company_subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;

create table if not exists billing_checkouts (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references companies(id) on delete cascade,
  requested_by_user_id    uuid references users(id) on delete set null,
  plan_price_id           uuid not null references plan_prices(id),
  provider                text not null check (provider in ('PADDLE')),
  provider_transaction_id text unique,
  checkout_url            text,
  status                  text not null default 'CREATING'
                          check (status in ('CREATING','PENDING','COMPLETED','EXPIRED','FAILED')),
  failure_reason          text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists billing_checkouts_company_idx
  on billing_checkouts (company_id, created_at desc);

comment on column company_subscriptions.provider_updated_at is
  'Provider event occurred_at last applied; older webhook deliveries are ignored.';
comment on table billing_checkouts is
  'Hosted checkout attempts. The Paddle transaction id and webhook inbox event ids provide replay evidence.';
