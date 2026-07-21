-- 0003_rates.sql
-- Rate engine catalog (CREWQUO_V2_PLAN.md §3.3, §6).
-- role_catalog: named roles a company staffs. rate_card_templates: holiday /
-- timeframe definitions. rate_cards: PAY (paid to a provider) and BILL (charged
-- to a client) rates. Margin = BILL - PAY. Currency is inherited from
-- companies.currency and never stored per card (decision #5). The rule that a
-- provider never reads the client-side BILL card is enforced in the API (§4).

create table if not exists role_catalog (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);
create index if not exists role_catalog_company_idx on role_catalog (company_id);

create table if not exists rate_card_templates (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null,
  timeframe_definitions jsonb not null default '[]', -- holiday/timeframe defs (§6)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rate_card_templates_company_idx on rate_card_templates (company_id);

create table if not exists rate_cards (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade, -- the card owner
  kind         text not null check (kind in ('PAY','BILL')),
  counterparty_company_id uuid references companies(id),       -- specific provider(PAY)/client(BILL); null=default
  role_id      uuid not null references role_catalog(id) on delete cascade,
  rate_mode    text not null check (rate_mode in ('HOURLY','SHIFT','DAILY')),
  rate_label   text not null check (rate_label in
                 ('MON_FRI_DAY','FRI_SAT_NIGHT','MON_THU_NIGHT','SUNDAY','SHIFT','DAILY')),
  hourly_rate_cents    integer,
  ot_hourly_rate_cents integer,
  shift_rate_cents     integer,
  daily_rate_cents     integer,
  min_hours            numeric(6,2),
  weekend_multiplier   numeric(6,3),
  night_multiplier     numeric(6,3),
  effective_from date not null,
  effective_to   date,                          -- null = open-ended
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rate_cards_lookup_idx
  on rate_cards (company_id, kind, role_id, rate_label, effective_from desc);
