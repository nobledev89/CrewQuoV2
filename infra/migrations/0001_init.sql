-- 0001_init.sql
-- Foundational identity & tenancy (CREWQUO_V2_PLAN.md §3.1 and §5).
-- gen_random_uuid() is built into PostgreSQL 13+.

create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  email             text not null unique,
  password_hash     text,                         -- null when Google-only
  google_sub        text unique,                  -- Google subject id, null if not linked
  name              text not null,
  avatar_url        text,
  is_super_admin    boolean not null default false,
  email_verified_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists companies (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  currency              text not null default 'GBP',   -- ISO 4217; set once per company
  is_placeholder        boolean not null default false,
  claimed_by_company_id uuid references companies(id),
  settings              jsonb not null default '{}',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- user <-> company. Replaces v1's ownCompany/activeCompany/subcontractorRoles claims.
create table if not exists memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  role       text not null check (role in ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER')),
  status     text not null default 'ACTIVE' check (status in ('ACTIVE', 'INVITED', 'SUSPENDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, company_id)
);
create index if not exists memberships_company_id_idx on memberships (company_id);
create index if not exists memberships_user_id_idx on memberships (user_id);

create table if not exists refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists refresh_tokens_user_id_idx on refresh_tokens (user_id);

create table if not exists system_settings (
  key        text primary key,
  value      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
