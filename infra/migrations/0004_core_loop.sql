-- 0004_core_loop.sql
-- The core work loop (CREWQUO_V2_PLAN.md §3.2, §3.4, §3.6): engagements (the
-- relationship graph), projects + assignments, work capture (time_logs,
-- expenses, project_submissions) with the DRAFT→SUBMITTED→APPROVED/REJECTED
-- workflow, and the unified invites table. Plus push_tokens for Expo push.
--
-- Authorization (one-hop visibility, provider-never-reads-BILL, the work-
-- workflow invariant) is enforced in the API (src/authorization/policies.ts),
-- not the DB — see §4.

create table if not exists engagements (
  id                    uuid primary key default gen_random_uuid(),
  client_company_id     uuid not null references companies(id),  -- hirer (pays, approves)
  provider_company_id   uuid not null references companies(id),  -- subcontractor (delivers)
  status                text not null default 'ACTIVE'
                          check (status in ('PENDING','ACTIVE','PAUSED','ENDED')),
  created_by_company_id  uuid not null references companies(id),  -- initiator (operates_downstream)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (client_company_id <> provider_company_id),
  unique (client_company_id, provider_company_id)
);
create index if not exists engagements_client_idx on engagements (client_company_id);
create index if not exists engagements_provider_idx on engagements (provider_company_id);

create table if not exists projects (
  id                uuid primary key default gen_random_uuid(),
  owner_company_id  uuid not null references companies(id) on delete cascade,
  client_company_id uuid references companies(id),
  engagement_id     uuid references engagements(id),
  name    text not null,
  status  text not null default 'ACTIVE'
            check (status in ('PLANNED','ACTIVE','COMPLETED','ARCHIVED')),
  client_visible boolean not null default false,
  starts_on date,
  ends_on   date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_owner_idx on projects (owner_company_id);
create index if not exists projects_client_idx on projects (client_company_id)
  where client_company_id is not null;

create table if not exists project_assignments (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  provider_company_id uuid not null references companies(id),
  engagement_id uuid not null references engagements(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, provider_company_id)
);
create index if not exists project_assignments_project_idx on project_assignments (project_id);

create table if not exists time_logs (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),  -- flows UP this edge for approval
  project_id    uuid not null references projects(id),
  provider_company_id uuid not null references companies(id),
  logged_by_user_id   uuid not null references users(id),
  role_id       uuid not null references role_catalog(id),
  shift_type    text not null
                  check (shift_type in ('WEEKDAY_DAY','NIGHT','SUNDAY','SHIFT','DAILY')),
  work_date     date not null,
  hours_regular numeric(6,2) not null default 0,
  hours_ot      numeric(6,2) not null default 0,
  status        text not null default 'DRAFT'
                  check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  resolved_rate jsonb,                          -- rate snapshot at submit time (§6)
  reviewed_by_user_id uuid references users(id),
  reviewed_at   timestamptz,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists time_logs_engagement_status_idx on time_logs (engagement_id, status);
create index if not exists time_logs_project_idx on time_logs (project_id);
create index if not exists time_logs_provider_status_idx on time_logs (provider_company_id, status);

create table if not exists expenses (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  project_id    uuid not null references projects(id),
  provider_company_id uuid not null references companies(id),
  logged_by_user_id   uuid not null references users(id),
  amount_cents  integer not null,
  category      text,
  description   text,
  receipt_url   text,                           -- R2 object (upload deferred)
  status        text not null default 'DRAFT'
                  check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  reviewed_by_user_id uuid references users(id),
  reviewed_at   timestamptz,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists expenses_engagement_status_idx on expenses (engagement_id, status);

create table if not exists project_submissions (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  project_id    uuid not null references projects(id),
  provider_company_id uuid not null references companies(id),
  period_start date,
  period_end   date,
  status text not null default 'DRAFT'
           check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  submitted_by_user_id uuid references users(id),
  reviewed_by_user_id  uuid references users(id),
  reviewed_at   timestamptz,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists project_submissions_engagement_idx on project_submissions (engagement_id, status);

create table if not exists invites (
  id            uuid primary key default gen_random_uuid(),
  invite_token  text not null unique,                   -- opaque capability
  kind          text not null check (kind in ('MEMBER','ENGAGEMENT','CLIENT_PORTAL')),
  target_company_id uuid not null references companies(id),
  email         text not null,
  role          text check (role in ('OWNER','ADMIN','MANAGER','MEMBER')),
  engagement_id uuid references engagements(id),
  status        text not null default 'PENDING'
                  check (status in ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  invited_by_user_id uuid references users(id),
  expires_at    timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists invites_target_idx on invites (target_company_id, status);

-- Expo push tokens per user device (§3.4 mobile push). One row per device token.
create table if not exists push_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token      text not null unique,                       -- ExponentPushToken[...]
  platform   text check (platform in ('ios','android','web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_tokens_user_idx on push_tokens (user_id);
